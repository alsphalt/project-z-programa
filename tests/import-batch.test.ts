/**
 * Batched GitHub import.
 *
 * The reported failure was the dialog sitting on "wait for the repository":
 * the whole import used to happen inside one request, which a deployment's
 * execution limit cuts off. These assertions prove the new contract — the start
 * call returns promptly, each batch stores real files, the job is resumable and
 * cancellable, and nothing is cleared before the first file is written.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-import-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

// @ts-expect-error the GitHub double is a plain .mjs module without types
const { createMockGitHub } = await import('./mock-github.mjs');

const files: Record<string, string> = {};
for (let index = 1; index <= 25; index += 1) {
  files[`src/file-${String(index).padStart(2, '0')}.js`] = `module.exports = ${index};\n`;
}
files['.env'] = 'SECRET=do-not-import\n';
files['package.json'] = '{"name":"bot"}\n';

const github = await createMockGitHub({ files });
process.env.DARKNOTE_GITHUB_API_BASE = github.url;
after(async () => {
  await github.close();
});

const { saveToken, saveRepositoryConfig } = await import('../src/lib/github/credentials.ts');
const { startGitHubImport, runImportBatch, cancelImport } = await import('../src/lib/projects/import-batch.ts');
const { listProjectFilePaths, listProjectFiles, getProject } = await import('../src/lib/projects/repo.ts');
const { IMPORT_BATCH_SIZE, MAX_GITHUB_FILES } = await import('../src/lib/projects/import.ts');

await saveToken({ token: 'test-token-value' });
await saveRepositoryConfig({ owner: github.state.owner, name: github.state.repo, branch: github.state.branch });

test('starting an import only reads the tree and returns a job', async () => {
  const { job, reused } = await startGitHubImport({ owner: github.state.owner, repoName: github.state.repo });
  assert.equal(reused, false);
  // 25 javascript files + package.json; .env is refused by the secret-path rule.
  assert.equal(job.totalFiles, 26);
  assert.equal(job.status, 'running');
  assert.ok(job.totalFiles <= MAX_GITHUB_FILES);

  // Nothing has been written yet, so an instantly-cancelled import cannot have
  // damaged anything.
  const paths = await listProjectFilePaths(job.projectId!);
  assert.equal(paths.length, 0);
});

test('a second start while a job is running reuses it instead of duplicating', async () => {
  const first = await startGitHubImport({ owner: github.state.owner, repoName: github.state.repo });
  const second = await startGitHubImport({ owner: github.state.owner, repoName: github.state.repo });
  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(first.job.fetchedFiles, 0);
});

test('batches store real files and finish with the project ready', async () => {
  const { job } = await startGitHubImport({ owner: github.state.owner, repoName: github.state.repo });
  let current = job;
  let steps = 0;

  while (current.status === 'running' && steps < 50) {
    current = await runImportBatch(current.id);
    steps += 1;
  }

  assert.equal(current.status, 'succeeded');
  assert.ok(steps > 1, `the import must be split across requests (took ${steps})`);
  assert.equal(current.fetchedFiles, 26);
  assert.ok(current.fetchedFiles <= steps * IMPORT_BATCH_SIZE);

  const project = await getProject(job.projectId!);
  assert.equal(project?.status, 'ready');
  assert.ok(project?.baseCommitSha, 'the base commit is recorded so sync has a starting point');

  const stored = await listProjectFiles(job.projectId!, { withContent: true });
  const paths = stored.map((file) => file.path).sort();
  assert.equal(paths.length, 26);
  assert.ok(paths.includes('src/file-25.js'));
  assert.ok(paths.includes('package.json'));
  assert.ok(!paths.includes('.env'), 'credential files must never be stored');

  const sample = stored.find((file) => file.path === 'src/file-07.js');
  assert.equal(sample?.content, 'module.exports = 7;\n', 'file contents are stored, not placeholders');
  assert.equal(sample?.dirty, false);
});

test('a cancelled import keeps the files already written', async () => {
  const { job } = await startGitHubImport({ owner: github.state.owner, repoName: github.state.repo });
  const afterOne = await runImportBatch(job.id);
  assert.equal(afterOne.fetchedFiles, IMPORT_BATCH_SIZE);

  const cancelled = await cancelImport(job.id);
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.fetchedFiles, IMPORT_BATCH_SIZE);

  // Re-importing refreshes the same project, so the previous 26 files are still
  // there: cancelling must not destroy a working copy that already existed.
  const paths = await listProjectFilePaths(job.projectId!);
  assert.equal(paths.length, 26, 'cancelling must not remove an existing working copy');

  // Further batches do nothing: a cancelled job is terminal.
  const again = await runImportBatch(job.id);
  assert.equal(again.fetchedFiles, IMPORT_BATCH_SIZE);
});

/**
 * A job only advances while a tab is driving its batches. If that tab goes away
 * the row stays `running`, and the old lookup returned it forever, so looking
 * like "the import is stuck" was the only possible outcome of retrying.
 */
test('a stalled import is abandoned instead of blocking every later attempt', async () => {
  const { query, queryOne } = await import('../src/lib/db.ts');

  const { job } = await startGitHubImport({ owner: github.state.owner, repoName: github.state.repo });
  assert.equal(job.status, 'running');

  // Age the row past the stale window without changing anything else.
  await query(`update project_import_jobs set started_at = now() - interval '20 minutes' where id = $1`, [job.id]);

  const retried = await startGitHubImport({ owner: github.state.owner, repoName: github.state.repo });
  assert.equal(retried.reused, false, 'a 20-minute-old running job must not be reused');
  assert.notEqual(retried.job.id, job.id, 'the retry starts a new job');

  const old = await queryOne<{ status: string; phase: string | null }>(
    `select status, phase from project_import_jobs where id = $1`,
    [job.id],
  );
  assert.equal(old?.status, 'failed');
  assert.equal(old?.phase, 'abandoned');

  await cancelImport(retried.job.id);
});

/** A repository with nothing importable must release the project, not pin it. */
test('an import with no eligible files finishes the project instead of leaving it importing', async () => {
  const { createMockGitHub } = await import('./mock-github.mjs');
  const empty = await createMockGitHub({
    repo: 'empty-bot',
    // `.env` is credential-shaped and the image is binary: neither is importable.
    files: { '.env': 'SECRET=1\n', 'logo.png': 'not-really-a-png\n' },
  });
  const previousBase = process.env.DARKNOTE_GITHUB_API_BASE;
  process.env.DARKNOTE_GITHUB_API_BASE = empty.url;
  try {
    const { job } = await startGitHubImport({ owner: empty.state.owner, repoName: empty.state.repo });
    assert.equal(job.totalFiles, 0);

    const finished = await runImportBatch(job.id);
    assert.equal(finished.status, 'succeeded');

    const project = await getProject(job.projectId!);
    assert.notEqual(project?.status, 'importing', 'the project must not stay on "importing"');
    assert.equal(project?.status, 'import_failed');
  } finally {
    if (previousBase === undefined) delete process.env.DARKNOTE_GITHUB_API_BASE;
    else process.env.DARKNOTE_GITHUB_API_BASE = previousBase;
    await empty.close();
  }
});
