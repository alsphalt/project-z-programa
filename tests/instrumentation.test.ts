/**
 * Regression guard for the blank-page failure.
 *
 * `next dev` compiles `src/instrumentation.ts` in a dedicated bundle that does
 * not apply `serverExternalPackages`. When that file imported the GitHub pull
 * poller, `pg` entered the graph, `pg` requires `fs`, and the compilation died
 * with `Module not found: Can't resolve 'fs'` — which aborts the dev server's
 * boot, so every page was blank.
 *
 * The fix was to start the workers from the normal server graph instead. These
 * assertions fail if the import comes back.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

test('instrumentation.ts imports nothing from the application', () => {
  const source = read('src/instrumentation.ts');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');

  const imports = [
    ...code.matchAll(/^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm),
    ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    imports,
    [],
    `instrumentation.ts must stay import-free (found: ${imports.join(', ')}). The workers live in src/lib/worker/boot.ts.`,
  );
});

test('the workers are exported from their own module and started from the server graph', () => {
  const boot = read('src/lib/worker/boot.ts');
  assert.match(boot, /export function ensureBackgroundWorkers\(/, 'the boot module must export the entry point');
  assert.match(boot, /import 'server-only'/, 'the boot module is server code');

  const layout = read('src/app/layout.tsx');
  assert.match(layout, /ensureBackgroundWorkers\(\)/, 'the root layout must start the workers');

  const health = read('src/app/api/health/route.ts');
  assert.match(health, /ensureBackgroundWorkers\(\)/, 'the health probe must start the workers in a fresh process');
});

test('ensureBackgroundWorkers is idempotent and never throws', async () => {
  process.env.DARKNOTE_DISABLE_GITHUB_WORKER = '1';
  process.env.DARKNOTE_DISABLE_GITHUB_PULL_POLL = '1';
  const { ensureBackgroundWorkers } = await import('../src/lib/worker/boot.ts');
  ensureBackgroundWorkers();
  ensureBackgroundWorkers();
  const flags = globalThis as unknown as { __darknoteWorkersStarted?: boolean };
  assert.equal(flags.__darknoteWorkersStarted, true);
});
