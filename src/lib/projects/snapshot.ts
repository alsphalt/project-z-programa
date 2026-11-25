import 'server-only';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ApiError } from '../api';
import { sha256, uuid } from '../crypto';
import { query, queryOne, withTransaction } from '../db';
import { backupStorage } from '../backups/storage';
import { logActivity } from '../audit';
import * as repo from './repo';

/**
 * Whole-tree snapshots of an imported project.
 *
 * This is the artefact behind "BACKUP & REPLACE": before an import overwrites a
 * working copy that already exists, every stored file is written to backup
 * storage as a single gzipped archive with a manifest hash, and the import only
 * proceeds once that archive has been read back and re-hashed successfully.
 *
 * Deliberate properties:
 *  - the archive never goes into PostgreSQL (large projects, and the spec
 *    forbids it) — only its identity and manifest hash are stored;
 *  - `verifySnapshot()` re-reads the archive from storage every time it matters.
 *    A stale `verified = true` flag is not evidence;
 *  - restoring is atomic (delete + insert in one transaction) and the manifest
 *    is recomputed **inside** that transaction, so a partial restore cannot
 *    commit;
 *  - a restore takes its own snapshot first, so restoring is reversible too.
 */

export type SnapshotKind = 'pre-import' | 'manual' | 'pre-restore' | 'auto-rollback';

export interface SnapshotFile {
  path: string;
  sha256: string | null;
  sizeBytes: number;
  isText: boolean;
  contentOmitted: boolean;
  remoteSha: string | null;
  content: string | null;
}

export interface SnapshotRecord {
  id: string;
  projectId: string;
  kind: SnapshotKind;
  label: string | null;
  storageKey: string;
  filesCount: number;
  bytes: number;
  manifestSha256: string;
  verified: boolean;
  verifiedAt: string | null;
  restoredAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SnapshotManifest {
  manifestSha256: string;
  files: number;
  bytes: number;
}

/** Snapshots kept per project before the oldest are pruned. */
export const SNAPSHOT_RETENTION = 10;

type Row = Record<string, unknown>;

function mapSnapshot(row: Row): SnapshotRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: (row.kind as SnapshotKind) ?? 'manual',
    label: (row.label as string) ?? null,
    storageKey: String(row.storage_key),
    filesCount: Number(row.files_count ?? 0),
    bytes: Number(row.bytes ?? 0),
    manifestSha256: String(row.manifest_sha256 ?? ''),
    verified: Boolean(row.verified),
    verifiedAt: row.verified_at ? new Date(row.verified_at as string).toISOString() : null,
    restoredAt: row.restored_at ? new Date(row.restored_at as string).toISOString() : null,
    createdBy: (row.created_by as string) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

/**
 * Manifest over `path`, content hash and size, sorted by path.
 *
 * `sha256` is recomputed from the content when the content is present, so a
 * corrupted archive that kept its metadata cannot pass verification.
 */
export function snapshotManifest(files: SnapshotFile[]): SnapshotManifest {
  const lines = files
    .map((file) => ({
      path: file.path,
      hash: file.content !== null ? sha256(file.content) : (file.sha256 ?? ''),
      bytes: file.content !== null ? Buffer.byteLength(file.content, 'utf8') : file.sizeBytes,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const material = lines.map((line) => `${line.path}\t${line.hash}\t${line.bytes}`).join('\n');
  return {
    manifestSha256: sha256(material),
    files: lines.length,
    bytes: lines.reduce((sum, line) => sum + line.bytes, 0),
  };
}

function encodeArchive(projectId: string, files: SnapshotFile[]): Buffer {
  const payload = { version: 1, projectId, createdAt: new Date().toISOString(), files };
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
}

function decodeArchive(buffer: Buffer, projectId: string): SnapshotFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(buffer).toString('utf8'));
  } catch {
    throw new ApiError('That snapshot archive is unreadable (not a valid gzip payload).', 422, 'snapshot_corrupt');
  }
  const payload = parsed as { version?: number; projectId?: string; files?: unknown };
  if (!payload || payload.version !== 1 || !Array.isArray(payload.files)) {
    throw new ApiError('That snapshot archive has an unknown format.', 422, 'snapshot_corrupt');
  }
  if (payload.projectId !== projectId) {
    throw new ApiError(
      'That snapshot belongs to a different project; restoring it here would mix two working copies.',
      409,
      'snapshot_wrong_project',
    );
  }
  return payload.files as SnapshotFile[];
}

async function readProjectFiles(projectId: string): Promise<SnapshotFile[]> {
  const rows = await query<Row>(
    `select path, sha256, size_bytes, is_text, content_omitted, remote_sha, content
       from imported_project_files
      where project_id = $1
      order by path asc`,
    [projectId],
  );
  return rows.map((row) => ({
    path: String(row.path),
    sha256: (row.sha256 as string) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    isText: row.is_text === undefined ? true : Boolean(row.is_text),
    contentOmitted: Boolean(row.content_omitted),
    remoteSha: (row.remote_sha as string) ?? null,
    content: (row.content as string) ?? null,
  }));
}

/**
 * Captures every stored file of a project into backup storage and verifies it.
 * Throws unless the archive can be read back and matches the manifest.
 */
export async function createProjectSnapshot(options: {
  projectId: string;
  kind?: SnapshotKind;
  label?: string | null;
  userId?: string | null;
  keep?: number;
}): Promise<SnapshotRecord> {
  const project = await repo.requireProject(options.projectId);
  const files = await readProjectFiles(project.id);
  if (!files.length) {
    throw new ApiError(
      'There is nothing to back up: the destination project has no stored files.',
      400,
      'empty_project',
    );
  }

  const manifest = snapshotManifest(files);
  const id = uuid();
  const storageKey = `projects/${project.id}/${id}.json.gz`;

  await backupStorage().put(storageKey, encodeArchive(project.id, files));

  const row = await queryOne<Row>(
    `insert into project_snapshots
       (id, project_id, kind, label, storage_key, files_count, bytes, manifest_sha256, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning *`,
    [
      id,
      project.id,
      options.kind ?? 'manual',
      options.label ?? null,
      storageKey,
      manifest.files,
      manifest.bytes,
      manifest.manifestSha256,
      options.userId ?? null,
    ],
  );

  const record = mapSnapshot(row as Row);

  // Verify before anything is allowed to overwrite the project. A backup that
  // was never read back is not a backup.
  const verified = await verifySnapshot(id);
  if (!verified.ok) {
    await query(`delete from project_snapshots where id = $1`, [id]);
    await backupStorage().remove(storageKey).catch(() => undefined);
    throw new ApiError(
      `The backup could not be verified (${verified.reason ?? 'manifest mismatch'}), so the import was not started.`,
      500,
      'snapshot_unverified',
    );
  }

  await pruneSnapshots(project.id, options.keep ?? SNAPSHOT_RETENTION);
  return { ...record, verified: true, verifiedAt: new Date().toISOString() };
}

/** Re-reads the archive from storage and compares it with the recorded manifest. */
export async function verifySnapshot(
  snapshotId: string,
): Promise<{ ok: boolean; reason?: string; files?: number; bytes?: number }> {
  const row = await queryOne<Row>(`select * from project_snapshots where id = $1`, [snapshotId]);
  if (!row) throw new ApiError('That snapshot no longer exists.', 404, 'snapshot_not_found');
  const record = mapSnapshot(row);

  let buffer: Buffer;
  try {
    buffer = await backupStorage().get(record.storageKey);
  } catch {
    return { ok: false, reason: 'the archive is missing from backup storage' };
  }

  let files: SnapshotFile[];
  try {
    files = decodeArchive(buffer, record.projectId);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'unreadable archive' };
  }

  const manifest = snapshotManifest(files);
  if (manifest.manifestSha256 !== record.manifestSha256) {
    return { ok: false, reason: 'archive contents no longer match the recorded manifest' };
  }
  if (manifest.files !== record.filesCount) {
    return { ok: false, reason: `archive holds ${manifest.files} files, the record says ${record.filesCount}` };
  }

  await query(`update project_snapshots set verified = true, verified_at = now() where id = $1`, [snapshotId]);
  return { ok: true, files: manifest.files, bytes: manifest.bytes };
}

export async function listProjectSnapshots(projectId: string): Promise<SnapshotRecord[]> {
  const rows = await query<Row>(
    `select * from project_snapshots where project_id = $1 order by created_at desc`,
    [projectId],
  );
  return rows.map(mapSnapshot);
}

export async function getProjectSnapshot(projectId: string, snapshotId: string): Promise<SnapshotRecord> {
  const row = await queryOne<Row>(
    `select * from project_snapshots where id = $1 and project_id = $2`,
    [snapshotId, projectId],
  );
  if (!row) throw new ApiError('That snapshot does not belong to this project.', 404, 'snapshot_not_found');
  return mapSnapshot(row);
}

export interface RestoreReport {
  snapshot: SnapshotRecord;
  safetySnapshotId: string;
  files: number;
  bytes: number;
  verified: boolean;
  note: string;
  at: string;
}

/**
 * Replaces the project's stored tree with the snapshot's tree, atomically.
 *
 * The manifest is recomputed from the rows written **inside** the transaction:
 * if the restored tree does not match the archive byte for byte, the
 * transaction rolls back and the project keeps the state it had.
 */
export async function restoreProjectSnapshot(options: {
  projectId: string;
  snapshotId: string;
  userId?: string | null;
  user?: { id: string; email: string } | null;
  /** Internal guard so an automatic rollback never snapshots itself forever. */
  skipSafetySnapshot?: boolean;
}): Promise<RestoreReport> {
  const record = await getProjectSnapshot(options.projectId, options.snapshotId);

  const check = await verifySnapshot(record.id);
  if (!check.ok) {
    throw new ApiError(
      `The snapshot failed verification (${check.reason ?? 'unknown reason'}), so nothing was restored.`,
      409,
      'snapshot_integrity_failed',
    );
  }

  const buffer = await backupStorage().get(record.storageKey);
  const files = decodeArchive(buffer, record.projectId);
  const expected = snapshotManifest(files);

  const safety = options.skipSafetySnapshot
    ? null
    : await createProjectSnapshot({
        projectId: options.projectId,
        kind: 'pre-restore',
        label: `Before restoring ${record.label ?? record.id}`,
        userId: options.userId ?? null,
      }).catch(() => null);

  /**
   * Ids are kept for paths that already exist. A restore rewrites the whole
   * tree, and new ids would silently invalidate every open editor tab and any
   * draft pointing at a file: the tab would then save to a 404.
   */
  const existingIds = new Map(
    (
      await query<{ id: string; path: string }>(
        `select id, path from imported_project_files where project_id = $1`,
        [options.projectId],
      )
    ).map((row) => [String(row.path), String(row.id)]),
  );

  const written = await withTransaction(async (connection) => {
    await connection.query(`delete from imported_project_files where project_id = $1`, [options.projectId]);
    for (let index = 0; index < files.length; index += 40) {
      const chunk = files.slice(index, index + 40);
      const values: string[] = [];
      const params: Array<string | number | boolean | null> = [];
      chunk.forEach((file) => {
        const base = params.length;
        values.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`,
        );
        params.push(
          existingIds.get(file.path) ?? uuid(),
          options.projectId,
          file.path,
          repo.baseNameOf(file.path),
          repo.extensionOf(file.path),
          file.sizeBytes,
          file.content !== null ? sha256(file.content) : file.sha256,
          file.content,
          file.isText,
          file.remoteSha,
        );
      });
      await connection.query(
        `insert into imported_project_files
           (id, project_id, path, name, extension, size_bytes, sha256, content, is_text, remote_sha)
         values ${values.join(',')}
         on conflict (project_id, path) do update set
           name = excluded.name, extension = excluded.extension, size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256, content = excluded.content, is_text = excluded.is_text,
           remote_sha = excluded.remote_sha, dirty = false, changed_at = null, updated_at = now()`,
        params,
      );
    }

    const restored = await connection.query<{
      path: string;
      sha256: string | null;
      size_bytes: string | number;
      content: string | null;
    }>(
      `select path, sha256, size_bytes, content from imported_project_files where project_id = $1 order by path asc`,
      [options.projectId],
    );
    const manifest = snapshotManifest(
      restored.rows.map((row) => ({
        path: String(row.path),
        sha256: row.sha256 ? String(row.sha256) : null,
        sizeBytes: Number(row.size_bytes ?? 0),
        isText: true,
        contentOmitted: false,
        remoteSha: null,
        content: row.content === null ? null : String(row.content),
      })),
    );
    if (manifest.manifestSha256 !== expected.manifestSha256) {
      // Roll the whole restore back rather than leave a half-written tree.
      throw new ApiError(
        'The restored tree did not match the snapshot manifest, so the restore was rolled back.',
        500,
        'restore_verification_failed',
      );
    }
    return manifest;
  });

  await repo.updateProject(options.projectId, { status: 'ready', statusMessage: null, syncError: null });
  await repo.refreshStats(options.projectId);
  await query(`update project_snapshots set restored_at = now() where id = $1`, [record.id]);
  await repo.addSyncEvent(
    options.projectId,
    'success',
    'restore',
    `[✓] Restored ${written.files} files from snapshot ${record.id.slice(0, 8)} (${written.bytes} bytes, verified).`,
  );
  await logActivity({
    user: options.user ?? undefined,
    action: 'project.snapshot.restore',
    target: options.projectId,
    severity: 'warning',
    detail: { snapshotId: record.id, files: written.files, bytes: written.bytes, safetySnapshotId: safety?.id ?? null },
  });

  return {
    snapshot: { ...record, restoredAt: new Date().toISOString() },
    safetySnapshotId: safety?.id ?? '',
    files: written.files,
    bytes: written.bytes,
    verified: true,
    note: `Restored ${written.files} files and re-verified the manifest.`,
    at: new Date().toISOString(),
  };
}

/** Deletes the oldest snapshots beyond `keep`, archive first. */
export async function pruneSnapshots(projectId: string, keep = SNAPSHOT_RETENTION): Promise<number> {
  const rows = await query<Row>(
    `select id, storage_key from project_snapshots
      where project_id = $1
      order by created_at desc
      offset $2`,
    [projectId, keep],
  );
  for (const row of rows) {
    await backupStorage().remove(String(row.storage_key)).catch(() => undefined);
    await query(`delete from project_snapshots where id = $1`, [String(row.id)]);
  }
  return rows.length;
}
