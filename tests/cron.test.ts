/**
 * Serverless scheduler contract.
 *
 * On Vercel a function is frozen between requests, so the in-process timers in
 * `src/lib/worker/boot.ts` can never drain the push queue or poll branches.
 * `/api/cron/tick` replaces them — and because it talks to the hosting panel and
 * GitHub with stored credentials, the auth path matters more than the happy
 * path: an unset secret must disable the endpoint, and a wrong bearer must be
 * rejected before any work is imported.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

const { GET } = await import('../src/app/api/cron/tick/route.ts');
const { isServerlessRuntime } = await import('../src/lib/worker/boot.ts');

test('the endpoint refuses to run when CRON_SECRET is not configured', async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const response = await GET(new Request('http://localhost/api/cron/tick'));
    assert.equal(response.status, 503);
    const body = (await response.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /CRON_SECRET/);
  } finally {
    if (previous !== undefined) process.env.CRON_SECRET = previous;
  }
});

test('a wrong bearer is rejected before any work starts', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'expected-secret';
  try {
    const wrong = await GET(
      new Request('http://localhost/api/cron/tick', { headers: { authorization: 'Bearer nope' } }),
    );
    assert.equal(wrong.status, 401);

    const missing = await GET(new Request('http://localhost/api/cron/tick'));
    assert.equal(missing.status, 401);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('serverless hosts are detected so timers are not started there', () => {
  const keys = ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY', 'DARKNOTE_SERVERLESS'] as const;
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(isServerlessRuntime(), false, 'a normal node process keeps its timers');

    process.env.VERCEL = '1';
    assert.equal(isServerlessRuntime(), true, 'Vercel must fall back to /api/cron/tick');
    delete process.env.VERCEL;

    process.env.DARKNOTE_SERVERLESS = '1';
    assert.equal(isServerlessRuntime(), true, 'the explicit flag works for other serverless hosts');
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});
