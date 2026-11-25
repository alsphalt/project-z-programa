import 'server-only';
import { dbKind, parseJsonb, query, queryOne } from '../db';
import type { ServerRecord } from '../servers/repo';
import { consoleBuffer } from '../services/console';
import { listErrors, errorStats } from '../errors/store';
import type { ErrorEvent } from '../errors/types';
import { summarizeJavaScript } from '../search/ast';
import { explorerSearch } from '../services/explorer';

/**
 * Tools over DARKNOTE's real data.
 *
 * Everything a BIGBROTHER answer claims about files, commands, errors or runtime
 * state comes from one of these functions. They return rows or an explicit
 * "nothing indexed" note — never example data.
 */

export interface ProjectHit {
  path: string;
  fileName: string;
  line: number | null;
  label: string | null;
  kind: 'case' | 'function' | 'file' | 'content';
  snippet: string | null;
  openHref: string;
  explorerHref: string;
  matchCount: number;
}

export interface ProjectSearchResult {
  hits: ProjectHit[];
  notes: string[];
  snapshotAt: string | null;
  indexedFiles: number;
}

function editorHref(path: string, line: number | null): string {
  const params = new URLSearchParams({ path });
  if (line && line > 0) params.set('line', String(line));
  return `/editor?${params.toString()}`;
}

function explorerHref(path: string): string {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '/';
  return `/files?${new URLSearchParams({ path: parent }).toString()}`;
}

function snippetFor(content: string, line: number, radius = 1): string {
  const lines = content.split('\n');
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines
    .slice(start, end)
    .map((text, index) => `${start + index + 1}: ${text.trim().slice(0, 220)}`)
    .join('\n');
}

export async function searchProject(
  server: ServerRecord,
  rawTerm: string,
  limit = 8,
): Promise<ProjectSearchResult> {
  const term = rawTerm.trim();
  if (!term) {
    return { hits: [], notes: ['No search term was extracted from the question.'], snapshotAt: null, indexedFiles: 0 };
  }

  const [indexCount, result] = await Promise.all([
    queryOne<{ count: string | number }>(
      `select count(*)::int as count from file_indexes
        where server_id = $1 and deleted_at is null and is_directory = false`,
      [server.id],
    ),
    // The Explorer search is the same engine the Project Explorer uses: symbols,
    // file names and indexed code hits with exact line numbers.
    explorerSearch(server, term, { limit: 200 }),
  ]);

  const indexedFiles = Number(indexCount?.count ?? 0);
  if (indexedFiles === 0) {
    return {
      hits: [],
      notes: [
        'No files are indexed for this server yet, so there is nothing to search. Run Server Discovery (or Project Explorer → Scan) first — until then any file path would be a guess.',
      ],
      snapshotAt: null,
      indexedFiles: 0,
    };
  }

  const hits: ProjectHit[] = [];
  const seen = new Set<string>();
  const push = (hit: ProjectHit) => {
    const key = `${hit.path}:${hit.line ?? 0}:${hit.kind}:${hit.label ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  for (const symbol of result.symbols) {
    push({
      path: symbol.path,
      fileName: symbol.path.split('/').pop() ?? symbol.path,
      line: symbol.line || null,
      label: symbol.name,
      kind: symbol.kind === 'case' ? 'case' : 'function',
      snippet: symbol.detail ?? `${symbol.kind} “${symbol.name}”`,
      openHref: editorHref(symbol.path, symbol.line || null),
      explorerHref: explorerHref(symbol.path),
      matchCount: 1,
    });
  }

  for (const name of result.names) {
    if (name.isDirectory) continue;
    push({
      path: name.path,
      fileName: name.name,
      line: null,
      label: null,
      kind: 'file',
      snippet: null,
      openHref: editorHref(name.path, null),
      explorerHref: explorerHref(name.path),
      matchCount: 1,
    });
  }

  for (const file of result.files) {
    for (const [index, hit] of file.hits.slice(0, 2).entries()) {
      push({
        path: file.path,
        fileName: file.name,
        line: hit.line,
        label: null,
        kind: 'content',
        snippet: [hit.before, hit.text, hit.after].filter(Boolean).join('\n').trim() || null,
        openHref: editorHref(file.path, hit.line),
        explorerHref: explorerHref(file.path),
        matchCount: Math.max(1, file.matches - index),
      });
    }
  }

  const notes = [...result.notes];
  if (!hits.length) {
    notes.push(
      `Nothing in the index matches “${term}”. The file may be new, outside the project root, or excluded (session folders and credentials are never indexed).`,
    );
  } else if (result.snapshotAt) {
    notes.push(`Code hits come from the indexed snapshot taken ${result.snapshotAt}. Opening a file re-reads production.`);
  }

  // Symbols and file names are stronger answers than a text hit inside a file.
  const order = { case: 0, function: 1, file: 2, content: 3 } as const;
  hits.sort((a, b) => order[a.kind] - order[b.kind]);

  return {
    hits: hits.slice(0, limit),
    notes: [...new Set(notes)],
    snapshotAt: result.snapshotAt,
    indexedFiles,
  };
}

export async function pluginFiles(serverId: string): Promise<{ dirs: string[]; files: ProjectHit[] }> {
  const rows = await query<{ path: string; name: string; is_directory: boolean }>(
    `select path, name, is_directory from file_indexes
      where server_id = $1 and deleted_at is null
        and (lower(path) like '%/plugin%' or lower(path) like '%/command/%' or lower(path) like '%/commands/%')
      order by path asc limit 120`,
    [serverId],
  );
  const dirs = [...new Set(rows.filter((row) => row.is_directory).map((row) => row.path))].slice(0, 12);
  const files = rows
    .filter((row) => !row.is_directory)
    .slice(0, 12)
    .map((row) => ({
      path: row.path,
      fileName: row.name,
      line: null,
      label: null,
      kind: 'file' as const,
      snippet: null,
      openHref: editorHref(row.path, null),
      explorerHref: explorerHref(row.path),
      matchCount: 1,
    }));
  return { dirs, files };
}

export async function importsOf(serverId: string, path: string): Promise<Array<{ source: string; names: string[]; line: number }>> {
  const row = await queryOne<{ content: string }>(
    'select content from file_contents where server_id = $1 and path = $2',
    [serverId, path],
  );
  if (!row) return [];
  const summary = summarizeJavaScript(row.content);
  return summary.imports.slice(0, 12).map((item) => ({ source: item.source, names: item.names, line: item.line }));
}

export interface RuntimeFacts {
  containerState: string;
  whatsappState: string;
  whatsappSignal: string | null;
  checkedAt: string | null;
  consoleState: string;
  consoleError: string | null;
  bufferedLines: number;
  indexFiles: number;
  indexFolders: number;
  lastScanAt: string | null;
  pendingDrafts: number;
  openConflicts: number;
  deploymentLock: { owner: string; expiresAt: string } | null;
  lastDeployment: { status: string; at: string; error: string | null } | null;
}

export async function runtimeFacts(serverId: string): Promise<RuntimeFacts> {
  const [status, counts, scan, drafts, conflicts, lock, deployment] = await Promise.all([
    queryOne<{
      container_state: string; whatsapp_state: string; whatsapp_signal: string | null; checked_at: string;
    }>('select container_state, whatsapp_state, whatsapp_signal, checked_at from bot_status where server_id = $1', [serverId]),
    queryOne<{ files: string | number; folders: string | number }>(
      `select count(*) filter (where is_directory = false)::int as files,
              count(*) filter (where is_directory = true)::int as folders
         from file_indexes where server_id = $1 and deleted_at is null`,
      [serverId],
    ),
    queryOne<{ started_at: string }>(
      'select started_at from sync_history where server_id = $1 order by started_at desc limit 1',
      [serverId],
    ),
    queryOne<{ count: string | number }>(
      `select count(*)::int as count from editor_drafts where server_id = $1 and status in ('draft','conflict')`,
      [serverId],
    ),
    queryOne<{ count: string | number }>(
      'select count(*)::int as count from sync_conflicts where server_id = $1 and resolution is null',
      [serverId],
    ),
    queryOne<{ owner: string; expires_at: string }>(
      'select owner, expires_at from deployment_locks where server_id = $1 and expires_at > now()',
      [serverId],
    ),
    queryOne<{ status: string; started_at: string; error: string | null }>(
      'select status, started_at, error from deployments where server_id = $1 order by started_at desc limit 1',
      [serverId],
    ),
  ]);

  const buffer = consoleBuffer(serverId);
  const lines = buffer.lines;

  return {
    containerState: status?.container_state ?? 'unknown',
    whatsappState: status?.whatsapp_state ?? 'unknown',
    whatsappSignal: status?.whatsapp_signal ?? null,
    checkedAt: status?.checked_at ?? null,
    consoleState: buffer.state,
    consoleError: buffer.error,
    bufferedLines: lines.length,
    indexFiles: Number(counts?.files ?? 0),
    indexFolders: Number(counts?.folders ?? 0),
    lastScanAt: scan?.started_at ?? null,
    pendingDrafts: Number(drafts?.count ?? 0),
    openConflicts: Number(conflicts?.count ?? 0),
    deploymentLock: lock ? { owner: lock.owner, expiresAt: lock.expires_at } : null,
    lastDeployment: deployment ? { status: deployment.status, at: deployment.started_at, error: deployment.error } : null,
  };
}

export interface ErrorAnswer {
  matched: ErrorEvent[];
  activeCount: number;
  criticalCount: number;
  note: string;
}

export async function errorsForQuestion(serverId: string | null, question: string): Promise<ErrorAnswer> {
  // With no server selected only server-less (API/auth/browser) records are
  // read. A per-server lookup always happens inside an access-checked request.
  const scope = serverId ? { serverId } : { serverIds: [] };
  const [{ errors }, stats] = await Promise.all([
    listErrors({ ...scope, status: 'active', limit: 80 }),
    errorStats(serverId, serverId ? undefined : []),
  ]);

  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 3);

  const scored = errors
    .map((error) => {
      const haystack = `${error.title} ${error.code} ${error.message} ${error.filePath ?? ''} ${error.source} ${error.endpoint ?? ''}`.toLowerCase();
      const score = tokens.reduce((sum, token) => (haystack.includes(token) ? sum + 1 : sum), 0);
      return { error, score };
    })
    .sort((a, b) => b.score - a.score || (a.error.severity === 'critical' ? -1 : 1));

  const matched = scored.filter((item) => item.score > 0).slice(0, 3).map((item) => item.error);
  const fallback = matched.length ? [] : errors.slice(0, 3);

  return {
    matched: matched.length ? matched : fallback,
    activeCount: stats.active,
    criticalCount: stats.criticalOpen,
    note: matched.length
      ? 'Matched against active records by code, message, file and source.'
      : errors.length
        ? 'No record matched those words, so the most recent active problems are shown instead. An unmatched question may describe something that has not been captured yet.'
        : serverId
          ? 'No errors are recorded for this server yet. Open the Error Center and run a diagnostic scan to capture the current console, deployments and panel state.'
          : 'No server is selected, so only global API, auth and browser failures are in scope — and none are recorded yet. Select a server to include its runtime errors.',
  };
}

export interface DiagnosticFinding {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'unknown';
  detail: string;
  href?: string;
}

export async function runDiagnostics(server: ServerRecord | null): Promise<{ findings: DiagnosticFinding[]; at: string }> {
  const findings: DiagnosticFinding[] = [];
  findings.push({
    id: 'database',
    label: 'Administration database',
    status: 'ok',
    detail: `Connected using the ${dbKind()} driver.`,
  });

  if (!server) {
    findings.push({
      id: 'server',
      label: 'Connected server',
      status: 'fail',
      detail: 'No Pterodactyl server is registered, so panel, console and file checks cannot run.',
      href: '/settings',
    });
    return { findings, at: new Date().toISOString() };
  }

  const facts = await runtimeFacts(server.id);
  const stats = await errorStats(server.id);

  findings.push({
    id: 'panel-config',
    label: 'Panel configuration',
    status: server.connectionState === 'connected' ? 'ok' : server.connectionState === 'unconfigured' ? 'fail' : 'warn',
    detail: `Connection state “${server.connectionState}”${server.lastError ? ` — ${server.lastError}` : ''}. Panel ${server.panelUrl}, server ${server.serverIdentifier}.`,
    href: '/settings',
  });

  findings.push({
    id: 'container',
    label: 'Container state',
    status: facts.containerState === 'running' ? 'ok' : facts.containerState === 'unknown' ? 'unknown' : 'warn',
    detail: `Panel reports “${facts.containerState}”${facts.checkedAt ? ` (checked ${facts.checkedAt})` : ' — no status sample stored yet'}.`,
    href: '/monitor',
  });

  findings.push({
    id: 'whatsapp',
    label: 'WhatsApp session',
    status: facts.whatsappState === 'connected' ? 'ok' : facts.whatsappState === 'unknown' ? 'unknown' : 'fail',
    detail:
      facts.whatsappState === 'unknown'
        ? 'No connection event has been observed for the current process, and no status file was read. Unknown is the honest verdict.'
        : `State “${facts.whatsappState}”${facts.whatsappSignal ? ` — ${facts.whatsappSignal.slice(0, 160)}` : ''}.`,
    href: '/monitor',
  });

  findings.push({
    id: 'console',
    label: 'Console websocket',
    status: facts.consoleState === 'live' ? 'ok' : facts.consoleState === 'error' ? 'fail' : 'warn',
    detail: `Stream state “${facts.consoleState}”, ${facts.bufferedLines} line(s) buffered${facts.consoleError ? ` — ${facts.consoleError}` : ''}.`,
    href: '/console',
  });

  findings.push({
    id: 'index',
    label: 'Project index',
    status: facts.indexFiles === 0 ? 'fail' : 'ok',
    detail: `${facts.indexFiles} file(s), ${facts.indexFolders} folder(s)${facts.lastScanAt ? `; last scan ${facts.lastScanAt}` : '; never scanned'}.`,
    href: '/discovery',
  });

  findings.push({
    id: 'working-copy',
    label: 'Pending work',
    status: facts.openConflicts > 0 ? 'warn' : 'ok',
    detail: `${facts.pendingDrafts} pending draft(s), ${facts.openConflicts} open conflict(s).`,
    href: '/sync',
  });

  findings.push({
    id: 'deployments',
    label: 'Deployments',
    status: facts.deploymentLock ? 'warn' : facts.lastDeployment?.status === 'failed' || facts.lastDeployment?.status === 'rolled_back' ? 'fail' : 'ok',
    detail: facts.deploymentLock
      ? `A deployment lock is held by ${facts.deploymentLock.owner} until ${facts.deploymentLock.expiresAt}.`
      : facts.lastDeployment
        ? `Last deployment ${facts.lastDeployment.status} at ${facts.lastDeployment.at}${facts.lastDeployment.error ? ` — ${facts.lastDeployment.error.slice(0, 200)}` : ''}.`
        : 'No deployment has run for this server yet.',
    href: '/deployments',
  });

  findings.push({
    id: 'errors',
    label: 'Captured problems',
    status: stats.criticalOpen > 0 ? 'fail' : stats.active > 0 ? 'warn' : 'ok',
    detail: `${stats.criticalOpen} critical, ${stats.moderateOpen} moderate and ${stats.minorOpen} minor active; ${stats.resolved} resolved.`,
    href: '/errors',
  });

  return { findings, at: new Date().toISOString() };
}

export async function projectReport(server: ServerRecord | null): Promise<string> {
  const at = new Date().toISOString();
  if (!server) {
    return `# DARKNOTE report\n\nGenerated ${at}.\n\nNo server is connected, so no panel or file facts could be collected. Connect a Pterodactyl server in Admin Settings first.`;
  }
  const facts = await runtimeFacts(server.id);
  const stats = await errorStats(server.id);
  const { errors } = await listErrors({ serverId: server.id, status: 'active', limit: 8 });

  return [
    `# DARKNOTE report — ${server.name}`,
    '',
    `Generated ${at} from stored runtime facts (no values are estimated).`,
    '',
    '## Runtime',
    `- Container: ${facts.containerState}`,
    `- WhatsApp: ${facts.whatsappState}${facts.whatsappSignal ? ` (${facts.whatsappSignal.slice(0, 160)})` : ''}`,
    `- Console: ${facts.consoleState}, ${facts.bufferedLines} line(s) buffered`,
    `- Index: ${facts.indexFiles} files / ${facts.indexFolders} folders; last scan ${facts.lastScanAt ?? 'never'}`,
    `- Pending drafts: ${facts.pendingDrafts}; open conflicts: ${facts.openConflicts}`,
    `- Last deployment: ${facts.lastDeployment ? `${facts.lastDeployment.status} at ${facts.lastDeployment.at}` : 'none'}`,
    '',
    '## Errors',
    `- Active: ${stats.active} (critical ${stats.criticalOpen}, moderate ${stats.moderateOpen}, minor ${stats.minorOpen})`,
    `- Resolved: ${stats.resolved}`,
    ...errors.map(
      (error) =>
        `- [${error.severity}] ${error.title} — ${error.filePath ?? 'no file'}${error.line ? `:${error.line}` : ''} (${error.occurrences}×)`,
    ),
    '',
    '## Next actions',
    stats.criticalOpen > 0
      ? '- Open the Error Center and work through the critical records first.'
      : '- No critical problem is recorded. Run a diagnostic scan before making changes.',
  ].join('\n');
}
