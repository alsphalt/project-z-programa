/**
 * GitHub → DARKNOTE synchronization.
 *
 * These assertions run the real engine against a temporary PostgreSQL (PGlite)
 * and a protocol-accurate GitHub double, so a pass means files really changed in
 * the working copy — not that a function returned `true`.
 *
 * Covered:
 *   - added, modified and deleted files arrive in one pull;
 *   - a file edited on both sides becomes a conflict and the local bytes are
 *     kept (nothing remote is overwritten);
 *   - the base commit only advances when the pull applied cleanly;
 *   - webhook signatures verify against the raw body and reject tampering;
 *   - a delivery is claimed once, so a GitHub retry cannot apply twice.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-ghsync-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

// @ts-expect-error the GitHub double is a plain .mjs module without types
const { createMockGitHub } = await import('./mock-github.mjs');

const github = await createMockGitHub({ files: { 'index.js': 'v1\n', 'old.js': 'remove me\n' } });
// The doubles listen on real ports; released so the runner can exit.
after(async () => {
  await github.close();
});
process.env.DARKNOTE_GITHUB_API_BASE = github.url;

const { createProject, replaceProjectFiles, getProject, getProjectFileByPath, updateProject, upsertProjectFile } = await import(
  '../src/lib/projects/repo.ts'
);
const { pullRemoteChanges } = await import('../src/lib/github/pull.ts');
const { saveToken, saveRepositoryConfig } = await import('../src/lib/github/credentials.ts');
const { verifyWebhookSignature, parsePushEvent, claimDelivery } = await import('../src/lib/github/webhook.ts');
const { query } = await import('../src/lib/db.ts');

function entry(content: string, remoteSha: string | null) {
  return {
    path: '',
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    sha256: null,
    content,
    isText: true,
    contentOmitted: false,
    remoteSha,
  };
}

await saveToken({ token: 'test-token-value' });
await saveRepositoryConfig({ owner: 'octocat', name: 'darknote-bot', branch: 'main' });

const project = await createProject({
  name: 'darknote-bot',
  source: 'github',
  sourceLabel: 'octocat/darknote-bot',
  github: {
    owner: github.state.owner,
    repo: github.state.repo,
    branch: github.state.branch,
    defaultBranch: github.state.branch,
    private: false,
    commitSha: github.state.head,
  },
});

await replaceProjectFiles(project.id, [
  { ...entry('v1\n', null), path: 'index.js' },
  { ...entry('remove me\n', null), path: 'old.js' },
]);

// ---------------------------------------------------------------- signatures

test('webhook signatures are verified against the raw body only', () => {
  const secret = 'the-signing-secret';
  const body = JSON.stringify({ ref: 'refs/heads/main' });
  const good = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

  assert.equal(verifyWebhookSignature(body, good, secret), true);
  assert.equal(verifyWebhookSignature(`${body} `, good, secret), false, 'a changed body must not verify');
  assert.equal(verifyWebhookSignature(body, good, `${secret}-other`), false, 'a different secret must not verify');
  assert.equal(verifyWebhookSignature(body, null, secret), false);
  assert.equal(verifyWebhookSignature(body, 'sha1=abc', secret), false);
  assert.equal(verifyWebhookSignature(body, good.slice(0, -2), secret), false);
});

test('only branch pushes are actionable', () => {
  const payload = {
    ref: 'refs/heads/main',
    after: 'abc123',
    repository: { full_name: 'octocat/darknote-bot', name: 'darknote-bot', owner: { login: 'octocat' } },
    head_commit: { message: 'fix: bot reply\n\nbody text' },
  };

  const push = parsePushEvent('push', payload, 'delivery-1');
  assert.ok(push);
  assert.equal(push.branch, 'main');
  assert.equal(push.commitSha, 'abc123');
  assert.equal(push.commitMessage, 'fix: bot reply', 'the subject line is what the panel shows');

  assert.equal(parsePushEvent('push', { ...payload, ref: 'refs/tags/v1' }, 'd'), null, 'tags are not branch pushes');
  assert.equal(parsePushEvent('push', { ...payload, deleted: true }, 'd'), null, 'a deleted branch is not a push');
  assert.equal(parsePushEvent('push', { ...payload, after: '0'.repeat(40) }, 'd'), null);
  assert.equal(parsePushEvent('ping', payload, 'd'), null);
});

test('a delivery id can only be claimed once', async () => {
  const first = await claimDelivery({ deliveryId: 'delivery-dedupe', event: 'push' });
  const second = await claimDelivery({ deliveryId: 'delivery-dedupe', event: 'push' });
  assert.equal(first, true, 'the first delivery is claimed');
  assert.equal(second, false, 'a GitHub retry must not be processed again');
});

// --------------------------------------------------------------------- pulls

test('a single pull applies additions, modifications and deletions', async () => {
  const before = await getProject(project.id);
  assert.equal(before?.baseCommitSha, github.state.head);

  github.pushRemotely({ 'index.js': 'v2\n', 'new.js': 'brand new\n', 'old.js': null });
  const head = github.state.head;

  const outcome = await pullRemoteChanges(project.id, { trigger: 'webhook', propagate: false });
  assert.equal(outcome.unchanged, false);
  assert.deepEqual(outcome.applied.sort(), ['index.js', 'new.js']);
  assert.deepEqual(outcome.deleted, ['old.js']);
  assert.equal(outcome.conflicts.length, 0);
  assert.equal(outcome.toCommit, head);

  const index = await getProjectFileByPath(project.id, 'index.js');
  assert.equal(index?.content, 'v2\n', 'the panel copy holds GitHub’s bytes');
  assert.equal(index?.dirty, false, 'a pulled file is not a local change');

  const added = await getProjectFileByPath(project.id, 'new.js');
  assert.equal(added?.content, 'brand new\n');

  const deleted = await getProjectFileByPath(project.id, 'old.js');
  assert.equal(deleted, null, 'a file deleted on GitHub is gone from the working copy');

  const after = await getProject(project.id);
  assert.equal(after?.baseCommitSha, head, 'the base commit advances only after a clean apply');
  assert.equal(after?.syncStatus, 'synced');

  const events = await query<{ message: string }>(
    `select message from github_sync_events where project_id = $1 order by id desc limit 3`,
    [project.id],
  );
  assert.ok(events.some((row) => row.message.includes('GitHub → panel')));
});

test('pulling again at the same head is a no-op', async () => {
  const outcome = await pullRemoteChanges(project.id, { trigger: 'poll', propagate: false });
  assert.equal(outcome.unchanged, true);
  assert.deepEqual(outcome.applied, []);
});

test('a file edited on both sides becomes a conflict and keeps the local bytes', async () => {
  // Local edit, not yet pushed.
  await upsertProjectFile({
    projectId: project.id,
    path: 'index.js',
    content: 'local edit\n',
    sizeBytes: 11,
    sha256: null,
    remoteSha: null,
    dirty: true,
  });
  await updateProject(project.id, { syncStatus: 'pending' });

  const baseBefore = (await getProject(project.id))?.baseCommitSha;
  github.pushRemotely({ 'index.js': 'remote edit\n' });

  const outcome = await pullRemoteChanges(project.id, { trigger: 'webhook', propagate: false });
  assert.equal(outcome.conflicts.length, 1);
  assert.equal(outcome.conflicts[0].path, 'index.js');
  assert.equal(outcome.conflicts[0].reason, 'both_modified');
  assert.deepEqual(outcome.applied, [], 'a conflicting path must not be applied');

  const local = await getProjectFileByPath(project.id, 'index.js');
  assert.equal(local?.content, 'local edit\n', 'the local edit is preserved, never silently overwritten');
  assert.equal(local?.dirty, true);

  const conflict = await query<{ local_content: string; remote_content: string; status: string }>(
    `select local_content, remote_content, status from github_sync_conflicts where project_id = $1 and path = 'index.js'`,
    [project.id],
  );
  assert.equal(conflict.length, 1, 'both versions are stored for the resolution UI');
  assert.equal(conflict[0].local_content, 'local edit\n');
  assert.equal(conflict[0].remote_content, 'remote edit\n');
  assert.equal(conflict[0].status, 'open');

  const after = await getProject(project.id);
  assert.equal(after?.baseCommitSha, baseBefore, 'the base stays put while a conflict is open');
  assert.equal(after?.syncStatus, 'conflict');
});

test('a repeated pull does not pile up duplicate conflicts for the same path', async () => {
  await pullRemoteChanges(project.id, { trigger: 'poll', propagate: false }).catch(() => undefined);
  const rows = await query<{ id: string }>(
    `select id from github_sync_conflicts where project_id = $1 and path = 'index.js' and status = 'open'`,
    [project.id],
  );
  assert.equal(rows.length, 1);
});
