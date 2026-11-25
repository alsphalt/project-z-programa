import 'server-only';
import { ApiError } from '../api';
import { query } from '../db';
import { logActivity } from '../audit';
import { sendConsoleCommand } from '../services/console';
import { requireServer } from '../servers/repo';
import * as repo from './repo';

/**
 * Dependency / installation engine.
 *
 * Two halves, deliberately separated:
 *
 *  1. `analyzeProject()` is pure. It reads the stored manifests and returns the
 *     runtime, the package manager, the exact install and start commands, the
 *     declared dependencies, the environment **keys** the project expects, and
 *     the problems that would make an install fail. It executes nothing, so it
 *     is safe on untrusted repositories and can run during inspection.
 *  2. `executeInstall()` sends exactly that command to the bound hosting server,
 *     and only that command. There is no free-form shell here: an override has
 *     to look like a package-manager invocation and may not chain a second
 *     command. Completion is not assumed — the panel's console is the source of
 *     truth, so the caller is told to verify there.
 */

export type Runtime = 'node' | 'python' | 'php' | 'static' | 'unknown';

export interface ManifestFile {
  path: string;
  content: string | null;
}

export interface InstallProblem {
  code: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  file?: string;
}

export interface ProjectAnalysis {
  runtime: Runtime;
  language: string;
  packageManager: string | null;
  manifestPath: string | null;
  lockfilePath: string | null;
  installCommand: string | null;
  startCommand: string | null;
  startScript: string | null;
  dependencies: Array<{ name: string; version: string }>;
  devDependencies: Array<{ name: string; version: string }>;
  envKeys: string[];
  engineRange: string | null;
  problems: InstallProblem[];
  installable: boolean;
  report: string;
}

const LOCKFILES: Array<{ file: string; manager: string; install: string; run: string }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm', install: 'pnpm install --frozen-lockfile', run: 'pnpm start' },
  { file: 'yarn.lock', manager: 'yarn', install: 'yarn install --frozen-lockfile', run: 'yarn start' },
  { file: 'bun.lockb', manager: 'bun', install: 'bun install --frozen-lockfile', run: 'bun start' },
  { file: 'package-lock.json', manager: 'npm', install: 'npm ci', run: 'npm start' },
  { file: 'npm-shrinkwrap.json', manager: 'npm', install: 'npm ci', run: 'npm start' },
];

const PYTHON_MANIFESTS = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'];

function parseEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function parseDependencies(value: unknown): Array<{ name: string; version: string }> {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([name]) => typeof name === 'string')
    .map(([name, version]) => ({ name, version: typeof version === 'string' ? version : String(version ?? '') }));
}

function readJson(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Detects the runtime, the manager and the commands a project needs.
 * Pure: no network, no filesystem, no execution.
 */
export function analyzeProject(files: ManifestFile[]): ProjectAnalysis {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const has = (path: string) => byPath.has(path);
  const problems: InstallProblem[] = [];

  const packageJsonPath = ['package.json', 'app/package.json', 'src/package.json'].find(has) ?? null;
  const pythonManifest = PYTHON_MANIFESTS.map((name) => {
    if (has(name)) return name;
    const nested = files.find((file) => file.path.endsWith(`/${name}`));
    return nested ? nested.path : null;
  }).find((value): value is string => Boolean(value)) ?? null;
  const composerPath = ['composer.json'].find(has) ?? files.find((f) => f.path.endsWith('/composer.json'))?.path ?? null;
  const staticEntry = ['index.html', 'public/index.html', 'dist/index.html'].find(has) ?? null;

  const envFile = files.find((file) => /(^|\/)(\.env\.example|\.env\.sample|\.env\.template|env\.example)$/.test(file.path));
  const envKeys = envFile?.content ? parseEnvKeys(envFile.content) : [];

  let runtime: Runtime = 'unknown';
  if (packageJsonPath) runtime = 'node';
  else if (pythonManifest) runtime = 'python';
  else if (composerPath) runtime = 'php';
  else if (staticEntry) runtime = 'static';

  let packageManager: string | null = null;
  let manifestPath: string | null = null;
  let lockfilePath: string | null = null;
  let installCommand: string | null = null;
  let startCommand: string | null = null;
  let startScript: string | null = null;
  let dependencies: Array<{ name: string; version: string }> = [];
  let devDependencies: Array<{ name: string; version: string }> = [];
  let engineRange: string | null = null;
  const language = runtime === 'node' ? 'JavaScript / TypeScript' : runtime === 'python' ? 'Python' : runtime === 'php' ? 'PHP' : runtime === 'static' ? 'HTML / CSS' : 'Unknown';

  if (packageJsonPath) {
    manifestPath = packageJsonPath;
    const pkg = readJson(byPath.get(packageJsonPath) ?? null);
    if (!pkg) {
      problems.push({
        code: 'invalid_package_json',
        severity: 'critical',
        message: 'package.json does not parse as JSON, so no dependency set can be installed from it.',
        file: packageJsonPath,
      });
    } else {
      const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
      const scriptNames = Object.keys(scripts);
      startScript = typeof scripts.start === 'string' ? 'start' : typeof scripts.dev === 'string' ? 'dev' : null;
      dependencies = parseDependencies(pkg.dependencies);
      devDependencies = parseDependencies(pkg.devDependencies);
      const engines = (pkg.engines ?? {}) as Record<string, unknown>;
      engineRange = typeof engines.node === 'string' ? engines.node : null;

      const lock = LOCKFILES.find((entry) => has(entry.file));
      if (lock) {
        packageManager = lock.manager;
        lockfilePath = lock.file;
        installCommand = lock.install;
      } else {
        packageManager = 'npm';
        installCommand = dependencies.length ? 'npm install --omit=dev' : 'npm install';
        problems.push({
          code: 'no_lockfile',
          severity: 'low',
          message: 'No lockfile is committed, so an install is not reproducible. Commit package-lock.json (or pnpm/yarn/bun lockfile).',
          file: packageJsonPath,
        });
      }

      if (startScript === 'start') {
        startCommand = packageManager === 'yarn' ? 'yarn start' : packageManager === 'pnpm' ? 'pnpm start' : packageManager === 'bun' ? 'bun start' : 'npm start';
      } else if (startScript === 'dev') {
        startCommand = packageManager === 'yarn' ? 'yarn dev' : packageManager === 'pnpm' ? 'pnpm dev' : packageManager === 'bun' ? 'bun run dev' : 'npm run dev';
        problems.push({
          code: 'no_start_script',
          severity: 'high',
          message: 'package.json has no "start" script; only "dev" exists. The panel startup command will not find "npm start".',
          file: packageJsonPath,
        });
      } else if (typeof pkg.main === 'string') {
        startCommand = `node ${pkg.main}`;
        problems.push({
          code: 'no_start_script',
          severity: 'medium',
          message: `package.json declares no start script; falling back to "node ${pkg.main}".`,
          file: packageJsonPath,
        });
      } else {
        problems.push({
          code: 'no_entrypoint',
          severity: 'critical',
          message: 'package.json declares neither a start script nor a "main" entry, so there is nothing to run.',
          file: packageJsonPath,
        });
      }

      if (!scriptNames.length) {
        problems.push({
          code: 'no_scripts',
          severity: 'medium',
          message: 'package.json declares no scripts.',
          file: packageJsonPath,
        });
      }
      if (!engineRange) {
        problems.push({
          code: 'no_engines',
          severity: 'low',
          message: 'package.json does not pin a Node version. A panel running an older runtime may fail on modern syntax.',
          file: packageJsonPath,
        });
      }
      if (pkg.type === 'module' && startCommand?.startsWith('node ')) {
        problems.push({
          code: 'esm_entrypoint',
          severity: 'low',
          message: 'Project is an ES module ("type": "module"); the panel must run Node 14+ with ESM support.',
          file: packageJsonPath,
        });
      }
    }
  }

  if (runtime === 'python' && pythonManifest) {
    manifestPath = pythonManifest;
    if (pythonManifest === 'requirements.txt') {
      packageManager = 'pip';
      installCommand = 'pip3 install -r requirements.txt';
      const content = byPath.get(pythonManifest) ?? '';
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && !line.startsWith('-'));
      const unpinned = lines.filter((line) => !/[=<>~!]=|==/.test(line));
      if (unpinned.length) {
        problems.push({
          code: 'python_unpinned',
          severity: 'low',
          message: `${unpinned.length} requirement(s) are not version-pinned, so installs are not reproducible.`,
          file: pythonManifest,
        });
      }
    } else if (pythonManifest === 'Pipfile') {
      packageManager = 'pipenv';
      installCommand = 'pipenv install --deploy';
    } else if (pythonManifest === 'pyproject.toml') {
      packageManager = 'pip';
      installCommand = 'pip3 install .';
    } else {
      packageManager = 'pip';
      installCommand = 'pip3 install -e .';
    }
    startCommand = has('main.py') ? 'python3 main.py' : has('bot.py') ? 'python3 bot.py' : has('app.py') ? 'python3 app.py' : null;
    if (!startCommand) {
      problems.push({
        code: 'no_entrypoint',
        severity: 'high',
        message: 'No main.py, bot.py or app.py was found, so the start command cannot be derived.',
      });
    }
  }

  if (runtime === 'php' && composerPath) {
    manifestPath = composerPath;
    packageManager = 'composer';
    installCommand = 'composer install --no-dev --no-interaction';
    if (!has('composer.lock')) {
      problems.push({
        code: 'no_lockfile',
        severity: 'low',
        message: 'composer.lock is not committed, so PHP dependencies are not reproducible.',
        file: composerPath,
      });
    }
  }

  if (runtime === 'static') {
    manifestPath = staticEntry;
    packageManager = null;
    installCommand = null;
    startCommand = null;
  }

  if (runtime === 'unknown') {
    problems.push({
      code: 'no_manifest',
      severity: 'medium',
      message: 'No package.json, requirements.txt, composer.json or index.html was found, so no runtime could be identified.',
    });
  }

  if (packageJsonPath && pythonManifest) {
    problems.push({
      code: 'mixed_manifests',
      severity: 'low',
      message: 'Both a Node manifest and a Python manifest exist. The panel can only run one runtime; confirm which one serves the bot.',
    });
  }

  const runtimeLabel = runtime === 'node' ? 'Node.js' : runtime === 'python' ? 'Python' : runtime === 'php' ? 'PHP' : runtime === 'static' ? 'Static site' : 'Unidentified';
  const reportLines = [
    `Runtime: ${runtimeLabel}`,
    `Manifest: ${manifestPath ?? 'none detected'}`,
    `Package manager: ${packageManager ?? 'n/a'}${lockfilePath ? ` (lockfile: ${lockfilePath})` : ''}`,
    `Install command: ${installCommand ?? 'none required'}`,
    `Start command: ${startCommand ?? 'not derivable'}`,
    `Dependencies: ${dependencies.length} production, ${devDependencies.length} development`,
    `Environment keys expected: ${envKeys.length}${envKeys.length ? ` (${envKeys.join(', ')})` : ''}`,
    engineRange ? `Declared Node range: ${engineRange}` : 'Declared Node range: not pinned',
    `Problems: ${problems.length ? `${problems.length} (${problems.map((p) => p.code).join(', ')})` : 'none'}`,
  ];

  return {
    runtime,
    language,
    packageManager,
    manifestPath,
    lockfilePath,
    installCommand,
    startCommand,
    startScript,
    dependencies,
    devDependencies,
    envKeys,
    engineRange,
    problems,
    installable: Boolean(installCommand),
    report: reportLines.join('\n'),
  };
}

/** Reads the manifests of a stored project and analyses them. */
export async function analyzeProjectById(
  projectId: string,
): Promise<ProjectAnalysis & { projectId: string; projectName: string; inspectedFiles: number }> {
  const project = await repo.requireProject(projectId);
  const rows = await query<{ path: string; content: string | null }>(
    `select path, content from imported_project_files
      where project_id = $1
        and (path like '%package.json' or path like '%lock%' or path like '%requirements.txt'
             or path like '%pyproject.toml' or path like '%Pipfile' or path like '%composer.json'
             or path like '%index.html' or path like '%.env%' or path like '%setup.py'
             or path in ('main.py','bot.py','app.py'))
      order by path asc
      limit 400`,
    [projectId],
  );
  return { ...analyzeProject(rows), projectId: project.id, projectName: project.name, inspectedFiles: rows.length };
}

const ALLOWED_OVERRIDE = /^(npm|npx|pnpm|yarn|bun|pip3?|python3? -m pip|composer)\s[^;|&<>`$(){}[\]]{0,180}$/;

export interface InstallExecution {
  sent: boolean;
  command: string;
  serverId: string;
  serverName: string;
  directory: string;
  note: string;
  verification: 'console';
}

/**
 * Sends the analysed install command to the server bound to this project.
 *
 * Refuses rather than guesses: no binding, no panel credentials or an
 * unapproved command is an error with the exact requirement named.
 */
export async function executeInstall(options: {
  projectId: string;
  user?: { id: string; email: string } | null;
  confirm: boolean;
  commandOverride?: string | null;
}): Promise<InstallExecution> {
  if (!options.confirm) {
    throw new ApiError(
      'Installing dependencies runs a command on the hosting server. Confirm explicitly (confirm: true).',
      400,
      'confirmation_required',
    );
  }

  const analysis = await analyzeProjectById(options.projectId);
  if (!analysis.installCommand) {
    throw new ApiError(
      `Nothing to install: ${analysis.runtime === 'static' ? 'this is a static site with no dependency manifest.' : 'no dependency manifest was detected.'}`,
      409,
      'nothing_to_install',
    );
  }

  const command = options.commandOverride?.trim() || analysis.installCommand;
  if (options.commandOverride && !ALLOWED_OVERRIDE.test(command)) {
    throw new ApiError(
      'The install command must be a single package-manager invocation (npm, pnpm, yarn, bun, pip, composer). Shell operators are refused.',
      400,
      'command_not_allowed',
    );
  }

  const bindings = await query<{ server_id: string; path_prefix: string }>(
    `select server_id, path_prefix from server_github_bindings where project_id = $1 order by created_at asc limit 1`,
    [options.projectId],
  );
  const binding = bindings[0];
  if (!binding) {
    throw new ApiError(
      'This project is not bound to a hosting server yet, so there is nowhere to install. Bind it in LIVE MONITORING → GITHUB SYNC first.',
      409,
      'no_server_binding',
    );
  }

  const server = await requireServer(binding.server_id);
  const prefix = (binding.path_prefix || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.\./g, '');
  const directory = prefix ? `/${prefix}` : '/';
  const full = prefix ? `cd /${prefix} && ${command}` : command;

  await sendConsoleCommand(server, full);
  await logActivity({
    user: options.user ?? undefined,
    serverId: server.id,
    action: 'project.install',
    target: options.projectId,
    severity: 'warning',
    detail: { command: full, directory, runtime: analysis.runtime, manager: analysis.packageManager },
  });

  return {
    sent: true,
    command: full,
    serverId: server.id,
    serverName: server.name,
    directory,
    note:
      'The command was sent to the panel console. Installation is reported complete only when LIVE MONITORING shows it finished — this response is not proof that it succeeded.',
    verification: 'console',
  };
}
