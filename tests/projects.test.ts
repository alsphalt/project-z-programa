/**
 * Project import, CRASH AND FIX and GitHub synchronization — end to end against a
 * protocol-accurate GitHub double.
 *
 * These tests prove the parts that are easy to fake:
 *  - a repository import really fetches blobs and stores their text;
 *  - the case search returns the exact AST range, including nested switches;
 *  - a save writes the real file and leaves every other case untouched;
 *  - a push creates a commit, moves the ref, and is only then reported synced;
 *  - a remote change turns into a conflict instead of an overwrite;
 *  - a ZIP with traversal entries and credentials is imported safely.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { createMockGitHub } from './mock-github.mjs';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-projects-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

const INDEX_JS = `const sock = { sendMessage: async () => undefined };

async function handle(cmd) {
  switch (cmd) {
    case 'menu': {
      const items = ['a', 'b'];
      for (const item of items) {
        switch (item) {
          case 'a': continue;
          default: break;
        }
      }
      await sock.sendMessage('x', { text: 'Welcome to Darknote' });
      break;
    }
    case 'ping':
      await sock.sendMessage('x', { text: 'pong' });
      break;
    default:
      break;
  }
}

module.exports = { handle };
`;

const HELPER_JS = `module.exports = () => 'helper';\n`;

const github = await createMockGitHub({
  files: {
    'index.js': INDEX_JS,
    'lib/helper.js': HELPER_JS,
    '.env': 'SECRET=do-not-import\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
  },
});

process.env.DARKNOTE_GITHUB_API_BASE = github.url;

const { query, queryOne } = await import('../src/lib/db.ts');
const { saveToken, getConnectionView } = await import('../src/lib/github/credentials.ts');
const { importFromGitHub, importFromZip } = await import('../src/lib/projects/import.ts');
const { getProject, listProjectFiles, listDirtyFiles, requireProject } = await import('../src/lib/projects/repo.ts');
const { searchCases } = await import('../src/lib/crashfix/search.ts');
const { saveCaseEdit, listEditHistory, rollbackEdit } = await import('../src/lib/crashfix/save.ts');
const { scheduleSync, runDueSyncJobs, syncProjectNow, resolveConflict, getSyncState } = await import('../src/lib/github/sync.ts');

let projectId = '';
let savedFileSha = '';

test.after(async () => {
  await github.close();
});

test('the token is verified against GitHub before it is stored', async () => {
  const view = await saveToken({ token: 'test-token-value', userId: 'user-1' });
  assert.equal(view.connected, true);
  assert.equal(view.account?.login, 'octocat');
  assert.ok(view.tokenHint?.startsWith('••••'), 'only a hint is exposed');
  assert.equal(view.tokenConfigured, true);

  await assert.rejects(
    () => saveToken({ token: 'wrong-token' }),
    /401|invalid|rejected/i,
    'an unauthenticated token must never be saved',
  );
  const after = await getConnectionView();
  assert.equal(after.account?.login, 'octocat', 'the rejected token did not replace the good one');
});

test('a repository import fetches the real files and skips credentials/dependencies', async () => {
  const result = await importFromGitHub({ owner: 'octocat', repoName: 'darknote-bot', userId: 'user-1' });
  projectId = result.project.id;
  assert.equal(result.summary.files, 2, 'index.js and lib/helper.js only');
  assert.equal(result.summary.textFiles, 2);
  assert.ok(result.summary.skipped >= 2, '.env and node_modules are skipped');
  assert.equal(result.summary.branch, 'main');

  const files = await listProjectFiles(projectId);
  const paths = files.map((file) => file.path).sort();
  assert.deepEqual(paths, ['index.js', 'lib/helper.js']);

  const withContent = await listProjectFiles(projectId, { withContent: true });
  const index = withContent.find((file) => file.path === 'index.js');
  assert.ok(index?.content?.includes("case 'menu'"), 'the real file text was stored');
  assert.ok(index?.remoteSha, 'the git blob sha was recorded for later conflict checks');

  const project = await requireProject(projectId);
  assert.equal(project.source, 'github');
  assert.equal(project.githubBranch, 'main');
  assert.ok(project.baseCommitSha, 'the imported commit is remembered');
});

test('the case search returns only the matching case, with exact boundaries', async () => {
  const result = await searchCases('menu');
  assert.equal(result.matches.length, 1, 'nested case blocks are not reported as menu');
  const match = result.matches[0];
  assert.equal(match.caseName, 'menu');
  assert.ok(match.code.startsWith("case 'menu':"));
  assert.ok(match.code.includes("text: 'Welcome to Darknote'"));
  assert.ok(!match.code.includes("case 'ping'"), 'the next case is not included');
  assert.ok(result.stats.filesScanned >= 2);

  const missing = await searchCases('nonexistent-command');
  assert.equal(missing.matches.length, 0);
});

test('saving a case rewrites the real file and leaves the other cases alone', async () => {
  const found = await searchCases('menu');
  const match = found.matches[0];
  const nextCode = match.code.replace('Welcome to Darknote', 'Welcome to Darknote v2');

  const saved = await saveCaseEdit({
    projectId,
    fileId: match.fileId,
    caseName: match.caseName,
    caseStart: match.caseStart,
    expectedFileSha: match.fileSha,
    expectedCaseSha: match.caseSha,
    expectedCaseCode: match.code,
    nextCode,
    userId: 'user-1',
  });

  savedFileSha = saved.fileSha;
  assert.equal(saved.validation.ok, true);
  assert.equal(saved.sync.applicable, true);
  assert.equal(saved.sync.scheduled, true, 'the save queues a debounced push');

  const files = await listProjectFiles(projectId, { withContent: true });
  const index = files.find((file) => file.path === 'index.js');
  assert.ok(index?.content?.includes('Welcome to Darknote v2'), 'the original file was updated');
  assert.ok(index?.content?.includes("case 'ping'"), 'the neighbouring case survived');
  assert.ok(index?.content?.includes("case 'a': continue;"), 'the nested switch survived');
  assert.equal(index?.dirty, true, 'the file is marked for synchronization');

  const dirty = await listDirtyFiles(projectId);
  assert.equal(dirty.length, 1);

  const job = await queryOne<{ not_before: string }>(
    `select not_before from github_sync_jobs where project_id = $1 and status = 'pending'`,
    [projectId],
  );
  assert.ok(job, 'a pending job exists');
  const delayMs = new Date(job!.not_before).getTime() - Date.now();
  assert.ok(delayMs > 0 && delayMs <= 6000, `debounce window is ~5s (got ${delayMs}ms)`);
});

test('a stale save is refused instead of overwriting the file', async () => {
  const found = await searchCases('menu');
  const match = found.matches[0];
  await assert.rejects(
    () =>
      saveCaseEdit({
        projectId,
        fileId: match.fileId,
        caseName: match.caseName,
        caseStart: match.caseStart,
        expectedFileSha: 'a'.repeat(64),
        expectedCaseCode: match.code,
        nextCode: match.code,
        userId: 'user-1',
      }),
    (error: { code?: string }) => error.code === 'file_changed',
  );

  await assert.rejects(
    () =>
      saveCaseEdit({
        projectId,
        fileId: match.fileId,
        caseName: match.caseName,
        caseStart: match.caseStart,
        expectedFileSha: match.fileSha,
        expectedCaseCode: match.code,
        nextCode: "case 'menu': { this is not javascript",
        userId: 'user-1',
      }),
    (error: { code?: string }) => error.code === 'case_syntax_error',
  );
});

test('the debounced worker pushes a real commit and only then reports success', async () => {
  await query(`update github_sync_jobs set not_before = now() - interval '1 second' where project_id = $1 and status = 'pending'`, [projectId]);
  const headBefore = github.state.head;

  const outcome = await runDueSyncJobs(2);
  assert.equal(outcome.processed, 1);

  assert.notEqual(github.state.head, headBefore, 'the branch really moved');
  assert.ok(github.contentsAtHead('index.js')?.includes('Welcome to Darknote v2'), 'GitHub holds the edited content');
  assert.ok(github.contentsAtHead('lib/helper.js')?.includes('helper'), 'untouched files are preserved');
  assert.ok(
    github.state.requests.some((entry) => entry.startsWith('POST /repos/octocat/darknote-bot/git/commits')),
    'a commit was created through the Git Data API',
  );

  const project = await requireProject(projectId);
  assert.equal(project.syncStatus, 'synced');
  assert.equal(project.baseCommitSha, github.state.head);
  assert.equal(project.lastCommitSha, github.state.head);
  assert.ok(project.lastCommitUrl?.includes('/commit/'));
  assert.equal((await listDirtyFiles(projectId)).length, 0, 'dirty flags were cleared after confirmation');

  const state = await getSyncState(projectId);
  assert.ok(state.events.some((event) => event.message.includes('GITHUB SYNCHRONIZED SUCCESSFULLY')));
});

test('a remote change becomes a conflict, never an overwrite', async () => {
  const remoteCommit = github.pushRemotely({ 'lib/helper.js': "module.exports = () => 'remote change';\n" });

  const found = await searchCases('menu');
  const match = found.matches[0];
  await saveCaseEdit({
    projectId,
    fileId: match.fileId,
    caseName: match.caseName,
    caseStart: match.caseStart,
    expectedFileSha: match.fileSha,
    expectedCaseSha: match.caseSha,
    expectedCaseCode: match.code,
    nextCode: match.code.replace('Welcome to Darknote v2', 'Welcome to Darknote v3'),
    userId: 'user-1',
  });

  await query(`update github_sync_jobs set not_before = now() - interval '1 second' where project_id = $1 and status = 'pending'`, [projectId]);
  await runDueSyncJobs(2);

  const project = await requireProject(projectId);
  assert.equal(project.syncStatus, 'conflict');
  assert.match(project.syncError ?? '', /remote branch moved|changed on GitHub/i);
  assert.equal(github.state.head, remoteCommit, 'the remote commit was not overwritten');

  const files = await listProjectFiles(projectId, { withContent: true });
  assert.ok(
    files.find((file) => file.path === 'index.js')?.content?.includes('Welcome to Darknote v3'),
    'the local edit is preserved',
  );
  assert.equal((await listDirtyFiles(projectId)).length, 1, 'the change stays pending');
});

test('resolving a conflict rebases onto the remote head and pushes', async () => {
  const resolved = await resolveConflict(projectId, 'merge-remote');
  assert.equal(resolved.sync.syncStatus, 'synced');
  assert.ok(github.contentsAtHead('index.js')?.includes('Welcome to Darknote v3'), 'the local edit landed');
  assert.ok(
    github.contentsAtHead('lib/helper.js')?.includes('remote change'),
    'the remote change was preserved when rebasing',
  );

  const project = await requireProject(projectId);
  assert.equal(project.syncStatus, 'synced');
});

test('a manual sync pushes without waiting for the debounce', async () => {
  const found = await searchCases('ping');
  const match = found.matches[0];
  await saveCaseEdit({
    projectId,
    fileId: match.fileId,
    caseName: match.caseName,
    caseStart: match.caseStart,
    expectedFileSha: match.fileSha,
    expectedCaseSha: match.caseSha,
    expectedCaseCode: match.code,
    nextCode: match.code.replace("text: 'pong'", "text: 'pong v2'"),
    userId: 'user-1',
  });

  const state = await syncProjectNow(projectId, 'manual');
  assert.equal(state.syncStatus, 'synced');
  assert.ok(github.contentsAtHead('index.js')?.includes('pong v2'));
});

test('a ZIP upload is extracted safely and keeps the project structure', async () => {
  const archive = zipSync({
    'my-project/index.js': new TextEncoder().encode(INDEX_JS),
    'my-project/../evil.js': new TextEncoder().encode('pwned'),
    'my-project/.env': new TextEncoder().encode('SECRET=1'),
    'my-project/README.md': new TextEncoder().encode('# hello'),
  });

  const result = await importFromZip({
    buffer: Buffer.from(archive),
    filename: 'my-project.zip',
    userId: 'user-1',
  });

  assert.equal(result.project.source, 'upload');
  assert.equal(result.project.name, 'my-project', 'the single wrapping folder becomes the project name');
  assert.equal(result.summary.files, 2, 'only index.js and README.md are importable');
  assert.ok(result.summary.skipped >= 2, 'the traversal entry and .env are refused');

  const files = await listProjectFiles(result.project.id);
  assert.deepEqual(files.map((file) => file.path).sort(), ['README.md', 'index.js']);

  const uploaded = await getProject(result.project.id);
  assert.ok(uploaded);
  assert.equal(uploaded!.githubRepo, null, 'an uploaded project is not bound to a repository');
});

test('edit history records what was replaced and can be restored', async () => {
  const history = await listEditHistory(projectId);
  assert.ok(history.length >= 3);
  const last = history[0];
  assert.equal(last.status, 'saved');
  assert.ok(last.beforeCode.includes('case'));
  assert.ok(last.afterCode.includes('case'));

  const restored = await rollbackEdit({ historyId: last.id, userId: 'user-1' });
  assert.ok(restored.fileSha);

  const files = await listProjectFiles(projectId, { withContent: true });
  const index = files.find((file) => file.path === 'index.js');
  assert.ok(index?.content?.includes(last.beforeCode.trim().slice(0, 40)), 'the earlier text is back in the file');

  const after = await listEditHistory(projectId);
  assert.equal(after[0].action, 'rollback');
});

test('scheduling without a connected token is refused', async () => {
  await query(`delete from github_connection`);
  // Re-create an empty connection row so the view reports "disconnected".
  await query(`insert into github_connection (id) values ('default') on conflict (id) do nothing`);
  await assert.rejects(() => scheduleSync(projectId, ['index.js']), /not connected/i);
});
