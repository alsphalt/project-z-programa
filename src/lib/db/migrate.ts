import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DbClient, DbConnection, MigrationRecord, MigrationStatus } from './types';

/**
 * Anything that can run a statement: the pool-backed client or one pinned
 * connection from a transaction. Every read in this module goes through it so
 * the same code can run inside or outside the migration gate.
 */
type Queryable = Pick<DbClient, 'query' | 'exec'> | DbConnection;

/**
 * Version-controlled migrations.
 *
 * The baseline is `db/schema.sql` — the single idempotent script that creates
 * every table, index and constraint. Everything after it lives in
 * `db/migrations/NNNN_name.sql` and is applied in filename order.
 *
 * Why not rewrite the schema into 40 ordered migrations? Because the baseline is
 * already `create … if not exists` and is shared by the embedded PGlite
 * development database, the tests and every existing deployment. Rewriting it
 * would mean guessing the state of production; adding a forward-only log on top
 * of it does not.
 *
 * Guarantees:
 *   - a PostgreSQL advisory lock serialises concurrent boots (several serverless
 *     instances cold-starting at once must not race);
 *   - every applied file is recorded with a SHA-256 checksum, so an edited
 *     migration that was already deployed is reported instead of silently
 *     skipped;
 *   - a database created by an older build (legacy `schema_migrations` rows, no
 *     `db_migrations` table) is adopted without re-running anything and without
 *     touching existing data.
 *
 * How the lock is held (repaired 2026-11-24, see the production outage below)
 * ---------------------------------------------------------------------------
 * The gate is `pg_try_advisory_xact_lock`, taken on the *same connection and
 * inside the same transaction* that then applies the DDL.
 *
 * The previous implementation took `pg_try_advisory_lock` through `client.query()`,
 * which is a pooled call: the connection was returned to the pool the moment the
 * statement finished, while still holding a session-scoped lock. Three
 * consequences, all of them observed in production:
 *
 *   1. the DDL ran on whichever connection the next pooled call picked, so the
 *      lock protected nothing — two instances applied the baseline at the same
 *      time and one died with
 *      `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`;
 *   2. the matching `pg_advisory_unlock` often landed on a different session,
 *      returned false, and left the lock held by an idle pooled connection —
 *      permanently, on a transaction-mode pooler such as Neon's `-pooler` host,
 *      where a client disconnect does not end the server session;
 *   3. every later boot then failed the 20 s wait with
 *      "Another process is running DARKNOTE migrations (advisory lock held for
 *      20s)" and login returned 500 until the lock's backend was recycled.
 *
 * A transaction-scoped lock is released by the server when the transaction ends
 * — commit, rollback, or the backend dying — so it cannot leak, and it is pinned
 * to one backend for its whole duration, which is also the only advisory-lock
 * form that is correct behind a transaction-mode pooler.
 */

const REGISTRY_TABLE = 'db_migrations';
const LEGACY_TABLE = 'schema_migrations';

/**
 * Advisory lock key for the migration gate.
 *
 * A fixed 64-bit constant rather than `hashtext('darknote_migrations')`: the
 * legacy key is abandoned on production backends by the broken implementation
 * above, and reusing it would mean waiting on a lock nobody can release. The key
 * only has to be stable for the code that ships together.
 */
export const MIGRATION_LOCK_KEY = '7623980129843';

const LOCK_KEY = MIGRATION_LOCK_KEY;

/** How long to wait for another instance's migration before giving up. */
export const MIGRATION_LOCK_WAIT_MS = (() => {
  const raw = Number(process.env.DARKNOTE_MIGRATION_LOCK_WAIT_MS ?? '');
  return Number.isFinite(raw) && raw >= 1_000 ? Math.min(raw, 120_000) : 15_000;
})();

export const BASELINE_NAME = '0001_baseline';

/**
 * Columns added to tables that a previous build already created.
 *
 * `create table if not exists` never alters a table that already exists, so an
 * older database keeps its old column set. schema.sql is then executed against
 * it and fails halfway — `imported_project_files_pending_delete_idx` references
 * `pending_delete`, which the old table does not have:
 *
 *   column "pending_delete" does not exist   (db/schema.sql:854)
 *
 * Because that failure happened before the version marker was written, every
 * later boot repeated it and every query failed (the production outage of
 * 2026-11-20). The repair therefore runs BEFORE the baseline and independently
 * of the registry, so a database that is already marked current but drifted
 * still heals itself.
 */
const LEGACY_COLUMNS: ReadonlyArray<readonly [table: string, column: string, definition: string]> = [
  ['imported_project_files', 'pending_delete', 'boolean not null default false'],
  ['github_sync_jobs', 'message', 'text'],
  ['editor_drafts', 'expected_bytes', 'bigint'],
  ['editor_drafts', 'expected_sha256', 'text'],
  ['editor_drafts', 'chunk_count', 'integer'],
];

/** Folder holding `schema.sql` and `migrations/`, relative to the project root. */
const SQL_DIR = 'db';

/** How far up the tree to look for the project root before giving up. */
const MAX_ANCESTORS = 8;

declare const __dirname: string | undefined;

function ancestors(start: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(start);
  for (let depth = 0; depth <= MAX_ANCESTORS; depth += 1) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return out;
}

/** Directory of the script that was started (`next start`, `npm run db:migrate`). */
function entryDir(): string | null {
  const entry = process.argv[1];
  return typeof entry === 'string' && entry.length > 0 ? path.dirname(path.resolve(entry)) : null;
}

/** Directory of this module as emitted by the bundler, when the runtime has one. */
function moduleDir(): string | null {
  try {
    return typeof __dirname === 'string' && __dirname.length > 0 ? __dirname : null;
  } catch {
    return null;
  }
}

/**
 * Every directory that could be the project root, most explicit first.
 *
 * `process.cwd()` alone is not enough. A process started by systemd, pm2 or
 * Pterodactyl, a `next start` launched from a parent folder, and a Next
 * standalone/serverless bundle all have a working directory that has nothing to
 * do with where the project was built. The old lookup only tried `cwd` and its
 * parent, so the first database call failed with "db/schema.sql not found" even
 * though the file was committed.
 */
export function dbRootCandidates(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | null | undefined) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push(resolved);
  };

  // 1. Explicit override, so a host with an unusual layout has a documented way
  //    out. Accepts the project root or the `db` folder itself.
  const override = process.env.DARKNOTE_DB_DIR?.trim();
  if (override) {
    add(override);
    add(path.dirname(path.resolve(override)));
  }

  // 2. The working directory and its ancestors (`npm run`, `next dev`).
  for (const dir of ancestors(process.cwd())) add(dir);

  // 3. The entry script and this module, then their ancestors. Covers a server
  //    started from another directory and a bundled `.next` output.
  for (const start of [entryDir(), moduleDir()]) {
    if (!start) continue;
    for (const dir of ancestors(start)) add(dir);
  }

  return roots;
}

/** A `db/schema.sql` that is not the project's baseline (an empty file, a note) is rejected. */
function looksLikeBaseline(file: string): boolean {
  try {
    return /create\s+table/i.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The project root that owns `db/schema.sql`, or `null` when no candidate has
 * one. Exported for the test that proves the cwd-independent lookup.
 */
export function findDbRoot(roots: string[] = dbRootCandidates()): string | null {
  for (const root of roots) {
    if (looksLikeBaseline(path.join(root, SQL_DIR, 'schema.sql'))) return root;
    // DARKNOTE_DB_DIR may point straight at db/.
    if (path.basename(root) === SQL_DIR && looksLikeBaseline(path.join(root, 'schema.sql'))) {
      return path.dirname(root);
    }
  }
  return null;
}

let cachedRoot: string | null = null;

/** Slate the memoised root; only tests and scripts that chdir need this. */
export function resetDbRootCache(): void {
  cachedRoot = null;
}

/**
 * Project root, resolved once. Throws an operator-facing error that lists every
 * path that was tried — a bare "not found" is what made this hard to diagnose.
 */
export function dbRoot(): string {
  if (cachedRoot) return cachedRoot;
  const root = findDbRoot();
  if (!root) {
    const tried = dbRootCandidates().map((candidate) => path.join(candidate, SQL_DIR, 'schema.sql'));
    throw new Error(
      [
        'Cannot initialise the database: db/schema.sql was not found.',
        'Looked for:',
        ...tried.map((candidate) => `  ${candidate}`),
        'The file must sit next to package.json. If your host ships only the built output,',
        'make sure db/ is traced into the bundle (outputFileTracingIncludes in next.config.ts),',
        'or set DARKNOTE_DB_DIR to the directory that contains db/.',
      ].join('\n'),
    );
  }
  cachedRoot = root;
  return root;
}

function readSql(relative: string): string {
  const file = path.join(dbRoot(), relative);
  if (!fs.existsSync(file)) {
    throw new Error(`${relative} not found at ${file} — cannot initialise the database`);
  }
  return fs.readFileSync(file, 'utf8');
}

export function baselineSql(): string {
  return readSql(path.join(SQL_DIR, 'schema.sql'));
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 32);
}

/**
 * Every migration this build ships, in application order: the baseline first,
 * then `db/migrations/*.sql` sorted by name.
 */
export function migrationFiles(): MigrationFile[] {
  const baseline = baselineSql();
  const files: MigrationFile[] = [
    { name: BASELINE_NAME, sql: baseline, checksum: checksum(baseline) },
  ];

  // Same root as the baseline: a migrations folder found through a different
  // rule than schema.sql is a folder from a different checkout.
  const dir = path.join(dbRoot(), SQL_DIR, 'migrations');
  if (!fs.existsSync(dir)) return files;

  const extra = fs
    .readdirSync(dir)
    .filter((entry) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(entry))
    .sort();
  for (const entry of extra) {
    const sql = fs.readFileSync(path.join(dir, entry), 'utf8');
    files.push({ name: entry.replace(/\.sql$/i, ''), sql, checksum: checksum(sql) });
  }
  return files;
}

async function tableExists(client: Queryable, table: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.tables
        where table_schema = current_schema() and table_name = $1
     ) as present`,
    [table],
  );
  return Boolean(result.rows[0]?.present);
}

/** Idempotent: adds the column only when the table exists without it. */
async function addColumnIfMissing(
  client: Queryable,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = $1 and column_name = $2
     ) as present`,
    [table, column],
  );
  if (result.rows[0]?.present) return;
  if (!(await tableExists(client, table))) return;
  await client.query(`alter table ${table} add column if not exists ${column} ${definition}`);
}

export async function repairLegacyColumns(client: Queryable): Promise<void> {
  for (const [table, column, definition] of LEGACY_COLUMNS) {
    await addColumnIfMissing(client, table, column, definition);
  }
}

async function ensureRegistry(client: Queryable): Promise<void> {
  await client.query(
    `create table if not exists ${REGISTRY_TABLE} (
       name         text primary key,
       checksum     text not null,
       applied_at   timestamptz not null default now(),
       duration_ms  integer
     )`,
  );
}

async function appliedMigrations(client: Queryable): Promise<MigrationRecord[]> {
  const rows = await client.query<{
    name: string;
    checksum: string;
    applied_at: string;
    duration_ms: number | null;
  }>(`select name, checksum, applied_at, duration_ms from ${REGISTRY_TABLE} order by name`);
  return rows.rows.map((row) => ({
    name: row.name,
    checksum: row.checksum,
    appliedAt:
      (row.applied_at as unknown) instanceof Date
        ? (row.applied_at as unknown as Date).toISOString()
        : String(row.applied_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  }));
}

/**
 * The applied records, or `null` when the registry table does not exist yet.
 *
 * Deliberately read-only. `migrationStatus` used to call `ensureRegistry()`,
 * which is `create table if not exists` — DDL — so a health probe or a login
 * request could race two instances into that statement and fail on
 * `pg_type_typname_nsp_index`. Creating the registry is now something only the
 * process holding the gate does.
 */
async function readRegistry(client: Queryable): Promise<MigrationRecord[] | null> {
  const present = await client.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [REGISTRY_TABLE],
  );
  if (!present.rows[0]?.present) return null;
  return appliedMigrations(client);
}

function statusOf(files: MigrationFile[], applied: MigrationRecord[]): MigrationStatus {
  const appliedByName = new Map(applied.map((record) => [record.name, record]));
  return {
    available: files.map((file) => file.name),
    applied,
    pending: files.filter((file) => !appliedByName.has(file.name)).map((file) => file.name),
    drifted: files
      .filter((file) => {
        const record = appliedByName.get(file.name);
        return record ? record.checksum !== file.checksum : false;
      })
      .map((file) => file.name),
  };
}

/**
 * Read-only status: two statements, no DDL, no lock. Safe on a cold start, on a
 * health probe, and on a login request.
 */
export async function migrationStatus(client: Queryable): Promise<MigrationStatus> {
  const files = migrationFiles();
  const applied = (await readRegistry(client)) ?? [];
  return statusOf(files, applied);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gateBusyMessage(waitMs: number): string {
  return [
    `Another process is running DARKNOTE migrations (the migration gate was held for ${Math.round(
      waitMs / 1000,
    )}s).`,
    'This is the safe outcome — a second instance waits instead of racing.',
    'If it persists, a migration is slow or a previous deployment was killed mid-run. Inspect the session:',
    "  select pid, state, now() - xact_start as age, left(query, 120) from pg_stat_activity where state <> 'idle';",
    'then run `npm run db:migrate` once from a single machine.',
    'The gate is transaction-scoped, so it is released automatically when that transaction ends — nothing needs to be unlocked by hand.',
  ].join(' ');
}

/**
 * Take the migration gate on ONE connection, as a transaction-scoped lock.
 *
 * Must be called with a connection that is inside a transaction (the callback
 * of `client.transaction`), because that is what scopes the lock: PostgreSQL
 * drops it when the transaction commits, rolls back, or the backend dies. It
 * therefore cannot be leaked, and it cannot be released on the wrong session.
 */
async function acquireGate(connection: DbConnection, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  let round = 0;
  for (;;) {
    const result = await connection.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock($1::bigint) as locked',
      [LOCK_KEY],
    );
    if (result.rows[0]?.locked) return;
    if (Date.now() >= deadline) throw new Error(gateBusyMessage(waitMs));
    round += 1;
    // Jittered backoff: a hundred cold starts must not poll in lock step.
    await delay(Math.min(150 + round * 80, 1_200) + Math.floor(Math.random() * 120));
  }
}

export interface MigrateOptions {
  /** Only report what would change. */
  dryRun?: boolean;
  /** Ignore checksum drift instead of failing. */
  allowDrift?: boolean;
  /**
   * Skip the gate. Only for a database with a single caller (embedded PGlite in
   * tests) — never for anything that can be reached by two instances.
   */
  noLock?: boolean;
  /** How long to wait for another instance's migration before giving up. */
  lockWaitMs?: number;
}

export interface MigrateResult extends MigrationStatus {
  appliedNow: string[];
  skipped: boolean;
}

async function recordMigration(
  client: Queryable,
  file: MigrationFile,
  durationMs: number,
  mode: 'apply' | 'refresh',
): Promise<void> {
  if (mode === 'refresh') {
    await client.query(
      `insert into ${REGISTRY_TABLE} (name, checksum, duration_ms) values ($1, $2, 0)
       on conflict (name) do update set checksum = excluded.checksum`,
      [file.name, file.checksum],
    );
    return;
  }
  await client.query(
    `insert into ${REGISTRY_TABLE} (name, checksum, duration_ms) values ($1, $2, $3)
     on conflict (name) do update set checksum = excluded.checksum, duration_ms = excluded.duration_ms`,
    [file.name, file.checksum, durationMs],
  );
}

/**
 * Adoption: a database created by a build that only knew `schema_migrations`
 * already contains the baseline tables. Record it instead of re-running the
 * whole baseline, and do it inside the gate like every other write.
 */
async function adoptLegacyBaseline(client: Queryable, files: MigrationFile[]): Promise<void> {
  const current = await appliedMigrations(client);
  if (current.length > 0) return;
  if (!(await tableExists(client, LEGACY_TABLE))) return;
  const legacy = await client.query<{ version: number }>(`select version from ${LEGACY_TABLE}`);
  if (legacy.rows.length === 0) return;
  const baseline = files[0];
  await client.query(
    `insert into ${REGISTRY_TABLE} (name, checksum, duration_ms) values ($1, $2, 0)
     on conflict (name) do nothing`,
    [baseline.name, baseline.checksum],
  );
}

/**
 * Apply everything that is pending.
 *
 * Two phases:
 *
 *   1. **Preflight** — read-only: two statements, no DDL, no lock. When nothing
 *      is pending (every boot after the first, and every instance that loses the
 *      race for the gate) this is the entire cost, so calling it on boot is
 *      cheap rather than a schema rewrite.
 *   2. **Apply** — one connection, one transaction, gate held, pending set
 *      recomputed *inside* the gate. Two instances therefore cannot apply the
 *      same file, and a failure rolls the batch back instead of leaving a
 *      half-applied schema that the next boot trips over.
 */
export async function migrate(
  client: DbClient,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const files = migrationFiles();
  const gateWaitMs = options.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS;

  // ------------------------------------------------------------------ phase 1
  const existing = (await readRegistry(client)) ?? [];
  const preflight = statusOf(files, existing);

  /**
   * The baseline is `create … if not exists` end to end, so re-running it can
   * only add what is missing — never rewrite a row. A cosmetic edit to
   * schema.sql (a comment, a reordered column in a table that already exists)
   * therefore must not block a boot; it is re-applied once and its checksum
   * refreshed. Numbered migrations are not idempotent by contract and stay
   * strictly checked: editing a released one is a bug, not a taste change.
   */
  const strictDrift = preflight.drifted.filter((name) => name !== BASELINE_NAME);
  if (strictDrift.length > 0 && !options.allowDrift) {
    throw new Error(
      `Migration checksum drift: ${strictDrift.join(', ')} changed after it was applied. Add a new migration instead of editing a released one (or pass --allow-drift if you know the change is safe).`,
    );
  }

  const baselineDrift = preflight.drifted.includes(BASELINE_NAME);
  const workExists = preflight.pending.length > 0 || baselineDrift;

  if (options.dryRun) {
    return {
      ...preflight,
      appliedNow: preflight.pending,
      skipped: preflight.pending.length === 0,
    };
  }
  if (!workExists) {
    return { ...preflight, appliedNow: [], skipped: true };
  }

  // ------------------------------------------------------------------ phase 2
  const appliedNow = await client.transaction(async (connection) => {
    if (!options.noLock) await acquireGate(connection, gateWaitMs);

    // Everything below runs on the connection that holds the gate. Creating the
    // registry and healing legacy columns are DDL, so they belong here too.
    await repairLegacyColumns(connection);
    await ensureRegistry(connection);
    await adoptLegacyBaseline(connection, files);

    // Double-checked: the instance that won the race computes its own work, and
    // an instance that waited for the gate finds the registry current here and
    // applies nothing.
    const inside = statusOf(files, await appliedMigrations(connection));
    const applied: string[] = [];

    if (inside.drifted.includes(BASELINE_NAME)) {
      await connection.exec(files[0].sql);
      await recordMigration(connection, files[0], 0, 'refresh');
      applied.push(files[0].name);
    }

    for (const file of files) {
      if (!inside.pending.includes(file.name)) continue;
      const started = Date.now();
      try {
        await connection.exec(file.sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file.name} failed: ${message}`);
      }
      await recordMigration(connection, file, Date.now() - started, 'apply');
      applied.push(file.name);
    }
    return applied;
  });

  const status = await migrationStatus(client);
  return { ...status, appliedNow, skipped: appliedNow.length === 0 };
}
