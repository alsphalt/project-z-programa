import 'server-only';
import { query, queryOne } from './db';
import type { ServerRecord } from './servers/repo';
import { refreshStatus, consoleBuffer } from './services/console';
import { currentLock, listDeployments } from './services/deploy';
import { extensionOf } from './security/paths';
import { editorLimitFor } from './files/service';
import { env } from './env';

/** Monaco language id for a remote filename. */
export function languageFor(nameOrPath: string): string | null {
  const ext = extensionOf(nameOrPath);
  const map: Record<string, string> = {
    js: 'javascript',
    cjs: 'javascript',
    mjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    json5: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    svg: 'xml',
    sh: 'shell',
    bash: 'shell',
    sql: 'sql',
    py: 'python',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    properties: 'ini',
    txt: 'plaintext',
    log: 'plaintext',
    csv: 'plaintext',
  };
  return map[ext] ?? null;
}

/** Coarse classification used only for display next to a protected path. */
export function secretKindFor(path: string): string | null {
  if (/(^|\/)\.env(\..*)?$/i.test(path)) return 'env-file';
  if (/(^|\/)(auth|sessions?|session)(\/|$)/i.test(path)) return 'whatsapp-session';
  if (/creds\.json$/i.test(path)) return 'baileys-creds';
  if (/pre-key-\d+\.json$/i.test(path) || /sender-key-.*\.json$/i.test(path)) return 'signal-key';
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(path)) return 'private-key';
  if (/(^|\/)id_(rsa|ed25519)/i.test(path)) return 'ssh-key';
  if (/(^|\/)\.npmrc$/i.test(path)) return 'registry-token';
  return null;
}

export type ConsoleLineView = { ts: number; text: string; level: string };

const ERROR_RE = /\b(error|exception|syntaxerror|referenceerror|typeerror|cannot find module|module_not_found|econnrefused|unhandled|failed|fatal)\b/i;
const WARN_RE = /\b(warn|warning|deprecated|retry|reconnecting)\b/i;

export function classifyLine(text: string): string {
  if (ERROR_RE.test(text)) return 'error';
  if (WARN_RE.test(text)) return 'warn';
  return 'info';
}

function lineViews(serverId: string): ConsoleLineView[] {
  const buffer = consoleBuffer(serverId);
  const now = Date.now();
  const entries = buffer.entries.length
    ? buffer.entries
    : buffer.lines.map((text) => ({ ts: now, text }));
  return entries.map((entry) => ({
    ts: entry.ts || now,
    text: entry.text,
    level: classifyLine(entry.text),
  }));
}

export type MonitorPayload = {
  name: string;
  checkedAt: string;
  panel: {
    reachable: boolean;
    /** null, not 0, when the panel could not report a value. */
    state: string;
    cpuPercent: number | null;
    memoryBytes: number | null;
    memoryLimitBytes: number | null;
    diskBytes: number | null;
    diskLimitBytes: number | null;
    uptimeMs: number | null;
    error: string | null;
  };
  bot: {
    state: string;
    whatsapp: string;
    whatsappSource: 'bot-process' | 'console-event' | 'none';
    signal: string | null;
    detail: string;
    evidence: string[];
  };
  console: {
    streamState: string;
    streamError: string | null;
    attached: boolean;
    lines: ConsoleLineView[];
  };
  editor: { limitBytes: number; ceilingBytes: number; chunkBytes: number };
  index: {
    files: number;
    folders: number;
    lastScanAt: string | null;
    lastScanStatus: string | null;
    lastScanMethod: string;
  };
  sync: { lastSyncAt: string | null; pendingDrafts: number; openConflicts: number; changedFiles: number };
  deployments: { restarts: number; lastStatus: string | null; lastAt: string | null; lock: { owner: string; expiresAt: string } | null };
  errors: Array<{ level: string; message: string; at: string; source: string }>;
};

/**
 * One monitor payload for Overview, Live Monitor and Terminal.
 *
 * Container state and WhatsApp state are reported separately and never conflated:
 * a running container does not prove the WhatsApp session is connected.
 */
/**
 * `lineLimit` bounds the console tail carried by the monitor payload.
 *
 * The tail used to be a fixed 400 lines on every poll. On a phone that payload is
 * parsed, retained by the response cache and re-rendered every ten seconds; a
 * busy bot can make each line a couple of hundred characters, so 400 of them is
 * a hundred kilobytes of JSON per tick. Callers that only need the state badge
 * ask for a handful; the terminal asks for the full tail once.
 */
export async function buildMonitor(server: ServerRecord, options: { lineLimit?: number } = {}): Promise<MonitorPayload> {
  let status: Awaited<ReturnType<typeof refreshStatus>> | null = null;
  let panelError: string | null = null;

  // refreshStatus attaches the persistent console websocket, so every monitor
  // poll also refreshes the live console tail.
  try {
    status = await refreshStatus(server);
  } catch (error) {
    panelError = error instanceof Error ? error.message : String(error);
  }

  const [indexCounts, scanRow, draftCount, conflictCount, changedCount, deploymentRows, lock] = await Promise.all([
    queryOne<{ files: string | number; folders: string | number }>(
      `select
        (select count(*)::int from file_indexes where server_id = $1 and is_directory = false and deleted_at is null) as files,
        (select count(*)::int from file_indexes where server_id = $1 and is_directory = true and deleted_at is null) as folders`,
      [server.id],
    ),
    queryOne<{ started_at: string; status: string; mode: string }>(
      `select started_at, status, mode from sync_history where server_id = $1 order by started_at desc limit 1`,
      [server.id],
    ),
    queryOne<{ count: string | number }>(
      `select count(*)::int as count from editor_drafts where server_id = $1 and status in ('draft','conflict')`,
      [server.id],
    ),
    queryOne<{ count: string | number }>(
      `select count(*)::int as count from sync_conflicts where server_id = $1 and resolution is null`,
      [server.id],
    ),
    queryOne<{ count: string | number }>(
      `select count(*)::int as count from update_events where server_id = $1 and acknowledged = false`,
      [server.id],
    ),
    listDeployments(server.id, 5),
    currentLock(server.id),
  ]);

  const deploymentList = deploymentRows as Array<{
    id: string;
    status: string;
    restart_performed: boolean;
    started_at: string;
    finished_at: string | null;
  }>;
  const restarts = deploymentList.filter((row) => row.restart_performed).length;

  const buffer = consoleBuffer(server.id);
  const lines = lineViews(server.id);
  const botState = status?.containerState ?? buffer.containerState ?? 'unknown';
  const whatsapp = status?.whatsappState ?? 'unknown';
  const evidence = status?.whatsappEvidence ?? [];
  const consoleState = status?.consoleState ?? buffer.state;

  const errors = lines
    .filter((line) => line.level === 'error')
    .slice(-20)
    .map((line) => ({ level: 'error', message: line.text, at: new Date(line.ts).toISOString(), source: 'console' }));
  if (panelError) {
    errors.push({ level: 'error', message: panelError, at: new Date().toISOString(), source: 'panel' });
  }

  const detail =
    panelError
      ? `The panel did not answer: ${panelError}`
      : whatsapp === 'connected'
        ? status?.whatsappSource === 'bot-process'
          ? 'The bot process reported an open WhatsApp session.'
          : 'The bot log reports an open WhatsApp session for this process.'
        : whatsapp === 'unknown'
          ? consoleState === 'live'
            ? 'The console is attached, but no WhatsApp connection event has been printed yet.'
            : 'The console is not attached yet, so WhatsApp state cannot be observed.'
          : `The bot log reports the WhatsApp session as “${whatsapp}”.`;

  return {
    name: server.name,
    checkedAt: new Date().toISOString(),
    panel: {
      reachable: !panelError,
      state: botState,
      cpuPercent: status?.cpuPercent ?? null,
      memoryBytes: status?.memoryBytes ?? null,
      memoryLimitBytes: status?.memoryLimitBytes ?? null,
      diskBytes: status?.diskBytes ?? null,
      diskLimitBytes: null,
      uptimeMs: status?.uptimeMs ?? null,
      error: panelError,
    },
    bot: {
      state: botState,
      whatsapp,
      whatsappSource: status?.whatsappSource ?? 'none',
      signal: status?.whatsappSignal ?? null,
      detail,
      evidence,
    },
    console: {
      streamState: buffer.error && consoleState === 'error' ? 'error' : consoleState === 'live' ? 'live' : consoleState,
      streamError: buffer.error,
      attached: consoleState === 'live' || consoleState === 'connecting' || consoleState === 'reconnecting',
      lines: lines.slice(-Math.max(1, Math.min(400, options.lineLimit ?? 120))),
    },
    editor: {
      limitBytes: editorLimitFor(server),
      ceilingBytes: env.maxEditorBytes,
      chunkBytes: env.editorChunkBytes,
    },
    index: {
      files: Number(indexCounts?.files ?? 0),
      folders: Number(indexCounts?.folders ?? 0),
      lastScanAt: scanRow?.started_at ?? server.lastScanAt,
      lastScanStatus: scanRow?.status ?? null,
      lastScanMethod: scanRow?.mode === 'scan' ? 'full scan' : scanRow?.mode === 'poll' ? 'scheduled poll' : 'manual scan',
    },
    sync: {
      lastSyncAt: scanRow?.started_at ?? server.lastSyncAt,
      pendingDrafts: Number(draftCount?.count ?? 0),
      openConflicts: Number(conflictCount?.count ?? 0),
      changedFiles: Number(changedCount?.count ?? 0),
    },
    deployments: {
      restarts,
      lastStatus: deploymentList[0]?.status ?? null,
      lastAt: deploymentList[0]?.started_at ?? null,
      lock,
    },
    errors,
  };
}

/** Policy view derived from the stored server row plus safety defaults. */
export function serverPolicyView(server: ServerRecord) {
  return {
    autoRestart: server.autoRestart,
    healthTimeoutMs: server.startupTimeoutS * 1000,
    healthyPatterns: ['connected to whatsapp', 'connection open', 'session restored', 'bot started'],
    failurePatterns: ['syntaxerror', 'cannot find module', 'unhandledpromiserejection', 'logged out', 'econnrefused'],
    ignore: server.excludedPaths,
    maxScanDepth: 10,
    maxScanFiles: 4000,
    indexContent: true,
  };
}

export function serverStateView(server: ServerRecord): string {
  if (!server.isActive) return 'DISABLED';
  switch (server.connectionState) {
    case 'connected':
      return 'CONNECTED';
    case 'unreachable':
      return 'UNREACHABLE';
    case 'failed':
    case 'error':
      return 'ERROR';
    case 'scanning':
      return 'SCANNING';
    default:
      return 'UNCONFIGURED';
  }
}

export async function countsFor(serverId: string): Promise<{ files: number; deployments: number; scans: number }> {
  const row = await queryOne<{ files: string | number; deployments: string | number; scans: string | number }>(
    `select
       (select count(*)::int from file_indexes where server_id = $1 and is_directory = false and deleted_at is null) as files,
       (select count(*)::int from deployments where server_id = $1) as deployments,
       (select count(*)::int from sync_history where server_id = $1) as scans`,
    [serverId],
  );
  return {
    files: Number(row?.files ?? 0),
    deployments: Number(row?.deployments ?? 0),
    scans: Number(row?.scans ?? 0),
  };
}

export async function latestScan(serverId: string) {
  return queryOne<{
    id: string;
    status: string;
    mode: string;
    files_scanned: number;
    files_added: number;
    files_changed: number;
    files_deleted: number;
    files_failed: number;
    message: string | null;
    started_at: string;
    finished_at: string | null;
  }>(
    `select id, status, mode, files_scanned, files_added, files_changed, files_deleted, files_failed, message,
            started_at, finished_at
       from sync_history where server_id = $1 order by started_at desc limit 1`,
    [serverId],
  );
}

export async function countConflicts(serverId: string): Promise<number> {
  const row = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from sync_conflicts where server_id = $1 and resolution is null`,
    [serverId],
  );
  return Number(row?.count ?? 0);
}

export async function countFiles(serverId: string): Promise<number> {
  const row = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from file_indexes where server_id = $1 and is_directory = false and deleted_at is null`,
    [serverId],
  );
  return Number(row?.count ?? 0);
}

export async function listIndexedFiles(serverId: string, limit = 500) {
  return query<{
    path: string;
    name: string;
    size_bytes: string | number;
    sha256: string | null;
    remote_modified_at: string | null;
    indexed_at: string;
  }>(
    `select path, name, size_bytes, sha256, remote_modified_at, indexed_at
       from file_indexes where server_id = $1 and is_directory = false and deleted_at is null
      order by path asc limit $2`,
    [serverId, limit],
  );
}
