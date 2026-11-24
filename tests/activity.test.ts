/**
 * Activity Logs tests.
 *
 * These drive the real read service and the real write path against an embedded
 * PostgreSQL (PGlite). They assert pagination/scope behaviour rather than that
 * "some rows came back": a total that disagrees with the page, or a filter that
 * silently leaks another server's history, is the failure mode that matters.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-activity-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

const { query } = await import('../src/lib/db.ts');
const { logActivity } = await import('../src/lib/audit.ts');
const { listActivity, activityFacets, activitySummary } = await import('../src/lib/services/activity.ts');
const { serversVisibleTo } = await import('../src/lib/servers/repo.ts');

const OWNER = {
  id: 'owner-activity',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'owner' as const,
  permissions: [],
};
const OPERATOR = {
  id: 'operator-activity',
  email: 'operator@example.com',
  name: 'Operator',
  role: 'operator' as const,
  permissions: [],
};

await query(
  `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,'owner')
   on conflict (id) do nothing`,
  [OWNER.id, OWNER.email, OWNER.name, 'not-a-real-hash'],
);
await query(
  `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,'operator')
   on conflict (id) do nothing`,
  [OPERATOR.id, OPERATOR.email, OPERATOR.name, 'not-a-real-hash'],
);

const { createServer } = await import('../src/lib/servers/repo.ts');

const alpha = await createServer(
  { name: 'Alpha', panelUrl: 'https://panel.example', serverIdentifier: 'srv-alpha', apiKey: 'ptlc_test_key_value' },
  OWNER,
);
const beta = await createServer(
  { name: 'Beta', panelUrl: 'https://panel.example', serverIdentifier: 'srv-beta', apiKey: 'ptlc_test_key_value' },
  OWNER,
);
const serverA = alpha.id;
const serverB = beta.id;

// A grant for the operator on Alpha only — the visibility scope asserted below.
await query(
  `insert into server_permissions (id, server_id, user_id, permissions) values ($1,$2,$3,'[]'::jsonb)
   on conflict do nothing`,
  [`perm-activity-${Math.random().toString(16).slice(2)}`, serverA, OPERATOR.id],
);

test('the write path records the actor, the target and structured detail', async () => {
  await logActivity({
    user: { id: OWNER.id, email: OWNER.email },
    serverId: serverA,
    action: 'activity.test.write',
    target: '/data/commands/menu.js',
    severity: 'warning',
    detail: { bytes: 1204, reason: 'unit test' },
  });

  const page = await listActivity({ serverId: serverA, action: 'activity.test.write' });
  assert.equal(page.total, 1, 'exactly one row for the filtered action');
  const event = page.events[0];
  assert.equal(event.action, 'activity.test.write');
  assert.equal(event.target, '/data/commands/menu.js');
  assert.equal(event.severity, 'warning');
  assert.equal(event.userEmail, OWNER.email);
  assert.equal(event.serverName, 'Alpha', 'the join resolves the server name');
  assert.equal((event.detail as { bytes: number }).bytes, 1204);
});

test('total matches the filtered set, and limit/offset paginate without overlap', async () => {
  for (let index = 0; index < 7; index += 1) {
    await logActivity({
      user: { id: OWNER.id, email: OWNER.email },
      serverId: serverA,
      action: 'activity.test.page',
      target: `file-${index}.js`,
    });
  }

  const first = await listActivity({ serverId: serverA, action: 'activity.test.page', limit: 3, offset: 0 });
  const second = await listActivity({ serverId: serverA, action: 'activity.test.page', limit: 3, offset: 3 });
  assert.equal(first.total, 7);
  assert.equal(second.total, 7, 'the total describes the whole filter, not the page');
  assert.equal(first.events.length, 3);
  assert.equal(second.events.length, 3);
  const ids = new Set([...first.events, ...second.events].map((event) => event.id));
  assert.equal(ids.size, 6, 'no row appears on two pages');

  // Newest first: the last written target leads the first page.
  assert.equal(first.events[0].target, 'file-6.js');
});

test('the limit is clamped, so one request cannot pull the whole table', async () => {
  const page = await listActivity({ serverId: serverA, limit: 100_000 });
  assert.ok(page.limit <= 200, `limit ${page.limit} must be clamped`);
  assert.ok(page.events.length <= 200);
});

test('severity and action-family filters narrow the set', async () => {
  await logActivity({ serverId: serverA, action: 'file.write', target: 'a.js', severity: 'info' });
  await logActivity({ serverId: serverA, action: 'file.delete', target: 'b.js', severity: 'critical' });
  await logActivity({ serverId: serverA, action: 'deploy.run', target: 'c.js', severity: 'info' });

  const critical = await listActivity({ serverId: serverA, severity: 'critical' });
  assert.ok(critical.events.every((event) => event.severity === 'critical'));
  assert.equal(critical.total, 1);

  const filesOnly = await listActivity({ serverId: serverA, action: 'file.' });
  assert.equal(filesOnly.total, 2, 'the family form `file.` matches file.write and file.delete');
  assert.ok(filesOnly.events.every((event) => event.action.startsWith('file.')));
});

test('search is case-insensitive across action, target, actor and detail', async () => {
  await logActivity({
    user: { id: OWNER.id, email: OWNER.email },
    serverId: serverA,
    action: 'editor.save',
    target: 'Commands/MENU.js',
  });
  await logActivity({ serverId: serverA, action: 'editor.save', target: 'other.js', detail: { note: 'MENU handler' } });

  // Scoped to the editor.save rows this test wrote: the older write-path test
  // also recorded a `menu.js` target, so the unfiltered term legitimately matches more.
  const byTarget = await listActivity({ serverId: serverA, action: 'editor.save', q: 'menu' });
  assert.equal(byTarget.total, 2, 'target match + detail match, case-insensitively');

  // A literal % must not behave like a wildcard.
  const literal = await listActivity({ serverId: serverA, q: '%' });
  assert.equal(literal.total, 0);
});

test('an operator only sees activity for servers they hold a grant for', async () => {
  await logActivity({ serverId: serverB, action: 'secret.action', target: 'beta-only' });

  const visible = (await serversVisibleTo(OPERATOR)).map((server) => server.id);
  assert.deepEqual(visible, [serverA], 'the operator has a grant on Alpha only');

  const scoped = await listActivity({ serverIds: visible, q: 'secret.action' });
  assert.equal(scoped.total, 0, 'Beta history must not leak through the aggregate scope');

  const owner = await listActivity({ q: 'secret.action' });
  assert.equal(owner.total, 1, 'an owner sees every server');
});

test('facets count the scope, not just the current selection', async () => {
  const facets = await activityFacets({ serverId: serverA });
  const actions = facets.actions.map((facet) => facet.action);
  assert.ok(actions.includes('file.write'));
  assert.ok(actions.includes('activity.test.page'));
  const severities = new Map(facets.severities.map((entry) => [entry.severity, entry.count]));
  assert.ok((severities.get('critical') ?? 0) >= 1);
  assert.ok((severities.get('info') ?? 0) >= 1);
  assert.equal(facets.servers[0].serverName, 'Alpha');
});

test('the summary counters describe the last 24 hours and the whole set', async () => {
  const summary = await activitySummary(serverA);
  assert.ok(summary.last24h > 0);
  assert.ok(summary.warnings24h >= 1, 'the warning row written above is inside the window');
  assert.ok(summary.lastEventAt, 'the newest timestamp is reported');
  const older = await activitySummary(serverB);
  assert.equal(older.warnings24h, 0);
});

test('an empty visibility scope yields account-level events only, never everything', async () => {
  await logActivity({ action: 'auth.login', target: OWNER.email });
  await logActivity({ serverId: serverA, action: 'auth.login', target: 'server-scoped' });

  const none = await listActivity({ serverIds: [], q: 'auth.login' });
  assert.equal(none.total, 1, 'only the row with a null server_id is visible');
  assert.equal(none.events[0].serverId, null);
});
