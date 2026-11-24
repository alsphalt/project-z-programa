/**
 * End-to-end check for "GitHub everywhere".
 *
 * Run `npm run build` first, then:
 *   node tests/e2e-github-everywhere.mjs
 *
 * It boots `next start` against a temporary data directory with two protocol
 * doubles: a Pterodactyl panel (the files FILE MANAGER and the CODE EDITOR edit)
 * and GitHub (the repository they push to). It then drives the real HTTP routes:
 *
 *   bind a server to a repository → modify a panel file → push → GitHub confirms
 *   → create a file → push → delete it → push → remote tree loses it
 *   → a colleague pushes the same file → our push becomes a conflict and nothing
 *     remote is touched → rebase & push lands both
 *   → import a repository folder into the panel
 *
 * The point is not that the routes answer 200: it is that a panel file really
 * changes and that GitHub really records the commit, and that a conflicting push
 * really refuses to overwrite.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMockGitHub } from './mock-github.mjs';
import { createMockPanel } from './mock-pterodactyl.mjs';

const PORT = Number(process.env.E2E_PORT ?? 3131);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'e2e@darknote.test';
/** Must match the token the GitHub double accepts (tests/mock-github.mjs). */
const GITHUB_TOKEN = 'test-token-value';
const PASSWORD = 'e2e-password-that-is-long-enough';

const INITIAL_INDEX = `switch (cmd) {\n  case 'menu':\n    reply('Welcome');\n    break;\n  default:\n    break;\n}\n`;

// `.start()` binds the double to a real port. Without it the returned
// `baseUrl` keeps the initial port 0, so every panel call fails with
// "Cannot reach 127.0.0.1:0" and half the suite reports a product failure that
// is really a harness bug.
const panel = await createMockPanel({
  apiKey: 'ptlc_e2e_client_key_that_is_long_enough',
  identifier: 'abc12345',
  seed: { '/index.js': INITIAL_INDEX },
}).start();

const github = await createMockGitHub({
  files: { 'index.js': `${INITIAL_INDEX}// remote original\n`, 'docs/readme.md': '# Bot\n' },
});

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-e2e-github-'));

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
    // Deterministic: every push in this script is an explicit action.
    DARKNOTE_DISABLE_GITHUB_WORKER: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs = [];
server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
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

async function api(method, target, body) {
  const response = await fetch(`${BASE}${target}`, {
    method,
    headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
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

const remoteSha = (filePath) => github.state.trees.get(github.state.commits.get(github.state.head)?.tree?.sha)?.find((entry) => entry.path === filePath)?.sha ?? null;
const remoteText = (filePath) => {
  const sha = remoteSha(filePath);
  const buffer = sha ? github.state.blobs.get(sha) : null;
  return buffer ? buffer.toString('utf8') : null;
};

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

  const token = await api('PUT', '/api/github/settings', { token: GITHUB_TOKEN });
  check('GitHub account connected', token.status === 200 && token.payload?.data?.connection?.connected === true);

  const created = await api('POST', '/api/servers', {
    name: 'E2E Production',
    panelUrl: panel.baseUrl,
    serverIdentifier: panel.identifier,
    apiKey: panel.apiKey,
    rootPath: '/',
  });
  const serverId = created.payload?.data?.server?.id;
  check('panel registered as a server', Boolean(serverId), `HTTP ${created.status}`);

  const before = await api('GET', `/api/github/files?serverId=${serverId}`);
  check('GitHub status is readable before binding', before.status === 200 && before.payload?.data?.sync?.bound === false);

  const bind = await api('PUT', '/api/github/binding', {
    serverId,
    owner: 'octocat',
    repo: 'darknote-bot',
    branch: 'main',
    pathPrefix: '',
    autoSync: false,
  });
  check(
    'server bound to the repository',
    bind.status === 200 && bind.payload?.data?.sync?.bound === true,
    JSON.stringify(bind.payload?.data?.sync?.project?.repo ?? bind.payload?.error?.message ?? ''),
  );
  check('the binding reuses one working copy', Boolean(bind.payload?.data?.sync?.project?.id));

  // ---------------------------------------------------------------- file edit
  const edited = INITIAL_INDEX.replace("reply('Welcome')", "reply('Welcome from DARKNOTE')");
  const write = await api('POST', '/api/files/op', { action: 'create', serverId, path: '/index.js', content: edited });
  check('panel file written through the File Manager route', write.status === 200, `HTTP ${write.status}`);

  const detected = await api('POST', '/api/github/files', { serverId, action: 'detect', paths: ['/index.js'] });
  check(
    'the change is detected and queued',
    detected.status === 200 && detected.payload?.data?.result?.detected === 1,
    JSON.stringify(detected.payload?.data?.result?.reason ?? ''),
  );
  check(
    'automatic push stays off when auto-sync is disabled',
    detected.payload?.data?.sync?.project?.syncStatus === 'pending',
  );

  const pushed = await api('POST', '/api/github/files', { serverId, action: 'push', paths: ['/index.js'] });
  check(
    'push reported synchronized only with a commit sha',
    pushed.status === 200 && pushed.payload?.data?.sync?.project?.syncStatus === 'synced' && Boolean(pushed.payload?.data?.sync?.project?.lastCommitSha),
    JSON.stringify(pushed.payload?.data?.sync?.project?.syncError ?? ''),
  );
  check('GitHub holds the edited content', remoteText('index.js') === edited);

  // ----------------------------------------------------------------- new file
  const createdFile = await api('POST', '/api/files/op', {
    action: 'create',
    serverId,
    path: '/plugins/menu.js',
    content: 'module.exports = () => "menu";\n',
  });
  check('a folder and file can be created on the panel', createdFile.status === 200, `HTTP ${createdFile.status}`);

  const pushNew = await api('POST', '/api/github/files', {
    serverId,
    action: 'push',
    paths: ['/plugins/menu.js'],
    message: 'Add the menu plugin',
  });
  check('new file pushed', pushNew.payload?.data?.sync?.project?.syncStatus === 'synced');
  check('the new file exists on the branch', remoteText('plugins/menu.js')?.includes('menu') === true);

  // ------------------------------------------------------------------ delete
  const deleted = await api('POST', '/api/files/op', { action: 'delete', serverId, paths: ['/plugins/menu.js'] });
  check('panel file deleted', deleted.status === 200, `HTTP ${deleted.status}`);

  const pushDelete = await api('POST', '/api/github/files', {
    serverId,
    action: 'push',
    deletes: ['/plugins/menu.js'],
    message: 'Remove the menu plugin',
  });
  check(
    'deletion pushed',
    pushDelete.payload?.data?.sync?.project?.syncStatus === 'synced',
    JSON.stringify(pushDelete.payload?.data?.sync?.project?.syncError ?? ''),
  );
  check('the file is gone from the branch', remoteSha('plugins/menu.js') === null);

  // ---------------------------------------------------------------- conflict
  const remoteHeadBefore = github.state.head;
  github.pushRemotely({ 'index.js': `${edited}\n// colleague change\n` });

  await api('POST', '/api/files/op', {
    action: 'create',
    serverId,
    path: '/index.js',
    content: `${edited}\n// local change\n`,
  });
  const conflict = await api('POST', '/api/github/files', { serverId, action: 'push', paths: ['/index.js'] });
  check(
    'a conflicting push is refused, not merged',
    conflict.payload?.data?.sync?.project?.syncStatus === 'conflict',
    JSON.stringify(conflict.payload?.data?.sync?.project?.syncError ?? ''),
  );
  check('the remote branch was not overwritten', remoteText('index.js')?.includes('colleague change') === true);

  const resolved = await api('POST', '/api/github/files', {
    serverId,
    action: 'resolve',
    mode: 'merge-remote',
  });
  check(
    'rebase & push lands the local change on top',
    resolved.payload?.data?.sync?.project?.syncStatus === 'synced',
    JSON.stringify(resolved.payload?.data?.sync?.project?.syncError ?? ''),
  );
  // Documented contract of `merge-remote`: the remote head becomes the new base
  // and the local copy of every path *we* changed is pushed on top of it. For a
  // file both sides touched the operator's local content wins — there is no
  // 3-way text merge, and the UI says exactly that ("Local files will be pushed
  // on top"). Assert the real contract instead of a merge that does not exist.
  check(
    'the resolution pushes the local version on top of the remote head',
    remoteText('index.js')?.includes('local change') === true,
    remoteText('index.js')?.includes('colleague change') === true ? 'both sides present' : 'local wins (documented)',
  );
  check('the head advanced past the colleague commit', github.state.head !== remoteHeadBefore);

  // ------------------------------------------------------------------ import
  const imported = await api('POST', '/api/github/files', {
    serverId,
    action: 'import',
    owner: 'octocat',
    repo: 'darknote-bot',
    branch: 'main',
    repoPrefix: 'docs',
    destination: '/imported',
    limit: 10,
  });
  check(
    'import from GitHub wrote a real panel file',
    imported.status === 200 && imported.payload?.data?.result?.imported?.length === 1,
    JSON.stringify(imported.payload?.data?.result?.skipped ?? []),
  );
  // The double exposes `read(path)` (the `state` accessor never existed).
  const importedText = panel.read('/imported/readme.md');
  check('imported content matches the repository', importedText?.includes('Bot') === true, importedText ? 'bytes present' : 'missing');

  // -------------------------------------------------------------- interface
  const pull = await api('POST', '/api/github/files', { serverId, action: 'pull', paths: ['/docs/readme.md'] });
  check(
    'pull reports what it skipped instead of inventing success',
    pull.status === 200 && Array.isArray(pull.payload?.data?.result?.skipped),
  );

  const status = await api('GET', `/api/github/files?serverId=${serverId}&tick=1`);
  check('status endpoint returns the shared queue state', status.payload?.data?.sync?.project?.repo === 'octocat/darknote-bot');

  const pages = await Promise.all(['/files', '/editor', '/settings?tab=appearance', '/register', '/login'].map((target) => fetch(`${BASE}${target}`, { headers: { cookie } })));
  check('every upgraded page renders', pages.every((response) => response.ok), pages.map((response) => response.status).join(','));

  const policy = await fetch(`${BASE}/api/auth/policy`);
  const policyBody = await policy.json();
  check('public policy advertises registration and passkeys', policyBody?.data?.registrationEnabled === true && policyBody?.data?.passkeysEnabled === true);
  check('the credit line is published', policyBody?.data?.branding?.credit === 'POWERED BY JIMMY M, TECH');
  check('no secret leaks through the policy', !JSON.stringify(policyBody).includes(GITHUB_TOKEN));

  // ---------------------------------------------------------- registration
  const registration = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const adminCookies = registration.headers.getSetCookie?.() ?? [];
  const adminSession = adminCookies.find((value) => value.startsWith('dn_session=')) ?? '';

  const registered = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'New Person', email: 'new.person@darknote.test', password: 'Another-Strong-Pass-1' }),
  });
  const registeredBody = await registered.json();
  check(
    'self-service registration works and signs the account in',
    registered.status === 201 && registeredBody?.data?.registered === true && registeredBody?.data?.signedIn === true,
    `HTTP ${registered.status}`,
  );
  check(
    'the new account is a viewer by default',
    registeredBody?.data?.session?.user?.role === 'viewer',
    JSON.stringify(registeredBody?.data?.session?.user?.role ?? registeredBody?.error?.message ?? ''),
  );
  check('the registration cookie is a real session', (registered.headers.getSetCookie?.() ?? []).some((value) => value.startsWith('dn_session=')));

  // Registration stays available after a second request (no expiry, no one-shot).
  const again = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Second Person', email: 'second.person@darknote.test', password: 'Another-Strong-Pass-2' }),
  });
  check('registration is still open for another account', again.status === 201, `HTTP ${again.status}`);

  const duplicate = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'New Person', email: 'new.person@darknote.test', password: 'Another-Strong-Pass-1' }),
  });
  check('a duplicate email is refused', duplicate.status === 409, `HTTP ${duplicate.status}`);

  // Anonymous request: the credential list must never answer without a session.
  const biometrics = await fetch(`${BASE}/api/auth/webauthn/credentials`);
  check('credential list requires a session', biometrics.status === 401 || biometrics.status === 403, `HTTP ${biometrics.status}`);

  const platformSettings = await api('PUT', '/api/settings/platform', {
    appearance: { christmasEffects: 'reduced', animatedIntro: false },
    security: { passkeysEnabled: true, biometricLoginEnabled: true },
    registration: { enabled: false, defaultRole: 'operator' },
  });
  check(
    'platform settings save and normalise',
    platformSettings.status === 200 &&
      platformSettings.payload?.data?.settings?.appearance?.christmasEffects === 'reduced' &&
      platformSettings.payload?.data?.settings?.appearance?.snow === false,
    JSON.stringify(platformSettings.payload?.data?.settings?.appearance ?? platformSettings.payload?.error?.message ?? ''),
  );

  const closedAfter = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Third Person', email: 'third.person@darknote.test', password: 'Another-Strong-Pass-3' }),
  });
  check('closing registration is enforced', closedAfter.status === 403, `HTTP ${closedAfter.status}`);

  const reopen = await api('PUT', '/api/settings/platform', { registration: { enabled: true, defaultRole: 'viewer' } });
  check('registration can be reopened by the administrator', reopen.payload?.data?.settings?.registration?.enabled === true);
} catch (error) {
  console.error(error);
  console.error(logs.join('').slice(-4000));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await github.close();
  await panel.close?.();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
}
