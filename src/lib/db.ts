import { env, ensureDataDirs } from './env';
import { migrate, migrationStatus, type MigrateResult } from './db/migrate';
import type { DbClient, DbConnection, DbKind, DbPoolStats, MigrationStatus, SqlParam } from './db/types';

export type { DbClient, DbConnection, DbKind, DbPoolStats, SqlParam } from './db/types';

/**
 * Database access.
 *
 * One interface (`DbClient`) over three drivers:
 *
 *   - `postgres` — node-postgres over TCP/TLS. Works with a Neon pooled
 *     connection string (`…-pooler.…neon.tech`), with a self-hosted PostgreSQL
 *     and with CI. This is the default whenever `DATABASE_URL` is set.
 *   - `neon` — `@neondatabase/serverless` (WebSocket) for environments where a
 *     long-lived TCP socket is unavailable or wasteful. Opt in with
 *     `DARKNOTE_DB_DRIVER=neon`.
 *   - `pglite` — the embedded PostgreSQL build used for local evaluation and by
 *     the test suite. Never the production store.
 *
 * Two rules keep connections from leaking:
 *
 *   1. The pool is created once per process (cached promise, also across HMR
 *      reloads through `globalThis`), so a request never opens a connection.
 *   2. On a serverless platform the pool is capped at one connection and
 *      `allowExitOnIdle` is set, so an idle function instance returns its
 *      connection to the pooler instead of holding a Neon slot.
 */

interface Cache {
  client?: Promise<DbClient>;
  migrations?: MigrateResult | null;
  /** Last failed initialisation, so a burst of requests does not retry it. */
  failure?: { at: number; error: Error };
}

const globalCache = globalThis as unknown as { __darknoteDb?: Cache };
const cache: Cache = (globalCache.__darknoteDb ??= {});

/** Human-readable description of the configured target, never the password. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return 'configured database';
  }
}

function isNeonHost(url: string): boolean {
  try {
    return /\.neon\.tech$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Can this process fall back to the embedded PGlite database?
 *
 * Locally, yes — that is how the app runs without any infrastructure. On a
 * serverless host (Vercel, Lambda, Netlify) the answer is no unless the operator
 * asks for it explicitly: the filesystem is read-only apart from an ephemeral
 * `/tmp`, so a PGlite database there is created empty on one instance, is
 * invisible to the next one, and is discarded on the next cold start — along
 * with every administrator account, session and project row written to it.
 *
 * It is also the shape of the reported production failure: with no
 * `DATABASE_URL`, the first query initialises PGlite, and if the baseline is not
 * in the deployed function bundle (or the platform refused the directory) the
 * login page reports "db/schema.sql not found — cannot initialise the database".
 * Either way the SQL file is not the problem — the missing connection string is.
 * Failing loudly beats silently building a database that cannot survive a
 * redeploy, and the message names the variable to set.
 */
export function pgliteFallbackAllowed(): boolean {
  if (env.dbDriver === 'pglite') return true;
  const serverless =
    process.env.VERCEL === '1' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.NETLIFY);
  return !(serverless && env.isProd);
}

export const NO_DATABASE_URL_MESSAGE = [
  'DATABASE_URL is not configured, and this deployment runs on a serverless host where the embedded',
  'PGlite database cannot persist: it would be created empty in /tmp and discarded on the next cold',
  'start, losing every administrator account and session.',
  'Set DATABASE_URL to the Neon PostgreSQL connection string (Neon → Project → Connection string,',
  'the "-pooler" host) and redeploy, or set DARKNOTE_DB_DRIVER=pglite deliberately for a throw-away preview.',
].join(' ');

function sslConfig(): false | { rejectUnauthorized: boolean } {
  if (env.databaseSsl === 'disable') return false;
  return { rejectUnauthorized: env.databaseSsl !== 'no-verify' };
}

/**
 * Pool size.
 *
 * Neon's pooled endpoint (PgBouncer in transaction mode) multiplexes many
 * clients onto few server connections, so the only thing a large local pool
 * achieves on Vercel is exhausting the project's connection limit. One
 * connection per instance is the documented serverless default; a long-running
 * `next start` deployment can use more.
 */
export function poolSize(): number {
  const explicit = Number(process.env.DARKNOTE_DB_POOL ?? '');
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(20, Math.floor(explicit));
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
  return serverless ? 1 : 8;
}

const TRANSIENT = [
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECTION_CLOSED',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08003',
  '08006',
  '08001',
];

export function isTransientDbError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | undefined;
  if (!err) return false;
  const code = String(err.code ?? '').toUpperCase();
  if (TRANSIENT.includes(code)) return true;
  const message = String(err.message ?? '').toLowerCase();
  return (
    message.includes('connection terminated') ||
    message.includes('connection closed') ||
    message.includes('server closed the connection') ||
    message.includes('timeout exceeded when trying to connect')
  );
}

/** One retry, short backoff — enough for a pooled connection recycled by Neon. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientDbError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120 * attempt));
    }
  }
  throw lastError;
}

function nullStats(): DbPoolStats {
  return { total: null, idle: null, waiting: null };
}

async function createPostgres(): Promise<DbClient> {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: poolSize(),
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
    allowExitOnIdle: true,
    application_name: 'darknote-control-center',
    ssl: sslConfig(),
  });
  // A pool error (server restart, network reset) must not take the process down:
  // node-postgres emits it on the pool, and an unhandled 'error' event is fatal.
  pool.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.warn(`[darknote] idle database connection dropped: ${error.message}`);
  });

  const client: DbClient = {
    kind: 'postgres',
    target: describeTarget(env.databaseUrl),
    async query<T>(sql: string, params?: SqlParam[]) {
      const res = await withRetry(() => pool.query(sql, params as unknown[]));
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (connection: DbConnection) => Promise<T>) {
      const connection = await pool.connect();
      const transactionClient: DbConnection = {
        async query<T>(sql: string, params?: SqlParam[]) {
          const result = await connection.query(sql, params as unknown[]);
          return { rows: result.rows as T[] };
        },
        async exec(sql: string) {
          await connection.query(sql);
        },
      };
      try {
        await connection.query('begin');
        const result = await fn(transactionClient);
        await connection.query('commit');
        return result;
      } catch (error) {
        try {
          await connection.query('rollback');
        } catch {
          /* the connection is already gone; rollback is implicit */
        }
        throw error;
      } finally {
        connection.release();
      }
    },
    stats() {
      return {
        total: pool.totalCount ?? null,
        idle: pool.idleCount ?? null,
        waiting: pool.waitingCount ?? null,
      };
    },
    async close() {
      await pool.end().catch(() => undefined);
    },
  };
  return client;
}

/**
 * Neon's serverless driver. Same SQL, no TCP socket: queries travel over a
 * WebSocket to the same PostgreSQL endpoint, which is what survives a
 * serverless platform that freezes or recycles a function between requests.
 */
async function createNeonServerless(): Promise<DbClient> {
  const neonModule = await import('@neondatabase/serverless');
  const { Pool, neonConfig } = neonModule;

  // Node needs an explicit WebSocket implementation; browsers have a global.
  if (!neonConfig.webSocketConstructor) {
    const { default: WebSocket } = await import('ws');
    neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;
  }

  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: poolSize(),
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
    allowExitOnIdle: true,
  });

  const client: DbClient = {
    kind: 'neon',
    target: describeTarget(env.databaseUrl),
    async query<T>(sql: string, params?: SqlParam[]) {
      const res = await withRetry(() => pool.query(sql, params as unknown[]));
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (connection: DbConnection) => Promise<T>) {
      const connection = await pool.connect();
      const transactionClient: DbConnection = {
        async query<T>(sql: string, params?: SqlParam[]) {
          const result = await connection.query(sql, params as unknown[]);
          return { rows: result.rows as T[] };
        },
        async exec(sql: string) {
          await connection.query(sql);
        },
      };
      try {
        await connection.query('begin');
        const result = await fn(transactionClient);
        await connection.query('commit');
        return result;
      } catch (error) {
        try {
          await connection.query('rollback');
        } catch {
          /* ignore */
        }
        throw error;
      } finally {
        connection.release();
      }
    },
    stats() {
      return {
        total: (pool as unknown as { totalCount?: number }).totalCount ?? null,
        idle: (pool as unknown as { idleCount?: number }).idleCount ?? null,
        waiting: (pool as unknown as { waitingCount?: number }).waitingCount ?? null,
      };
    },
    async close() {
      await pool.end().catch(() => undefined);
    },
  };
  return client;
}

async function createPglite(): Promise<DbClient> {
  // Never build a throw-away database where it cannot survive: see
  // `pgliteFallbackAllowed`. Throwing here surfaces through `dbHealth()` as
  // `ok: false` with an actionable message instead of a file-not-found.
  if (!pgliteFallbackAllowed()) throw new Error(NO_DATABASE_URL_MESSAGE);
  ensureDataDirs();
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create({ dataDir: env.pgliteDir });
  const client: DbClient = {
    kind: 'pglite',
    target: env.pgliteDir,
    async query<T>(sql: string, params?: SqlParam[]) {
      const res = await pg.query(sql, params as unknown[]);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async transaction<T>(fn: (connection: DbConnection) => Promise<T>) {
      const transactionClient: DbConnection = {
        async query<T>(sql: string, params?: SqlParam[]) {
          const result = await pg.query(sql, params as unknown[]);
          return { rows: result.rows as T[] };
        },
        async exec(sql: string) {
          await pg.exec(sql);
        },
      };
      await pg.query('begin');
      try {
        const result = await fn(transactionClient);
        await pg.query('commit');
        return result;
      } catch (error) {
        try {
          await pg.query('rollback');
        } catch {
          /* ignore */
        }
        throw error;
      }
    },
    stats() {
      return nullStats();
    },
    async close() {
      await pg.close().catch(() => undefined);
    },
  };
  return client;
}

function resolveKind(): DbKind {
  if (env.dbDriver === 'pglite') return 'pglite';
  if (!env.databaseUrl) return 'pglite';
  if (env.dbDriver === 'neon') return 'neon';
  if (env.dbDriver === 'postgres' || env.dbDriver === 'pg') return 'postgres';
  // auto
  return isNeonHost(env.databaseUrl) && (process.env.VERCEL === '1' || process.env.DARKNOTE_NEON_SERVERLESS === '1')
    ? 'neon'
    : 'postgres';
}

async function connect(): Promise<DbClient> {
  const kind = resolveKind();
  if (kind === 'pglite') return createPglite();
  return kind === 'neon' ? createNeonServerless() : createPostgres();
}

/**
 * Schema policy at boot.
 *
 * The rule the production outage taught: **a request must never migrate.**
 *
 *   - `always` — apply pending files on boot. Correct for a single long-running
 *     process (`next start`, a container, a VPS) and for development.
 *   - `auto` (default) — apply on boot where one process owns the schema, i.e.
 *     a long-running server; **verify only** on a serverless platform in
 *     production, because there every instance is a fresh process that would
 *     otherwise try to migrate on its first request.
 *   - `verify` — never apply; report pending files as a warning and in
 *     `/api/health`. Pairs with `npm run db:migrate` in a deploy step.
 *   - `never` — never apply, and treat a pending migration as a startup error
 *     instead of serving against an unknown schema.
 *
 * Verification is two read-only statements (see `migrationStatus`), so it cannot
 * hold a lock, create a table or block the login page.
 */
export type MigrationMode = 'always' | 'auto' | 'verify' | 'never';

export function migrationMode(): MigrationMode {
  const raw = (process.env.DARKNOTE_DB_MIGRATE ?? '').trim().toLowerCase();
  if (raw === 'always' || raw === 'verify' || raw === 'never') return raw;
  return 'auto';
}

/** Vercel / Lambda / Netlify: a process per request, not a server. */
function isServerlessRuntime(): boolean {
  return (
    process.env.VERCEL === '1' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.NETLIFY)
  );
}

/** Does this process own the schema, or only read it? */
export function mayMigrateOnBoot(): boolean {
  const mode = migrationMode();
  if (mode === 'always') return true;
  if (mode === 'never' || mode === 'verify') return false;
  return !(isServerlessRuntime() && env.isProd);
}

async function bootMigrations(client: DbClient): Promise<MigrateResult | null> {
  // CLI paths (db:migrate, db:backup, db:restore) own the schema themselves and
  // must be able to take a backup *before* anything is applied.
  if (process.env.DARKNOTE_NO_AUTO_MIGRATE === '1') return null;
  if (mayMigrateOnBoot()) return migrate(client, { allowDrift: true });

  const mode = migrationMode();
  const status = await migrationStatus(client);
  if (status.pending.length === 0) return null;

  const detail = `The database has ${status.pending.length} pending migration(s): ${status.pending.join(', ')}.`;
  if (mode === 'never') {
    throw new Error(
      `${detail} This deployment is configured with DARKNOTE_DB_MIGRATE=never, so it will not apply them: run \`npm run db:migrate\` once against this database and redeploy.`,
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[darknote] ${detail} Not applied here — a request never migrates. Run \`npm run db:migrate\` once from a single machine, or set DARKNOTE_DB_MIGRATE=always on exactly one long-running instance.`,
  );
  return null;
}

/**
 * How long a failed initialisation is remembered.
 *
 * A burst of requests used to retry the whole thing — connect, verify, and
 * (before this change) a 20 s attempt at the migration gate — once per request,
 * which turned one bad boot into a stampede of connections and lock polls. A
 * short window serves every request in that burst the same answer, and the
 * database that comes back after an outage heals on the next attempt.
 *
 * `DARKNOTE_DB_RETRY_MS=0` disables the pause.
 */
function retryPauseMs(): number {
  const raw = Number(process.env.DARKNOTE_DB_RETRY_MS ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : 3_000;
}

export function db(): Promise<DbClient> {
  if (!cache.client) {
    const pause = retryPauseMs();
    if (pause > 0 && cache.failure && Date.now() - cache.failure.at < pause) {
      return Promise.reject(cache.failure.error);
    }

    cache.client = (async () => {
      const client = await connect();
      try {
        cache.migrations = await bootMigrations(client);
        cache.failure = undefined;
        return client;
      } catch (error) {
        // Do not cache a failed initialisation: the next request retries, and a
        // database that comes back after an outage heals without a redeploy.
        await client.close().catch(() => undefined);
        cache.client = undefined;
        cache.failure = {
          at: Date.now(),
          error: error instanceof Error ? error : new Error(String(error)),
        };
        throw error;
      }
    })();
  }
  return cache.client;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const client = await db();
  const result = await client.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** JSON columns are always sent as stringified values so both drivers agree. */
export function jsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export async function withTransaction<T>(fn: (connection: DbConnection) => Promise<T>): Promise<T> {
  const client = await db();
  return client.transaction(fn);
}

export function dbKind(): DbKind {
  return resolveKind();
}

/** Release the pool. Scripts and tests only — the app keeps one pool for its life. */
export async function closeDatabase(): Promise<void> {
  const pending = cache.client;
  cache.client = undefined;
  cache.migrations = undefined;
  cache.failure = undefined;
  if (!pending) return;
  const client = await pending.catch(() => null);
  await client?.close();
}

export interface DbHealth {
  ok: boolean;
  kind: DbKind;
  target: string;
  latencyMs: number | null;
  serverVersion: string | null;
  tables: number | null;
  administrators: number | null;
  pool: DbPoolStats;
  migrations: { applied: number; pending: string[]; drifted: string[]; latest: string | null };
  error: string | null;
}

/**
 * Real connection test: asks PostgreSQL for its version, counts the schema and
 * reports what the migration registry holds. Used by `/api/health` and by
 * `npm run db:check`, so a deployment never claims to be healthy on a cached
 * answer.
 */
export async function dbHealth(): Promise<DbHealth> {
  const kind = resolveKind();
  const base: DbHealth = {
    ok: false,
    kind,
    target: kind === 'pglite' ? env.pgliteDir : describeTarget(env.databaseUrl),
    latencyMs: null,
    serverVersion: null,
    tables: null,
    administrators: null,
    pool: nullStats(),
    migrations: { applied: 0, pending: [], drifted: [], latest: null },
    error: null,
  };

  try {
    const client = await db();
    const started = Date.now();
    const version = await client.query<{ version: string }>('select version() as version');
    const tables = await client.query<{ count: string | number }>(
      `select count(*)::int as count from information_schema.tables where table_schema = current_schema()`,
    );
    let administrators: number | null = null;
    try {
      const admins = await client.query<{ count: string | number }>(
        'select count(*)::int as count from admin_users',
      );
      administrators = Number(admins.rows[0]?.count ?? 0);
    } catch {
      administrators = null;
    }
    const status: MigrationStatus = await migrationStatus(client).catch(() => ({
      available: [],
      applied: [],
      pending: [],
      drifted: [],
    }));

    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - started,
      serverVersion: String(version.rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ') || null,
      tables: Number(tables.rows[0]?.count ?? 0),
      administrators,
      pool: client.stats(),
      migrations: {
        applied: status.applied.length,
        pending: status.pending,
        drifted: status.drifted,
        latest: status.applied.at(-1)?.name ?? null,
      },
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
