/**
 * The serverless database guard.
 *
 * Reported symptom: the production login page said "db/schema.sql not found —
 * cannot initialise the database". The file is committed and traced into the
 * build; what actually happened when no `DATABASE_URL` was present was that the
 * app fell back to the embedded PGlite database, which cannot persist on a
 * serverless host. The fallback is now refused there, by name, instead of
 * producing a file-not-found from a database that would have been discarded on
 * the next cold start.
 *
 * These tests run in real child processes because `env` is read once at import
 * time, exactly as it is in a deployment.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOOKS = path.join(HERE, 'register-hooks.mjs');
const DB = pathToFileURL(path.join(REPO, 'src', 'lib', 'db.ts')).href;

/** A clean environment: no inherited connection string, token or platform flag. */
function cleanEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(DATABASE_URL|VERCEL|NETLIFY|AWS_LAMBDA_FUNCTION_NAME|DARKNOTE_DB_DRIVER|DARKNOTE_DATA_DIR)$/.test(key)) continue;
    if (key.startsWith('DARKNOTE_DB')) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function run(source: string, overrides: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', HOOKS, '--experimental-strip-types', '--input-type=module', '-e', source],
    { cwd: REPO, encoding: 'utf8', env: cleanEnv(overrides) },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('a serverless production deployment without DATABASE_URL refuses PGlite and names the variable', () => {
  const probe = run(
    `const { dbHealth } = await import(${JSON.stringify(DB)});
     process.stdout.write(JSON.stringify(await dbHealth()));`,
    { NODE_ENV: 'production', VERCEL: '1' },
  );

  assert.equal(probe.status, 0, probe.stderr);
  const health = JSON.parse(probe.stdout) as { ok: boolean; error: string | null };
  assert.equal(health.ok, false, 'an unconfigured production database is not healthy');
  assert.match(health.error ?? '', /DATABASE_URL/);
  assert.match(health.error ?? '', /Neon/);
  assert.doesNotMatch(health.error ?? '', /schema\.sql not found/, 'the real cause is named, not the file');
});

test('the guard is off locally, so `npm run dev` and `next start` still use PGlite', () => {
  const probe = run(
    `const { pgliteFallbackAllowed } = await import(${JSON.stringify(DB)});
     process.stdout.write(String(pgliteFallbackAllowed()));`,
    { NODE_ENV: 'production' },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), 'true');
});

test('DARKNOTE_DB_DRIVER=pglite remains a deliberate, explicit escape hatch', () => {
  const probe = run(
    `const { pgliteFallbackAllowed } = await import(${JSON.stringify(DB)});
     process.stdout.write(String(pgliteFallbackAllowed()));`,
    { NODE_ENV: 'production', VERCEL: '1', DARKNOTE_DB_DRIVER: 'pglite' },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), 'true');
});

test('the login probe answers 200 with the database error instead of a bare 500', async () => {
  // Import the route directly; `publicRoute` only wraps the handler.
  const envBackup = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';
    delete process.env.DATABASE_URL;
    const { GET } = await import('../src/app/api/auth/session/route.ts');
    const response = (await GET(new Request('http://localhost/api/auth/session') as never)) as Response;
    assert.equal(response.status, 200, 'the login screen must always be able to render');
    // Route handlers answer `{ ok, data }`; the client unwraps `data`.
    const body = (await response.json()) as {
      data: {
        needsBootstrap: boolean;
        env: { ok: boolean; missing: string[] };
        database: { ok: boolean; error: string | null };
      };
    };
    assert.equal(body.data.database.ok, false);
    assert.match(body.data.database.error ?? '', /DATABASE_URL/);
    assert.equal(body.data.needsBootstrap, false, 'a broken database is not a first-run deployment');
    assert.ok(body.data.env.missing.some((entry) => entry.includes('DATABASE_URL')));
  } finally {
    process.env = envBackup;
  }
});
