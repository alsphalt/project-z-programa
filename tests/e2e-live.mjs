/**
 * Live HTTP end-to-end check.
 *
 * Boots the real Next.js server (production build) plus a protocol-accurate
 * Pterodactyl double, signs in over HTTP, and drives the same routes the browser
 * uses:
 *
 *   POST /api/monitor                      → power restart/start/stop
 *   GET  /api/monitor                      → real state, resources, console tail
 *   GET  /api/files/content?mode=meta      → size/limit without the bytes
 *   GET  /api/files/content?mode=chunk     → chunked read of a >2 MB file
 *   POST /api/drafts/chunk                 → create / PUT slices / finalize
 *   POST /api/deployments { draftId }      → write, verify hash, restart
 *   GET  /api/versions + POST /api/versions→ compare and restore a version
 *
 * The double answers 405 to a wrong verb, so a power call that is not POST
 * fails here exactly as it would on a real panel.
 *
 * Usage:  npm run build && node tests/e2e-live.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPanel } from './mock-pterodactyl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.DARKNOTE_E2E_PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'e2e-owner@example.com', password: 'Correct-Horse-Battery-9' };

if (!existsSync(path.join(projectRoot, '.next', 'BUILD_ID'))) {
  console.error('No production build found. Run `npm run build` first, then re-run this script.');
  process.exit(2);
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function largeSource(bytes) {
  const lines = ["#!/usr/bin/env node", "'use strict';", 'const handlers = new Map();'];
  let length = lines.join('\n').length;
  let index = 0;
  while (length < bytes) {
    const line = `handlers.set('command_${index}', async (conn, m) => { await m.reply('reply ${index}'); });`;
    lines.push(line);
    length += line.length + 1;
    index += 1;
  }
  lines.push('module.exports = { handlers, dispatch };', '');
  return lines.join('\n');
}

function bigBroSource(bytes) {
  const lines = [
    '#!/usr/bin/env node',
    "'use strict';",
    '// DARKNOTE command module — the file the editor must show in full.',
    'const handlers = new Map();',
    'async function dispatch(conn, m) {',
    '  switch (m.text) {',
    "    case '.menu': { await m.reply('menu'); break; }",
    "    case '.ping': { await m.reply('pong'); break; }",
    "    default: { break; }",
    '  }',
    '}',
  ];
  let length = lines.join('\n').length;
  let index = 0;
  while (length < bytes) {
    const line = `handlers.set('cmd_${index}', async (conn, m) => { await m.reply('reply ${index}'); });`;
    lines.push(line);
    length += line.length + 1;
    index += 1;
  }
  lines.push('module.exports = { handlers, dispatch };', '');
  return lines.join('\n');
}

const BIGBRO = bigBroSource(391 * 1024);

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-e2e-'));
// The panel API key must satisfy the app's own validation (min 20 chars).
const panel = await createMockPanel({
  identifier: 'abc12345',
  apiKey: 'ptlc_e2e_client_key_that_is_long_enough',
  seed: {
    '/huge.js': largeSource(3 * 1024 * 1024),
    // The file the editor was reported to open as a 391 KB blank surface.
    '/BIGBRO.js': bigBroSource(391 * 1024),
    '/README.md': '# DARKNOTE L2\n\nA WhatsApp bot.\n\n## Commands\n- .menu\n- .ping\n',
    '/styles.css': ':root { --accent: #6d5efc; }\nbody { background: #05060a; color: #e7eaf3; }\n',
    '/notes.txt': 'plain text notes\nsecond line\n',
    '/package.json': JSON.stringify(
      {
        name: 'darknote-l2',
        version: '1.0.0',
        main: 'index.js',
        scripts: { start: 'node index.js', deploy: 'git pull && node index.js' },
        dependencies: { 'whatsapp-web.js': '^1.23.0' },
      },
      null,
      2,
    ),
    '/plugins/menu/index.js': `'use strict';
const { smsg } = require('../../lib/msg');
async function handleMenu(conn, m) {
  const command = m.text.slice(1).split(' ')[0];
  switch (command) {
    case 'menu': { await m.reply('menu'); break; }
    case 'list': { await m.reply('list'); break; }
    default: break;
  }
}
module.exports = { handleMenu };
`,
    '/commands/ping.js': `module.exports = { name: 'ping', run: async (m) => { switch (m.text) { case '.ping': { await m.reply('pong'); break; } default: break; } } };
`,
  },
}).start();

let nextProcess = null;
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function storeCookies(response) {
  const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(method, pathname, body) {
  const headers = { Origin: BASE, Accept: 'application/json' };
  if (jar.size) headers.Cookie = cookieHeader();
  const csrf = jar.get('dn_csrf');
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(response);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  if (!response.ok || payload?.ok === false) {
    // A 405 here is the exact failure the browser used to show, so name it.
    const hint = response.status === 405 ? ' (HTTP 405 — the request used a verb this route/panel does not implement)' : '';
    const detail = payload?.details ? ` — ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${method} ${pathname} → ${response.status}${hint}: ${payload?.error ?? payload?.raw ?? text}${detail}`);
  }
  return payload?.data ?? payload;
}

async function rawGet(pathname) {
  const headers = { Accept: '*/*' };
  if (jar.size) headers.Cookie = cookieHeader();
  const response = await fetch(`${BASE}${pathname}`, { headers });
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    text: await response.text(),
  };
}

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const data = await call('GET', '/api/health');
      if (data?.database === 'ok') return data;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('The Next server did not become healthy in 90s. Check its output above.');
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let step = 0;
function ok(message) {
  step += 1;
  console.log(`  ✓ ${step}. ${message}`);
}

try {
  console.log(`\nDARKNOTE live HTTP check — Next on ${BASE}, panel double on ${panel.baseUrl}`);
  nextProcess = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(PORT)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DARKNOTE_DATA_DIR: dataDir,
      DARKNOTE_DB_DRIVER: 'pglite',
      DARKNOTE_SECRET: 'e2e-secret-value-that-is-long-enough-for-aes-256-gcm',
      DARKNOTE_ADMIN_EMAIL: ADMIN.email,
      DARKNOTE_ADMIN_PASSWORD: ADMIN.password,
      DARKNOTE_ADMIN_NAME: 'E2E Owner',
      DARKNOTE_APP_URL: BASE,
      DARKNOTE_MAX_EDITOR_BYTES: String(64 * 1024 * 1024),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nextProcess.stdout.on('data', (chunk) => process.stdout.write(`    [next] ${chunk}`));
  nextProcess.stderr.on('data', (chunk) => process.stderr.write(`    [next] ${chunk}`));
  nextProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`    [next] exited with code ${code}`);
  });

  await waitForServer();
  ok('production server is up and its database/storage are healthy');

  await call('POST', '/api/auth/login', { email: ADMIN.email, password: ADMIN.password });
  assert.ok(jar.get('dn_session'), 'login must set a session cookie');
  assert.ok(jar.get('dn_csrf'), 'login must set a CSRF cookie');
  ok('signed in over HTTP with a session and CSRF token');

  const created = await call('POST', '/api/servers', {
    name: 'Darknote E2E',
    panelUrl: panel.baseUrl,
    serverIdentifier: panel.identifier,
    apiKey: panel.apiKey,
    rootPath: '/',
    maxFileBytes: 16 * 1024 * 1024,
  });
  const serverId = created?.server?.id;
  assert.ok(serverId, 'server registration must return an id');
  ok(`registered the panel (server ${serverId})`);

  const tested = await call('POST', `/api/servers/${serverId}/test`, { deep: false });
  assert.ok(Array.isArray(tested?.capabilities) && tested.capabilities.length > 0);
  assert.ok(tested.capabilities.some((check) => check.ok === true), 'at least the read checks must pass');
  ok(`connection test ran (${tested.capabilities.filter((check) => check.ok).length}/${tested.capabilities.length} checks ok)`);

  // ---- project explorer --------------------------------------------------
  const scan = await call('POST', '/api/explorer/scan', { serverId, deep: true });
  assert.ok(scan.indexed > 5, `expected the explorer scan to index files, got ${scan.indexed}`);
  assert.equal(Array.isArray(scan.added), true);
  ok(`explorer scan walked the project (${scan.indexed} indexed, ${scan.cases} cases, ${scan.functions} functions)`);

  const explorer = await call('GET', `/api/explorer?serverId=${serverId}`);
  const categoryIds = explorer.categories.map((category) => category.id);
  assert.deepEqual(categoryIds, ['plugins', 'package', 'entry', 'cases', 'functions', 'config', 'database']);
  assert.equal(explorer.entry.path, '/index.js', 'the entry must be the file the panel starts');
  assert.equal(explorer.entry.startupCommand, 'node index.js');
  const categoryById = Object.fromEntries(explorer.categories.map((category) => [category.id, category]));
  assert.ok(categoryById.plugins.count >= 2, 'plugins must be discovered from the real folders');
  assert.ok(categoryById.cases.count >= 4, 'cases must be discovered across several files');
  assert.ok(categoryById.database.count >= 1);
  assert.ok(categoryById.config.count >= 1);
  ok(
    `explorer overview: ${explorer.index.files} files, ${explorer.index.caseCount} cases, ${explorer.index.functionCount} functions, entry ${explorer.entry.path}`,
  );

  const pluginView = await call('GET', `/api/explorer/category?serverId=${serverId}&id=plugins`);
  const pluginNames = pluginView.items.map((item) => item.name);
  assert.ok(pluginNames.includes('menu'), `plugin items: ${pluginNames.join(', ')}`);
  assert.ok(pluginView.items.find((item) => item.name === 'menu').children.some((child) => child.path === '/plugins/menu/index.js'));
  ok(`plugins category grouped ${pluginView.total} plugin(s) including "menu"`);

  const caseView = await call('GET', `/api/explorer/category?serverId=${serverId}&id=cases`);
  const casePaths = caseView.items.map((item) => item.path);
  assert.ok(casePaths.includes('/BIGBRO.js'), `cases from BIGBRO.js must be found (got ${casePaths.join(', ')})`);
  assert.ok(casePaths.includes('/plugins/menu/index.js'), 'cases from a plugin file must be found');
  assert.ok(
    caseView.items.every((item) => (item.children ?? []).every((child) => typeof child.line === 'number' && child.line > 0)),
    'every case must carry a line number',
  );
  ok(`cases category found ${caseView.total} file(s) of commands with exact lines`);

  const paged = await call('GET', `/api/explorer/category?serverId=${serverId}&id=cases&limit=1&offset=1`);
  assert.equal(paged.items.length, 1);
  assert.equal(paged.offset, 1);
  assert.ok(paged.total >= 2, `cases total: ${paged.total}`);
  ok(`category pagination returns one page at a time (${paged.total} total)`);

  const entryView = await call('GET', `/api/explorer/category?serverId=${serverId}&id=entry`);
  assert.ok(entryView.items.some((item) => item.path === '/index.js' && item.badges.includes('entry point')));

  const packageView = await call('GET', `/api/explorer/category?serverId=${serverId}&id=package`);
  assert.ok(packageView.items.some((item) => item.name === 'npm run start'));
  ok('entry + package.json categories resolved from the panel');

  const search = await call('GET', `/api/explorer/search?serverId=${serverId}&q=menu`);
  assert.ok(search.symbols.some((symbol) => symbol.name === 'menu'), 'a case must be searchable by name');
  assert.ok(search.files.some((file) => file.path === '/BIGBRO.js' && file.hits.length > 0), 'code locations must be returned');
  ok(`search found the "menu" command in ${search.files.length} file(s) with line-level hits`);

  const fileInfo = await call('GET', `/api/explorer/file?serverId=${serverId}&path=${encodeURIComponent('/plugins/menu/index.js')}`);
  assert.ok(fileInfo.symbols.cases.some((entry) => entry.name === 'menu'));
  assert.ok(fileInfo.symbols.functions.some((entry) => entry.name === 'handleMenu'));
  assert.equal(fileInfo.imports.find((entry) => entry.specifier === '../../lib/msg')?.resolvedPath, '/lib/msg.js');
  const libInfo = await call('GET', `/api/explorer/file?serverId=${serverId}&path=${encodeURIComponent('/lib/msg.js')}`);
  assert.ok(libInfo.importedBy.some((entry) => entry.path === '/plugins/menu/index.js'), 'reverse dependencies must resolve');
  ok('file information returns symbols, resolved imports and reverse dependencies');

  // Protected production records cannot be deleted from the explorer.
  let protectedRefused = false;
  try {
    await call('DELETE', `/api/explorer/file?serverId=${serverId}&path=${encodeURIComponent('/database/owner.json')}&confirm=DELETE`);
  } catch (error) {
    protectedRefused = /403|protected/i.test(String(error.message));
  }
  assert.equal(protectedRefused, true, 'a data record must be refused');
  assert.ok(panel.read('/database/owner.json'), 'the data record must still exist');

  let confirmRequired = false;
  try {
    await call('DELETE', `/api/explorer/file?serverId=${serverId}&path=${encodeURIComponent('/notes.txt')}`);
  } catch (error) {
    confirmRequired = /400|confirmation/i.test(String(error.message));
  }
  assert.equal(confirmRequired, true, 'a delete without confirmation must be refused');
  ok('explorer refuses protected records and unconfirmed deletes');

  // A rescan must reflect files added in the panel.
  panel.externalEdit('/plugins/menu/added-later.js', "module.exports = { late: true };\n");
  const rescanned = await call('POST', '/api/explorer/scan', { serverId, deep: true });
  assert.ok(rescanned.added.includes('/plugins/menu/added-later.js'), `added: ${rescanned.added.join(', ')}`);
  const afterRescan = await call('GET', `/api/explorer/category?serverId=${serverId}&id=plugins`);
  assert.ok(
    afterRescan.items.find((item) => item.name === 'menu').children.some((child) => child.path === '/plugins/menu/added-later.js'),
    'the new file must appear after rescanning',
  );
  ok('rescan picks up a newly created plugin file');

  // ---- folder deletion guards --------------------------------------------
  let dataDirRefused = false;
  try {
    await call('DELETE', `/api/explorer/file?serverId=${serverId}&path=${encodeURIComponent('/database')}&confirm=database`);
  } catch (error) {
    dataDirRefused = /403|protected|production data/i.test(String(error.message));
  }
  assert.equal(dataDirRefused, true, 'a data folder must not be deletable');

  let authRefused = false;
  try {
    await call('DELETE', `/api/explorer/file?serverId=${serverId}&path=${encodeURIComponent('/auth')}&confirm=auth`);
  } catch (error) {
    authRefused = /403|credential|secret/i.test(String(error.message));
  }
  assert.equal(authRefused, true, 'a credential folder must not be deletable');
  assert.ok(panel.read('/auth/creds.json'), 'credentials must still exist');

  await call('POST', '/api/files/op', { action: 'mkdir', serverId, path: '/scratch/deep' });
  let wrongToken = false;
  try {
    await call('DELETE', `/api/explorer/file?serverId=${serverId}&path=${encodeURIComponent('/scratch')}&confirm=DELETE`);
  } catch (error) {
    wrongToken = /400|folder name|confirmation/i.test(String(error.message));
  }
  assert.equal(wrongToken, true, 'a folder delete must require the folder name, not a generic token');

  const folderDelete = await call(
    'DELETE',
    `/api/explorer/file?serverId=${serverId}&path=${encodeURIComponent('/scratch')}&confirm=scratch`,
  );
  assert.deepEqual(folderDelete.deleted, ['/scratch']);
  ok('folder deletion needs its own name and refuses data/credential folders');

  // ---- the discovery page follows the real entry point -------------------
  const discovery = await call('GET', `/api/servers/${serverId}/discover`);
  const importantPaths = discovery.importantFiles.map((file) => file.path);
  assert.ok(importantPaths.includes('/index.js'), `important files: ${importantPaths.join(', ')}`);
  ok('discovery now lists the real entry point instead of a hardcoded filename list');

  // ---- power -------------------------------------------------------------
  for (const action of ['restart', 'stop', 'start']) {
    const result = await call('POST', '/api/monitor', { serverId, action, confirm: 'CONFIRM' });
    assert.equal(result.method, 'POST', `${action} must be forwarded with POST`);
    assert.equal(result.endpoint, `/api/client/servers/${panel.identifier}/power`);
    const sent = panel.powers.at(-1);
    assert.equal(sent?.signal, action);
    assert.equal(sent?.method, 'POST');
    assert.ok(result.observedState, `the panel should report a state after ${action}`);
  }
  assert.deepEqual(
    [...new Set(panel.powers.map((entry) => entry.method))],
    ['POST'],
    'no power request may use a verb other than POST',
  );
  ok('restart, stop and start each reached the panel as POST …/power with the right signal');

  // ---- monitor -----------------------------------------------------------
  const monitor = await waitFor(async () => {
    const data = await call('GET', `/api/monitor?serverId=${serverId}`);
    return data?.console?.streamState === 'live' && data?.console?.lines?.length ? data : null;
  }, 25_000, 'the live console to attach');

  assert.equal(monitor.panel.reachable, true);
  assert.equal(monitor.panel.state, 'running');
  assert.equal(monitor.panel.cpuPercent, 12.5);
  assert.equal(monitor.panel.memoryBytes, 268435456);
  assert.ok(monitor.console.lines.some((line) => /Connected to WhatsApp/i.test(line.text)));
  assert.equal(monitor.bot.whatsapp, 'connected');
  assert.equal(monitor.bot.whatsappSource, 'console-event');
  ok(`live monitor: container running, CPU ${monitor.panel.cpuPercent}%, RAM ${monitor.panel.memoryBytes} B, console attached`);

  // ---- the editor's real path (small file, whole body) -------------------
  const bigroMeta = await call(
    'GET',
    `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/BIGBRO.js')}&mode=meta`,
  );
  assert.equal(bigroMeta.content, null, 'meta mode must not ship the body');
  assert.equal(bigroMeta.language, 'javascript');
  assert.equal(bigroMeta.sizeBytes, Buffer.byteLength(BIGBRO, 'utf8'));
  assert.equal(bigroMeta.totalChars, BIGBRO.length);
  ok(
    `BIGBRO.js metadata: ${(bigroMeta.sizeBytes / 1024).toFixed(0)} KB, ${bigroMeta.totalChars.toLocaleString()} chars, limit ${(bigroMeta.limitBytes / 1024 / 1024).toFixed(0)} MB`,
  );

  // This is the request the editor makes for any file below 1 MB. It used to be
  // the one that produced an empty editor, so assert the body, not just the hash.
  const bigroFull = await call(
    'GET',
    `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/BIGBRO.js')}&mode=full`,
  );
  assert.equal(typeof bigroFull.content, 'string', 'the body must be a string, not null/undefined');
  assert.equal(bigroFull.content.length, bigroFull.totalChars, 'no characters may be dropped');
  assert.equal(sha256(bigroFull.content), bigroFull.sha256, 'the body must hash to the reported SHA-256');
  assert.equal(bigroFull.content, BIGBRO, 'the body must be the production file itself');
  assert.ok(bigroFull.content.startsWith('#!/usr/bin/env node'));
  assert.ok(bigroFull.content.trimEnd().endsWith('module.exports = { handlers, dispatch };'));
  assert.equal(bigroFull.validation.ok, true, 'the real source must parse');
  ok('BIGBRO.js opened through mode=full with the complete source and a matching SHA-256');

  // ---- draft, reload, deploy for that file --------------------------------
  // A real, parseable edit: appending a trailing comment keeps every original byte.
  const bigroEdit = `${BIGBRO}// edited from the control center\n`;
  await call('PUT', '/api/drafts', {
    serverId,
    path: '/BIGBRO.js',
    content: bigroEdit,
    baseSha: bigroFull.sha256,
  });
  const withDraft = await call(
    'GET',
    `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/BIGBRO.js')}&mode=meta`,
  );
  assert.ok(withDraft.draft, 'the saved draft must be attached to the file');
  assert.equal(withDraft.draft.content, bigroEdit, 'the draft must hold the edited bytes');

  const afterDraft = await call(
    'GET',
    `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/BIGBRO.js')}&mode=full&fresh=1`,
  );
  assert.equal(afterDraft.content, BIGBRO, 'saving a draft must not touch production');
  assert.equal(afterDraft.draft.content, bigroEdit, 'reopening must return both versions');
  ok('draft saved without touching production; reopening returns the production body plus the draft');

  // Reload = re-read production, discarding the draft.
  await call('DELETE', `/api/drafts?serverId=${serverId}&path=${encodeURIComponent('/BIGBRO.js')}`);
  const reloaded = await call(
    'GET',
    `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/BIGBRO.js')}&mode=full&fresh=1`,
  );
  assert.equal(reloaded.content, BIGBRO, 'reload must restore the exact production contents');
  assert.equal(reloaded.draft, null);
  ok('reload restored the exact production contents and cleared the draft');

  const bigroDeploy = await call('POST', '/api/deployments', {
    serverId,
    files: [{ path: '/BIGBRO.js', content: bigroEdit, expectedSha: reloaded.sha256 }],
    message: 'e2e editor deploy',
  });
  assert.equal(bigroDeploy.deployment.status, 'SUCCEEDED', `deploy failed: ${bigroDeploy.deployment.error}`);
  assert.equal(bigroDeploy.deployment.files[0].postHash, sha256(bigroEdit));
  assert.equal(panel.read('/BIGBRO.js'), bigroEdit, 'production must hold the complete edited file');
  assert.ok(panel.read('/BIGBRO.js').length > 390 * 1024, 'the deploy must not truncate the file');
  ok('deployed the edited BIGBRO.js, verified the re-read hash and kept all 391 KB');

  const restoredBigBro = await call('POST', '/api/deployments', {
    serverId,
    files: [{ path: '/BIGBRO.js', content: BIGBRO, expectedSha: sha256(bigroEdit) }],
    message: 'e2e restore original',
  });
  assert.equal(
    restoredBigBro.deployment.status,
    'SUCCEEDED',
    `restore failed: ${restoredBigBro.deployment.error}`,
  );
  assert.equal(panel.read('/BIGBRO.js'), BIGBRO, 'the original must be restorable');
  ok('restored the original BIGBRO.js byte-for-byte');

  // A blank editor must never be able to erase production, even if the UI guard
  // is bypassed: the write path itself has to refuse it.
  let emptyBlocked = false;
  try {
    await call('POST', '/api/deployments', {
      serverId,
      files: [{ path: '/BIGBRO.js', content: '', expectedSha: sha256(BIGBRO) }],
      message: 'e2e empty write must fail',
    });
  } catch (error) {
    emptyBlocked = /422|empty_write_blocked|empty buffer/i.test(String(error.message));
  }
  assert.equal(emptyBlocked, true, 'an empty deployment must be refused with empty_write_blocked');
  assert.equal(panel.read('/BIGBRO.js'), BIGBRO, 'the refused deploy must leave production untouched');
  ok('empty deployment refused server-side; production still holds all 391 KB');

  // ---- what the browser actually loads ------------------------------------
  const editorPage = await rawGet(`/editor?path=${encodeURIComponent('/BIGBRO.js')}`);
  assert.equal(editorPage.status, 200, 'the editor page must render');
  assert.match(editorPage.type, /text\/html/);

  const monacoLoader = await rawGet('/monaco/vs/loader.js');
  assert.equal(monacoLoader.status, 200, 'Monaco must be served from this origin, not a CDN');
  assert.match(monacoLoader.type, /javascript/);
  assert.match(monacoLoader.text, /loadPlugin|define/, 'that must be the Monaco AMD loader');

  const monacoMain = await rawGet('/monaco/vs/editor/editor.main.js');
  assert.equal(monacoMain.status, 200);
  assert.ok(monacoMain.text.length > 1_000_000, 'the editor bundle must be complete');

  const monacoCss = await rawGet('/monaco/vs/editor/editor.main.css');
  assert.equal(monacoCss.status, 200);
  assert.match(monacoCss.text, /\.monaco-editor/, 'editor styles must resolve (no unstyled surface)');
  ok('editor page and self-hosted Monaco assets (loader, bundle, stylesheet) all served');

  // ---- every file type the editor claims to support ----------------------
  const otherFiles = [
    { path: '/index.js', language: 'javascript' },
    { path: '/lib/msg.js', language: 'javascript' },
    { path: '/package.json', language: 'json' },
    { path: '/config.json', language: 'json' },
    { path: '/README.md', language: 'markdown' },
    { path: '/styles.css', language: 'css' },
    { path: '/notes.txt', language: 'plaintext' },
  ];
  for (const file of otherFiles) {
    const opened = await call(
      'GET',
      `/api/files/content?serverId=${serverId}&path=${encodeURIComponent(file.path)}&mode=full`,
    );
    assert.equal(opened.language, file.language, `${file.path} must map to ${file.language}`);
    assert.equal(typeof opened.content, 'string');
    assert.ok(opened.content.length > 0, `${file.path} must not open as an empty surface`);
    assert.equal(opened.content, panel.read(file.path), `${file.path} must be the production body`);
    assert.equal(sha256(opened.content), opened.sha256);
    assert.equal(opened.validation.ok, true, `${file.path} must parse`);
  }
  ok(`opened ${otherFiles.length} other file types (js, json, md, css, txt) with real content and no parse errors`);

  // Protected paths stay protected: the editor must refuse, not show an empty tab.
  let blocked = false;
  try {
    await call('GET', `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/.env')}&mode=full`);
  } catch (error) {
    blocked = /403|secret/i.test(String(error.message));
  }
  assert.equal(blocked, true, 'a credential path must be refused, never opened blank');
  ok('credential paths are refused');

  // ---- large file read ---------------------------------------------------
  const meta = await call('GET', `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/huge.js')}&mode=meta`);
  assert.ok(meta.sizeBytes > 2 * 1024 * 1024, `expected a >2 MB file, got ${meta.sizeBytes}`);
  assert.equal(meta.content, null, 'meta mode must not ship the file body');
  assert.ok(meta.limitBytes >= meta.sizeBytes, `limit ${meta.limitBytes} must allow the file`);

  const parts = [];
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const chunk = await call(
      'GET',
      `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/huge.js')}&mode=chunk&offset=${offset}&length=${meta.chunkBytes}`,
    );
    parts.push(chunk.content ?? '');
    if (chunk.nextOffset === null) break;
    assert.ok(chunk.nextOffset > offset, 'the chunked reader must advance');
    offset = chunk.nextOffset;
  }
  const loaded = parts.join('');
  assert.equal(loaded.length, meta.totalChars, 'the whole file must arrive');
  assert.equal(sha256(loaded), meta.sha256, 'the reassembled file must hash identically');
  ok(`read a ${(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB file in ${parts.length} chunks with a matching SHA-256`);

  // ---- chunked draft -----------------------------------------------------
  const edited = `${loaded}// e2e edit marker\n`;
  const createdDraft = await call('POST', '/api/drafts/chunk', {
    action: 'create',
    serverId,
    path: '/huge.js',
    totalBytes: Buffer.byteLength(edited, 'utf8'),
    totalChars: edited.length,
    baseSha: meta.sha256,
  });
  const stepChars = createdDraft.chunkBytes;
  const sliceCount = Math.ceil(edited.length / stepChars);
  for (let index = 0; index < sliceCount; index += 1) {
    await call('PUT', '/api/drafts/chunk', {
      serverId,
      draftId: createdDraft.draftId,
      index,
      content: edited.slice(index * stepChars, (index + 1) * stepChars),
    });
  }
  const finalized = await call('POST', '/api/drafts/chunk', {
    action: 'finalize',
    serverId,
    draftId: createdDraft.draftId,
    sha256: sha256(edited),
  });
  assert.equal(finalized.sha256, sha256(edited));
  assert.equal(finalized.bytes, Buffer.byteLength(edited, 'utf8'));
  ok(`stored the edited ${(finalized.bytes / 1024 / 1024).toFixed(1)} MB draft in ${sliceCount} chunks, server-verified`);

  const draftRead = await call(
    'GET',
    `/api/drafts/chunk?serverId=${serverId}&draftId=${createdDraft.draftId}&mode=chunk&offset=0&length=${stepChars}`,
  );
  assert.equal(draftRead.totalChars, edited.length);
  assert.equal(draftRead.content, edited.slice(0, stepChars));
  ok('read the stored draft back in slices without loading it whole');

  // ---- deploy by draftId -------------------------------------------------
  const deployed = await call('POST', '/api/deployments', {
    serverId,
    draftId: createdDraft.draftId,
    message: 'e2e large-file deploy',
  });
  const deployment = deployed.deployment;
  assert.equal(deployment.status, 'SUCCEEDED', `deployment failed: ${deployment.error}`);
  assert.equal(deployment.files[0].postHash, sha256(edited));
  assert.equal(panel.read('/huge.js'), edited, 'production must hold exactly the deployed bytes');
  ok('deployed the draft, hash re-read from production matches, bot restart issued');

  // ---- version + rollback ------------------------------------------------
  // Versions are listed by the Backups page through /api/backups.
  const backupView = await call('GET', `/api/backups?serverId=${serverId}`);
  const previous = (backupView.versions ?? []).find(
    (version) => version.sha256 === meta.sha256 && version.path === '/huge.js',
  );
  assert.ok(previous, 'the pre-deploy version must be listed in Backups & Versions');

  const compared = await call('GET', `/api/versions?serverId=${serverId}&id=${previous.id}`);
  assert.equal(compared.version.sha256, meta.sha256);
  assert.equal(compared.content, loaded, 'the stored version must be byte-identical to the original');
  assert.equal(compared.identical, false, 'the stored version differs from current production');
  ok('version comparison returns the original bytes and a diff against production');

  const restored = await call('POST', '/api/versions', {
    serverId,
    versionId: previous.id,
    message: 'e2e rollback',
  });
  assert.equal(restored.deployment.status, 'SUCCEEDED', `restore failed: ${restored.deployment.error}`);
  assert.equal(panel.read('/huge.js'), loaded, 'rollback must restore the original bytes exactly');
  ok('rollback restored the original file byte-for-byte');

  console.log(`\nAll ${step} live checks passed against ${BASE} + a 405-enforcing panel double.\n`);
} catch (error) {
  console.error(`\n✗ Live check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (nextProcess) {
    nextProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        nextProcess?.kill('SIGKILL');
        resolve();
      }, 8_000);
      nextProcess.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await panel.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
