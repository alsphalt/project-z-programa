/**
 * End-to-end pipeline test.
 *
 * Runs the real services against a Pterodactyl-shaped panel to prove the
 * mechanics that matter: discovery indexes what the server actually has, an
 * edit is refused when production moved underneath it, a write is backed up and
 * hash-verified, a deployment restarts the bot, and downloads are served from
 * freshly-read production bytes.
 *
 * It is a harness, not a live-panel verification: your panel's permissions and
 * quirks still have to be confirmed with the capability test in Admin Settings.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMockPanel } from './mock-pterodactyl.mjs';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-test-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

const panel = await createMockPanel({ identifier: 'abc12345' }).start();

const { createServer, getServer } = await import('../src/lib/servers/repo.ts');
const { scanServer } = await import('../src/lib/services/discovery.ts');
const { fetchRemoteFile, writeProductionFile, fileHistory } = await import('../src/lib/files/service.ts');
const { deployChanges, rollbackDeployment } = await import('../src/lib/services/deploy.ts');
const { downloadOne } = await import('../src/lib/services/downloads.ts');
const { sha256 } = await import('../src/lib/crypto.ts');
const { query } = await import('../src/lib/db.ts');
const { buildMonitor } = await import('../src/lib/views.ts');

const principal = { id: 'test-admin-1', email: 'tester@example.com', name: 'Tester', role: 'owner' as const, permissions: [] };
let serverId = '';

test('connect and register the panel', async () => {
  // The real account row is required: connected_servers.created_by is a FK.
  await query(
    `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,'owner')
     on conflict (id) do nothing`,
    [principal.id, principal.email, principal.name, 'not-a-real-hash'],
  );

  const server = await createServer(
    {
      name: 'Darknote L2',
      panelUrl: panel.baseUrl,
      serverIdentifier: panel.identifier,
      apiKey: panel.apiKey,
      projectRoot: '/',
      startupTimeoutS: 2,
      syncIntervalS: 300,
    },
    principal,
  );
  serverId = server.id;
  assert.ok(server.id);
  assert.match(server.panelUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('discovery indexes the real files and skips protected paths', async () => {
  const server = await getServer(serverId);
  assert.ok(server);
  const result = await scanServer({ server, mode: 'manual', user: principal });

  assert.ok(result.indexed >= 5, `expected several indexed files, got ${result.indexed}`);
  assert.ok(result.casesFound >= 3, `expected switch cases to be discovered, got ${result.casesFound}`);

  const indexed = await query<{ path: string }>('select path from file_indexes where server_id = $1 and deleted_at is null', [
    serverId,
  ]);
  const paths = indexed.map((row) => row.path);
  assert.ok(paths.includes('/BIGBRO.js'), 'BIGBRO.js should be indexed');
  assert.ok(paths.includes('/lib/msg.js'), 'lib files should be indexed');
  assert.ok(!paths.some((p) => p.startsWith('/auth/')), 'WhatsApp session folder must never be indexed');

  const cases = await query<{ name: string }>(
    "select name from command_metadata where server_id = $1 and kind = 'case' order by name",
    [serverId],
  );
  const names = cases.map((row) => row.name);
  for (const expected of ['menu', 'ping', 'play']) {
    assert.ok(names.includes(expected), `case '${expected}' should be discovered, got ${names.join(', ')}`);
  }
  // The scanner also reports the `default:` label, which is a real switch label.
  assert.ok(!names.includes('menu_typo'));
});

test('reading a protected path is refused', async () => {
  const server = await getServer(serverId);
  await assert.rejects(() => fetchRemoteFile(server!, '/auth/creds.json'), /secret/i);
  await assert.rejects(() => fetchRemoteFile(server!, '/.env'), /secret/i);
});

test('a stale expected hash blocks the write and leaves production untouched', async () => {
  const server = await getServer(serverId);
  const before = panel.read('/BIGBRO.js');
  await assert.rejects(
    () =>
      writeProductionFile({
        server: server!,
        path: '/BIGBRO.js',
        content: 'should never land',
        expectedHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        userId: principal.id,
      }),
    /changed since you opened/i,
  );
  assert.equal(panel.read('/BIGBRO.js'), before, 'production must be unchanged after a refused write');
});

test('an approved write is backed up, hash-verified and versioned', async () => {
  const server = await getServer(serverId);
  const snapshot = await fetchRemoteFile(server!, '/index.js');
  const next = `const { handleMessage } = require('./BIGBRO');\nconsole.log('DARKNOTE L2 starting v2');\n`;

  const result = await writeProductionFile({
    server: server!,
    path: '/index.js',
    content: next,
    expectedHash: snapshot.sha256,
    userId: principal.id,
    note: 'test edit',
  });

  assert.equal(result.hash, sha256(next));
  assert.ok(result.backupId, 'a backup id must be recorded');
  assert.equal(panel.read('/index.js'), next, 'the panel must hold the new bytes');
  assert.equal(sha256(panel.read('/index.js')!), result.hash, 'read-back hash must match');

  const history = await fileHistory(serverId, '/index.js');
  assert.ok(history.length >= 2, 'previous and new versions should both exist');
});

test('deployment restarts the bot and reports a real health verdict', async () => {
  const server = await getServer(serverId);
  const before = panel.powers.length;
  const outcome = await deployChanges({
    server: server!,
    user: principal,
    changes: [
      {
        path: '/lib/msg.js',
        content: "module.exports = { smsg: (m) => m, version: 2 };\n",
        expectedHash: null,
      },
    ],
    note: 'deploy test',
    restartMode: 'auto',
  });

  assert.equal(outcome.status, 'succeeded', `deployment failed: ${outcome.error}`);
  assert.ok(outcome.restarted, 'a code change should trigger a restart');
  assert.ok(panel.powers.length > before, 'the panel must have received a restart signal');
  assert.equal(panel.powers.at(-1)?.signal, 'restart');
  assert.equal(outcome.lockReleased, true, 'the deployment lock must be released');

  // Health is judged from the panel's own startup output. The harness serves a
  // real websocket, so "healthy" is legitimate here — but it must be backed by
  // observed lines, never assumed from the write succeeding.
  assert.ok(['healthy', 'unknown', 'timeout'].includes(outcome.health.verdict));
  if (outcome.health.verdict === 'healthy') {
    assert.equal(outcome.health.logs.length > 0, true, 'a healthy verdict needs observed console output');
  }
});

test('rollback restores only the files the deployment changed', async () => {
  const server = await getServer(serverId);
  const deployments = await query<{ id: string }>(
    "select id from deployments where server_id = $1 and status = 'succeeded' order by started_at desc limit 1",
    [serverId],
  );
  const deploymentId = deployments[0]?.id;
  assert.ok(deploymentId);

  const rollback = await rollbackDeployment({ server: server!, user: principal, deploymentId });
  assert.ok(rollback.restored.includes('/lib/msg.js'));
  assert.match(panel.read('/lib/msg.js')!, /smsg/);
  assert.doesNotMatch(panel.read('/lib/msg.js')!, /version: 2/);
});

test('downloads serve verified production bytes', async () => {
  const server = await getServer(serverId);
  const artifact = await downloadOne({ server: server!, path: '/BIGBRO.js', user: principal });
  assert.equal(artifact.sha256, sha256(panel.read('/BIGBRO.js')!));
  assert.equal(artifact.buffer.toString('utf8'), panel.read('/BIGBRO.js'));
});

test('a remote edit made in the panel is detected on the next scan', async () => {
  const server = await getServer(serverId);
  panel.externalEdit('/lib/msg.js', 'module.exports = { smsg: (m) => m, externallyEdited: true };\n');
  const result = await scanServer({ server: server!, mode: 'poll', user: principal });
  assert.ok(result.changed >= 1, 'the externally-edited file must be reported as changed');
});

test('monitor separates container state from WhatsApp state', async () => {
  const server = await getServer(serverId);
  const monitor = await buildMonitor(server!);
  assert.equal(monitor.panel.reachable, true);
  assert.equal(monitor.panel.state, 'running');
  // WhatsApp is reported separately from the container. It may only be a value
  // that was actually observed in this process's console output.
  assert.ok(['connected', 'disconnected', 'unknown'].includes(monitor.bot.whatsapp));
  if (monitor.bot.whatsappSource === 'none') {
    assert.equal(monitor.bot.whatsapp, 'unknown', 'a verdict without evidence is not allowed');
  }
});

test.after(async () => {
  await panel.stop();
});
