import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Central environment access. Nothing here throws at import time so that the
 * Next.js build never depends on runtime secrets being present.
 */
const dataDir = process.env.DARKNOTE_DATA_DIR
  ? path.resolve(process.env.DARKNOTE_DATA_DIR)
  : path.join(process.cwd(), '.data');

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  dataDir,
  backupDir: path.join(dataDir, 'backups'),
  uploadDir: path.join(dataDir, 'uploads'),
  pgliteDir: path.join(dataDir, 'pglite'),

  databaseUrl: process.env.DATABASE_URL ?? '',
  /**
   * `require` (default) verifies the certificate — what Neon serves. `no-verify`
   * is for a proxy with a private CA; `disable` is for a local socket.
   */
  databaseSsl: (process.env.DATABASE_SSL ?? 'require').toLowerCase(),
  /**
   * postgres | neon | pglite | auto
   *
   * `postgres` is node-postgres over TCP (works with Neon's pooled endpoint,
   * a self-hosted server or CI). `neon` uses @neondatabase/serverless over a
   * WebSocket. `auto` picks the WebSocket driver only for a neon.tech host on a
   * serverless platform, and TCP everywhere else.
   */
  dbDriver: (process.env.DARKNOTE_DB_DRIVER ?? 'auto').toLowerCase() as
    | 'auto'
    | 'neon'
    | 'postgres'
    | 'pg'
    | 'pglite',

  adminEmail: process.env.DARKNOTE_ADMIN_EMAIL ?? '',
  adminPassword: process.env.DARKNOTE_ADMIN_PASSWORD ?? '',
  adminName: process.env.DARKNOTE_ADMIN_NAME ?? 'Administrator',

  /**
   * Shared secret that gates the browser first-run setup form. Accepts the
   * documented name and the bare SETUP_TOKEN spelling the setup screen refers to.
   */
  setupToken: process.env.DARKNOTE_SETUP_TOKEN ?? process.env.SETUP_TOKEN ?? '',

  /** Used for session token hashing + AES-256-GCM credential encryption. */
  secret: process.env.DARKNOTE_SECRET ?? '',

  sessionHours: Number(process.env.DARKNOTE_SESSION_HOURS ?? 12),
  loginMaxAttempts: Number(process.env.DARKNOTE_LOGIN_MAX_ATTEMPTS ?? 8),
  loginWindowMinutes: Number(process.env.DARKNOTE_LOGIN_WINDOW_MINUTES ?? 15),

  /** Global safety rails for remote operations. */
  maxIndexFiles: Number(process.env.DARKNOTE_MAX_INDEX_FILES ?? 4000),
  maxIndexDepth: Number(process.env.DARKNOTE_MAX_INDEX_DEPTH ?? 10),
  maxDownloadBytes: Number(process.env.DARKNOTE_MAX_DOWNLOAD_BYTES ?? 96 * 1024 * 1024),

  /**
   * Hard process ceiling for opening/editing a single text file. Per-server
   * limits (connected_servers.max_file_bytes) may be lower but can never exceed
   * this. The old build hard-coded a 2 MB ceiling; that is gone.
   */
  maxEditorBytes: Number(process.env.DARKNOTE_MAX_EDITOR_BYTES ?? 64 * 1024 * 1024),
  /** Size of one chunk the browser asks for / uploads. */
  editorChunkBytes: Math.max(
    64 * 1024,
    Math.min(Number(process.env.DARKNOTE_EDITOR_CHUNK_BYTES ?? 512 * 1024), 8 * 1024 * 1024),
  ),
  /** Never mirror a file larger than this into the SQL content cache. */
  maxSqlContentCacheBytes: Number(process.env.DARKNOTE_MAX_SQL_CACHE_BYTES ?? 1024 * 1024),
  maxSearchResults: Number(process.env.DARKNOTE_MAX_SEARCH_RESULTS ?? 400),

  trustProxy: process.env.DARKNOTE_TRUST_PROXY === '1',
  appUrl: process.env.DARKNOTE_APP_URL ?? '',
};

let dataDirsReady = false;

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** EROFS/EACCES/EPERM on a mounted container layer, or a cwd that does not exist. */
function isReadOnlyFileSystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EROFS' || code === 'EACCES' || code === 'EPERM' || code === 'ENOENT';
}

export function ensureDataDirs(): void {
  if (dataDirsReady) return;

  let base = env.dataDir;
  try {
    mkdirPrivate(base);
  } catch (error) {
    if (!isReadOnlyFileSystemError(error)) throw error;
    /**
     * Serverless platforms mount the deployment read-only (on Vercel the working
     * directory is `/var/task`), so `.data` cannot be created there and every
     * storage call failed with `ENOENT … mkdir '/var/task/.data'`. Only the
     * temporary directory is writable in that environment: use it and say so,
     * rather than turning the whole console into a 500.
     */
    base = path.join(os.tmpdir(), 'darknote-data');
    mkdirPrivate(base);
    // eslint-disable-next-line no-console
    console.warn(
      `[darknote] data directory ${env.dataDir} is not writable on this platform; using ${base} (ephemeral — persist uploads and backups elsewhere)`,
    );
    env.dataDir = base;
    env.backupDir = path.join(base, 'backups');
    env.uploadDir = path.join(base, 'uploads');
    env.pgliteDir = path.join(base, 'pglite');
  }

  mkdirPrivate(env.backupDir);
  mkdirPrivate(env.uploadDir);
  dataDirsReady = true;
}

let cachedSecret: string | null = null;

/**
 * Secrets must be stable between restarts, otherwise sessions and encrypted
 * panel credentials break. In production DARKNOTE_SECRET is mandatory; in
 * development we persist a generated key inside the private data directory.
 */
export function appSecret(): string {
  if (cachedSecret) return cachedSecret;
  if (env.secret && env.secret.length >= 24) {
    cachedSecret = env.secret;
    return cachedSecret;
  }
  if (env.isProd) {
    throw new Error(
      'DARKNOTE_SECRET is not configured. Set a random 32+ character value (openssl rand -base64 48) before starting in production.',
    );
  }
  ensureDataDirs();
  const keyFile = path.join(env.dataDir, 'dev-secret.key');
  if (fs.existsSync(keyFile)) {
    cachedSecret = fs.readFileSync(keyFile, 'utf8').trim();
    return cachedSecret;
  }
  const generated = crypto.randomBytes(48).toString('base64');
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  // eslint-disable-next-line no-console
  console.warn('[darknote] DARKNOTE_SECRET not set — generated a development key at .data/dev-secret.key');
  cachedSecret = generated;
  return generated;
}

export function warnMissingConfig(): string[] {
  const missing: string[] = [];
  if (!env.databaseUrl && env.dbDriver !== 'pglite') {
    missing.push('DATABASE_URL (Neon PostgreSQL) — currently using the embedded PGlite development database');
  }
  if (!env.secret) missing.push('DARKNOTE_SECRET — session signing and credential encryption key');
  if (!env.adminEmail || !env.adminPassword) {
    missing.push('DARKNOTE_ADMIN_EMAIL / DARKNOTE_ADMIN_PASSWORD — first-run administrator bootstrap');
  }
  return missing;
}
