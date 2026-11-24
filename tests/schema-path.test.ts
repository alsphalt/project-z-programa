/**
 * Where `db/schema.sql` is looked up.
 *
 * The first database call reads the baseline with `fs`, so the path has to be
 * right in every way this app is started: `npm run dev`, `next start` from the
 * project, a process started from another directory, and a bundled build. The
 * previous lookup tried `process.cwd()` and `process.cwd()/..` only, which fails
 * for all but the first — and produced a bare "db/schema.sql not found" that
 * looked like a missing file even when the file was committed.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findDbRoot } from '../src/lib/db/migrate.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOOKS = path.join(HERE, 'register-hooks.mjs');
const MIGRATE = pathToFileURL(path.join(REPO, 'src', 'lib', 'db', 'migrate.ts')).href;

const BASELINE = `-- test baseline
create table if not exists users (
  id serial primary key,
  email text not null
);
`;

function tempProject(withSchema: boolean): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'darknote-schema-'));
  if (withSchema) {
    mkdirSync(path.join(root, 'db'), { recursive: true });
    writeFileSync(path.join(root, 'db', 'schema.sql'), BASELINE);
  }
  return root;
}

/** Run a snippet in a real child process with a chosen cwd, the way a host starts the app. */
function runNode(cwd: string, source: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', HOOKS, '--experimental-strip-types', '--input-type=module', '-e', source],
    { cwd, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('a directory without db/schema.sql is not accepted as the project root', () => {
  const empty = tempProject(false);
  assert.equal(findDbRoot([empty]), null);
});

test('a db/schema.sql that is not a schema is rejected', () => {
  const root = tempProject(false);
  mkdirSync(path.join(root, 'db'), { recursive: true });
  writeFileSync(path.join(root, 'db', 'schema.sql'), '-- not the baseline\n');
  assert.equal(findDbRoot([root]), null);
});

test('the project root is found next to db/', () => {
  const root = tempProject(true);
  assert.equal(findDbRoot([root]), root);
});

test('DARKNOTE_DB_DIR may point at db/ itself', () => {
  const root = tempProject(true);
  assert.equal(findDbRoot([path.join(root, 'db')]), root);
});

test('the baseline resolves when the process is started from a subdirectory', () => {
  // No cwd match, no entry-script match: only walking up from the working
  // directory can find the checkout. Before the fix this threw.
  const started = runNode(
    path.join(REPO, 'src', 'lib'),
    `const { dbRoot, baselineSql } = await import(${JSON.stringify(MIGRATE)});
     process.stdout.write(dbRoot() + '\\n' + (baselineSql().length > 0 ? 'schema-loaded' : 'empty'));`,
  );
  assert.equal(started.status, 0, started.stderr);
  const [root, loaded] = started.stdout.split('\n');
  assert.equal(root, REPO, 'the checkout that owns db/ is the root, not the working directory');
  assert.equal(loaded, 'schema-loaded');
});

test('a missing schema fails with the attempted paths and the override', () => {
  const empty = tempProject(false);
  const failed = runNode(
    empty,
    `const { baselineSql } = await import(${JSON.stringify(MIGRATE)});
     baselineSql();`,
  );
  assert.notEqual(failed.status, 0, 'a missing schema must still be a hard error');
  assert.match(failed.stderr, /db\/schema\.sql was not found/);
  assert.match(failed.stderr, /DARKNOTE_DB_DIR/, 'the operator is told how to fix it');
  assert.ok(
    failed.stderr.includes(path.join(empty, 'db', 'schema.sql')),
    'every path that was tried is listed',
  );
});

test('the tracked schema and migrations exist exactly where the code expects them', () => {
  const files = execFileSync('git', ['ls-files', 'db'], { cwd: REPO, encoding: 'utf8' })
    .trim()
    .split('\n');
  assert.ok(files.includes('db/schema.sql'), 'db/schema.sql must be committed, not only on disk');
  assert.ok(
    files.some((file) => /^db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(file)),
    'db/migrations/*.sql must be committed too',
  );
  assert.equal(findDbRoot([REPO]), REPO);
});
