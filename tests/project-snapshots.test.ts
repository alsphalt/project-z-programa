/**
 * Project snapshots and the "REPLACE EXISTING PROJECT FILES?" gate.
 *
 * These drive the real import state machine against the real database and a
 * protocol-accurate GitHub double. What is asserted is the part that would hurt
 * if it were wrong:
 *
 *  - a second import into a populated destination refuses and reports exactly
 *    how many files are identical, different, new and about to be orphaned;
 *  - choosing "Backup & Replace" stores a verifiable archive *before* anything
 *    is overwritten;
 *  - a restore puts the old tree back byte for byte and removes the files the
 *    new tree introduced;
 *  - a corrupt archive is refused rather than silently restored;
 *  - an import that dies half way puts the previous working copy back.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-snapshots-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

// @ts-expect-error the GitHub double is a plain .mjs module without types
const { createMockGitHub } = await import('./mock-github.mjs');

const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'darknote-bot', version: '1.0.0', main: 'main.js', scripts: { start: 'node main.js' } }),
  'main.js': 'const menu = require("./commands/menu");\nconsole.log(menu);\n',
  'commands/menu.js': "module.exports = { case: 'menu' };\n",
  'README.md': '# Darknote\n',
};

const github = await createMockGitHub({ files });
process.env.DARKNOTE_GITHUB_API_BASE = github.url;
after(async () => {
  await github.close();
});

const { saveToken, saveRepositoryConfig } = await import('../src/lib/github/credentials.ts');
const { startGitHubImport, runImportBatch } = await import('../src/lib/projects/import-batch.ts');
const { listProjectFiles, listProjectFilePaths, getProject } = await import('../src/lib/projects/repo.ts');
const {
  createProjectSnapshot,
  listProjectSnapshots,
  restoreProjectSnapshot,
  snapshotManifest,
  verifySnapshot,
} = await import('../src/lib/projects/snapshot.ts');
const { backupStorage } = await import('../src/lib/backups/storage.ts');

await saveToken({ token: 'test-token-value' });
await saveRepositoryConfig({ owner: github.state.owner, name: github.state.repo, branch: github.state.branch });

/** Drives every batch of a job that was already started. */
async function drain(job: { id: string; status: string }) {
  let current = job;
  let steps = 0;
  while (current.status === 'running' && steps < 40) {
    current = await runImportBatch(current.id);
    steps += 1;
  }
  return current;
}

const first = await startGitHubImport({ owner: github.state.owner, repoName: github.state.repo });
const projectId = first.job.projectId!;
const firstJob = await drain(first.job);
assert.equal(firstJob.status, 'succeeded');

test('an import records a runtime and an install command in the job detail', async () => {
  const job = await import('../src/lib/projects/import.ts').then((mod) => mod.getImportJob(firstJob.id));
  assert.ok(job.message?.includes('node'), `message should name the runtime, got: ${job.message}`);
  assert.ok(job.message?.includes('npm'), 'message should name the package manager');
});

test('a manifest is stable across passes and covers content, not just names', async () => {
  const a = snapshotManifest([
    { path: 'a.js', sha256: null, sizeBytes: 3, isText: true, contentOmitted: false, remoteSha: null, content: 'one' },
    { path: 'b.js', sha256: null, sizeBytes: 3, isText: true, contentOmitted: false, remoteSha: null, content: 'two' },
  ]);
  const b = snapshotManifest([
    { path: 'b.js', sha256: null, sizeBytes: 3, isText: true, contentOmitted: false, remoteSha: null, content: 'two' },
    { path: 'a.js', sha256: null, sizeBytes: 3, isText: true, contentOmitted: false, remoteSha: null, content: 'one' },
  ]);
  const changed = snapshotManifest([
    { path: 'a.js', sha256: null, sizeBytes: 3, isText: true, contentOmitted: false, remoteSha: null, content: 'ONE' },
    { path: 'b.js', sha256: null, sizeBytes: 3, isText: true, contentOmitted: false, remoteSha: null, content: 'two' },
  ]);
  assert.equal(a.manifestSha256, b.manifestSha256, 'path order must not change the manifest');
  assert.notEqual(a.manifestSha256, changed.manifestSha256, 'a content change must change the manifest');
  assert.equal(a.files, 2);
  assert.equal(a.bytes, 6);
});

test('a snapshot verifies, and a tampered archive does not', async () => {
  const snapshot = await createProjectSnapshot({ projectId, kind: 'manual', label: 'test' });
  assert.equal(snapshot.verified, true);
  assert.equal(snapshot.filesCount, 4);

  const ok = await verifySnapshot(snapshot.id);
  assert.equal(ok.ok, true);

  // Corrupt the stored archive the way a truncated upload or a bad disk would.
  await backupStorage().put(snapshot.storageKey, Buffer.from('not a gzip payload'));
  const broken = await verifySnapshot(snapshot.id);
  assert.equal(broken.ok, false);

  await assert.rejects(
    () => restoreProjectSnapshot({ projectId, snapshotId: snapshot.id, skipSafetySnapshot: true }),
    (error: unknown) => (error as { code?: string }).code === 'snapshot_integrity_failed',
    'a corrupt snapshot must never be restored',
  );

  // The project is untouched by the refused restore.
  const paths = await listProjectFilePaths(projectId);
  assert.equal(paths.length, 4);
});

test('a second import into a populated destination refuses and reports the collision counts', async () => {
  // The same path, new content: `different` + 1. One new file: `added` + 1.
  // One file removed upstream: `orphaned` + 1.
  github.pushRemotely({
    'commands/menu.js': "module.exports = { case: 'menu', updated: true };\n",
    'commands/help.js': "module.exports = { case: 'help' };\n",
    'README.md': null as unknown as string,
  });

  await assert.rejects(
    () => startGitHubImport({ owner: github.state.owner, repoName: github.state.repo }),
    (error: unknown) => {
      const api = error as { status?: number; code?: string; details?: Record<string, unknown> };
      assert.equal(api.code, 'confirmation_required');
      assert.equal(api.status, 409);
      const details = api.details as {
        collisions: { identical: number; different: number; added: number; orphaned: number };
        destination: { files: number };
        incoming: { files: number };
      };
      assert.equal(details.destination.files, 4);
      assert.equal(details.collisions.different, 1);
      assert.equal(details.collisions.added, 1);
      assert.equal(details.collisions.orphaned, 1);
      // 4 stored: 1 changed, 1 removed upstream, 2 unchanged (package.json, main.js)
      assert.equal(details.collisions.identical, 2);
      return true;
    },
  );

  // Refusing must not have touched the working copy, and must not leave a job.
  const paths = await listProjectFilePaths(projectId);
  assert.deepEqual(paths.sort(), ['README.md', 'commands/menu.js', 'main.js', 'package.json']);
});

test('"Backup & Replace" snapshots before overwriting and the import then replaces the tree', async () => {
  const started = await startGitHubImport({
    owner: github.state.owner,
    repoName: github.state.repo,
    onExisting: 'replace',
  });
  assert.ok(started.snapshotId, 'a verified snapshot must exist before the first batch runs');

  const snapshots = await listProjectSnapshots(projectId);
  const preImport = snapshots.find((snapshot) => snapshot.id === started.snapshotId);
  assert.equal(preImport?.kind, 'pre-import');
  assert.equal(preImport?.verified, true);
  assert.equal(preImport?.filesCount, 4);

  const job = await drain(started.job);
  assert.equal(job.status, 'succeeded');

  const after1 = (await listProjectFilePaths(projectId)).sort();
  assert.deepEqual(after1, ['commands/help.js', 'commands/menu.js', 'main.js', 'package.json']);

  const stored = await listProjectFiles(projectId, { withContent: true });
  const menu = stored.find((file) => file.path === 'commands/menu.js');
  assert.ok(menu?.content?.includes('updated: true'), 'the new content must be stored');
});

test('restoring a snapshot puts the old tree back and removes files the new one added', async () => {
  const snapshots = await listProjectSnapshots(projectId);
  const preImport = snapshots.find((snapshot) => snapshot.kind === 'pre-import' && snapshot.verified);
  assert.ok(preImport);

  const report = await restoreProjectSnapshot({ projectId, snapshotId: preImport!.id });
  assert.equal(report.verified, true);
  assert.equal(report.files, 4);
  assert.ok(report.safetySnapshotId, 'the restore must itself be reversible');

  const restored = (await listProjectFiles(projectId, { withContent: true })).sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  assert.deepEqual(
    restored.map((file) => file.path),
    ['README.md', 'commands/menu.js', 'main.js', 'package.json'],
  );
  const menu = restored.find((file) => file.path === 'commands/menu.js');
  assert.equal(menu?.content, "module.exports = { case: 'menu' };\n", 'the old bytes must come back exactly');
});

test('a restore keeps file ids stable for paths that still exist', async () => {
  const before = await listProjectFiles(projectId);
  const indexBefore = before.find((file) => file.path === 'main.js');
  const snapshots = await listProjectSnapshots(projectId);
  const usable = snapshots.find((snapshot) => snapshot.verified && snapshot.kind === 'pre-import');
  assert.ok(usable && indexBefore);

  await restoreProjectSnapshot({ projectId, snapshotId: usable!.id, skipSafetySnapshot: true });

  const after1 = await listProjectFiles(projectId);
  const indexAfter = after1.find((file) => file.path === 'main.js');
  assert.equal(
    indexAfter?.id,
    indexBefore!.id,
    'an open editor tab holds a file id; a restore must not invalidate it',
  );
});

test('an import that fails mid-way restores the snapshot it took', async () => {
  const before = (await listProjectFiles(projectId, { withContent: true })).map((file) => `${file.path}:${file.content}`);

  const started = await startGitHubImport({
    owner: github.state.owner,
    repoName: github.state.repo,
    onExisting: 'replace',
  });
  assert.ok(started.snapshotId);

  // The blobs vanish between the tree read and the first batch: the import
  // cannot complete, which is the case this rollback exists for.
  const saved = new Map(github.state.blobs);
  github.state.blobs.clear();

  await assert.rejects(() => runImportBatch(started.job.id));

  github.state.blobs = saved;

  const after1 = (await listProjectFiles(projectId, { withContent: true })).map((file) => `${file.path}:${file.content}`);
  assert.deepEqual(after1, before, 'the working copy must be exactly what it was before the failed import');

  const { getImportJob } = await import('../src/lib/projects/import.ts');
  const job = await getImportJob(started.job.id);
  assert.equal(job.status, 'failed');
  assert.ok(
    job.message?.toLowerCase().includes('restored'),
    `the failure must say the snapshot was restored, got: ${job.message}`,
  );

  const project = await getProject(projectId);
  assert.equal(project?.status, 'ready');
});
