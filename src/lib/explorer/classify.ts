/**
 * Project Explorer classification.
 *
 * Everything here is a *hint*, never an assumption: a path is proposed for a
 * category and then verified against the real index, the real AST metadata and
 * the real import graph before it is shown. No category is a hardcoded folder
 * name — DARKNOTE projects differ, so the same rules have to find
 * `/plugins/menu.js`, `/src/plugins/menu/index.js`, `/command/menu.js` and
 * `/BIGBRO.js` without being told which one exists.
 *
 * Pure module: no server imports, so it is unit-testable.
 */

export type ExplorerCategoryId =
  | 'plugins'
  | 'package'
  | 'entry'
  | 'cases'
  | 'functions'
  | 'config'
  | 'database';

export interface CategoryDefinition {
  id: ExplorerCategoryId;
  label: string;
  description: string;
  /** What the category is looking for, shown in the UI when nothing is found. */
  hint: string;
}

export const EXPLORER_CATEGORIES: CategoryDefinition[] = [
  {
    id: 'plugins',
    label: 'Plugins',
    description: 'Installed plugin modules, their files, commands and dependencies',
    hint: 'No plugin directory was found. Any folder whose files are required by the entry point is still listed under Cases and Functions.',
  },
  {
    id: 'package',
    label: 'package.json & dependencies',
    description: 'Declared dependencies, versions, scripts and dependency problems',
    hint: 'No package.json exists in the project root.',
  },
  {
    id: 'entry',
    label: 'Main file / entry point',
    description: 'The file the panel actually starts, verified against the filesystem',
    hint: 'The startup command did not name a file and no main entry could be verified.',
  },
  {
    id: 'cases',
    label: 'Cases / commands',
    description: 'Every switch case and command handler, with its exact file and line',
    hint: 'No parsed case or command handler was found yet. Run a scan to parse JavaScript files.',
  },
  {
    id: 'functions',
    label: 'Functions / helpers',
    description: 'Function declarations, arrow constants and exports, by file',
    hint: 'No functions were parsed yet. Run a scan.',
  },
  {
    id: 'config',
    label: 'Configuration / settings',
    description: 'Config files, environment templates and the keys they define',
    hint: 'No configuration file was found.',
  },
  {
    id: 'database',
    label: 'Database / models / storage',
    description: 'Schemas, connection code, models and protected data files',
    hint: 'No database, model or storage path was found.',
  },
];

export function categoryLabel(id: ExplorerCategoryId): string {
  return EXPLORER_CATEGORIES.find((category) => category.id === id)?.label ?? id;
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function fileName(path: string): string {
  const parts = segments(path);
  return parts[parts.length - 1] ?? path;
}

export function extensionOf(path: string): string {
  const name = fileName(path).toLowerCase();
  if (name.startsWith('.') && !name.slice(1).includes('.')) return name.slice(1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

/** Languages the explorer can show a source file for. */
const SOURCE_EXTENSIONS = new Set([
  'js',
  'cjs',
  'mjs',
  'jsx',
  'ts',
  'tsx',
  'json',
  'json5',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'md',
  'markdown',
  'txt',
  'yml',
  'yaml',
  'xml',
  'svg',
  'sh',
  'bash',
  'sql',
  'py',
  'toml',
  'ini',
  'conf',
  'properties',
  'log',
  'csv',
  'prisma',
]);

const SCRIPT_EXTENSIONS = new Set(['js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx']);

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

export function isScriptFile(path: string): boolean {
  return SCRIPT_EXTENSIONS.has(extensionOf(path));
}

/** Directory names that usually hold plugin code. Matched as a whole segment. */
const PLUGIN_SEGMENTS = new Set([
  'plugin',
  'plugins',
  'modules',
  'module',
  'extensions',
  'extension',
  'addons',
  'addon',
  'features',
  'feature',
  'handlers',
  'commands',
  'command',
  'cmds',
  'cmd',
  'case',
  'cases',
]);

const CONFIG_SEGMENTS = new Set(['config', 'configs', 'conf', 'settings', 'env']);
const DATABASE_SEGMENTS = new Set([
  'database',
  'databases',
  'db',
  'data',
  'models',
  'model',
  'schemas',
  'schema',
  'migrations',
  'storage',
  'prisma',
]);

const BINARY_OR_DATA_LIBRARIES = new Set(['node_modules', '.git', '.next', 'dist', 'build']);

/** The nearest ancestor segment that makes a path plugin-shaped, if any. */
export function pluginScopeOf(path: string): { scope: string; depth: number; segment: string } | null {
  const parts = segments(path);
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const segment = parts[index].toLowerCase();
    if (PLUGIN_SEGMENTS.has(segment)) {
      return { scope: `/${parts.slice(0, index + 1).join('/')}`, depth: index, segment };
    }
  }
  return null;
}

/**
 * Plugin identity: the directory directly under the plugin scope, or the file
 * itself when the scope contains loose scripts (`/plugins/menu.js`).
 */
export function pluginNameOf(path: string): { name: string; root: string } | null {
  const scope = pluginScopeOf(path);
  if (!scope) return null;
  const parts = segments(path);
  const rest = parts.slice(scope.depth + 1);
  if (rest.length === 0) return null;
  if (rest.length === 1) {
    const name = rest[0].replace(/\.[^.]+$/, '');
    return { name, root: path };
  }
  const dir = rest[0];
  return { name: dir, root: `/${parts.slice(0, scope.depth + 2).join('/')}` };
}

export function isConfigPath(path: string): boolean {
  const name = fileName(path).toLowerCase();
  const parts = segments(path).map((part) => part.toLowerCase());
  if (name === '.env.example' || name === '.env.sample' || name === '.env.template') return true;
  if (name.startsWith('.env') && name !== '.env') return true;
  if (/^(config|config\.\w+|conf|settings|app\.config|ecosystem\.config)/.test(name)) return true;
  if (/\.(ya?ml|ini|conf|toml)$/.test(name) && parts.some((part) => CONFIG_SEGMENTS.has(part))) return true;
  if (CONFIG_SEGMENTS.has(parts[0] ?? '') && isSourceFile(path)) return true;
  return false;
}

export function isDatabasePath(path: string): boolean {
  const name = fileName(path).toLowerCase();
  const parts = segments(path).map((part) => part.toLowerCase());
  if (parts.some((part) => BINARY_OR_DATA_LIBRARIES.has(part))) return false;
  if (/\.(sqlite3?|db|mdb|sql|prisma)$/.test(name)) return true;
  if (parts.some((part) => DATABASE_SEGMENTS.has(part))) return true;
  if (/^(db|database|datasource|sequelize|mongoose|prisma)(\.\w+)?\.(js|cjs|mjs|ts)$/.test(name)) return true;
  return false;
}

/**
 * Data records are read-only in the explorer: a `.sqlite`, `.db` or a JSON file
 * inside `database/`/`data/` holds production records, not source code. They can
 * be downloaded, but editing or deleting them from here is refused.
 */
export function isDataRecord(path: string): boolean {
  const name = fileName(path).toLowerCase();
  const parts = segments(path).map((part) => part.toLowerCase());
  if (/\.(sqlite3?|db|db3|mdb|realm|ndjson|jsonl)$/.test(name)) return true;
  if (!['database', 'databases', 'db', 'data', 'storage'].some((segment) => parts.slice(0, -1).includes(segment))) {
    return false;
  }
  return /\.(json|csv|log|txt|dat|bak)$/.test(name);
}

/** Every category a path plausibly belongs to, with the reason. */
export function classifyPath(path: string): Array<{ id: ExplorerCategoryId; reason: string }> {
  const hits: Array<{ id: ExplorerCategoryId; reason: string }> = [];
  const name = fileName(path).toLowerCase();

  const plugin = pluginNameOf(path);
  if (plugin) hits.push({ id: 'plugins', reason: `inside ${pluginScopeOf(path)?.scope ?? 'a plugin path'}` });
  if (name === 'package.json') hits.push({ id: 'package', reason: 'package manifest' });
  if (isConfigPath(path)) hits.push({ id: 'config', reason: 'configuration filename or folder' });
  if (isDatabasePath(path)) hits.push({ id: 'database', reason: 'database/schema/model path' });
  if (isScriptFile(path) && /(case|switch|handler|command)/i.test(path)) {
    hits.push({ id: 'cases', reason: 'filename suggests command handlers' });
  }
  if (isScriptFile(path) && /(util|helper|lib|function|fn)/i.test(path)) {
    hits.push({ id: 'functions', reason: 'filename suggests helpers' });
  }
  return hits;
}

export interface EntryCandidate {
  path: string;
  score: number;
  evidence: string;
}

export interface EntryDetection {
  path: string | null;
  evidence: string;
  startupFile: string | null;
  runtime: string | null;
  candidates: EntryCandidate[];
  note: string | null;
}

const SCRIPT_CANDIDATES = ['index.js', 'main.js', 'bot.js', 'app.js', 'server.js', 'start.js', 'BIGBRO.js'];

/** Pull the script out of a Pterodactyl startup command. */
export function parseStartupCommand(command: string | null | undefined): {
  file: string | null;
  runtime: string | null;
  packageScript: string | null;
} {
  const text = (command ?? '').trim();
  if (!text) return { file: null, runtime: null, packageScript: null };
  const tokens = text.split(/\s+/).map((token) => token.replace(/^["']|["']$/g, ''));

  // node / nodejs / bun / deno [flags] script.js
  const runtimeIndex = tokens.findIndex((token) => /^(node|nodejs|bun|deno|ts-node|nodemon)$/i.test(token));
  if (runtimeIndex !== -1) {
    for (let index = runtimeIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.startsWith('-')) continue;
      if (/\.(js|cjs|mjs|ts)$/i.test(token)) return { file: token, runtime: tokens[runtimeIndex].toLowerCase(), packageScript: null };
      break;
    }
    // `node .` runs the package main entry.
    const dot = tokens.slice(runtimeIndex + 1).find((token) => token === '.' || token === './');
    if (dot) return { file: null, runtime: tokens[runtimeIndex].toLowerCase(), packageScript: 'start' };
    return { file: null, runtime: tokens[runtimeIndex].toLowerCase(), packageScript: 'start' };
  }

  // npm/yarn/pnpm start [file]
  const packageIndex = tokens.findIndex((token) => /^(npm|yarn|pnpm)$/i.test(token));
  if (packageIndex !== -1) {
    const next = tokens[packageIndex + 1];
    const explicit = tokens.slice(packageIndex + 1).find((token) => /\.(js|cjs|mjs)$/i.test(token));
    if (explicit) return { file: explicit, runtime: tokens[packageIndex].toLowerCase(), packageScript: null };
    if (next === 'run' && tokens[packageIndex + 2]) {
      return { file: null, runtime: tokens[packageIndex].toLowerCase(), packageScript: tokens[packageIndex + 2] };
    }
    return { file: null, runtime: tokens[packageIndex].toLowerCase(), packageScript: next && !next.startsWith('-') ? next : 'start' };
  }

  // pm2 start x.js | pm2 start ecosystem.config.js
  const pm2Index = tokens.findIndex((token) => token === 'pm2');
  if (pm2Index !== -1) {
    const file = tokens.slice(pm2Index + 1).find((token) => /\.(js|cjs|mjs)$/i.test(token));
    if (file) return { file, runtime: 'pm2', packageScript: null };
  }

  // sh start.sh
  const shellFile = tokens.find((token) => /\.sh$/i.test(token));
  if (shellFile) return { file: shellFile, runtime: 'shell', packageScript: null };

  const direct = tokens.find((token) => /\.(js|cjs|mjs)$/i.test(token));
  return { file: direct ?? null, runtime: null, packageScript: null };
}

function normalise(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
}

/**
 * Rank entry-point candidates using evidence, not a fixed filename.
 *
 * Startup command > package `main` > package `start` script > referenced by the
 * package scripts > a conventional filename that actually exists > the file the
 * project imports most often.
 */
export function rankEntryCandidates(input: {
  files: string[];
  startupCommand?: string | null;
  packageMain?: string | null;
  packageScripts?: Record<string, string>;
  incomingCount?: Record<string, number>;
}): EntryDetection {
  const fileSet = new Set(input.files.map(normalise));
  const parsed = parseStartupCommand(input.startupCommand);
  const candidates: EntryCandidate[] = [];
  const seen = new Set<string>();

  const add = (rawPath: string | null | undefined, score: number, evidence: string) => {
    if (!rawPath) return;
    const path = normalise(rawPath);
    if (!fileSet.has(path)) return;
    if (seen.has(path)) {
      const existing = candidates.find((candidate) => candidate.path === path);
      if (existing && existing.score < score) {
        existing.score = score;
        existing.evidence = evidence;
      }
      return;
    }
    seen.add(path);
    candidates.push({ path, score, evidence });
  };

  add(parsed.file, 100, `named in the panel startup command (${input.startupCommand?.trim() || 'startup command'})`);
  add(input.packageMain, 90, 'declared as "main" in package.json');

  const scriptName = parsed.packageScript ?? 'start';
  const scriptCommand = input.packageScripts?.[scriptName];
  if (scriptCommand) {
    const scriptParsed = parseStartupCommand(scriptCommand);
    add(scriptParsed.file, 85, `package.json scripts.${scriptName} → ${scriptCommand.trim()}`);
    if (!scriptParsed.file) {
      const token = scriptCommand.split(/\s+/).find((part) => /\.(js|cjs|mjs)$/i.test(part));
      add(token ? token.replace(/^["']|["']$/g, '') : null, 80, `package.json scripts.${scriptName}`);
    }
  }

  for (const [name, value] of Object.entries(input.packageScripts ?? {})) {
    if (name === scriptName) continue;
    const scriptParsed = parseStartupCommand(value);
    if (scriptParsed.file) add(scriptParsed.file, 60, `referenced by package.json scripts.${name}`);
  }

  for (const candidate of SCRIPT_CANDIDATES) {
    const match = input.files.find((file) => file.toLowerCase() === normalise(candidate).toLowerCase() || normalise(file).toLowerCase().endsWith(`/${candidate.toLowerCase()}`));
    add(match, 50, `conventional entry filename "${candidate}" that exists in the project`);
  }

  const incoming = input.incomingCount ?? {};
  const importedMost = Object.entries(incoming)
    .filter(([path]) => !path.includes('/node_modules/') && isScriptFile(path))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [path, count] of importedMost) {
    add(path, 20 + Math.min(count, 20), `imported by ${count} project file${count === 1 ? '' : 's'} (highest in-degree)`);
  }

  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const best = candidates[0] ?? null;

  let note: string | null = null;
  const startupMissing = Boolean(parsed.file) && !fileSet.has(normalise(parsed.file!));
  if (!best) {
    note = input.startupCommand
      ? `The startup command (${input.startupCommand.trim()}) names no file that exists in the indexed project. Run a scan, or check the panel's startup command.`
      : 'The panel returned no startup command and no entry candidate exists in the index.';
  } else if (startupMissing) {
    note = `The startup command names ${parsed.file}, which does not exist in the project. The entry below is the closest verified fallback — the bot cannot start as configured.`;
  } else if (parsed.runtime === 'shell') {
    note = `The panel starts a shell script (${parsed.file}). The entry below is the highest-ranked JavaScript file, not the script itself.`;
  } else if (parsed.runtime === 'pm2') {
    note = 'The panel starts the project through pm2; the file below comes from the pm2 command line.';
  } else if (!parsed.file) {
    note = 'The startup command does not name a file directly, so the entry was resolved from package.json and the import graph.';
  }

  return {
    path: best?.path ?? null,
    evidence: best?.evidence ?? 'unresolved',
    startupFile: parsed.file ? normalise(parsed.file) : null,
    runtime: parsed.runtime,
    candidates,
    note,
  };
}

/** Bare package names imported by project code (not relative paths). */
export function bareModuleOf(specifier: string): string | null {
  const value = specifier.trim();
  if (!value || value.startsWith('.') || value.startsWith('/')) return null;
  if (value.startsWith('node:')) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) return null;
  const parts = value.split('/');
  if (value.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

/** Resolve a relative import against a known file set. */
export function resolveSpecifier(fromPath: string, specifier: string, files: Set<string>): string | null {
  const value = specifier.trim();
  if (!value.startsWith('.')) return null;
  const baseParts = fromPath.split('/').slice(0, -1);
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  const joined = baseParts.join('/').replace(/\/{2,}/g, '/');
  const base = joined.startsWith('/') ? joined : `/${joined}`;
  const attempts = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.json`,
    `${base}.ts`,
    `${base}/index.js`,
    `${base}/index.cjs`,
    `${base}/index.mjs`,
    `${base}/index.json`,
  ];
  for (const attempt of attempts) {
    if (files.has(attempt)) return attempt;
  }
  return null;
}

export interface PackageProblem {
  code: string;
  message: string;
  path?: string;
}

export interface DependencyView {
  name: string;
  range: string;
  kind: 'dependency' | 'devDependency';
  imported: boolean;
  installed: 'present' | 'missing' | 'unverified';
  /** Latest published version, only when the registry check is enabled. */
  latest: string | null;
  status: 'ok' | 'missing' | 'unused' | 'unpinned' | 'outdated';
}

/**
 * Compare declared dependencies against what the code actually imports and what
 * the filesystem actually contains.
 *
 * "Outdated" needs a registry lookup; without one this deliberately reports
 * `unverified` rather than inventing a version.
 */
export function analyseDependencies(input: {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  imported: string[];
  installedModules: string[] | null;
  /** name → latest published version; omitted when the registry check is off. */
  latest?: Record<string, string> | null;
}): { entries: DependencyView[]; problems: PackageProblem[]; undeclared: string[] } {
  const imported = new Set(input.imported);
  const installed = input.installedModules ? new Set(input.installedModules) : null;
  const builtins = new Set([
    'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https', 'module',
    'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream',
    'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
  ]);

  const entries: DependencyView[] = [];
  for (const [kind, block] of [
    ['dependency', input.dependencies],
    ['devDependency', input.devDependencies],
  ] as const) {
    for (const [name, range] of Object.entries(block ?? {})) {
      const isImported = imported.has(name);
      const presence: DependencyView['installed'] = installed
        ? installed.has(name)
          ? 'present'
          : 'missing'
        : 'unverified';
      const unpinned = !range || range === '*' || range === 'latest';
      const latest = input.latest?.[name] ?? null;
      const outdated = latest ? isOutdatedVersion(range || '', latest) === true : false;
      const status: DependencyView['status'] =
        presence === 'missing'
          ? 'missing'
          : !isImported
            ? 'unused'
            : outdated
              ? 'outdated'
              : unpinned
                ? 'unpinned'
                : 'ok';
      entries.push({
        name,
        range: range || '(none)',
        kind,
        imported: isImported,
        installed: presence,
        latest,
        status,
      });
    }
  }

  const problems: PackageProblem[] = [];
  const declared = new Set([...Object.keys(input.dependencies ?? {}), ...Object.keys(input.devDependencies ?? {})]);
  const undeclared: string[] = [];
  for (const name of imported) {
    if (declared.has(name) || builtins.has(name)) continue;
    if (name.startsWith('node:') || name.startsWith('@types/')) continue;
    undeclared.push(name);
  }
  for (const name of undeclared.slice(0, 25)) {
    problems.push({
      code: 'undeclared_dependency',
      message: `Code imports "${name}" but package.json does not declare it. Installing on a fresh server would break it.`,
    });
  }
  for (const entry of entries) {
    if (entry.status === 'outdated' && entry.latest) {
      problems.push({
        code: 'outdated_dependency',
        message: `${entry.name} is declared as ${entry.range} but ${entry.latest} is published — a fresh install would still pin the old range.`,
      });
    }
    if (entry.status === 'missing') {
      problems.push({
        code: 'missing_dependency',
        message: `${entry.name} is declared but has no folder in node_modules — the panel would fail on ${entry.name}.`,
      });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, problems, undeclared };
}

/** Top-level keys defined by a config file. Values are never returned. */
export function configKeysOf(path: string, content: string): string[] {
  const name = fileName(path).toLowerCase();
  if (name.includes('.env')) {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('=')[0]?.trim())
      .filter((key): key is string => Boolean(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .slice(0, 80);
  }
  if (name.endsWith('.json') || name.endsWith('.json5')) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return Object.keys(parsed ?? {}).slice(0, 80);
    } catch {
      return [];
    }
  }
  if (/\.(ya?ml)$/.test(name)) {
    return content
      .split(/\r?\n/)
      .filter((line) => /^[A-Za-z0-9_.-]+\s*:/.test(line))
      .map((line) => line.split(':')[0].trim())
      .slice(0, 80);
  }
  if (/\.(js|cjs|mjs|ts)$/.test(name)) {
    const keys = new Set<string>();
    for (const match of content.matchAll(/^\s{0,4}([A-Za-z_$][\w$]*)\s*:/gm)) keys.add(match[1]);
    return [...keys].slice(0, 60);
  }
  return [];
}

/** Folders the explorer must never delete, whatever the permissions say. */
export const PROTECTED_DELETE_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'auth',
  'sessions',
  'session',
]);

/** Directories that hold production records or credentials, not source. */
export const PROTECTED_DATA_SEGMENTS = new Set(['database', 'databases', 'db', 'data', 'storage']);

/**
 * Why a delete must be refused, or null when it is allowed.
 *
 * Files are checked by the caller for `isSecretPath`/`isDataRecord`; this covers
 * the structural cases that a path-based check misses — deleting the folder that
 * *contains* credentials or records is just as destructive as deleting them.
 */
export function deletionBlockReason(path: string, isDirectory: boolean): string | null {
  const parts = segments(path).map((part) => part.toLowerCase());
  const name = parts[parts.length - 1] ?? '';
  const banned = parts.find((part) => PROTECTED_DELETE_SEGMENTS.has(part));
  if (banned) return `"${banned}" is a system, dependency or credential folder and cannot be deleted from the explorer.`;
  if (!isDirectory) return null;
  if (PROTECTED_DATA_SEGMENTS.has(name)) {
    return `"${name}" holds production data or credentials. Delete its contents individually, or use the panel.`;
  }
  return null;
}

/** package.json "main", resolved against the manifest's own directory. */
export function resolvePackageMainPath(packageJsonPath: string | null | undefined, main: string | null): string | null {
  if (!main) return null;
  if (main.startsWith('/') || main.startsWith('.')) return main;
  const dir = (packageJsonPath ?? '/package.json').split('/').slice(0, -1).join('/');
  const combined = `${dir}/${main}`.replace(/\/{2,}/g, '/');
  return combined.startsWith('/') ? combined : `/${combined}`;
}

interface Bound {
  operator: '^' | '~' | '>=' | '>' | '=';
  major: number;
  minor: number | null;
  patch: number | null;
}

export function registryCheckEnabled(): boolean {
  return process.env.DARKNOTE_NPM_REGISTRY_CHECK === '1';
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function parseBound(raw: string): Bound | null {
  const text = raw.trim();
  if (!text || text === '*' || text === 'latest' || text === 'x' || text === 'X') return null;
  const match = /^(\^|~|>=|>|=)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/.exec(text);
  if (!match) return null;
  const [, operator = '=', major, minorRaw, patchRaw] = match;
  const minor = minorRaw && !/[xX*]/.test(minorRaw) ? Number(minorRaw) : null;
  const patch = patchRaw && !/[xX*]/.test(patchRaw) ? Number(patchRaw) : null;
  return {
    operator: (operator || '=') as Bound['operator'],
    major: Number(major),
    minor,
    patch,
  };
}

function parseRange(range: string): Bound[][] | null {
  const text = range.trim();
  if (!text) return null;
  if (/^(workspace|file|link|portal|git|git\+|https?|npm):/i.test(text)) return null;
  if (text.includes('/')) return null;

  const alternatives = text.split('||').map((part) => part.trim());
  const parsed: Bound[][] = [];
  for (const alternative of alternatives) {
    const tokens = alternative.split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    const bounds: Bound[] = [];
    for (const token of tokens) {
      const bound = parseBound(token);
      // An unparseable token makes the whole range unknown rather than "satisfied".
      if (!bound) return null;
      bounds.push(bound);
    }
    parsed.push(bounds);
  }
  return parsed;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function fits(bound: Bound, version: [number, number, number]): boolean {
  const [major, minor, patch] = version;
  const min: [number, number, number] = [bound.major, bound.minor ?? 0, bound.patch ?? 0];

  switch (bound.operator) {
    case '>=':
      return compare(version, min) >= 0;
    case '>':
      return compare(version, min) > 0;
    case '^':
      if (bound.major > 0) return major === bound.major && compare(version, min) >= 0;
      // 0.x: the caret pins the minor line.
      return major === 0 && minor === (bound.minor ?? 0) && compare(version, min) >= 0;
    case '~':
      if (bound.minor === null) return major === bound.major && compare(version, min) >= 0;
      return major === bound.major && minor === bound.minor && compare(version, min) >= 0;
    case '=':
    default:
      if (bound.minor === null) return major === bound.major;
      if (bound.patch === null) return major === bound.major && minor === bound.minor;
      return compare(version, min) === 0;
  }
}

/** Does `version` satisfy the declared range? `null` when the range is unparseable. */
export function satisfiesRange(range: string, version: string): boolean | null {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return null;
  const parsedRange = parseRange(range);
  if (parsedRange === null) return null;
  if (parsedRange.length === 0) return true;
  return parsedRange.some((bounds) => bounds.every((bound) => fits(bound, parsedVersion)));
}

/** `true` = the published version falls outside the declared range. */
export function isOutdatedVersion(range: string, latest: string): boolean | null {
  const satisfied = satisfiesRange(range, latest);
  if (satisfied === null) return null;
  return !satisfied;
}

