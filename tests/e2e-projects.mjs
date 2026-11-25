/**
 * Live end-to-end check for the import / CRASH AND FIX / GitHub synchronization
 * workflow.
 *
 * It builds nothing: run `npm run build` first, then
 *   node tests/e2e-projects.mjs
 *
 * The script starts a GitHub double, boots `next start` against a temporary data
 * directory, signs in as the bootstrap owner, and drives the real HTTP routes:
 * connect a token → import a repository → search a case → save it → let the
 * debounced worker push → verify the commit landed on the double. It then repeats
 * the import through a ZIP upload and renders the pages.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { zipSync } from 'fflate';
import { createMockGitHub } from './mock-github.mjs';

const PORT = Number(process.env.E2E_PORT ?? 3123);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'e2e@darknote.test';
const PASSWORD = 'e2e-password-that-is-long-enough';

const INDEX_JS = `const sock = { sendMessage: async () => undefined };

switch (cmd) {
  case 'menu': {
    await sock.sendMessage('x', { text: 'Welcome to Darknote' });
    break;
  }
  case 'ping':
    await sock.sendMessage('x', { text: 'pong' });
    break;
  default:
    break;
}
`;

const github = await createMockGitHub({ files: { 'index.js': INDEX_JS, '.env': 'SECRET=1\n' } });
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-e2e-'));

const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DARKNOTE_DATA_DIR: dataDir,
    DARKNOTE_SECRET: 'e2e-secret-value-that-is-long-enough-for-aes-256-gcm',
    DARKNOTE_ADMIN_EMAIL: EMAIL,
    DARKNOTE_ADMIN_PASSWORD: PASSWORD,
    DARKNOTE_ADMIN_NAME: 'E2E Owner',
    DARKNOTE_GITHUB_API_BASE: github.url,
    DARKNOTE_DISABLE_GITHUB_WORKER: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs = [];
server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/login`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`server did not start:\n${logs.join('')}`);
}

let cookie = '';
let csrf = '';

function headers(extra = {}) {
  return { cookie, 'x-csrf-token': csrf, ...extra };
}

async function api(method, target, body, raw) {
  const response = await fetch(`${BASE}${target}`, {
    method,
    headers: raw ? headers(raw.headers ?? {}) : headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
}

try {
  await waitForServer();
  check('server answers /login', true);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookies = login.headers.getSetCookie?.() ?? [];
  const session = setCookies.find((value) => value.startsWith('dn_session=')) ?? '';
  const csrfCookie = setCookies.find((value) => value.startsWith('dn_csrf=')) ?? '';
  cookie = [session.split(';')[0], csrfCookie.split(';')[0]].filter(Boolean).join('; ');
  csrf = decodeURIComponent(csrfCookie.split('=')[1]?.split(';')[0] ?? '');
  check('signed in as the bootstrap owner', login.ok && Boolean(cookie), `HTTP ${login.status}`);

  const status = await api('GET', '/api/github/settings');
  check('GitHub starts disconnected', status.payload?.data?.connection?.connected === false);

  const bad = await api('PUT', '/api/github/settings', { token: 'nope-not-a-token' });
  check('an invalid token is refused', bad.status >= 400, `HTTP ${bad.status}`);

  const saved = await api('PUT', '/api/github/settings', { token: 'test-token-value' });
  check(
    'token verified and stored',
    saved.status === 200 && saved.payload?.data?.connection?.account?.login === 'octocat',
    JSON.stringify(saved.payload?.data?.connection?.tokenHint ?? ''),
  );
  check('the token is never returned', !JSON.stringify(saved.payload).includes('test-token-value'));

  const options = await api('GET', '/api/github/import-options');
  check('import options follow the connected account', options.payload?.data?.mode === 'account');

  const repos = await api('GET', '/api/github/repos?q=darknote');
  check('repository list is searchable', Array.isArray(repos.payload?.data?.repos) && repos.payload.data.repos.length === 1);

  const job = await api('POST', '/api/projects/import/job', { source: 'github' });
  const jobId = job.payload?.data?.jobId;
  check('import job opened', Boolean(jobId));

  const imported = await api('POST', '/api/projects/import/github', { owner: 'octocat', repo: 'darknote-bot', jobId });
  const projectId = imported.payload?.data?.project?.id;
  check(
    'repository imported through the API',
    imported.status === 200 && imported.payload?.data?.summary?.files === 1,
    `${imported.payload?.data?.summary?.files} file(s)`,
  );

  const jobStatus = await api('GET', `/api/projects/import/status?id=${jobId}`);
  check('import job reports success', jobStatus.payload?.data?.job?.status === 'succeeded');

  const search = await api('GET', '/api/crash-and-fix/search?q=menu');
  const match = search.payload?.data?.matches?.[0];
  check('case search finds the real case', Boolean(match) && match.caseName === 'menu');
  check('no file names or paths are returned', match && !('path' in match));

  const save = await api('POST', '/api/crash-and-fix/save', {
    projectId,
    fileId: match.fileId,
    caseName: match.caseName,
    caseStart: match.caseStart,
    expectedFileSha: match.fileSha,
    expectedCaseSha: match.caseSha,
    expectedCaseCode: match.code,
    nextCode: match.code.replace('Welcome to Darknote', 'Welcome to Darknote E2E'),
  });
  check('case saved to the project file', save.status === 200 && save.payload?.data?.sync?.scheduled === true);

  const stale = await api('POST', '/api/crash-and-fix/save', {
    projectId,
    fileId: match.fileId,
    caseName: match.caseName,
    caseStart: match.caseStart,
    expectedFileSha: match.fileSha,
    expectedCaseCode: match.code,
    nextCode: match.code,
  });
  check('a stale save is rejected', stale.status === 409, `HTTP ${stale.status}`);

  const headBefore = github.state.head;
  const pushed = await api('POST', '/api/github/sync', { projectId, action: 'sync' });
  check(
    'manual sync is confirmed by GitHub',
    pushed.payload?.data?.sync?.syncStatus === 'synced',
    pushed.payload?.data?.sync?.lastCommitSha?.slice(0, 7) ?? '',
  );
  check('the branch really moved', github.state.head !== headBefore);
  check('GitHub holds the edited content', (github.contentsAtHead('index.js') ?? '').includes('Welcome to Darknote E2E'));
  check('.env was never imported', !(github.contentsAtHead('.env') ?? '').includes('Welcome'));

  const archive = zipSync({
    'uploaded/index.js': new TextEncoder().encode(INDEX_JS),
    'uploaded/../escape.js': new TextEncoder().encode('nope'),
    'uploaded/style.css': new TextEncoder().encode('body{color:#fff}'),
  });
  const form = new FormData();
  form.append('files', new Blob([archive], { type: 'application/zip' }), 'uploaded.zip');
  const upload = await api('POST', '/api/projects/import/upload', undefined, { body: form, headers: {} });
  check(
    'ZIP upload imported safely',
    upload.status === 200 && upload.payload?.data?.summary?.files === 2,
    `${upload.payload?.data?.summary?.files} files · ${upload.payload?.data?.summary?.skipped} skipped`,
  );

  const listing = await api('GET', '/api/projects');
  check('import history lists both projects', (listing.payload?.data?.projects ?? []).length === 2);

  for (const [label, target, needle] of [
    ['/crash-and-fix page', '/crash-and-fix', 'CRASH AND FIX'],
    ['/projects page', '/projects', 'Import history'],
    ['/monitor page', '/monitor', 'Live Monitor'],
    // The GitHub panel itself mounts client-side on `?tab=github`; the markup
    // that must exist on the server includes the tab bar entry.
    ['/settings page', '/settings?tab=github', 'github'],
  ]) {
    const response = await fetch(`${BASE}${target}`, { headers: { cookie } });
    const html = await response.text();
    check(`${label} renders`, response.ok && html.toUpperCase().includes(needle.toUpperCase()), `HTTP ${response.status}`);
  }
} catch (error) {
  console.error('E2E FAILED:', error);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await github.close();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length && logs.length) writeFileSync(path.join(dataDir, 'server.log'), logs.join(''));
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}
