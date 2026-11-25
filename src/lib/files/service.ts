import 'server-only';
import { jsonb, query, queryOne } from '../db';
import { randomToken, sha256, uuid } from '../crypto';
import { ApiError } from '../api';
import { env, ensureDataDirs } from '../env';
import type { ServerRecord } from '../servers/repo';
import { serverClient } from '../servers/repo';
import type { PterodactylClient, PteroFileEntry } from '../pterodactyl/client';
import {
  baseName,
  confineToRoot,
  isProbablyBinary,
  isSecretPath,
  joinRemote,
  parentOf,
} from '../security/paths';
import { backupKey, backupStorage } from '../backups/storage';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface RemoteFileSnapshot {
  path: string;
  content: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: string | null;
  secret: boolean;
}

/**
 * Effective editor limit for a server: the per-server setting, clamped by the
 * process ceiling. The old build multiplied a 512 KB default by four and called
 * the result a hard 2 MB limit.
 */
export function editorLimitFor(server: ServerRecord): number {
  const perServer = Number(server.maxFileBytes) > 0 ? Number(server.maxFileBytes) : 16 * 1024 * 1024;
  return Math.max(64 * 1024, Math.min(perServer, env.maxEditorBytes));
}

export async function remoteStat(
  client: PterodactylClient,
  filePath: string,
): Promise<PteroFileEntry | null> {
  try {
    const entries = await client.listFiles(parentOf(filePath));
    const name = baseName(filePath);
    return entries.find((entry) => entry.name === name && entry.is_file) ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a file from the production filesystem. Secrets are refused unless the
 * caller explicitly opts in with an elevated permission.
 */
export async function fetchRemoteFile(
  server: ServerRecord,
  filePath: string,
  options: { allowSecret?: boolean; maxBytes?: number; withStat?: boolean } = {},
): Promise<RemoteFileSnapshot> {
  const target = confineToRoot(server.projectRoot, filePath);
  if (isSecretPath(target) && !options.allowSecret) {
    throw new ApiError(
      'This path is classified as a secret (WhatsApp session / credential file) and is blocked by policy.',
      403,
      'secret_blocked',
    );
  }
  const client = await serverClient(server);
  const maxBytes = options.maxBytes ?? editorLimitFor(server);
  const content = await client.readFile(target, maxBytes);
  const stat = options.withStat === false ? null : await remoteStat(client, target);

  /**
   * A 200 with an empty body is how a missing `file.read` permission, an
   * interrupted transfer or a proxy used to reach the editor: the tab showed the
   * real filename and size (from the directory listing) and a completely blank
   * surface. Refuse it here so the UI reports a read failure instead of offering
   * an empty buffer to save.
   */
  if (stat && Number(stat.size) > 0 && content.length === 0) {
    throw new ApiError(
      `${target} is ${stat.size} bytes on the panel but its contents came back empty. ` +
        'Nothing was opened. Check that the Client API key has the file.read permission and try again.',
      502,
      'empty_body',
    );
  }

  return {
    path: target,
    content,
    sha256: sha256(content),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    modifiedAt: stat?.modified_at ?? null,
    secret: isSecretPath(target),
  };
}

/** Binary-safe fetch for backups and downloads. */
export async function downloadRemoteFile(
  server: ServerRecord,
  filePath: string,
  maxBytes = env.maxDownloadBytes,
): Promise<{ buffer: Buffer; sha256: string; sizeBytes: number }> {
  const target = confineToRoot(server.projectRoot, filePath);
  if (isSecretPath(target)) {
    throw new ApiError('Secret files cannot be downloaded or backed up.', 403, 'secret_blocked');
  }
  const client = await serverClient(server);
  const url = await client.downloadUrl(target);
  const buffer = await client.fetchDownload(url, maxBytes);
  return { buffer, sha256: sha256(buffer), sizeBytes: buffer.byteLength };
}

export async function cacheFileContent(
  serverId: string,
  filePath: string,
  hash: string,
  content: string,
): Promise<void> {
  await query(
    `insert into file_contents (server_id, path, sha256, content, bytes, fetched_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (server_id, path) do update set sha256 = excluded.sha256, content = excluded.content,
       bytes = excluded.bytes, fetched_at = now()`,
    [serverId, filePath, hash, content, Buffer.byteLength(content, 'utf8')],
  );
}

export async function cachedFileContent(
  serverId: string,
  filePath: string,
): Promise<{ content: string; sha256: string; bytes: number; fetchedAt: string } | null> {
  return queryOne(
    'select content, sha256, bytes, fetched_at from file_contents where server_id = $1 and path = $2',
    [serverId, filePath],
  );
}

/**
 * Short-lived in-process cache for full file text.
 *
 * Pterodactyl's `/files/contents` has no range support, so a 20 MB file costs one
 * 20 MB download and is then served to the browser as slices. Keeping the copy
 * here (not in the SQL `file_contents` table) means chunked reading never writes
 * giant blobs into Postgres.
 */
interface ReadCacheEntry {
  content: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: string | null;
  secret: boolean;
  fetchedAt: number;
}

const READ_TTL_MS = 90_000;
const READ_MAX_ENTRIES = 8;
const readCache = new Map<string, ReadCacheEntry>();

function readCacheKey(serverId: string, filePath: string): string {
  return `${serverId}\u0000${filePath}`;
}

export function invalidateReadCache(serverId: string, filePath?: string): void {
  if (filePath) {
    readCache.delete(readCacheKey(serverId, filePath));
    return;
  }
  for (const key of readCache.keys()) {
    if (key.startsWith(`${serverId}\u0000`)) readCache.delete(key);
  }
}

function pruneReadCache(): void {
  const budget = Math.max(env.maxDownloadBytes, 64 * 1024 * 1024);
  let total = 0;
  const entries = [...readCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
  for (const [, entry] of entries) total += entry.sizeBytes;
  for (const [key, entry] of entries) {
    if (readCache.size <= READ_MAX_ENTRIES && total <= budget) break;
    readCache.delete(key);
    total -= entry.sizeBytes;
  }
}

export async function readFileCached(
  server: ServerRecord,
  filePath: string,
  options: { maxBytes?: number; force?: boolean } = {},
): Promise<ReadCacheEntry> {
  const target = confineToRoot(server.projectRoot, filePath);
  const key = readCacheKey(server.id, target);
  const existing = readCache.get(key);
  if (!options.force && existing && Date.now() - existing.fetchedAt < READ_TTL_MS) {
    return existing;
  }
  const snapshot = await fetchRemoteFile(server, target, {
    maxBytes: options.maxBytes ?? editorLimitFor(server),
    withStat: true,
  });
  const entry: ReadCacheEntry = {
    content: snapshot.content,
    sha256: snapshot.sha256,
    sizeBytes: snapshot.sizeBytes,
    modifiedAt: snapshot.modifiedAt,
    secret: snapshot.secret,
    fetchedAt: Date.now(),
  };
  readCache.delete(key);
  readCache.set(key, entry);
  pruneReadCache();
  return entry;
}

export interface IndexEntry {
  path: string;
  name: string;
  parentPath: string;
  extension: string;
  isDirectory: boolean;
  isSymlink: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
  sha256: string | null;
  contentCached: boolean;
  secret: boolean;
  accessError: string | null;
}

export async function upsertIndexEntry(serverId: string, entry: IndexEntry): Promise<void> {
  const existing = await queryOne<{ id: string; sha256: string | null; deleted_at: string | null }>(
    'select id, sha256, deleted_at from file_indexes where server_id = $1 and path = $2',
    [serverId, entry.path],
  );
  if (existing) {
    await query(
      `update file_indexes set name=$3, parent_path=$4, extension=$5, is_directory=$6, is_symlink=$7,
         size_bytes=$8, remote_modified_at=$9::timestamptz, sha256=$10, content_cached=$11,
         is_secret=$12, access_error=$13, indexed_at=now(), deleted_at=null
       where server_id=$1 and path=$2`,
      [
        serverId,
        entry.path,
        entry.name,
        entry.parentPath,
        entry.extension,
        entry.isDirectory,
        entry.isSymlink,
        entry.sizeBytes,
        entry.modifiedAt,
        entry.sha256,
        entry.contentCached,
        entry.secret,
        entry.accessError,
      ],
    );
    return;
  }
  await query(
    `insert into file_indexes (id, server_id, path, name, parent_path, extension, is_directory, is_symlink,
       size_bytes, remote_modified_at, sha256, content_cached, is_secret, access_error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,$14)`,
    [
      uuid(),
      serverId,
      entry.path,
      entry.name,
      entry.parentPath,
      entry.extension,
      entry.isDirectory,
      entry.isSymlink,
      entry.sizeBytes,
      entry.modifiedAt,
      entry.sha256,
      entry.contentCached,
      entry.secret,
      entry.accessError,
    ],
  );
}

export async function indexedFile(serverId: string, filePath: string) {
  return queryOne<{
    id: string;
    path: string;
    sha256: string | null;
    size_bytes: string | number;
    remote_modified_at: string | null;
    content_cached: boolean;
    is_secret: boolean;
    deleted_at: string | null;
  }>('select * from file_indexes where server_id = $1 and path = $2 and is_directory = false', [
    serverId,
    filePath,
  ]);
}

export interface BackupRecord {
  id: string;
  version: number;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Store a copy of the current production content in private storage and record
 * it as a recoverable version. Called before every write.
 */
export async function createBackup(options: {
  server: ServerRecord;
  path: string;
  content?: string;
  buffer?: Buffer;
  reason: string;
  userId?: string | null;
  deploymentId?: string | null;
  note?: string | null;
}): Promise<BackupRecord> {
  const { server, path: filePath, reason } = options;
  let buffer: Buffer;
  if (options.buffer) buffer = options.buffer;
  else if (options.content !== undefined) buffer = Buffer.from(options.content, 'utf8');
  else buffer = (await downloadRemoteFile(server, filePath)).buffer;

  if (buffer.byteLength > env.maxDownloadBytes) {
    throw new ApiError('File is too large to back up with the configured limit.', 413, 'backup_too_large');
  }

  const hash = sha256(buffer);
  const key = backupKey(server.id, filePath, hash);
  await backupStorage().put(key, buffer);

  const backupId = uuid();
  await query(
    `insert into file_backups (id, server_id, path, sha256, size_bytes, storage_kind, storage_key, reason, deployment_id, created_by)
     values ($1,$2,$3,$4,$5,'local',$6,$7,$8,$9)`,
    [backupId, server.id, filePath, hash, buffer.byteLength, key, reason, options.deploymentId ?? null, options.userId ?? null],
  );

  const next = await queryOne<{ version: number }>(
    'select coalesce(max(version), 0) + 1 as version from file_versions where server_id = $1 and path = $2',
    [server.id, filePath],
  );
  const version = Number(next?.version ?? 1);
  await query(
    `insert into file_versions (id, server_id, path, version, sha256, size_bytes, content_ref, backup_id, deployment_id, change_note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      uuid(),
      server.id,
      filePath,
      version,
      hash,
      buffer.byteLength,
      key,
      backupId,
      options.deploymentId ?? null,
      options.note ?? reason,
      options.userId ?? null,
    ],
  );

  return { id: backupId, version, storageKey: key, sha256: hash, sizeBytes: buffer.byteLength };
}

async function verifyRemoteHash(
  client: PterodactylClient,
  filePath: string,
  expected: string,
  maxBytes = env.maxEditorBytes,
): Promise<void> {
  // Verify against the full process ceiling, not the editor limit: a file that
  // was just written must be proven byte-for-byte.
  const readBack = await client.readFile(filePath, Math.max(maxBytes, env.maxEditorBytes));
  const actual = sha256(readBack);
  if (actual !== expected) {
    throw new ApiError(
      `Write verification failed for ${filePath}: expected ${expected.slice(0, 12)}… but production returned ${actual.slice(0, 12)}….`,
      502,
      'write_verification_failed',
    );
  }
}

export interface WriteResult {
  path: string;
  previousHash: string | null;
  hash: string;
  version: number;
  backupId: string;
  atomic: boolean;
  restarted?: boolean;
}

/**
 * Write content to the real production file, never to a local copy.
 *
 * Order: optimistic-concurrency check → backup → atomic temp write + rename →
 * read-back hash verification → version metadata + index + cache update.
 */
export async function writeProductionFile(options: {
  server: ServerRecord;
  path: string;
  content: string;
  expectedHash?: string | null;
  note?: string;
  userId?: string | null;
  deploymentId?: string | null;
  skipBackup?: boolean;
  /** Internal restore paths only: allow an intentionally empty version to win. */
  allowEmpty?: boolean;
}): Promise<WriteResult> {
  const { server } = options;
  const target = confineToRoot(server.projectRoot, options.path);
  if (isSecretPath(target)) {
    throw new ApiError('Refusing to write to a protected session/credential path.', 403, 'secret_blocked');
  }
  if (isProbablyBinary(target)) {
    throw new ApiError('Binary files must be uploaded rather than written as text.', 415, 'binary_write');
  }

  const client = await serverClient(server);
  let current: string;
  try {
    current = await client.readFile(target, editorLimitFor(server));
  } catch (error) {
    if (error instanceof Error && /status 404|not found/i.test(error.message)) current = '';
    else throw error;
  }
  const currentHash = current === '' ? null : sha256(current);

  /**
   * Server-side twin of the editor's write guard. A blank editor surface must
   * never be able to erase a real production file, even if a client-side check
   * is bypassed or a draft was stored empty. Restores/rollbacks opt in
   * explicitly because replaying a genuinely empty version is legitimate.
   */
  if (!options.allowEmpty && options.content.length === 0 && current.length > 0) {
    throw new ApiError(
      `Refusing to overwrite ${target} with an empty buffer: production holds ` +
        `${Buffer.byteLength(current, 'utf8')} bytes. Reload the file and edit the real source.`,
      422,
      'empty_write_blocked',
    );
  }

  if (options.expectedHash && currentHash !== options.expectedHash) {
    throw new ApiError(
      'The production file changed since you opened it. Re-open the file and merge your changes — nothing was written.',
      409,
      'conflict',
      { remoteHash: currentHash, expectedHash: options.expectedHash, remoteModifiedAt: null },
    );
  }

  const backup = options.skipBackup
    ? { id: '', version: 0, storageKey: '', sha256: currentHash ?? '', sizeBytes: 0 }
    : await createBackup({
        server,
        path: target,
        content: current,
        reason: 'pre-write',
        userId: options.userId,
        deploymentId: options.deploymentId,
        note: options.note ?? 'Automatic backup before write',
      });

  const newHash = sha256(options.content);
  const parent = parentOf(target);
  const base = baseName(target);
  let atomic = false;

  if (server.atomicWrites) {
    const tmpName = `.${base}.darknote-${randomToken(4).replace(/[^a-zA-Z0-9]/g, '')}.tmp`;
    const tmpPath = joinRemote(parent, tmpName);
    try {
      await client.writeFile(tmpPath, options.content);
      await verifyRemoteHash(client, tmpPath, newHash);
      await client.rename(parent, [{ from: tmpName, to: base }]);
      await verifyRemoteHash(client, target, newHash);
      atomic = true;
    } catch (error) {
      // Clean up the temp file, then fall back to a direct verified write.
      try {
        await client.deleteFiles(parent, [tmpName]);
      } catch {
        /* the temp file may not exist */
      }
      if (error instanceof ApiError) throw error;
      await client.writeFile(target, options.content);
      await verifyRemoteHash(client, target, newHash);
    }
  } else {
    await client.writeFile(target, options.content);
    await verifyRemoteHash(client, target, newHash);
  }

  const versionRow = await queryOne<{ version: number }>(
    'select coalesce(max(version), 0) + 1 as version from file_versions where server_id = $1 and path = $2',
    [server.id, target],
  );
  const version = Number(versionRow?.version ?? 1);
  const stat = await remoteStat(client, target);
  await query(
    `insert into file_versions (id, server_id, path, version, sha256, size_bytes, deployment_id, change_note, created_by, remote_modified_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
    [
      uuid(),
      server.id,
      target,
      version,
      newHash,
      Buffer.byteLength(options.content, 'utf8'),
      options.deploymentId ?? null,
      options.note ?? 'Production write',
      options.userId ?? null,
      stat?.modified_at ?? null,
    ],
  );

  await upsertIndexEntry(server.id, {
    path: target,
    name: base,
    parentPath: parent,
    extension: base.includes('.') ? base.split('.').pop()!.toLowerCase() : '',
    isDirectory: false,
    isSymlink: false,
    sizeBytes: Buffer.byteLength(options.content, 'utf8'),
    modifiedAt: stat?.modified_at ?? new Date().toISOString(),
    sha256: newHash,
    contentCached: true,
    secret: false,
    accessError: null,
  });
  invalidateReadCache(server.id, target);
  // Mirror only small files into SQL. Large files are read from the panel and
  // cached in memory; a 20 MB row would slow every query for no benefit.
  if (Buffer.byteLength(options.content, 'utf8') <= env.maxSqlContentCacheBytes) {
    await cacheFileContent(server.id, target, newHash, options.content);
  }
  await query(
    `update editor_drafts set status = 'deployed', updated_at = now()
     where server_id = $1 and path = $2 and status in ('draft','conflict')`,
    [server.id, target],
  );

  return { path: target, previousHash: currentHash, hash: newHash, version, backupId: backup.id, atomic };
}

/** Validate a generated file on disk before it is allowed anywhere near production. */
export async function validateContent(
  filePath: string,
  content: string,
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ext = baseName(filePath).split('.').pop()?.toLowerCase() ?? '';
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > env.maxEditorBytes) {
    errors.push(`File is ${Math.round(bytes / 1024)} KB — above the ${Math.round(env.maxEditorBytes / 1024 / 1024)} MB process ceiling`);
  }
  if (content.includes('\0')) errors.push('File contains null bytes and is not valid text');

  if (ext === 'json') {
    try {
      JSON.parse(content);
    } catch (error) {
      errors.push(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (['js', 'cjs', 'mjs'].includes(ext)) {
    const acorn = await import('acorn');
    try {
      acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    } catch (scriptError) {
      try {
        acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
      } catch (moduleError) {
        errors.push(
          `Syntax error: ${moduleError instanceof Error ? moduleError.message : String(moduleError)}`,
        );
      }
      void scriptError;
    }
    // Node's own parser catches module/CommonJS issues acorn tolerates. It is
    // skipped for multi-megabyte files: writing a 20 MB temp file and spawning a
    // second parser adds seconds to every save, and acorn has already parsed it.
    try {
      if (bytes > 4 * 1024 * 1024) {
        warnings.push('Large file — syntax verified with the acorn parser only (node --check skipped).');
        throw new Error('__skipped_large_file__');
      }
      ensureDataDirs();
      const tmpDir = path.join(env.uploadDir, 'validate');
      await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const tmpFile = path.join(tmpDir, `check-${Date.now()}-${randomToken(4).replace(/[^a-zA-Z0-9]/g, '')}.${ext}`);
      await fs.writeFile(tmpFile, content, 'utf8');
      const { spawn } = await import('node:child_process');
      const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--check', tmpFile], { timeout: 15_000 });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
        child.on('error', (err) => resolve({ code: 1, stderr: err.message }));
      });
      await fs.unlink(tmpFile).catch(() => undefined);
      if (result.code !== 0 && errors.length === 0) {
        errors.push(`node --check failed: ${result.stderr.split('\n').slice(0, 4).join(' ').trim()}`);
      }
    } catch (error) {
      if (!(error instanceof Error && error.message === '__skipped_large_file__')) {
        warnings.push(
          `Could not run node --check locally: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (bytes > 1_500_000) warnings.push('Very large file — the editor uses its large-file profile.');
  return { ok: errors.length === 0, errors, warnings };
}

export async function fileHistory(serverId: string, filePath: string, limit = 30) {
  return query(
    `select v.id, v.version, v.sha256, v.size_bytes, v.change_note, v.created_by, v.deployment_id,
            v.created_at, v.remote_modified_at, b.storage_key, b.reason
       from file_versions v
       left join file_backups b on b.id = v.backup_id
      where v.server_id = $1 and v.path = $2
      order by v.version desc limit $3`,
    [serverId, filePath, limit],
  );
}

export async function recordUpdateEvent(
  serverId: string,
  kind: string,
  filePath: string | null,
  source: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `insert into update_events (id, server_id, path, kind, source, detail) values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [uuid(), serverId, filePath, kind, source, jsonb(detail)],
  );
}
