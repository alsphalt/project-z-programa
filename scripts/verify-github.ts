/**
 * Live GitHub verification.
 *
 * Runs the *application's own* GitHub code — the encrypted token store, the
 * repository listing and the real import pipeline (tree → blobs → working copy)
 * — against github.com. It exists because a mocked client proves the wiring, not
 * that the API contract still holds.
 *
 *   DARKNOTE_GITHUB_TOKEN=ghp_... npm run verify:github -- owner/repo [branch]
 *
 * The token is read from the environment, encrypted with DARKNOTE_SECRET into
 * `github_connection`, and never printed. Use a throwaway DARKNOTE_DATA_DIR (the
 * default here) so a real deployment's connection row is untouched.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DARKNOTE_DATA_DIR) {
  process.env.DARKNOTE_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'darknote-verify-github-'));
  // eslint-disable-next-line no-console
  console.log(`[verify] scratch data dir: ${process.env.DARKNOTE_DATA_DIR}`);
}
process.env.DARKNOTE_DB_DRIVER = process.env.DARKNOTE_DB_DRIVER ?? 'pglite';
if (!process.env.DARKNOTE_SECRET) {
  process.env.DARKNOTE_SECRET = 'verify-only-secret-value-long-enough-for-aes-256-gcm';
}

const token = (process.env.DARKNOTE_GITHUB_TOKEN ?? process.env.GITHUB_VERIFY_TOKEN ?? '').trim();
if (!token) {
  console.error('Set DARKNOTE_GITHUB_TOKEN (a fine-grained token with Contents: read).');
  process.exit(2);
}

const target = (process.argv[2] ?? '').trim();
const [owner, repoName] = target.split('/');
const branchArg = (process.argv[3] ?? '').trim() || null;

const { saveToken, getConnectionView, resolveToken } = await import('../src/lib/github/credentials.ts');
const { listRepositories, listRepositoryBranches } = await import('../src/lib/github/repos.ts');
const { importFromGitHub } = await import('../src/lib/projects/import.ts');
const projectRepo = await import('../src/lib/projects/repo.ts');

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

// 1. The token is accepted by GitHub and stored encrypted.
const view = await saveToken({ token });
check('token accepted', view.connected && Boolean(view.account?.login), `account ${view.account?.login ?? '?'}`);
console.log(`      scopes: ${view.scopes.join(', ') || '(none reported)'}`);
check('token not readable back', view.tokenConfigured && Boolean(view.tokenHint) && !JSON.stringify(view).includes(token), `hint ${view.tokenHint}`);

const again = await getConnectionView();
check('connection row persists', again.connected && again.account?.login === view.account?.login, `${again.status}`);

// 2. Repository listing through the app's client.
const listed = await listRepositories({ perPage: 30, refresh: true });
check('repositories listed', listed.repos.length > 0, `${listed.repos.length} repositories on page 1`);
for (const repo of listed.repos.slice(0, 5)) {
  console.log(
    `      ${repo.fullName} · ${repo.private ? 'private' : 'public'} · branch ${repo.defaultBranch} · ${repo.language ?? 'n/a'}`,
  );
}

if (!owner || !repoName) {
  console.log('\nNo owner/repo argument: import not attempted. Re-run with `-- owner/repo`.');
  process.exit(failures ? 1 : 0);
}

// 3. Branch listing and a real import.
const branches = await listRepositoryBranches(owner, repoName);
check('branches listed', branches.length > 0, branches.map((branch) => branch.name).slice(0, 5).join(', '));

const { project, summary } = await importFromGitHub({ owner, repoName, branch: branchArg });
check('repository imported', project.status === 'ready', `${summary.files} files, ${summary.bytes} bytes, branch ${summary.branch}`);
check('text files detected', (summary.textFiles ?? 0) > 0, `${summary.textFiles} decodable text files`);
check('commit recorded', Boolean(project.baseCommitSha), String(project.baseCommitSha).slice(0, 12));

// 4. The working copy really contains the repository's files.
const files = await projectRepo.listProjectFiles(project.id, { withContent: true });
const paths = new Set(files.map((file) => file.path));
check('working copy populated', files.length === summary.files, `${files.length} stored files`);
const manifests = [...paths].filter((p) => /(^|\/)(package\.json|requirements\.txt|composer\.json|pyproject\.toml|go\.mod)$/.test(p));
console.log(`      manifests: ${manifests.join(', ') || '(none)'}`);
const guess = manifests.find((p) => p.endsWith('package.json'));
if (guess) {
  const manifest = files.find((file) => file.path === guess);
  const parsed = manifest?.content ? (JSON.parse(manifest.content) as { name?: string; scripts?: Record<string, string> }) : null;
  console.log(`      ${guess}: name=${parsed?.name ?? '?'} start=${parsed?.scripts?.start ?? parsed?.scripts?.dev ?? '(no start script)'}`);
}

// 5. The token still decrypts (the store is round-trip safe).
const resolved = await resolveToken();
check('token round-trips from storage', Boolean(resolved) && resolved === token, 'decrypted value matches what was supplied');

console.log(`\n${failures === 0 ? 'VERIFIED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
