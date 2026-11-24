/**
 * Project Explorer tests.
 *
 * Two layers:
 *  1. classification rules (pure) — entry detection, plugin grouping, protected
 *     data, dependency analysis. These are the "intelligence" and must not depend
 *     on a specific project layout.
 *  2. a real service run against the panel double, with a project whose structure
 *     is deliberately different from DARKNOTE's (`/plugins`, `/commands`,
 *     `/config`, `/database`, `/data`) so nothing can be answered from a hardcoded
 *     folder name.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMockPanel } from './mock-pterodactyl.mjs';
import {
  analyseDependencies,
  classifyPath,
  configKeysOf,
  deletionBlockReason,
  isDataRecord,
  isOutdatedVersion,
  resolvePackageMainPath,
  satisfiesRange,
  parseStartupCommand,
  pluginNameOf,
  rankEntryCandidates,
  resolveSpecifier,
} from '../src/lib/explorer/classify.ts';
import { isSecretPath as isSecretPathForTests } from '../src/lib/security/paths.ts';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-explorer-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'explorer-secret-value-that-is-long-enough-for-aes';
process.env.NODE_ENV = 'test';
delete process.env.DARKNOTE_BOT_STATUS_PATH;

// ---------------------------------------------------------------------------
// 1. Classification rules
// ---------------------------------------------------------------------------
test('the startup command decides the entry point, not a filename convention', () => {
  assert.equal(parseStartupCommand('node index.js').file, 'index.js');
  assert.equal(parseStartupCommand('node --enable-source-maps bot.js').file, 'bot.js');
  assert.equal(parseStartupCommand('/usr/bin/node ./src/main.js').file, './src/main.js');
  assert.equal(parseStartupCommand('npm start').packageScript, 'start');
  assert.equal(parseStartupCommand('npm run serve').packageScript, 'serve');
  assert.equal(parseStartupCommand('pm2 start app.js').file, 'app.js');
  assert.equal(parseStartupCommand('bash start.sh').file, 'start.sh');
  assert.equal(parseStartupCommand('node .').file, null);
});

test('entry ranking prefers evidence and only accepts files that exist', () => {
  const detection = rankEntryCandidates({
    files: ['/index.js', '/BIGBRO.js', '/lib/util.js'],
    startupCommand: 'node BIGBRO.js',
    packageMain: 'index.js',
    packageScripts: { start: 'node index.js' },
    incomingCount: { '/lib/util.js': 12 },
  });
  assert.equal(detection.path, '/BIGBRO.js', 'the startup command wins over package.json and in-degree');
  assert.match(detection.evidence, /startup command/);

  const missing = rankEntryCandidates({
    files: ['/lib/util.js'],
    startupCommand: 'node ghost.js',
    incomingCount: { '/lib/util.js': 3 },
  });
  assert.equal(missing.path, '/lib/util.js', 'a startup file that does not exist cannot be the entry');
  assert.match(String(missing.note), /ghost\.js/);
});

test('entry detection never assumes BIGBRO.js', () => {
  const detection = rankEntryCandidates({
    files: ['/src/server.ts', '/src/plugins/menu.ts'],
    startupCommand: 'node src/server.ts',
  });
  assert.equal(detection.path, '/src/server.ts');
});

test('plugins are found in several layouts, including single files', () => {
  assert.deepEqual(pluginNameOf('/plugins/menu.js'), { name: 'menu', root: '/plugins/menu.js' });
  assert.deepEqual(pluginNameOf('/plugins/menu/index.js'), { name: 'menu', root: '/plugins/menu' });
  assert.deepEqual(pluginNameOf('/src/modules/downloader/lib/fetch.js'), {
    name: 'downloader',
    root: '/src/modules/downloader',
  });
  assert.deepEqual(pluginNameOf('/commands/ping.js'), { name: 'ping', root: '/commands/ping.js' });
  assert.equal(pluginNameOf('/lib/util.js'), null);
});

test('classification covers configuration and database shapes', () => {
  assert.ok(classifyPath('/config/settings.json').some((hit) => hit.id === 'config'));
  assert.ok(classifyPath('/.env.example').some((hit) => hit.id === 'config'));
  assert.ok(classifyPath('/database/schema.sql').some((hit) => hit.id === 'database'));
  assert.ok(classifyPath('/lib/db.js').some((hit) => hit.id === 'database'));
  assert.ok(classifyPath('/plugins/menu/index.js').some((hit) => hit.id === 'plugins'));
});

test('data records are protected, source files are not', () => {
  assert.equal(isDataRecord('/database/owner.json'), true);
  assert.equal(isDataRecord('/data/session.db'), true);
  assert.equal(isDataRecord('/database/schema.sql'), false);
  assert.equal(isDataRecord('/lib/db.js'), false);
  assert.equal(isSecretPathForTests('/.env'), true);
  assert.equal(isSecretPathForTests('/.env.example'), false);
});

test('folder deletion rules protect credentials, dependencies and data', () => {
  assert.match(String(deletionBlockReason('/node_modules', true)), /dependency|system/i);
  assert.match(String(deletionBlockReason('/.git', true)), /system|credential/i);
  assert.match(String(deletionBlockReason('/auth', true)), /credential/i);
  assert.match(String(deletionBlockReason('/sessions', true)), /credential/i);
  assert.match(String(deletionBlockReason('/database', true)), /production data/i);
  assert.match(String(deletionBlockReason('/data', true)), /production data/i);
  assert.equal(deletionBlockReason('/plugins/menu', true), null);
  assert.equal(deletionBlockReason('/plugins/menu/index.js', false), null);
});

test('package main resolves against the manifest directory', () => {
  assert.equal(resolvePackageMainPath('/package.json', 'index.js'), '/index.js');
  assert.equal(resolvePackageMainPath('/sub/package.json', 'src/app.js'), '/sub/src/app.js');
  assert.equal(resolvePackageMainPath('/sub/package.json', './app.js'), './app.js');
  assert.equal(resolvePackageMainPath('/package.json', null), null);
});

test('declared ranges are compared without inventing a version', () => {
  assert.equal(satisfiesRange('^1.2.3', '1.9.0'), true);
  assert.equal(satisfiesRange('^1.2.3', '2.0.0'), false);
  assert.equal(satisfiesRange('~1.2.3', '1.2.9'), true);
  assert.equal(satisfiesRange('~1.2.3', '1.3.0'), false);
  assert.equal(satisfiesRange('>=1.0.0', '3.1.0'), true);
  assert.equal(satisfiesRange('1.2.x', '1.2.7'), true);
  assert.equal(satisfiesRange('^0.4.1', '0.5.0'), false);
  assert.equal(satisfiesRange('^1.0.0 || ^2.0.0', '2.4.0'), true);
  assert.equal(satisfiesRange('workspace:*', '1.0.0'), null, 'unsupported ranges are unknown, not wrong');
  assert.equal(isOutdatedVersion('^1.2.3', '1.4.0'), false);
  assert.equal(isOutdatedVersion('^1.2.3', '2.0.0'), true);
  assert.equal(isOutdatedVersion('git+https://example.com/x.git', '1.0.0'), null);
});

test('a dependency outside its declared range is reported as outdated', () => {
  const analysis = analyseDependencies({
    dependencies: { 'whatsapp-web.js': '^1.0.0', express: '^4.18.0' },
    devDependencies: {},
    imported: ['whatsapp-web.js', 'express'],
    installedModules: ['whatsapp-web.js', 'express'],
    latest: { 'whatsapp-web.js': '2.0.0', express: '4.21.2' },
  });
  const byName = Object.fromEntries(analysis.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName['whatsapp-web.js'].status, 'outdated');
  assert.equal(byName['whatsapp-web.js'].latest, '2.0.0');
  assert.equal(byName.express.status, 'ok');
  assert.ok(analysis.problems.some((problem) => problem.code === 'outdated_dependency'));
});

test('registry lookups are bounded, per-package and non-fatal', async () => {
  const { fetchLatestVersions, resetRegistryCacheForTests } = await import('../src/lib/explorer/registry.ts');
  resetRegistryCacheForTests();
  const seen: string[] = [];
  const versions = await fetchLatestVersions(['alpha', 'beta', 'gamma'], {
    fetcher: (async (url: string) => {
      seen.push(String(url));
      if (String(url).includes('beta')) return new Response('nope', { status: 500 });
      if (String(url).includes('gamma')) throw new Error('offline');
      return new Response(JSON.stringify({ version: '3.1.4' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
  assert.equal(versions.get('alpha')?.latest, '3.1.4');
  assert.equal(versions.get('beta')?.latest, null);
  assert.match(String(versions.get('beta')?.error), /500/);
  assert.match(String(versions.get('gamma')?.error), /offline/);
  assert.equal(seen.length, 3);
});

test('config keys are read without leaking values', () => {
  const envKeys = configKeysOf('/.env.example', 'API_KEY=super-secret\nOWNER=2547\n# comment\n');
  assert.deepEqual(envKeys, ['API_KEY', 'OWNER']);
  assert.equal(envKeys.join(' ').includes('super-secret'), false);

  const jsonKeys = configKeysOf('/config.json', JSON.stringify({ botName: 'x', password: 'y' }));
  assert.deepEqual(jsonKeys, ['botName', 'password']);
});

test('dependency analysis reports missing and undeclared packages', () => {
  const analysis = analyseDependencies({
    dependencies: { 'whatsapp-web.js': '^1.2.0', missingpkg: '^2.0.0' },
    devDependencies: { typescript: '^5.0.0' },
    imported: ['whatsapp-web.js', 'axios', 'fs'],
    installedModules: ['whatsapp-web.js', 'typescript'],
  });
  const byName = Object.fromEntries(analysis.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName['whatsapp-web.js'].status, 'ok');
  assert.equal(byName.missingpkg.status, 'missing');
  assert.equal(byName.typescript.status, 'unused');
  assert.ok(analysis.undeclared.includes('axios'));
  assert.ok(!analysis.undeclared.includes('fs'), 'node builtins are not dependencies');
});

test('relative imports resolve through extension and index candidates', () => {
  const files = new Set(['/lib/msg.js', '/plugins/menu/index.js', '/config.json']);
  assert.equal(resolveSpecifier('/plugins/menu/index.js', '../../lib/msg', files), '/lib/msg.js');
  assert.equal(resolveSpecifier('/plugins/menu/index.js', '../menu', files), '/plugins/menu/index.js');
  assert.equal(resolveSpecifier('/index.js', './config.json', files), '/config.json');
  assert.equal(resolveSpecifier('/index.js', './ghost', files), null);
});

// ---------------------------------------------------------------------------
// 2. Service run against the panel double
// ---------------------------------------------------------------------------
const PLUGIN_INDEX = `'use strict';
const { smsg } = require('../../lib/msg');

function formatMenu(items) {
  return items.map((item) => '-' + item).join('\\n');
}

async function handleMenu(conn, m) {
  const command = m.text.slice(1).split(' ')[0];
  switch (command) {
    case 'menu': {
      await m.reply(formatMenu(['menu', 'ping']));
      break;
    }
    case 'list': {
      await m.reply('list');
      break;
    }
    default:
      break;
  }
}

module.exports = { handleMenu, formatMenu };
`;

const COMMAND_FILE = `'use strict';
module.exports = {
  name: 'ping',
  async run(conn, m) {
    switch (m.text) {
      case '.ping': {
        await m.reply('pong');
        break;
      }
      case '.pong': {
        await m.reply('ping');
        break;
      }
    }
  },
};
`;

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'layered-bot',
    version: '2.1.0',
    main: 'index.js',
    scripts: { start: 'node index.js', dev: 'nodemon index.js' },
    dependencies: { 'whatsapp-web.js': '^1.23.0', 'left-pad': '^1.3.0' },
  },
  null,
  2,
);

const panel = await createMockPanel({
  identifier: 'explorer1',
  apiKey: 'ptlc_explorer_key_long_enough',
  seed: {
    '/index.js': "const { handleMenu } = require('./plugins/menu');\nconst pkg = require('whatsapp-web.js');\nrequire('./commands/ping');\nconsole.log('bot up', pkg, handleMenu);\n",
    '/plugins/menu/index.js': PLUGIN_INDEX,
    '/plugins/menu/format.js': "module.exports = { pad: (v) => ' ' + v };\n",
    '/plugins/reminder.js': "module.exports = { remind: async (m) => m.reply('later') };\n",
    '/commands/ping.js': COMMAND_FILE,
    '/config/settings.json': JSON.stringify({ prefix: '.', owner: '2547', autoRead: true }, null, 2),
    '/config/prefix.js': "module.exports = { prefix: '.' };\n",
    '/database/schema.sql': 'create table users (id integer primary key, jid text);\n',
    '/database/owner.json': '{"owners":["2547"]}\n',
    '/data/session.db': 'binary-ish',
    '/.env.example': 'API_KEY=replace-me\nOWNER=2547\nSESSION_PATH=./sessions\n',
    '/lib/db.js': "module.exports = { query: async () => [] };\n",
    '/package.json': PACKAGE_JSON,
  },
}).start();

const { createServer, getServer } = await import('../src/lib/servers/repo.ts');
const { query } = await import('../src/lib/db.ts');
const { scanServer } = await import('../src/lib/services/discovery.ts');
const { explorerCategory, explorerFileInfo, explorerOverview, explorerSearch, scanProject } = await import(
  '../src/lib/services/explorer.ts'
);

const principal = {
  id: 'explorer-admin',
  email: 'explorer@example.com',
  name: 'Explorer',
  role: 'owner' as const,
  permissions: [] as string[],
};
let serverId = '';
let server = null as Awaited<ReturnType<typeof getServer>>;

test('index a differently shaped project', async () => {
  await query(
    `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,'owner')
     on conflict (id) do nothing`,
    [principal.id, principal.email, principal.name, 'not-a-real-hash'],
  );
  const created = await createServer(
    {
      name: 'Layered bot',
      panelUrl: panel.baseUrl,
      serverIdentifier: panel.identifier,
      apiKey: panel.apiKey,
      projectRoot: '/',
      startupTimeoutS: 2,
      syncIntervalS: 300,
    },
    principal as never,
  );
  serverId = created.id;
  server = await getServer(serverId);
  const result = await scanServer({ server: server!, user: principal as never, mode: 'manual', deep: true });
  assert.ok(result.indexed > 8, `expected the walk to index the project, got ${result.indexed}`);
});

test('the overview discovers all seven categories from the real files', async () => {
  const overview = await explorerOverview(server!);
  const ids = overview.categories.map((category) => category.id);
  assert.deepEqual(ids, ['plugins', 'package', 'entry', 'cases', 'functions', 'config', 'database']);
  const byId = Object.fromEntries(overview.categories.map((category) => [category.id, category]));
  assert.ok(byId.plugins.count >= 2, 'two plugin shapes must be found');
  assert.ok(byId.cases.count >= 4, 'cases must come from several files, not one');
  assert.ok(byId.functions.count >= 2);
  assert.ok(byId.config.count >= 2);
  assert.ok(byId.database.count >= 2);
  assert.ok(overview.index.files > 8);
  assert.equal(overview.warnings.some((warning) => warning.code === 'index_empty'), false);
});

test('the entry point is the file the panel actually starts', async () => {
  const overview = await explorerOverview(server!);
  assert.equal(overview.entry.path, '/index.js');
  assert.equal(overview.entry.startupCommand, 'node index.js');
  assert.match(overview.entry.evidence, /startup command/i);
  assert.equal(overview.package.name, 'layered-bot');
});

test('plugins are grouped by their own directory and single files are included', async () => {
  const view = await explorerCategory(server!, 'plugins');
  const names = view.items.map((item) => item.name);
  assert.ok(names.includes('menu'), `expected the menu plugin folder, got ${names.join(', ')}`);
  assert.ok(names.includes('reminder'), 'a single-file plugin must be listed too');
  const menu = view.items.find((item) => item.name === 'menu');
  assert.equal(menu?.count, 2);
  assert.ok(menu?.children?.some((child) => child.path === '/plugins/menu/index.js'));
  assert.match(String(menu?.detail), /command/);
});

test('cases from every file are discoverable with file and line', async () => {
  const view = await explorerCategory(server!, 'cases');
  const paths = view.items.map((item) => item.path);
  assert.ok(paths.includes('/plugins/menu/index.js'), 'cases inside a plugin must be found');
  assert.ok(paths.includes('/commands/ping.js'), 'cases inside a commands file must be found');
  const menu = view.items.find((item) => item.path === '/plugins/menu/index.js');
  const names = (menu?.children ?? []).map((child) => child.name);
  assert.ok(names.includes('menu') && names.includes('list'), `got ${names.join(', ')}`);
  assert.ok((menu?.children ?? []).every((child) => typeof child.line === 'number' && child.line > 0));
});

test('functions and helpers are listed per file', async () => {
  const view = await explorerCategory(server!, 'functions');
  const menu = view.items.find((item) => item.path === '/plugins/menu/index.js');
  assert.ok(menu, 'functions from the plugin file must be listed');
  const names = (menu?.children ?? []).map((child) => child.name);
  assert.ok(names.includes('handleMenu'), `expected handleMenu, got ${names.join(', ')}`);

  const filtered = await explorerCategory(server!, 'functions', { q: 'formatmenu' });
  assert.ok(filtered.items.some((item) => item.path === '/plugins/menu/index.js'));
});

test('configuration is discovered without exposing credential values', async () => {
  const view = await explorerCategory(server!, 'config');
  const paths = view.items.map((item) => item.path);
  assert.ok(paths.includes('/config/settings.json'));
  assert.ok(paths.includes('/.env.example'));
  const settings = view.items.find((item) => item.path === '/config/settings.json');
  assert.match(String(settings?.detail), /prefix/);

  const env = view.items.find((item) => item.path === '/.env.example');
  assert.ok(env, 'the env template must be listed');
  assert.equal(String(env?.detail).includes('replace-me'), false, 'a template value must never be shown');

  const secret = view.items.find((item) => item.path === '/.env');
  if (secret) {
    assert.equal(secret.protected, true);
    assert.equal(secret.editable, false);
  }
  const rendered = JSON.stringify(view);
  assert.equal(rendered.includes('replace-me'), false, 'no config value may reach the response');
});

test('database files are found and production records are protected', async () => {
  const view = await explorerCategory(server!, 'database');
  const rows = Object.fromEntries(view.items.map((item) => [item.path ?? '', item]));
  assert.ok(rows['/database/owner.json'], 'the data file must be listed');
  assert.equal(rows['/database/owner.json'].protected, true, 'a data record must be protected');
  assert.equal(rows['/database/schema.sql'].protected, false, 'schema source stays editable');
  assert.equal(rows['/data/session.db'].protected, true);
});

test('package.json analysis reports scripts, imports and missing packages', async () => {
  const view = await explorerCategory(server!, 'package');
  const names = view.items.map((item) => item.name);
  assert.ok(names.includes('whatsapp-web.js'));
  assert.ok(names.includes('npm run start'));
  assert.ok(names.includes('left-pad'), 'declared dependencies are listed even when unused');
  const whatsapp = view.items.find((item) => item.name === 'whatsapp-web.js');
  assert.ok(whatsapp);
  assert.match(String(whatsapp.detail), /imported yes/);
});

test('file information shows symbols, imports and reverse dependencies', async () => {
  const info = await explorerFileInfo(server!, '/plugins/menu/index.js');
  assert.equal(info.path, '/plugins/menu/index.js');
  assert.equal(info.editable, true);
  assert.ok(info.symbols.cases.some((entry) => entry.name === 'menu'));
  assert.ok(info.symbols.functions.some((entry) => entry.name === 'handleMenu'));
  const importEntry = info.imports.find((entry) => entry.specifier === '../../lib/msg');
  assert.equal(importEntry?.resolvedPath, '/lib/msg.js');

  const lib = await explorerFileInfo(server!, '/lib/msg.js');
  assert.ok(lib.importedBy.some((entry) => entry.path === '/plugins/menu/index.js'));
});

test('global search finds a command, a function and a code snippet by location', async () => {
  const byCase = await explorerSearch(server!, 'menu');
  assert.ok(byCase.symbols.some((symbol) => symbol.kind === 'case' && symbol.name === 'menu'));
  assert.ok(byCase.files.some((file) => file.path === '/plugins/menu/index.js' && file.hits.length > 0));

  const byFunction = await explorerSearch(server!, 'handleMenu');
  assert.ok(byFunction.symbols.some((symbol) => symbol.name === 'handleMenu'));
  assert.ok(byFunction.files.some((file) => file.path === '/plugins/menu/index.js'));

  const byName = await explorerSearch(server!, 'ping');
  assert.ok(byName.names.some((entry) => entry.path === '/commands/ping.js'));
});

test('category lists page without losing the real total', async () => {
  const first = await explorerCategory(server!, 'cases', { limit: 1, offset: 0 });
  const second = await explorerCategory(server!, 'cases', { limit: 1, offset: 1 });
  assert.ok(first.total >= 2, `expected several case files, got ${first.total}`);
  assert.equal(first.items.length, 1);
  assert.equal(first.offset, 0);
  assert.equal(first.truncated, true);
  assert.equal(second.offset, 1);
  assert.notEqual(first.items[0].id, second.items[0].id, 'the second page must not repeat the first');
  const all = await explorerCategory(server!, 'cases', { limit: 200, offset: 0 });
  assert.equal(all.items.length, all.total);
  assert.equal(all.truncated, false);
});

test('a rescan detects added, deleted and renamed files', async () => {
  panel.externalEdit('/plugins/menu/extra.js', "module.exports = { extra: true };\n");
  // Same bytes, new name: this is the rename case.
  panel.files.delete('/plugins/reminder.js');
  panel.externalEdit('/plugins/reminder-renamed.js', "module.exports = { remind: async (m) => m.reply('later') };\n");
  // Different bytes, no replacement: this is a real deletion.
  panel.files.delete('/config/prefix.js');

  const result = await scanProject(server!, principal as never);
  assert.ok(result.added.includes('/plugins/menu/extra.js'), `added: ${result.added.join(', ')}`);
  const renamed = result.renamed.find((entry) => entry.to === '/plugins/reminder-renamed.js');
  assert.ok(renamed, `expected a rename pair, got ${JSON.stringify(result.renamed)}`);
  assert.equal(renamed!.from, '/plugins/reminder.js');
  assert.equal(
    result.deleted.includes('/plugins/reminder.js'),
    false,
    'a paired rename must not also be reported as a deletion',
  );
  assert.ok(result.deleted.includes('/config/prefix.js'), `deleted: ${result.deleted.join(', ')}`);

  const view = await explorerCategory(server!, 'plugins');
  const names = view.items.map((item) => item.name);
  assert.ok(names.includes('reminder-renamed'), `after rescan: ${names.join(', ')}`);
  assert.equal(names.includes('reminder'), false);
});

test.after(async () => {
  await panel.stop();
});
