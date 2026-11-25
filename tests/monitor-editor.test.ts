/**
 * Monitor, power and large-file editor tests.
 *
 * The panel double here enforces the real HTTP verbs (it answers 405 to a wrong
 * one), so the regression that produced "Request failed (405)" — a browser or
 * backend calling an endpoint with a verb the panel does not implement — fails
 * this suite instead of only failing in production.
 *
 * It also serves a real Pterodactyl-style websocket, so console attach, JWT auth
 * and live output are exercised rather than assumed.
 *
 * This is a protocol-accurate harness, not your panel. Permissions on your own
 * account still have to be confirmed with Settings → Test connection.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMockPanel } from './mock-pterodactyl.mjs';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-monitor-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';
delete process.env.DARKNOTE_BOT_STATUS_PATH;

/** A >2 MB JavaScript file: the size the old editor refused to open. */
function largeSource(bytes: number): string {
  const lines = [
    '#!/usr/bin/env node',
    "'use strict';",
    '// A large generated command module, roughly the shape of BIGBRO.js.',
    'const handlers = new Map();',
  ];
  // Track the length incrementally: re-joining the buffer on every iteration is
  // quadratic and made the fixture take minutes for a 3 MB file.
  let length = lines.join('\n').length;
  let index = 0;
  while (length < bytes) {
    const line = `handlers.set('command_${index}', async (conn, m) => { await m.reply('reply ${index}'); });`;
    lines.push(line);
    length += line.length + 1;
    index += 1;
  }
  lines.push('module.exports = { handlers };', '');
  return lines.join('\n');
}

const HUGE = largeSource(3 * 1024 * 1024);

const panel = await createMockPanel({
  identifier: 'abc12345',
  seed: { '/huge.js': HUGE },
}).start();

const { createServer, getServer, updateServer } = await import('../src/lib/servers/repo.ts');
const { query } = await import('../src/lib/db.ts');
const { sha256 } = await import('../src/lib/crypto.ts');
const { editorLimitFor, fetchRemoteFile, readFileCached, writeProductionFile } = await import(
  '../src/lib/files/service.ts'
);
const { attachConsole, detachConsole, consoleBuffer, power, refreshStatus } = await import(
  '../src/lib/services/console.ts'
);
const { buildMonitor } = await import('../src/lib/views.ts');
const { env } = await import('../src/lib/env.ts');
const { getVersion, readVersionText, listVersions } = await import('../src/lib/versions.ts');

const principal = { id: 'test-admin-2', email: 'monitor@example.com', name: 'Monitor', role: 'owner' as const, permissions: [] };
let serverId = '';

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('register the panel', async () => {
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
});

test('resources come from the panel, not from defaults', async () => {
  const server = await getServer(serverId);
  const status = await refreshStatus(server!);
  assert.equal(status.containerState, 'running');
  assert.equal(status.cpuPercent, 12.5);
  assert.equal(status.memoryBytes, 268435456);
  assert.equal(status.memoryLimitBytes, 1073741824);
  assert.equal(status.diskBytes, 52428800);
  assert.equal(status.uptimeMs, 3_600_000);
  // No console event yet, so WhatsApp must be unknown — never inferred from the
  // container being up.
  assert.equal(status.whatsappState, 'unknown');
  assert.equal(status.whatsappSource, 'none');
});

test('power actions use POST /api/client/servers/{id}/power with the right body', async () => {
  const server = await getServer(serverId);
  const before = panel.powers.length;

  await power(server!, 'restart');
  const restart = panel.powers.at(-1);
  assert.equal(panel.powers.length, before + 1);
  assert.equal(restart?.signal, 'restart');
  assert.equal(restart?.method, 'POST', 'a non-POST power call would be answered 405 by the panel');
  assert.equal(restart?.path, `/api/client/servers/${panel.identifier}/power`);
  assert.equal(panel.containerState, 'running');

  await power(server!, 'stop');
  const stop = panel.powers.at(-1);
  assert.equal(stop?.signal, 'stop');
  assert.equal(stop?.method, 'POST');
  assert.equal(panel.containerState, 'offline', 'stop must actually change the container state');

  await power(server!, 'start');
  const start = panel.powers.at(-1);
  assert.equal(start?.signal, 'start');
  assert.equal(start?.method, 'POST');
  assert.equal(panel.containerState, 'running');

  // Every power call the client made went out as POST; a GET/PUT/PATCH would
  // have produced 405 and no entry in panel.powers at all.
  const powerCalls = panel.calls.filter((call: { path: string }) => call.path.endsWith('/power'));
  assert.ok(powerCalls.length >= 3);
  assert.deepEqual([...new Set(powerCalls.map((call: { method: string }) => call.method))], ['POST']);
});

test('console websocket authenticates and streams live output', async () => {
  const server = await getServer(serverId);
  detachConsole(serverId);
  attachConsole(server!);

  await waitFor(() => consoleBuffer(serverId).state === 'live', 10_000, 'console auth success');
  await waitFor(
    () => consoleBuffer(serverId).lines.some((line) => /Connected to WhatsApp/i.test(line)),
    10_000,
    'console output',
  );
  assert.ok(panel.wsConnections >= 1, 'the panel must have received a websocket connection');

  const monitor = await buildMonitor(server!);
  assert.equal(monitor.panel.reachable, true);
  assert.equal(monitor.panel.state, 'running');
  assert.ok(monitor.console.lines.length > 0, 'the monitor must show the console tail');
  // WhatsApp comes from this bot process's own console event, and it says so.
  assert.equal(monitor.bot.whatsapp, 'connected');
  assert.equal(monitor.bot.whatsappSource, 'console-event');

  panel.emitConsole('Connection closed. Reconnecting to WhatsApp (stream errored)');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterDrop = await buildMonitor(server!);
  assert.equal(afterDrop.bot.whatsapp, 'disconnected');

  // A new bot process invalidates the previous process's verdict.
  panel.emitConsole('DARKNOTE L2 starting');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterRestart = await buildMonitor(server!);
  assert.equal(afterRestart.bot.whatsapp, 'unknown', 'events from the previous process must not carry over');
});

test('a file larger than 2 MB opens completely and hashes correctly', async () => {
  const server = await getServer(serverId);
  const snapshot = await fetchRemoteFile(server!, '/huge.js');
  assert.ok(snapshot.sizeBytes > 2 * 1024 * 1024, `expected >2 MB, got ${snapshot.sizeBytes}`);
  assert.equal(snapshot.content, HUGE, 'the editor bytes must match production exactly');
  assert.equal(snapshot.sha256, sha256(HUGE));

  // Chunked reads must reassemble to the same string the panel holds.
  const cached = await readFileCached(server!, '/huge.js');
  const step = env.editorChunkBytes;
  const parts: string[] = [];
  for (let offset = 0; offset < cached.content.length; offset += step) {
    parts.push(cached.content.slice(offset, offset + step));
  }
  const rejoined = parts.join('');
  assert.equal(rejoined.length, cached.content.length);
  assert.equal(rejoined, HUGE, 'chunk boundaries must not corrupt or drop characters');
  assert.equal(sha256(rejoined), snapshot.sha256);
});

test('saving a large file preserves every byte and keeps a restorable backup', async () => {
  const server = await getServer(serverId);
  const before = await fetchRemoteFile(server!, '/huge.js');
  const edited = `${before.content}// tail added by the large-file editor\n`;

  const result = await writeProductionFile({
    server: server!,
    path: '/huge.js',
    content: edited,
    expectedHash: before.sha256,
    userId: principal.id,
    note: 'large file save',
  });

  assert.equal(result.hash, sha256(edited));
  assert.equal(panel.read('/huge.js'), edited, 'production must hold exactly the saved bytes');
  assert.ok(panel.read('/huge.js')!.length > 2 * 1024 * 1024);
  assert.ok(result.backupId, 'a backup must exist before the write');
  assert.equal(result.atomic, true);

  const versions = await listVersions(serverId, { path: '/huge.js' });
  const previous = versions.find((version) => version.sha256 === before.sha256);
  assert.ok(previous, 'the pre-write version must be recorded');
  const restored = await readVersionText(await getVersion(serverId, previous!.id));
  assert.equal(restored, before.content, 'the backup must be byte-identical to the original');
});

test('the editor limit is per server and clamped by the process ceiling', async () => {
  const server = await getServer(serverId);
  assert.equal(editorLimitFor(server!), 16 * 1024 * 1024, 'the default must not be 2 MB');

  await updateServer(serverId, { maxFileBytes: 1 * 1024 * 1024 });
  assert.equal(editorLimitFor((await getServer(serverId))!), 1 * 1024 * 1024);

  await updateServer(serverId, { maxFileBytes: 512 * 1024 * 1024 });
  const clamped = await getServer(serverId);
  assert.equal(editorLimitFor(clamped!), env.maxEditorBytes, 'a per-server limit can never exceed the ceiling');
});

test('BIGBRO.js (391 KB) is returned byte-for-byte, exactly as the panel holds it', async () => {
  const server = await getServer(serverId);
  const source = largeSource(391 * 1024);
  panel.externalEdit('/BIGBRO.js', source);

  const snapshot = await fetchRemoteFile(server!, '/BIGBRO.js');
  assert.equal(snapshot.content, source, 'every byte of the source must reach the editor');
  assert.equal(snapshot.content.length, source.length);
  assert.equal(snapshot.sha256, sha256(source));
  assert.ok(
    snapshot.sizeBytes > 390 * 1024 && snapshot.sizeBytes < 400 * 1024,
    `expected ~391 KB, got ${snapshot.sizeBytes} bytes`,
  );
  // The size the editor header prints comes from these bytes, so it must agree
  // with the file content rather than with a stale index row.
  assert.equal(snapshot.sizeBytes, Buffer.byteLength(source, 'utf8'));
});

test('a 200 with an empty body is an error, never a blank editor', async () => {
  const server = await getServer(serverId);
  panel.breakBody('/BIGBRO.js', true);
  try {
    await assert.rejects(
      () => fetchRemoteFile(server!, '/BIGBRO.js'),
      (error: { code?: string; message?: string }) => {
        assert.equal(error.code, 'empty_body');
        assert.match(String(error.message), /came back empty/);
        return true;
      },
    );
  } finally {
    panel.breakBody('/BIGBRO.js', false);
  }

  const recovered = await fetchRemoteFile(server!, '/BIGBRO.js');
  assert.ok(recovered.content.length > 390 * 1024, 'the file must open again once the body returns');
});

test('a non-UTF-8 file is refused instead of being silently mangled', async () => {
  const server = await getServer(serverId);
  // 0xE9 is Latin-1 "é" and is not a valid UTF-8 sequence on its own.
  panel.files.set('/legacy.js', {
    content: Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a]),
    mtime: new Date().toISOString(),
  });
  await assert.rejects(
    () => fetchRemoteFile(server!, '/legacy.js'),
    (error: { code?: string }) => error.code === 'not_utf8_text',
  );
});

test('an empty buffer is refused server-side before it can erase a file', async () => {
  const server = await getServer(serverId);
  const before = panel.read('/index.js');
  assert.ok(before && before.length > 0);

  await assert.rejects(
    () =>
      writeProductionFile({
        server: server!,
        path: '/index.js',
        content: '',
        expectedHash: sha256(before!),
        userId: principal.id,
        note: 'empty write test',
      }),
    (error: { code?: string }) => error.code === 'empty_write_blocked',
  );

  assert.equal(panel.read('/index.js'), before, 'production must still hold the original bytes');
});

test('deploying the 391 KB file preserves every byte and stays restorable', async () => {
  const server = await getServer(serverId);
  const before = await fetchRemoteFile(server!, '/BIGBRO.js');
  const edited = `${before.content}
// edited from the code editor\n`;

  const result = await writeProductionFile({
    server: server!,
    path: '/BIGBRO.js',
    content: edited,
    expectedHash: before.sha256,
    userId: principal.id,
    note: 'editor deploy test',
  });

  assert.equal(result.hash, sha256(edited));
  assert.equal(panel.read('/BIGBRO.js'), edited, 'production must hold the complete edited file');
  assert.ok(panel.read('/BIGBRO.js')!.length > 390 * 1024, 'the deploy must not truncate the file');

  const versions = await listVersions(serverId, { path: '/BIGBRO.js' });
  const previous = versions.find((version) => version.sha256 === before.sha256);
  assert.ok(previous, 'the pre-deploy content must be backed up');
  const restored = await readVersionText(await getVersion(serverId, previous!.id));
  assert.equal(restored, before.content, 'the backup must be byte-identical to the original');
});

test.after(async () => {
  detachConsole(serverId);
  await panel.stop();
});
