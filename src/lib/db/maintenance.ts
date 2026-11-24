import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { env, ensureDataDirs } from '../env';
import { db, query, withTransaction, type DbHealth } from '../db';

/**
 * Operational database jobs: retention, health history and logical backups.
 *
 * These run from a controlled command (`npm run db:maintenance`, `npm run
 * db:backup`) and never from a page request. Pruning and dumping inside a
 * request would turn a read-only console into a write amplifier, which is the
 * opposite of what a phone-sized browser needs.
 */

export interface RetentionPolicy {
  /** Failed-login rows are only useful for the lockout window. */
  loginAttemptsDays: number;
  /** Resolved error-intelligence events. 0 keeps them forever. */
  errorEventsDays: number;
  downloadHistoryDays: number;
  githubSyncEventsDays: number;
  healthReportsDays: number;
  /** Audit trail. 0 (the default) keeps every row — audit logs are evidence. */
  activityLogsDays: number;
}

function days(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function retentionPolicy(): RetentionPolicy {
  return {
    loginAttemptsDays: days('DARKNOTE_RETAIN_LOGIN_ATTEMPTS_DAYS', 30),
    errorEventsDays: days('DARKNOTE_RETAIN_ERRORS_DAYS', 120),
    downloadHistoryDays: days('DARKNOTE_RETAIN_DOWNLOADS_DAYS', 90),
    githubSyncEventsDays: days('DARKNOTE_RETAIN_SYNC_EVENTS_DAYS', 60),
    healthReportsDays: days('DARKNOTE_RETAIN_HEALTH_DAYS', 30),
    activityLogsDays: days('DARKNOTE_RETAIN_AUDIT_DAYS', 0),
  };
}

export interface PruneResult {
  table: string;
  deleted: number;
  kept: 'forever' | number;
}

/**
 * Delete rows that are past their usefulness. Each statement is bounded by a
 * timestamp and returns how many rows it removed, so the caller can log real
 * numbers instead of assuming.
 */
export async function pruneOperationalData(policy = retentionPolicy()): Promise<PruneResult[]> {
  const plan: Array<{ table: string; days: number; where: string; column?: string }> = [
    { table: 'login_attempts', days: policy.loginAttemptsDays, where: '' },
    {
      table: 'error_intel_events',
      days: policy.errorEventsDays,
      where: " and status in ('resolved', 'ignored')",
      column: 'last_seen_at',
    },
    { table: 'download_history', days: policy.downloadHistoryDays, where: '' },
    { table: 'github_sync_events', days: policy.githubSyncEventsDays, where: '' },
    { table: 'system_health_reports', days: policy.healthReportsDays, where: '' },
    { table: 'activity_logs', days: policy.activityLogsDays, where: '' },
  ];

  const results: PruneResult[] = [];
  for (const entry of plan) {
    if (entry.days <= 0) {
      results.push({ table: entry.table, deleted: 0, kept: 'forever' });
      continue;
    }
    try {
      const rows = await query<{ deleted: number }>(
        `with removed as (
           delete from ${entry.table}
            where ${entry.column ?? 'created_at'} < now() - ($1::text || ' days')::interval${entry.where}
            returning 1
         )
         select count(*)::int as deleted from removed`,
        [String(entry.days)],
      );
      results.push({ table: entry.table, deleted: Number(rows[0]?.deleted ?? 0), kept: entry.days });
    } catch (error) {
      // A table that does not exist yet (older database) is not a failure.
      results.push({ table: entry.table, deleted: 0, kept: entry.days });
      void error;
    }
  }
  return results;
}

/** Persist one health probe result (see db/migrations/0003). */
export async function recordHealthReport(
  health: DbHealth,
  source: 'cli' | 'api' | 'deploy' = 'cli',
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await query(
      `insert into system_health_reports
         (id, source, status, database_kind, latency_ms, tables, migrations, detail, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        source,
        health.ok ? (health.migrations.pending.length > 0 ? 'degraded' : 'ok') : 'failed',
        health.kind,
        health.latencyMs,
        health.tables,
        JSON.stringify(health.migrations),
        JSON.stringify({ target: health.target, pool: health.pool, administrators: health.administrators }),
        health.error,
      ],
    );
    return id;
  } catch {
    // The reports table may not exist yet on the very first boot; a failed
    // diagnostics write must never fail the caller.
    return null;
  }
}

/** Every table in the current schema with an exact row count. */
export async function tableRowCounts(): Promise<Array<{ table: string; rows: number; bytes: number | null }>> {
  const rows = await query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'
      order by table_name`,
  );
  const counts: Array<{ table: string; rows: number; bytes: number | null }> = [];
  for (const row of rows) {
    const table = row.table_name;
    try {
      const count = await query<{ count: string | number }>(
        `select count(*)::int as count from "${table}"`,
      );
      const size = await query<{ bytes: string | number | null }>(
        `select pg_total_relation_size($1::regclass) as bytes`,
        [table],
      );
      counts.push({
        table,
        rows: Number(count[0]?.count ?? 0),
        bytes: size[0]?.bytes === null || size[0]?.bytes === undefined ? null : Number(size[0].bytes),
      });
    } catch {
      /* a view or a table this role cannot read: report it as unknown */
      counts.push({ table, rows: -1, bytes: null });
    }
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* logical backup                                                              */
/* -------------------------------------------------------------------------- */

export interface BackupManifest {
  createdAt: string;
  driver: string;
  tables: Array<{ table: string; rows: number; file: string; sha256: string; bytes: number }>;
  totalRows: number;
  format: 'ndjson.gz';
  version: 1;
}

function backupRoot(): string {
  ensureDataDirs();
  return path.join(env.backupDir, 'database');
}

/**
 * Full logical backup to NDJSON (one gzip file per table + a manifest).
 *
 * `pg_dump` is not available on a serverless host, and a single `select *` over
 * a large table would materialise the whole table in memory — the exact failure
 * this project is fixing. Rows are therefore streamed in pages of 500, and each
 * table is written to its own file so a restore can be selective.
 */
export async function backupDatabase(label = 'manual'): Promise<{
  directory: string;
  manifest: BackupManifest;
}> {
  const root = backupRoot();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(root, `${stamp}-${label}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const client = await db();
  const tables = await query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'
      order by table_name`,
  );

  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    driver: client.kind,
    tables: [],
    totalRows: 0,
    format: 'ndjson.gz',
    version: 1,
  };

  const pageSize = 500;
  for (const { table_name: table } of tables) {
    const file = `${table}.ndjson.gz`;
    const target = path.join(directory, file);
    const out = fs.createWriteStream(target, { mode: 0o600 });
    const gzip = zlib.createGzip({ level: 6 });
    gzip.pipe(out);
    const hash = crypto.createHash('sha256');

    // Identifiers cannot be parameterised; they come from information_schema and
    // are quoted, so a table name can never inject SQL here.
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = $1
        order by ordinal_position`,
      [table],
    );
    const columnList = columns.map((column) => `"${column.column_name}"`).join(', ');
    let rows = 0;
    let offset = 0;
    for (;;) {
      const page = await query<Record<string, unknown>>(
        `select ${columnList} from "${table}" order by ctid limit ${pageSize} offset ${offset}`,
      );
      if (page.length === 0) break;
      const chunk = page.map((row) => JSON.stringify(row)).join('\n') + '\n';
      hash.update(chunk);
      rows += page.length;
      if (!gzip.write(chunk)) {
        await new Promise((resolve) => gzip.once('drain', resolve));
      }
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    await new Promise<void>((resolve, reject) => {
      gzip.end((error?: Error | null) => (error ? reject(error) : resolve()));
      out.on('error', reject);
      out.on('finish', () => resolve());
    });

    const bytes = fs.statSync(target).size;
    manifest.tables.push({ table, rows, file, sha256: hash.digest('hex'), bytes });
    manifest.totalRows += rows;
  }

  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  return { directory, manifest };
}

/**
 * Restore a backup directory.
 *
 * Refuses to touch a database that already has administrators unless `replace`
 * is set, because the common accident is running a restore against production
 * while trying to inspect a backup.
 */
export async function restoreDatabase(
  directory: string,
  options: { replace?: boolean } = {},
): Promise<{ restored: Array<{ table: string; rows: number }> }> {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`${manifestPath} does not exist`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;

  const existing = await query<{ count: string | number }>('select count(*)::int as count from admin_users').catch(
    () => [{ count: 0 }],
  );
  if (Number(existing[0]?.count ?? 0) > 0 && !options.replace) {
    throw new Error(
      'This database already contains administrators. Restoring would overwrite live data — pass --replace if that is really what you want.',
    );
  }

  const restored: Array<{ table: string; rows: number }> = [];
  for (const entry of manifest.tables) {
    const file = path.join(directory, entry.file);
    if (!fs.existsSync(file)) continue;
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const rows = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (rows.length === 0) {
      restored.push({ table: entry.table, rows: 0 });
      continue;
    }

    await withTransaction(async (connection) => {
      if (options.replace) await connection.query(`delete from "${entry.table}"`);
      const columns = Object.keys(rows[0]);
      const columnList = columns.map((column) => `"${column}"`).join(', ');
      for (const row of rows) {
        await connection.query(
          `insert into "${entry.table}" (${columnList})
           values (${columns.map((_, index) => `$${index + 1}`).join(', ')})
           on conflict do nothing`,
          columns.map((column) => normalise(row[column])),
        );
      }
    });
    restored.push({ table: entry.table, rows: rows.length });
  }
  return { restored };
}

/** JSON columns come back as objects; the driver wants strings. */
function normalise(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value as string | number | boolean;
}

/** Newest backup directories, newest first. */
export function listBackups(): Array<{ name: string; path: string; createdAt: string; rows: number }> {
  const root = backupRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => fs.existsSync(path.join(root, entry, 'manifest.json')))
    .map((entry) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, entry, 'manifest.json'), 'utf8'),
      ) as BackupManifest;
      return {
        name: entry,
        path: path.join(root, entry),
        createdAt: manifest.createdAt,
        rows: manifest.totalRows,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
