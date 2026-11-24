import 'server-only';
import { query, queryOne } from '../db';
import type { ServerRecord } from '../servers/repo';
import { serverClient } from '../servers/repo';
import { baseName, isSecretPath, joinRemote, normalizeRemotePath } from '../security/paths';
import { editorLimitFor, readFileCached } from '../files/service';
import { summarizeJavaScript } from '../search/ast';
import { searchCode } from '../search/engine';
import { languageFor, secretKindFor } from '../views';
import { fetchLatestVersions, registryCheckEnabled } from '../explorer/registry';
import { listCases } from './cases';
import { refreshCommandMetadata, scanServer } from './discovery';
import {
  EXPLORER_CATEGORIES,
  analyseDependencies,
  bareModuleOf,
  classifyPath,
  configKeysOf,
  extensionOf,
  isConfigPath,
  deletionBlockReason,
  isDataRecord,
  isDatabasePath,
  isScriptFile,
  isSourceFile,
  parseStartupCommand,
  pluginNameOf,
  rankEntryCandidates,
  resolvePackageMainPath,
  resolveSpecifier,
  type ExplorerCategoryId,
} from '../explorer/classify';
import type {
  ExplorerCategorySummary,
  ExplorerCategoryView,
  ExplorerEntryView,
  ExplorerFileInfo,
  ExplorerItem,
  ExplorerOverview,
  ExplorerPackageView,
  ExplorerScanResult,
  ExplorerSearchResult,
  ExplorerWarning,
} from '../explorer/types';
import type { Principal } from '../auth/permissions';

interface IndexRow {
  path: string;
  name: string;
  parent_path: string;
  extension: string | null;
  is_directory: boolean;
  size_bytes: string | number;
  remote_modified_at: string | null;
  sha256: string | null;
  content_cached: boolean;
  is_secret: boolean;
  access_error: string | null;
}

interface SymbolRow {
  path: string;
  kind: string;
  name: string;
  aliases: unknown;
  line_start: number;
  line_end: number;
  signature: string | null;
}

export interface ImportEdge {
  from: string;
  to: string | null;
  specifier: string;
  line: number;
  external: boolean;
  bare: string | null;
}

interface ImportGraph {
  edges: ImportEdge[];
  outgoing: Map<string, ImportEdge[]>;
  incoming: Map<string, ImportEdge[]>;
  broken: ImportEdge[];
  scanned: number;
  skipped: number;
  external: Map<string, number>;
  builtAt: number;
}

// ---------------------------------------------------------------------------
// Small in-process caches: a page load must not re-download a 400 KB file or
// re-parse the whole project on every request.
// ---------------------------------------------------------------------------
const startupCache = new Map<string, { at: number; command: string | null; error: string | null }>();
const moduleCache = new Map<string, { at: number; modules: string[] | null }>();
const graphCache = new Map<string, ImportGraph>();

const STARTUP_TTL = 60_000;
const MODULES_TTL = 300_000;
const GRAPH_TTL = 60_000;
const GRAPH_MAX_FILES = 400;
const GRAPH_MAX_BYTES = 12 * 1024 * 1024;

export function invalidateExplorerCache(serverId: string): void {
  startupCache.delete(serverId);
  moduleCache.delete(serverId);
  graphCache.delete(serverId);
}

async function loadIndex(server: ServerRecord): Promise<IndexRow[]> {
  return query<IndexRow>(
    `select path, name, parent_path, extension, is_directory, size_bytes, remote_modified_at,
            sha256, content_cached, is_secret, access_error
       from file_indexes
      where server_id = $1 and deleted_at is null
      order by path asc
      limit 20000`,
    [server.id],
  );
}

async function loadPathSet(server: ServerRecord): Promise<Set<string>> {
  const rows = await query<{ path: string }>(
    `select path from file_indexes
      where server_id = $1 and is_directory = false and deleted_at is null
      limit 20000`,
    [server.id],
  );
  return new Set(rows.map((row) => row.path));
}

async function startupCommandFor(server: ServerRecord): Promise<{ command: string | null; error: string | null }> {
  const cached = startupCache.get(server.id);
  if (cached && Date.now() - cached.at < STARTUP_TTL) return cached;
  let result: { command: string | null; error: string | null };
  try {
    const client = await serverClient(server);
    const startup = await client.getStartup();
    result = { command: startup?.current_startup_command ?? null, error: null };
  } catch (error) {
    result = { command: null, error: error instanceof Error ? error.message : String(error) };
  }
  startupCache.set(server.id, { at: Date.now(), ...result });
  return result;
}

async function installedModulesFor(server: ServerRecord): Promise<string[] | null> {
  const cached = moduleCache.get(server.id);
  if (cached && Date.now() - cached.at < MODULES_TTL) return cached.modules;
  let modules: string[] | null = null;
  try {
    const client = await serverClient(server);
    const entries = await client.listFiles(joinRemote(server.projectRoot, 'node_modules'));
    modules = entries.filter((entry) => entry.is_file === false).map((entry) => entry.name);
    // Scoped packages live one level deeper: @scope/name.
    const scopes = entries.filter((entry) => entry.is_file === false && entry.name.startsWith('@'));
    for (const scope of scopes.slice(0, 40)) {
      try {
        const inner = await client.listFiles(joinRemote(server.projectRoot, 'node_modules', scope.name));
        for (const entry of inner) modules.push(`${scope.name}/${entry.name}`);
      } catch {
        /* an unreadable scope must not poison the list */
      }
    }
  } catch {
    modules = null;
  }
  moduleCache.set(server.id, { at: Date.now(), modules });
  return modules;
}

/** Parse the cached JavaScript into an import graph, bounded in time and memory. */
async function importGraphFor(server: ServerRecord, index?: IndexRow[]): Promise<ImportGraph> {
  const snapshotRow = await queryOne<{ last: string | null }>(
    'select max(fetched_at) as last from file_contents where server_id = $1',
    [server.id],
  );
  const key = `${server.id}:${snapshotRow?.last ?? 'empty'}`;
  const cached = graphCache.get(key);
  if (cached && Date.now() - cached.builtAt < GRAPH_TTL) return cached;

  const fileSet = index
    ? new Set(index.filter((row) => !row.is_directory).map((row) => row.path))
    : await loadPathSet(server);
  const rows = await query<{ path: string; content: string }>(
    `select path, content from file_contents
      where server_id = $1
        and (path like '%.js' or path like '%.cjs' or path like '%.mjs' or path like '%.ts' or path like '%.jsx' or path like '%.tsx')
      order by length(content) asc
      limit $2`,
    [server.id, GRAPH_MAX_FILES],
  );

  const edges: ImportEdge[] = [];
  const outgoing = new Map<string, ImportEdge[]>();
  const incoming = new Map<string, ImportEdge[]>();
  const broken: ImportEdge[] = [];
  const external = new Map<string, number>();
  let scanned = 0;
  let skipped = 0;
  let budget = GRAPH_MAX_BYTES;

  for (const row of rows) {
    if (row.content.length > budget) {
      skipped += 1;
      continue;
    }
    budget -= row.content.length;
    const summary = summarizeJavaScript(row.content);
    if (!summary.ok) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    for (const imported of summary.imports) {
      const bare = bareModuleOf(imported.source);
      const resolved = resolveSpecifier(row.path, imported.source, fileSet);
      const edge: ImportEdge = {
        from: row.path,
        to: resolved,
        specifier: imported.source,
        line: imported.line,
        external: Boolean(bare),
        bare,
      };
      edges.push(edge);
      const list = outgoing.get(row.path) ?? [];
      list.push(edge);
      outgoing.set(row.path, list);
      if (resolved) {
        const back = incoming.get(resolved) ?? [];
        back.push(edge);
        incoming.set(resolved, back);
      } else if (bare) {
        external.set(bare, (external.get(bare) ?? 0) + 1);
      } else if (imported.source.startsWith('.')) {
        broken.push(edge);
      }
    }
  }

  const graph: ImportGraph = { edges, outgoing, incoming, broken, scanned, skipped, external, builtAt: Date.now() };
  // One graph per snapshot is enough; drop this server's older graphs.
  for (const existing of [...graphCache.keys()]) {
    if (existing.startsWith(`${server.id}:`) && existing !== key) graphCache.delete(existing);
  }
  graphCache.set(key, graph);
  return graph;
}

async function readPackageJson(
  server: ServerRecord,
  index: IndexRow[],
): Promise<{ path: string; raw: string; parsed: Record<string, unknown> } | null> {
  const candidates = index
    .filter((row) => !row.is_directory && row.name === 'package.json')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  const rootCandidate = candidates.find((row) => row.parent_path === normalizeRemotePath(server.projectRoot));
  const chosen = rootCandidate ?? candidates[0];
  if (!chosen) return null;

  let raw: string | null = null;
  const cachedRow = await queryOne<{ content: string }>(
    'select content from file_contents where server_id = $1 and path = $2',
    [server.id, chosen.path],
  );
  if (cachedRow?.content) raw = cachedRow.content;
  if (raw === null) {
    try {
      raw = (await readFileCached(server, chosen.path)).content;
    } catch {
      return null;
    }
  }
  try {
    return { path: chosen.path, raw, parsed: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { path: chosen.path, raw, parsed: {} };
  }
}

async function packageView(
  pkg: { path: string; raw: string; parsed: Record<string, unknown> } | null,
  graph: ImportGraph,
  installed: string[] | null,
): Promise<ExplorerPackageView> {
  if (!pkg) {
    return {
      path: null,
      name: null,
      version: null,
      main: null,
      scripts: [],
      dependencies: [],
      problems: [{ code: 'no_package_json', message: 'No package.json exists in this project, so dependencies cannot be verified.' }],
      installedCheck: 'unavailable',
      note: 'The panel filesystem was scanned; no package.json was found.',
    };
  }
  const dependencies = (pkg.parsed.dependencies as Record<string, string> | undefined) ?? {};
  const devDependencies = (pkg.parsed.devDependencies as Record<string, string> | undefined) ?? {};
  const scripts = (pkg.parsed.scripts as Record<string, string> | undefined) ?? {};
  const imported = [...graph.external.keys()];

  /**
   * Freshness is opt-in: `DARKNOTE_NPM_REGISTRY_CHECK=1`. Without it no request
   * leaves the server and every `latest` stays null (reported as unknown, never
   * as a guess).
   */
  let latest: Record<string, string> | null = null;
  let registryNote: string | null = null;
  if (registryCheckEnabled()) {
    const names = [...Object.keys(dependencies), ...Object.keys(devDependencies)];
    const checked = await fetchLatestVersions(names);
    latest = {};
    const failures: string[] = [];
    for (const [name, value] of checked) {
      if (value.latest) latest[name] = value.latest;
      else if (value.error) failures.push(`${name}: ${value.error}`);
    }
    if (failures.length) registryNote = `Registry lookups failed for ${failures.length} package(s): ${failures.slice(0, 3).join('; ')}.`;
  }

  const analysis = analyseDependencies({
    dependencies,
    devDependencies,
    imported,
    installedModules: installed,
    latest,
  });

  const problems = [...analysis.problems];
  if (!Object.keys(scripts).length) {
    problems.push({ code: 'no_scripts', message: 'package.json declares no scripts, so the panel cannot use npm start.' });
  }
  const main = typeof pkg.parsed.main === 'string' ? pkg.parsed.main : null;
  return {
    path: pkg.path,
    name: typeof pkg.parsed.name === 'string' ? pkg.parsed.name : null,
    version: typeof pkg.parsed.version === 'string' ? pkg.parsed.version : null,
    main,
    scripts: Object.entries(scripts).map(([name, command]) => ({ name, command: String(command) })),
    dependencies: analysis.entries,
    problems,
    installedCheck: installed ? 'checked' : 'unavailable',
    note: [
      installed
        ? 'Versions are the declared ranges. "Missing" means the folder is absent from node_modules.'
        : 'node_modules could not be listed (missing folder or no file.read permission), so installed state is unverified. Declared ranges are still shown.',
      registryCheckEnabled()
        ? 'Published versions were checked against the declared ranges; "outdated" means the latest release falls outside them.'
        : 'Published versions are not checked: set DARKNOTE_NPM_REGISTRY_CHECK=1 to compare declared ranges with the npm registry.',
      registryNote,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function groupByPath<T extends { path: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.path) ?? [];
    list.push(row);
    map.set(row.path, list);
  }
  return map;
}

async function symbolRows(serverId: string, kinds: string[], limit = 4000): Promise<SymbolRow[]> {
  return query<SymbolRow>(
    `select path, kind, name, aliases, line_start, line_end, signature
       from command_metadata
      where server_id = $1 and kind = any($2::text[])
      order by path asc, line_start asc
      limit $3`,
    [serverId, kinds, limit],
  );
}

function aliasList(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
export async function explorerOverview(server: ServerRecord): Promise<ExplorerOverview> {
  const index = await loadIndex(server);
  const [graph, startup, pkg, symbolCounts, lastSync] = await Promise.all([
    importGraphFor(server, index),
    startupCommandFor(server),
    readPackageJson(server, index),
    queryOne<{ cases: string | number; functions: string | number }>(
      `select
         (select count(*)::int from command_metadata where server_id = $1 and kind = 'case') as cases,
         (select count(*)::int from command_metadata where server_id = $1 and kind = 'function') as functions`,
      [server.id],
    ),
    queryOne<{
      status: string;
      started_at: string;
      finished_at: string | null;
      files_added: string | number;
      files_changed: string | number;
      files_deleted: string | number;
      files_failed: string | number;
      message: string | null;
      duration_ms: string | number | null;
    }>(
      `select status, started_at, finished_at, files_added, files_changed, files_deleted, files_failed, message,
              (extract(epoch from (finished_at - started_at)) * 1000)::bigint as duration_ms
         from sync_history where server_id = $1 order by started_at desc limit 1`,
      [server.id],
    ),
  ]);

  const files = index.filter((row) => !row.is_directory);
  const folders = index.filter((row) => row.is_directory);
  const indexedAt = files.reduce<string | null>((latest, row) => {
    const value = row.remote_modified_at;
    if (!value) return latest;
    if (!latest) return value;
    return value > latest ? value : latest;
  }, server.lastScanAt ?? null);

  const entry = entryView(server, files, graph, startup, pkg);
  const installed = await installedModulesFor(server);
  const packageInformation = await packageView(pkg, graph, installed);

  const plugins = pluginGroups(files);
  const configFiles = files.filter((row) => isConfigPath(row.path) && !row.is_secret);
  const dataFiles = files.filter((row) => isDatabasePath(row.path));
  const caseRows = await listCases(server.id, { limit: 1200 });
  const functionRows = await symbolRows(server.id, ['function'], 6000);

  const summaries: ExplorerCategorySummary[] = EXPLORER_CATEGORIES.map((definition) => {
    switch (definition.id) {
      case 'plugins':
        return {
          ...definition,
          count: plugins.length,
          samples: plugins.slice(0, 4).map((plugin) => plugin.name),
          available: plugins.length > 0,
        };
      case 'package':
        return {
          ...definition,
          count: packageInformation.dependencies.length,
          samples: packageInformation.dependencies.slice(0, 4).map((dep) => `${dep.name}@${dep.range}`),
          available: Boolean(packageInformation.path),
        };
      case 'entry':
        return {
          ...definition,
          count: entry.path ? 1 : 0,
          samples: entry.path ? [entry.path] : [],
          available: Boolean(entry.path),
        };
      case 'cases': {
        const byFile = groupByPath(caseRows);
        return {
          ...definition,
          count: caseRows.length,
          samples: [...byFile.keys()].slice(0, 4),
          available: caseRows.length > 0,
        };
      }
      case 'functions': {
        const byFile = groupByPath(functionRows);
        return {
          ...definition,
          count: functionRows.length,
          samples: [...byFile.keys()].slice(0, 4),
          available: functionRows.length > 0,
        };
      }
      case 'config':
        return {
          ...definition,
          count: configFiles.length,
          samples: configFiles.slice(0, 4).map((row) => row.path),
          available: configFiles.length > 0,
        };
      case 'database':
        return {
          ...definition,
          count: dataFiles.length,
          samples: dataFiles.slice(0, 4).map((row) => row.path),
          available: dataFiles.length > 0,
        };
      default:
        return { ...definition, count: 0, samples: [], available: false };
    }
  });

  const freshness = await queryOne<{ last_written: string | null; last_indexed: string | null }>(
    `select
       (select max(created_at) from file_versions where server_id = $1) as last_written,
       (select max(indexed_at) from file_indexes where server_id = $1) as last_indexed`,
    [server.id],
  );

  const warnings: ExplorerWarning[] = [];
  if (freshness?.last_written && freshness?.last_indexed && freshness.last_written > freshness.last_indexed) {
    warnings.push({
      code: 'index_stale',
      message:
        'A file was written after the last index update (upload or deploy). Rescan to make the explorer match production again.',
    });
  }
  if (!files.length) {
    warnings.push({
      code: 'index_empty',
      message: 'Nothing is indexed yet. Run “Scan project” to walk the real filesystem through the Pterodactyl API.',
    });
  }
  if (startup.error) {
    warnings.push({ code: 'startup_unavailable', message: `The panel startup command could not be read: ${startup.error}` });
  }
  if (files.length && !packageInformation.path) {
    warnings.push({ code: 'no_package_json', message: 'No package.json was found in the indexed project.' });
  }
  if (entry.path && entry.startupCommand && entry.startupFileMissing) {
    warnings.push({
      code: 'entry_missing',
      message: `The startup command names ${entry.startupFileMissing}, which is not in the project. The bot would fail to start.`,
    });
  }
  if (graph.broken.length) {
    warnings.push({
      code: 'broken_references',
      message: `${graph.broken.length} relative import${graph.broken.length === 1 ? '' : 's'} point at files that do not exist (first: ${graph.broken[0].from} → ${graph.broken[0].specifier}).`,
    });
  }
  if (graph.skipped) {
    warnings.push({
      code: 'import_scan_partial',
      message: `The import graph skipped ${graph.skipped} file${graph.skipped === 1 ? '' : 's'} (too large or unparseable), so relationships are partial.`,
    });
  }
  const failed = files.filter((row) => row.access_error);
  if (failed.length) {
    warnings.push({ code: 'read_failures', message: `${failed.length} files could not be read during the scan (first: ${failed[0].path}).`, path: failed[0].path });
  }

  return {
    server: { id: server.id, name: server.name, root: server.projectRoot },
    index: {
      files: files.length,
      folders: folders.length,
      withContent: files.filter((row) => row.content_cached).length,
      caseCount: Number(symbolCounts?.cases ?? 0),
      functionCount: Number(symbolCounts?.functions ?? 0),
      indexedAt,
    },
    lastScan: lastSync
      ? {
          at: lastSync.finished_at ?? lastSync.started_at,
          status: lastSync.status,
          added: Number(lastSync.files_added ?? 0),
          changed: Number(lastSync.files_changed ?? 0),
          deleted: Number(lastSync.files_deleted ?? 0),
          failed: Number(lastSync.files_failed ?? 0),
          message: lastSync.message,
          durationMs: lastSync.duration_ms === null ? null : Number(lastSync.duration_ms),
        }
      : null,
    categories: summaries,
    entry,
    package: packageInformation,
    warnings,
    capabilities: { canWrite: true, canDelete: true, canDeploy: true },
  };
}

interface EntryView extends ExplorerEntryView {
  startupFileMissing?: string;
}

function entryView(
  server: ServerRecord,
  files: IndexRow[],
  graph: ImportGraph,
  startup: { command: string | null; error: string | null },
  pkg: { parsed: Record<string, unknown> } | null,
): EntryView {
  const incomingCount: Record<string, number> = {};
  for (const [path, list] of graph.incoming) incomingCount[path] = list.length;
  const parsed = parseStartupCommand(startup.command);
  const packageDir = pkg && typeof (pkg as { path?: string }).path === 'string'
    ? normalizeRemotePath(String((pkg as { path?: string }).path!)).split('/').slice(0, -1).join('/')
    : '';
  const rawMain = typeof pkg?.parsed.main === 'string' ? (pkg.parsed.main as string) : null;
  const packageMain = rawMain
    ? rawMain.startsWith('/') || rawMain.startsWith('.')
      ? rawMain
      : `${packageDir}/${rawMain}`.replace(/\/+/g, '/')
    : null;
  const detection = rankEntryCandidates({
    files: files.map((row) => row.path),
    startupCommand: startup.command,
    packageMain,
    packageScripts: (pkg?.parsed.scripts as Record<string, string> | undefined) ?? {},
    incomingCount,
  });
  const startupFileMissing =
    parsed.file && !files.some((row) => row.path === normalizeRemotePath(parsed.file!))
      ? normalizeRemotePath(parsed.file)
      : undefined;
  void server;
  return {
    path: detection.path,
    evidence: detection.evidence,
    startupCommand: startup.command,
    runtime: detection.runtime,
    note: detection.note,
    candidates: detection.candidates.slice(0, 8),
    verified: Boolean(detection.path),
    startupFileMissing,
  };
}

/**
 * Entry point without the import graph: the discovery page needs an answer
 * without paying for a full parse. Same ranking rules as the explorer.
 */
export async function detectEntryPoint(server: ServerRecord): Promise<{
  path: string | null;
  evidence: string;
  startupCommand: string | null;
  note: string | null;
  runtime: string | null;
  packagePath: string | null;
}> {
  const [rows, startup] = await Promise.all([loadIndex(server), startupCommandFor(server)]);
  const paths = rows.filter((row) => !row.is_directory).map((row) => row.path);
  const pkg = await readPackageJson(server, rows);
  const scripts = (pkg?.parsed.scripts as Record<string, string> | undefined) ?? {};
  const detection = rankEntryCandidates({
    files: [...paths],
    startupCommand: startup.command,
    packageMain: resolvePackageMainPath(pkg?.path, typeof pkg?.parsed.main === 'string' ? (pkg.parsed.main as string) : null),
    packageScripts: scripts,
  });
  return {
    path: detection.path,
    evidence: detection.evidence,
    startupCommand: startup.command,
    note: detection.note,
    runtime: detection.runtime,
    packagePath: pkg?.path ?? null,
  };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------
interface PluginGroup {
  name: string;
  root: string;
  files: string[];
  sizeBytes: number;
  commands: string[];
  functions: number;
  importedBy: string[];
  externalPackages: string[];
}

function pluginGroups(files: IndexRow[]): PluginGroup[] {
  const groups = new Map<string, PluginGroup>();
  for (const row of files) {
    const plugin = pluginNameOf(row.path);
    if (!plugin) continue;
    const key = plugin.root.startsWith('/') && row.path.startsWith(`${plugin.root}/`) ? plugin.root : plugin.name;
    const group =
      groups.get(key) ??
      ({
        name: plugin.name,
        root: plugin.root,
        files: [],
        sizeBytes: 0,
        commands: [],
        functions: 0,
        importedBy: [],
        externalPackages: [],
      } satisfies PluginGroup);
    group.files.push(row.path);
    group.sizeBytes += Number(row.size_bytes ?? 0);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Category views
// ---------------------------------------------------------------------------
export async function explorerCategory(
  server: ServerRecord,
  id: ExplorerCategoryId,
  options: { q?: string; limit?: number; offset?: number } = {},
): Promise<ExplorerCategoryView> {
  const definition = EXPLORER_CATEGORIES.find((category) => category.id === id);
  if (!definition) throw new Error(`Unknown category ${id}`);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 1000);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  /** Slice one page and keep the real total so the UI can page without re-counting. */
  const page = (all: ExplorerItem[]) => ({
    items: all.slice(offset, offset + limit),
    total: all.length,
    truncated: offset + limit < all.length,
    offset,
  });
  const search = (options.q ?? '').trim().toLowerCase();
  const index = await loadIndex(server);
  const files = index.filter((row) => !row.is_directory);
  const notes: string[] = [];

  if (id === 'package') {
    const [graph, pkg] = await Promise.all([importGraphFor(server, index), readPackageJson(server, index)]);
    const installed = await installedModulesFor(server);
    const view = await packageView(pkg, graph, installed);
    const items: ExplorerItem[] = [
      ...view.scripts.map((script) => ({
        id: `script:${script.name}`,
        type: 'entry' as const,
        name: `npm run ${script.name}`,
        subtitle: script.command,
        detail: 'package.json script',
        path: view.path ?? undefined,
        badges: ['script'],
      })),
      ...view.dependencies.map((dep) => ({
        id: `dep:${dep.name}`,
        type: 'entry' as const,
        name: dep.name,
        subtitle: dep.range,
        detail: `${dep.kind === 'dependency' ? 'dependency' : 'devDependency'} · imported ${dep.imported ? 'yes' : 'no'} · installed ${dep.installed}${
          dep.latest ? ` · latest ${dep.latest}` : ''
        }`,
        path: view.path ?? undefined,
        badges: [dep.status],
        protected: false,
        editable: false,
      })),
    ].filter((item) => !search || `${item.name} ${item.subtitle ?? ''}`.toLowerCase().includes(search));

    notes.push(view.note ?? '');
    for (const problem of view.problems) notes.push(problem.message);
    return {
      ...definition,
      ...page(items),
      notes: notes.filter(Boolean),
    };
  }

  if (id === 'entry') {
    const [graph, startup, pkg] = await Promise.all([
      importGraphFor(server, index),
      startupCommandFor(server),
      readPackageJson(server, index),
    ]);
    const view = entryView(server, files, graph, startup, pkg);
    const items: ExplorerItem[] = view.candidates.map((candidate) => {
      const row = files.find((file) => file.path === candidate.path);
      return {
        id: `entry:${candidate.path}`,
        type: 'entry',
        name: baseName(candidate.path),
        path: candidate.path,
        subtitle: candidate.evidence,
        detail: `score ${candidate.score}${view.path === candidate.path ? ' · selected' : ''}`,
        sizeBytes: Number(row?.size_bytes ?? 0),
        modifiedAt: row?.remote_modified_at ?? null,
        badges: view.path === candidate.path ? ['entry point'] : ['candidate'],
        editable: true,
      };
    });
    if (view.startupCommand) notes.push(`Panel startup: ${view.startupCommand}`);
    if (view.note) notes.push(view.note);
    if (startup.error) notes.push(`Startup command unavailable: ${startup.error}`);
    return { ...definition, ...page(items), notes };
  }

  if (id === 'plugins') {
    const groups = pluginGroups(files);
    const [graph, caseRows, functionRows] = await Promise.all([
      importGraphFor(server, index),
      listCases(server.id, { limit: 1500 }),
      symbolRows(server.id, ['function'], 6000),
    ]);
    const commandsByFile = new Map<string, string[]>();
    for (const row of caseRows) {
      const list = commandsByFile.get(row.path) ?? [];
      list.push(row.name);
      commandsByFile.set(row.path, list);
    }
    const items: ExplorerItem[] = groups
      .filter((group) => !search || group.name.toLowerCase().includes(search) || group.files.some((file) => file.toLowerCase().includes(search)))
      .map((group) => {
        const singleFile = !files.some((row) => row.path.startsWith(`${group.root}/`));
        const commands = group.files.flatMap((file) => commandsByFile.get(file) ?? []);
        const functions = functionRows.filter((row) => group.files.includes(row.path));
        const importedBy = [...new Set(group.files.flatMap((file) => (graph.incoming.get(file) ?? []).map((edge) => edge.from)))];
        const externalPackages = [
          ...new Set(
            group.files.flatMap((file) =>
              (graph.outgoing.get(file) ?? []).filter((edge) => edge.bare).map((edge) => edge.bare as string),
            ),
          ),
        ];
        const detailParts = [
          `${commands.length} command${commands.length === 1 ? '' : 's'}`,
          `${functions.length} function${functions.length === 1 ? '' : 's'}`,
          externalPackages.length ? `uses ${externalPackages.slice(0, 4).join(', ')}` : null,
          importedBy.length ? `loaded by ${importedBy.slice(0, 3).join(', ')}` : 'not imported by any other file',
        ].filter(Boolean) as string[];
        return {
          id: `plugin:${group.root}`,
          type: 'plugin' as const,
          name: group.name,
          path: singleFile ? group.root : undefined,
          subtitle: singleFile ? `single-file plugin · ${group.root}` : `${group.files.length} files · ${group.root}`,
          detail: detailParts.join(' · '),
          sizeBytes: group.sizeBytes,
          count: group.files.length,
          badges: [singleFile ? 'file' : 'folder', ...(importedBy.length ? [] : ['unreferenced'])],
          editable: true,
          children: group.files.slice(0, 24).map((file) => ({
            path: file,
            name: baseName(file),
            detail: (commandsByFile.get(file) ?? []).slice(0, 4).join(', ') || undefined,
          })),
        } satisfies ExplorerItem;
      });
    notes.push(
      'Plugins are found by structure, not by a fixed folder name: any file inside a plugins/modules/extensions/commands-style folder is grouped by its own directory, and single-file plugins are detected too.',
    );
    if (!groups.length) {
      notes.push('No plugin-shaped directory exists in the index. Files required by the entry point still appear under Cases and Functions.');
    }
    return { ...definition, ...page(items), notes };
  }

  if (id === 'cases') {
    const rows = await listCases(server.id, { search: search || undefined, limit: 1500 });
    const byFile = groupByPath(rows);
    const items: ExplorerItem[] = [...byFile.entries()].map(([path, list]) => ({
      id: `cases:${path}`,
      type: 'case-group',
      name: baseName(path),
      path,
      subtitle: path,
      count: list.length,
      detail: `${list.length} case${list.length === 1 ? '' : 's'}`,
      badges: list.length > 20 ? ['large file'] : [],
      editable: true,
      children: list.slice(0, 40).map((row) => ({ path, name: row.name, line: row.lineStart, detail: `line ${row.lineStart}${row.aliases.length ? ` · aliases: ${row.aliases.join(', ')}` : ''}` })),
    }));
    const parsedPaths = new Set(rows.map((row) => row.path));
    const candidates = files.filter(
      (row) => isScriptFile(row.path) && /(case|command|handler|cmd)/i.test(row.path) && !parsedPaths.has(row.path),
    );
    for (const row of candidates.slice(0, 40)) {
      items.push({
        id: `cases-unparsed:${row.path}`,
        type: 'case-group',
        name: baseName(row.path),
        path: row.path,
        subtitle: row.path,
        detail: 'no parsed cases — open the file to inspect it',
        badges: ['unparsed'],
        editable: true,
      });
    }
    notes.push('Cases come from an AST walk of every parsed JavaScript file, so a case in any directory is found — not only the ones in a known commands folder.');
    if (!rows.length) notes.push('No case was parsed. Run a scan; files that fail to parse are listed as unparsed instead of being silently skipped.');
    return { ...definition, ...page(items), notes };
  }

  if (id === 'functions') {
    const rows = await symbolRows(server.id, ['function'], 6000);
    const filtered = search ? rows.filter((row) => row.name.toLowerCase().includes(search) || row.path.toLowerCase().includes(search)) : rows;
    const byFile = groupByPath(filtered);
    const items: ExplorerItem[] = [...byFile.entries()].map(([path, list]) => ({
      id: `functions:${path}`,
      type: 'function-group',
      name: baseName(path),
      path,
      subtitle: path,
      count: list.length,
      detail: `${list.length} function${list.length === 1 ? '' : 's'}`,
      editable: true,
      children: list.slice(0, 40).map((row) => ({ path, name: row.name, line: row.line_start, detail: row.signature ?? undefined })),
    }));
    notes.push('Functions and helpers are listed per file with their exact line, including arrow constants and class methods.');
    return { ...definition, ...page(items), notes };
  }

  if (id === 'config') {
    const configRows = files.filter((row) => isConfigPath(row.path));
    const secretRows = configRows.filter((row) => row.is_secret);
    const editableRows = configRows.filter((row) => !row.is_secret);
    const contents = await query<{ path: string; content: string }>(
      `select path, content from file_contents where server_id = $1 and path = any($2::text[])`,
      [server.id, editableRows.map((row) => row.path).slice(0, 200)],
    );
    const contentByPath = new Map(contents.map((row) => [row.path, row.content]));
    const items: ExplorerItem[] = editableRows
      .filter((row) => !search || row.path.toLowerCase().includes(search))
      .slice(0, limit)
      .map((row) => {
        const content = contentByPath.get(row.path);
        const keys = content ? configKeysOf(row.path, content) : [];
        return {
          id: `config:${row.path}`,
          type: 'config' as const,
          name: baseName(row.path),
          path: row.path,
          subtitle: row.path,
          detail: keys.length ? `${keys.length} keys: ${keys.slice(0, 8).join(', ')}` : content ? 'no keys detected' : 'not indexed yet — run a scan to read its keys',
          sizeBytes: Number(row.size_bytes ?? 0),
          modifiedAt: row.remote_modified_at,
          badges: keys.length ? ['keys'] : [],
          editable: true,
        } satisfies ExplorerItem;
      });
    for (const row of secretRows.slice(0, 20)) {
      items.push({
        id: `config-secret:${row.path}`,
        type: 'config',
        name: baseName(row.path),
        path: row.path,
        subtitle: row.path,
        detail: `${secretKindFor(row.path) ?? 'credential file'} — content is never read, shown or searched`,
        sizeBytes: Number(row.size_bytes ?? 0),
        protected: true,
        editable: false,
        badges: ['protected'],
      });
    }
    notes.push('Only file names and key names are shown. Values of credential files are never read by the explorer, and .env files are excluded entirely.');
    return { ...definition, ...page(items), notes };
  }

  // database
  const dataRows = files.filter((row) => isDatabasePath(row.path));
  const items: ExplorerItem[] = dataRows
    .filter((row) => !search || row.path.toLowerCase().includes(search))
    .slice(0, limit)
    .map((row) => {
      const record = isDataRecord(row.path);
      const kind = /\.sql$/i.test(row.path)
        ? 'schema'
        : /\.prisma$/i.test(row.path)
          ? 'schema'
          : /\.(sqlite3?|db)$/i.test(row.path)
            ? 'database file'
            : /model/i.test(row.path)
              ? 'model'
              : /(db|database|datasource|sequelize|mongoose)/i.test(baseName(row.path))
                ? 'connection'
                : 'storage';
      return {
        id: `data:${row.path}`,
        type: 'data' as const,
        name: baseName(row.path),
        path: row.path,
        subtitle: `${kind} · ${row.path}`,
        detail: record ? 'production records — download only, editing and deletion are refused' : 'source file',
        sizeBytes: Number(row.size_bytes ?? 0),
        modifiedAt: row.remote_modified_at,
        protected: record,
        editable: !record && isSourceFile(row.path),
        badges: [kind, ...(record ? ['protected'] : [])],
      } satisfies ExplorerItem;
    });
  notes.push('Schema, model and connection files are source and can be edited. Database files and JSON/CSV records inside data folders are marked protected and cannot be edited or deleted here.');
  return { ...definition, ...page(items), notes };
}

// ---------------------------------------------------------------------------
// File information + relationships
// ---------------------------------------------------------------------------
export async function explorerFileInfo(server: ServerRecord, requestedPath: string): Promise<ExplorerFileInfo> {
  const path = normalizeRemotePath(requestedPath);
  const row = await queryOne<IndexRow>(
    `select path, name, parent_path, extension, is_directory, size_bytes, remote_modified_at,
            sha256, content_cached, is_secret, access_error
       from file_indexes where server_id = $1 and path = $2 and deleted_at is null`,
    [server.id, path],
  );
  const graph = await importGraphFor(server);

  const symbols = await query<SymbolRow>(
    `select path, kind, name, aliases, line_start, line_end, signature
       from command_metadata where server_id = $1 and path = $2 order by line_start asc limit 500`,
    [server.id, path],
  );

  const draft = await queryOne<{ id: string; bytes: number; updated_at: string; status: string }>(
    `select id, coalesce(expected_bytes, 0)::int as bytes, updated_at, status from editor_drafts
      where server_id = $1 and path = $2 and status in ('draft','conflict') limit 1`,
    [server.id, path],
  ).catch(() => null);

  const versionCount = await queryOne<{ count: string | number }>(
    'select count(*)::int as count from file_versions where server_id = $1 and path = $2',
    [server.id, path],
  );
  const latestVersion = await queryOne<{ version: number; created_at: string; change_note: string | null }>(
    'select version, created_at, change_note from file_versions where server_id = $1 and path = $2 order by version desc limit 1',
    [server.id, path],
  );

  const outgoing = graph.outgoing.get(path) ?? [];
  const incoming = graph.incoming.get(path) ?? [];
  const categories = classifyPath(path);
  const secret = isSecretPath(path);
  const record = isDataRecord(path);
  const notes: string[] = [];

  if (!row) notes.push('This path is not in the file index yet; run a scan to add it.');
  if (secret) notes.push('This path holds credentials. Content is not read by the explorer, and the editor refuses it too.');
  if (record) notes.push('This file holds production records. It can be downloaded but not edited or deleted from the explorer.');
  if (row?.access_error) notes.push(`The last scan could not read this file: ${row.access_error}`);
  if (graph.skipped) notes.push(`${graph.skipped} files were skipped when building the import graph, so "imported by" may be incomplete.`);

  const parent = normalizeRemotePath(path).split('/').slice(0, -1).join('/') || '/';
  const siblingRows = await query<IndexRow>(
    `select path, name, parent_path, extension, is_directory, size_bytes, remote_modified_at,
            sha256, content_cached, is_secret, access_error
       from file_indexes
      where server_id = $1 and parent_path = $2 and path <> $3 and deleted_at is null
      order by is_directory desc, name asc limit 40`,
    [server.id, parent, path],
  );
  const siblings = siblingRows.map((entry) => ({
    path: entry.path,
    name: entry.name,
    isDirectory: entry.is_directory,
    sizeBytes: Number(entry.size_bytes ?? 0),
  }));

  return {
    path,
    name: baseName(path),
    extension: extensionOf(path),
    language: languageFor(path),
    isDirectory: Boolean(row?.is_directory),
    sizeBytes: Number(row?.size_bytes ?? 0),
    modifiedAt: row?.remote_modified_at ?? null,
    sha256: row?.sha256 ?? null,
    indexedSha: row?.sha256 ?? null,
    contentCached: Boolean(row?.content_cached),
    secret,
    secretKind: secretKindFor(path),
    editable: Boolean(!secret && !record && row && !row.is_directory),
    deletable: Boolean(
      !secret &&
        !record &&
        !deletionBlockReason(path, Boolean(row?.is_directory)) &&
        path !== normalizeRemotePath(server.projectRoot),
    ),
    protectedData: record,
    categories,
    draft: draft ? { id: draft.id, bytes: Number(draft.bytes ?? 0), updatedAt: draft.updated_at, status: draft.status } : null,
    versions: {
      count: Number(versionCount?.count ?? 0),
      latest: latestVersion ? { version: Number(latestVersion.version), createdAt: latestVersion.created_at, note: latestVersion.change_note } : null,
    },
    symbols: {
      cases: symbols
        .filter((symbol) => symbol.kind === 'case')
        .map((symbol) => ({ name: symbol.name, line: Number(symbol.line_start), aliases: aliasList(symbol.aliases) })),
      functions: symbols
        .filter((symbol) => symbol.kind === 'function')
        .map((symbol) => ({ name: symbol.name, line: Number(symbol.line_start), signature: symbol.signature })),
    },
    imports: outgoing.map((edge) => ({
      specifier: edge.specifier,
      line: edge.line,
      resolvedPath: edge.to,
      external: edge.external,
      bare: edge.bare,
    })),
    importedBy: incoming.map((edge) => ({ path: edge.from, line: edge.line, specifier: edge.specifier })),
    brokenReferences: outgoing.filter((edge) => !edge.to && !edge.external && edge.specifier.startsWith('.')).map((edge) => edge.specifier),
    siblings,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
export async function explorerSearch(
  server: ServerRecord,
  rawQuery: string,
  options: { limit?: number } = {},
): Promise<ExplorerSearchResult> {
  const queryText = rawQuery.trim();
  const limit = Math.min(options.limit ?? 300, 600);
  if (!queryText) {
    return { query: '', symbols: [], files: [], names: [], totalMatches: 0, truncated: false, notes: ['Type a plugin, command, case, function, file or code snippet.'], snapshotAt: null };
  }

  const [symbolHits, nameHits, textResult] = await Promise.all([
    query<SymbolRow>(
      `select path, kind, name, aliases, line_start, line_end, signature
         from command_metadata
        where server_id = $1 and kind in ('case','function') and lower(name) like $2
        order by case when lower(name) = $3 then 0 else 1 end, length(name) asc
        limit 60`,
      [server.id, `%${queryText.toLowerCase()}%`, queryText.toLowerCase()],
    ),
    query<{ path: string; name: string; is_directory: boolean }>(
      `select path, name, is_directory from file_indexes
        where server_id = $1 and deleted_at is null and lower(name) like $2
        order by length(name) asc limit 40`,
      [server.id, `%${queryText.toLowerCase()}%`],
    ),
    searchCode({ serverId: server.id, query: queryText, mode: 'text', maxResults: limit }),
  ]);

  const files = new Map<string, { path: string; name: string; matches: number; hits: ExplorerSearchResult['files'][number]['hits'] }>();
  for (const hit of textResult.hits) {
    const entry =
      files.get(hit.path) ??
      { path: hit.path, name: hit.fileName, matches: 0, hits: [] as ExplorerSearchResult['files'][number]['hits'] };
    entry.matches += 1;
    if (entry.hits.length < 6) {
      entry.hits.push({ line: hit.line, column: hit.column, text: hit.lineText, before: hit.before, after: hit.after });
    }
    files.set(hit.path, entry);
  }

  const coverage = await queryOne<{ uncached: string | number }>(
    `select count(*)::int as uncached from file_indexes
      where server_id = $1 and deleted_at is null and is_directory = false and content_cached = false`,
    [server.id],
  );
  const notes: string[] = [];
  const uncached = Number(coverage?.uncached ?? 0);
  if (uncached > 0) {
    notes.push(
      `${uncached} indexed file${uncached === 1 ? '' : 's'} could not be searched (binary, over the size limit, secret or unreadable).`,
    );
  }
  if (!textResult.hits.length && !symbolHits.length && !nameHits.length) {
    notes.push('Nothing matched. The search runs over indexed files; run a scan if the project changed.');
  }
  if (textResult.truncated) notes.push(`Results were capped at ${limit} matches.`);
  if (textResult.notes.length) notes.push(...textResult.notes);

  return {
    query: queryText,
    symbols: symbolHits.map((symbol) => ({
      path: symbol.path,
      name: symbol.name,
      kind: symbol.kind,
      line: Number(symbol.line_start),
      detail: symbol.signature ?? (aliasList(symbol.aliases).length ? `aliases: ${aliasList(symbol.aliases).join(', ')}` : undefined),
    })),
    files: [...files.values()].sort((a, b) => b.matches - a.matches),
    names: nameHits.map((row) => ({ path: row.path, name: row.name, isDirectory: row.is_directory })),
    totalMatches: textResult.totalMatches + symbolHits.length + nameHits.length,
    truncated: textResult.truncated,
    notes,
    snapshotAt: textResult.snapshotAt,
  };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
export async function scanProject(server: ServerRecord, user: Principal): Promise<ExplorerScanResult> {
  const startedAt = new Date().toISOString();
  const result = await scanServer({ server, user, mode: 'manual', deep: true });
  await refreshCommandMetadata(server.id, [], { limit: 1500 });
  // Report what the index now holds, not the size of the last insert batch.
  const metadata = await queryOne<{ cases: string | number; functions: string | number }>(
    `select
       (select count(*)::int from command_metadata where server_id = $1 and kind = 'case') as cases,
       (select count(*)::int from command_metadata where server_id = $1 and kind = 'function') as functions`,
    [server.id],
  );

  // Pair deletions with additions that share a hash: that is a rename or a move.
  const events = await query<{ path: string; kind: string; detail: Record<string, unknown> | null }>(
    `select path, kind, detail from update_events
      where server_id = $1 and detected_at >= $2::timestamptz and kind in ('added','deleted')
      order by detected_at asc`,
    [server.id, startedAt],
  );
  const added = events.filter((event) => event.kind === 'added').map((event) => event.path);
  const deletedEvents = events.filter((event) => event.kind === 'deleted');
  const byHash = new Map<string, string[]>();
  for (const event of deletedEvents) {
    const hash = typeof event.detail?.sha256 === 'string' ? (event.detail.sha256 as string) : null;
    if (!hash) continue;
    const list = byHash.get(hash) ?? [];
    list.push(event.path);
    byHash.set(hash, list);
  }
  const renamed: Array<{ from: string; to: string }> = [];
  const consumed = new Set<string>();
  for (const path of added) {
    const row = await queryOne<{ sha256: string | null }>(
      'select sha256 from file_indexes where server_id = $1 and path = $2',
      [server.id, path],
    );
    if (!row?.sha256) continue;
    const candidates = byHash.get(row.sha256);
    const from = candidates?.find((candidate) => !consumed.has(candidate));
    if (from) {
      consumed.add(from);
      renamed.push({ from, to: path });
    }
  }
  const deleted = deletedEvents.map((event) => event.path).filter((path) => !consumed.has(path));

  invalidateExplorerCache(server.id);

  return {
    status: result.status,
    scannedFiles: result.scannedFiles,
    scannedFolders: result.scannedDirectories,
    indexed: result.indexed,
    added,
    changed: events.length ? (await query<{ path: string }>(
      `select path from update_events where server_id = $1 and detected_at >= $2::timestamptz and kind = 'changed' order by path asc limit 500`,
      [server.id, startedAt],
    )).map((row) => row.path) : [],
    deleted,
    renamed,
    failed: result.accessErrors.map((error) => ({ path: error.path, message: error.error })),
    cases: Number(metadata?.cases ?? 0),
    functions: Number(metadata?.functions ?? 0),
    durationMs: result.durationMs,
    message: result.message,
    truncated: result.truncated,
    finishedAt: new Date().toISOString(),
  };
}

/** Reserve a scan slot so two taps cannot walk the panel at the same time. */
const running = new Set<string>();
export function beginScan(serverId: string): boolean {
  if (running.has(serverId)) return false;
  running.add(serverId);
  // A crashed request must not lock the project forever.
  const timer = setTimeout(() => running.delete(serverId), 10 * 60_000);
  if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref();
  return true;
}
export function endScan(serverId: string): void {
  running.delete(serverId);
}
