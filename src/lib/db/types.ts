/**
 * Database types shared by the runtime (`src/lib/db.ts`), the migration runner
 * (`src/lib/db/migrate.ts`), the maintenance helpers and the CLI scripts.
 *
 * They live in their own module so the migration runner can depend on them
 * without pulling in the connection factory — a circular import between the two
 * would otherwise be resolved differently depending on which one is loaded
 * first, which is exactly the kind of bug that only shows up on a cold start.
 */

export type SqlParam = string | number | boolean | null | string[] | number[];

export interface DbConnection {
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<{ rows: T[] }>;
  /** Run a multi-statement script. Used only for schema application. */
  exec(sql: string): Promise<void>;
}

/** Which driver is talking to PostgreSQL. Reported by `/api/health`. */
export type DbKind = 'neon' | 'postgres' | 'pglite';

export interface DbPoolStats {
  total: number | null;
  idle: number | null;
  waiting: number | null;
}

export interface DbClient extends DbConnection {
  readonly kind: DbKind;
  /** Human-readable target (host/database, never the password). */
  readonly target: string;
  transaction<T>(fn: (connection: DbConnection) => Promise<T>): Promise<T>;
  stats(): DbPoolStats;
  /** Release pooled connections. Used by scripts and by tests. */
  close(): Promise<void>;
}

export interface MigrationRecord {
  name: string;
  checksum: string;
  appliedAt: string;
  durationMs: number | null;
}

export interface MigrationStatus {
  /** Every migration file shipped with this build. */
  available: string[];
  /** Migrations recorded in `db_migrations`. */
  applied: MigrationRecord[];
  pending: string[];
  /** Files whose checksum no longer matches what was applied. */
  drifted: string[];
}
