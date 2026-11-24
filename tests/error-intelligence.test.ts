/**
 * Error Intelligence tests.
 *
 * These drive the real diagnosis rules, the real route introspection and the
 * real store against an embedded PostgreSQL (PGlite). They assert specific
 * explanations, not merely that "an error was recorded".
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-errors-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';
delete process.env.DARKNOTE_AI_API_KEY;

const { diagnose, fingerprintFor } = await import('../src/lib/errors/taxonomy.ts');
const { lookupApiRoute, pageExists } = await import('../src/lib/errors/routes.ts');
const { parseConsoleLine, parseStack, extractModuleName } = await import('../src/lib/errors/parse.ts');
const { recordError, listErrors, getError, setErrorStatus, errorStats } = await import('../src/lib/errors/store.ts');
const { buildProposal, applyRepair } = await import('../src/lib/errors/repair.ts');
const { query, queryOne } = await import('../src/lib/db.ts');
const { createServer } = await import('../src/lib/servers/repo.ts');

const principal = {
  id: 'owner-1',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'owner' as const,
  permissions: [],
};

// connected_servers.created_by is a real foreign key.
await query(
  `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,'owner')
   on conflict (id) do nothing`,
  [principal.id, principal.email, principal.name, 'not-a-real-hash'],
);

test('HTTP 405 names the route file and the missing verb', () => {
  const route = lookupApiRoute('/api/errors');
  assert.equal(route.exists, true);
  assert.ok(route.uploadedMethods.includes('GET'));
  assert.ok(!route.uploadedMethods.includes('POST'), 'the errors feed must not export POST');

  const diagnosis = diagnose(
    {
      message: 'Request failed (405)',
      source: 'api',
      endpoint: '/api/errors',
      httpMethod: 'POST',
      httpStatus: 405,
    },
    { route },
  );

  assert.match(diagnosis.title, /POST \/api\/errors is not handled/);
  assert.equal(diagnosis.filePath, 'src/app/api/errors/route.ts');
  assert.match(diagnosis.rootCause, /exports GET only|exports GET/);
  assert.match(diagnosis.recommendation, /export/);
  assert.equal(diagnosis.repairKind, 'add_http_method');
  assert.equal(diagnosis.severity, 'moderate');
});

test('a 405 on a route that does export the verb is attributed to the panel, not Next.js', () => {
  const route = lookupApiRoute('/api/monitor');
  assert.ok(route.uploadedMethods.includes('POST'));
  const diagnosis = diagnose(
    {
      message: 'Pterodactyl answered 405',
      source: 'panel',
      endpoint: '/api/monitor',
      httpMethod: 'POST',
      httpStatus: 405,
    },
    { route },
  );
  assert.match(diagnosis.title, /rejected with 405 upstream/);
  assert.match(diagnosis.rootCause, /did not come from Next\.js|upstream Pterodactyl/);
});

test('a missing dependency is explained with the package name and the install path', () => {
  const diagnosis = diagnose(
    {
      message: "Error: Cannot find module 'whatsapp-web.js'",
      source: 'console',
      code: 'MODULE_NOT_FOUND',
    },
    { project: { hasNodeModules: false, hasPackageJson: true, paths: [] } },
  );
  assert.match(diagnosis.title, /whatsapp-web\.js/);
  assert.equal(diagnosis.source, 'packages');
  assert.match(diagnosis.why, /node_modules/);
  assert.equal(diagnosis.repairKind, 'install_dependencies');
  assert.equal(diagnosis.repairAuthority, 'approval');
  assert.equal(extractModuleName("Cannot find module 'left-pad'"), 'left-pad');
});

test('a WhatsApp logout is distinguished from a network drop', () => {
  const logout = diagnose({
    message: 'Connection closed: logged out (401 device removed)',
    source: 'whatsapp',
  });
  assert.equal(logout.code, 'WHATSAPP_LOGGED_OUT');
  assert.equal(logout.severity, 'critical');
  assert.match(logout.recommendation, /Linked devices|pairing/i);

  const drop = diagnose({
    message: 'Connection closed, stream errored, reconnecting',
    source: 'whatsapp',
  });
  assert.equal(drop.code, 'WHATSAPP_CONNECTION_DROPPED');
  assert.equal(drop.repairKind, 'restart_bot');
});

test('npm resolution failures are classified separately from missing modules', () => {
  const diagnosis = diagnose({
    message: 'npm ERR! code ERESOLVE unable to resolve dependency tree: peer dep conflict',
    source: 'packages',
  });
  assert.equal(diagnosis.code, 'ERESOLVE');
  assert.match(diagnosis.recommendation, /legacy-peer-deps/);
});

test('stack parsing finds the first project frame, not node internals', () => {
  const location = parseStack(
    [
      'TypeError: Cannot read properties of undefined',
      '    at Object.<anonymous> (node:internal/modules/cjs/loader:1234:10)',
      '    at handleCommand (/data/plugins/menu.js:42:17)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  );
  assert.equal(location.filePath, '/data/plugins/menu.js');
  assert.equal(location.line, 42);
  assert.equal(location.column, 17);
  assert.equal(location.functionName, 'handleCommand');

  const parsed = parseConsoleLine('[12:01:02] SyntaxError: Unexpected token } at /data/main.js:18:3');
  assert.equal(parsed.isError, true);
  assert.equal(parsed.location.filePath, '/data/main.js');
  assert.equal(parsed.location.line, 18);
});

test('an unknown failure states that it could not be classified and invents nothing', () => {
  const diagnosis = diagnose({ message: 'Kernel panic in the toaster subroutine', source: 'console' });
  assert.equal(diagnosis.code, 'UNCLASSIFIED');
  assert.match(diagnosis.title, /unclassified/);
  assert.match(diagnosis.rootCause, /did not match any known signature/);
  assert.equal(diagnosis.repairAuthority, 'none');
});

test('fingerprints are stable across timestamps and ids', () => {
  const a = diagnose({ message: 'Error: timeout at 2026-11-19T10:00:00Z id 550e8400-e29b-41d4-a716-446655440000', source: 'console' });
  const b = diagnose({ message: 'Error: timeout at 2026-11-20T11:22:33Z id 550e8400-e29b-41d4-a716-446655440001', source: 'console' });
  const fa = fingerprintFor({ message: 'Error: timeout at 2026-11-19T10:00:00Z id 550e8400-e29b-41d4-a716-446655440000', source: 'console' }, a);
  const fb = fingerprintFor({ message: 'Error: timeout at 2026-11-20T11:22:33Z id 550e8400-e29b-41d4-a716-446655440001', source: 'console' }, b);
  assert.equal(fa, fb);
});

test('the store deduplicates repeats, reopens resolved problems and filters', async () => {
  const first = await recordError({
    message: 'Error: Cannot find module "axios"',
    source: 'console',
    code: 'MODULE_NOT_FOUND',
  });
  assert.ok(first);
  const second = await recordError({
    message: 'Error: Cannot find module "axios"',
    source: 'console',
    code: 'MODULE_NOT_FOUND',
  });
  assert.equal(second?.id, first?.id);
  assert.equal(second?.occurrences, 2);

  const resolved = await setErrorStatus(first!.id, 'resolved', { id: 'owner-1', email: 'owner@example.com' }, 'fixed');
  assert.equal(resolved?.status, 'resolved');

  const again = await recordError({
    message: 'Error: Cannot find module "axios"',
    source: 'console',
    code: 'MODULE_NOT_FOUND',
  });
  assert.equal(again?.status, 'active', 'a regression reopens the record');
  assert.equal(again?.occurrences, 3);

  const filtered = await listErrors({ q: 'axios', status: 'active' });
  assert.equal(filtered.errors.length, 1);
  assert.equal(filtered.total, 1);

  const stats = await errorStats();
  assert.ok(stats.active >= 1);
  assert.ok(stats.bySource.some((entry) => entry.source === 'packages'));
});

test('repair proposals respect authority and never write on propose', async () => {
  const server = await createServer(
    {
      name: 'Repair target',
      panelUrl: 'https://panel.invalid',
      serverIdentifier: 'abc123',
      apiKey: 'ptlc_test_key_value',
    },
    principal,
  );

  const error = await recordError({
    message: 'Deployment lock is held by another run',
    source: 'deployment',
    serverId: server.id,
    code: 'deployment_locked',
  });
  assert.ok(error);
  assert.equal(error?.repairAuthority, 'safe');

  const lockProposal = await buildProposal(error!, principal as never);
  assert.equal(lockProposal.proposal?.state, 'blocked', 'no expired lock exists, so the repair is blocked');

  const restart = await recordError({
    message: 'WhatsApp connection closed, reconnecting',
    source: 'whatsapp',
    serverId: server.id,
  });
  const restartProposal = await buildProposal(restart!, principal as never);
  assert.equal(restartProposal.authority, 'approval');
  assert.ok(restartProposal.proposal?.steps.some((step) => step.key === 'power'));

  // Refuses without the typed confirmation.
  await assert.rejects(
    () => applyRepair({ ...restart!, repair: restartProposal }, principal as never, { action: 'apply', confirm: 'yes' }),
    /Type RESTART/,
  );

  // A read-only role cannot authorise a production repair.
  const viewer = { id: 'v', email: 'v@example.com', name: 'V', role: 'viewer' as const, permissions: [] };
  await assert.rejects(
    () => applyRepair({ ...restart!, repair: restartProposal }, viewer as never, { action: 'apply', confirm: 'RESTART' }),
    /permission|authorisation|does not include/,
  );

  const stored = await queryOne<{ occurrences: number }>('select occurrences from error_intel_events where id = $1', [error!.id]);
  assert.equal(Number(stored?.occurrences), 1);
});

test('a file patch is validated before it can be proposed', async () => {
  const server = await queryOne<{ id: string }>('select id from connected_servers limit 1');
  assert.ok(server);

  const error = await recordError({
    message: 'Syntax error in main.js',
    source: 'console',
    serverId: server!.id,
    filePath: '/main.js',
  });
  assert.ok(error);

  const patchError = { ...error!, repairKind: 'file_patch', repairAuthority: 'approval' as const };
  const blocked = await buildProposal(patchError, principal as never, {
    path: '/broken.json',
    content: '{"a": 1,}',
  });
  assert.equal(blocked.proposal?.state, 'blocked');
  assert.ok(blocked.proposal?.validationErrors?.some((line) => /Invalid JSON/i.test(line)));

  const valid = await buildProposal(patchError, principal as never, {
    path: '/config.json',
    content: '{"a":1}',
  });
  assert.equal(valid.proposal?.state, 'proposed');
  assert.equal(valid.authority, 'approval');
  assert.ok(valid.proposal?.steps.some((step) => step.key === 'backup'));

  await assert.rejects(
    () => applyRepair({ ...error!, repair: valid }, principal as never, { action: 'apply', confirm: 'DEPLOY' }),
    /server|panel|connect|fetch|decrypt/i,
  );

  const rows = await query('select id from deployments');
  assert.equal(rows.length, 0, 'no deployment was created by a failed apply');
});

test('the navigation helper sees the pages this build actually ships', () => {
  assert.equal(pageExists('/errors'), true);
  assert.equal(pageExists('/bigbrother'), true);
  assert.equal(pageExists('/definitely-not-a-page'), false);
  const route = lookupApiRoute('/api/bigbrother/chat');
  assert.equal(route.exists, true);
  assert.ok(route.uploadedMethods.includes('POST'));
});
