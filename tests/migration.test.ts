/**
 * Schema migration regression test — the production outage of 2026-11-20.
 *
 * A database created by an older build keeps its old column set, because
 * `create table if not exists` never alters an existing table. schema.sql was
 * executed against that database and failed on
 * `imported_project_files_pending_delete_idx` (`column "pending_delete" does not
 * exist`, db/schema.sql:854). The version marker was never written, so every
 * boot repeated the failure and every authenticated request returned 500 —
 * including the server render of `/`, which is the
 * "Application error: a server-side exception has occurred" page.
 *
 * The test builds a v4-era database (no `pending_delete` column, no index, no
 * version marker) and proves that opening it now heals it instead of failing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-migration-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';

/** schema.sql as a v4 deployment created it: without the v5 column and index. */
function legacySchema(): string {
  const sql = readFileSync(path.join(process.cwd(), 'db', 'schema.sql'), 'utf8');
  const withoutColumn = sql.replace(/^\s*pending_delete boolean not null default false,.*$/m, '');
  assert.notEqual(withoutColumn, sql, 'the pending_delete column line was found in schema.sql');
  const withoutIndex = withoutColumn.replace(
    /create index if not exists imported_project_files_pending_delete_idx\s+on imported_project_files \(project_id\) where pending_delete = true;/,
    '',
  );
  assert.notEqual(withoutIndex, withoutColumn, 'the pending_delete index was found in schema.sql');
  return withoutIndex;
}

async function columnExists(client: PGlite, column: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'imported_project_files'
          and column_name = $1
     ) as present`,
    [column],
  );
  return Boolean(result.rows[0]?.present);
}

test('a database created before pending_delete existed migrates instead of failing', async () => {
  const pgliteDir = path.join(dataDir, 'pglite');

  // 1. Create the database exactly as the previous release left it.
  const legacy = await PGlite.create({ dataDir: pgliteDir });
  await legacy.exec(legacySchema());
  await legacy.exec(
    `create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())`,
  );
  assert.equal(await columnExists(legacy, 'pending_delete'), false);
  await legacy.close();

  // 2. Boot the current application against it — this is what every request does.
  const { query } = await import('../src/lib/db.ts');
  const rows = await query<{ count: number | string }>(
    'select count(*)::int as count from imported_project_files',
  );
  assert.equal(Number(rows[0]?.count), 0);

  // 3. The column, its partial index and the version marker really exist now.
  const check = await PGlite.create({ dataDir: pgliteDir });
  try {
    assert.equal(await columnExists(check, 'pending_delete'), true);
    const index = await check.query<{ indexname: string }>(
      `select indexname from pg_indexes where indexname = 'imported_project_files_pending_delete_idx'`,
    );
    assert.equal(index.rows.length, 1, 'the partial index must exist after migration');
    /**
     * The registry moved from `schema_migrations` (a single version integer) to
     * `db_migrations` (one row per applied file, with a checksum). A database
     * that only knows the old table is adopted: the baseline is recorded without
     * being re-run, and every later migration is applied on top of it.
     */
    const registry = await check.query<{ name: string }>(
      'select name from db_migrations order by name',
    );
    assert.equal(registry.rows[0]?.name, '0001_baseline', 'the baseline must be recorded');
    assert.ok(
      registry.rows.some((row) => row.name === '0002_operational_indexes'),
      'later migrations must be applied to an adopted database',
    );
    // The column the query layer writes through is usable, with its default.
    const column = await check.query<{ column_default: string | null }>(
      `select column_default from information_schema.columns
        where table_schema = current_schema() and table_name = 'imported_project_files'
          and column_name = 'pending_delete'`,
    );
    assert.match(String(column.rows[0]?.column_default), /false/);
    const rows = await check.query<{ pending_delete: boolean }>(
      `select pending_delete from imported_project_files limit 1`,
    );
    assert.deepEqual(rows.rows, []);
  } finally {
    await check.close();
  }
});
