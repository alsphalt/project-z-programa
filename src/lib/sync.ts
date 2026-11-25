import 'server-only';
import { ApiError } from './api';
import { query, queryOne } from './db';
import { randomToken, sha256 } from './crypto';
import type { ServerRecord } from './servers/repo';
import { serverClient } from './servers/repo';
import { fetchRemoteFile, writeProductionFile } from './files/service';
import { scanServer, type ScanResult } from './services/discovery';
import { currentLock } from './services/deploy';
import { baseName } from './security/paths';

export type SyncState =
  | 'connected'
  | 'scanning'
  | 'synchronizing'
  | 'synchronized'
  | 'remote_changes'
  | 'local_draft'
  | 'deployment_pending'
  | 'conflict'
  | 'connection_lost'
  | 'failed';

export interface SyncStatus {
  state: SyncState;
  label: string;
  tone: 'ok' | 'busy' | 'warn' | 'danger' | 'idle';
  detail: string;
  /** How changes are actually detected. Never claims real-time when polling. */
  mode: 'polling' | 'events';
  modeLabel: string;
  lastScanAt: string | null;
  lastSyncAt: string | null;
  lastFullScanAt: string | null;
  indexedFiles: number;
  indexedFolders: number;
  changedFiles: number;
  addedFiles: number;
  deletedFiles: number;
  pendingChanges: number;
  drafts: number;
  conflicts: number;
  pendingDeployments: number;
  failedAccess: number;
  deploymentLock: { owner: string; expiresAt: string } | null;
  lastError: string | null;
  syncIntervalSeconds: number;
}

interface SyncRunRow {
  id: string;
  mode: string;
  status: string;
  files_scanned: string | number;
  files_indexed: string | number;
  files_added: string | number;
  files_changed: string | number;
  files_deleted: string | number;
  files_failed: string | number;
  message: string | null;
  started_at: string;
  finished_at: string | null;
}

async function scalar(sql: string, params: Array<string | number | boolean | null>): Promise<number> {
  const row = await queryOne<{ value: string | number }>(sql, params);
  return Number(row?.value ?? 0);
}

export async function syncStatus(server: ServerRecord): Promise<SyncStatus> {
  const [
    running,
    lastRun,
    lastScan,
    indexedFiles,
    indexedFolders,
    changedFiles,
    addedFiles,
    deletedFiles,
    drafts,
    conflicts,
    pendingDeployments,
    failedAccess,
    lock,
  ] = await Promise.all([
    queryOne<SyncRunRow>(
      `select * from sync_history where server_id = $1 and status = 'running' order by started_at desc limit 1`,
      [server.id],
    ),
    queryOne<SyncRunRow>(
      `select * from sync_history where server_id = $1 and status in ('succeeded','partial','failed')
        order by started_at desc limit 1`,
      [server.id],
    ),
    queryOne<{ at: string }>(
      `select max(started_at) as at from sync_history where server_id = $1 and status in ('succeeded','partial') and mode = 'scan'`,
      [server.id],
    ),
    scalar(`select count(*) as value from file_indexes where server_id = $1 and is_directory = false and deleted_at is null`, [server.id]),
    scalar(`select count(*) as value from file_indexes where server_id = $1 and is_directory = true and deleted_at is null`, [server.id]),
    scalar(`select count(*) as value from update_events where server_id = $1 and acknowledged = false and kind = 'changed'`, [server.id]),
    scalar(`select count(*) as value from update_events where server_id = $1 and acknowledged = false and kind = 'added'`, [server.id]),
    scalar(`select count(*) as value from update_events where server_id = $1 and acknowledged = false and kind = 'deleted'`, [server.id]),
    scalar(`select count(*) as value from editor_drafts where server_id = $1 and status = 'draft'`, [server.id]),
    scalar(`select count(*) as value from sync_conflicts where server_id = $1 and resolution is null`, [server.id]),
    scalar(`select count(*) as value from deployments where server_id = $1 and status in ('pending','running')`, [server.id]),
    scalar(`select count(*) as value from file_indexes where server_id = $1 and access_error is not null and deleted_at is null`, [server.id]),
    currentLock(server.id),
  ]);

  const pendingChanges = changedFiles + addedFiles + deletedFiles;
  const mode: 'polling' | 'events' = server.syncMode === 'events' ? 'events' : 'polling';

  let state: SyncState = 'connected';
  let label = 'Connected';
  let tone: SyncStatus['tone'] = 'ok';
  let detail = 'The panel connection is configured. Run a scan to build the file index.';

  if (server.connectionState === 'error') {
    state = 'failed';
    label = 'Synchronization failed';
    tone = 'danger';
    detail = server.lastError ?? 'The last operation against the panel failed.';
  } else if (server.connectionState === 'unreachable') {
    state = 'connection_lost';
    label = 'Connection lost';
    tone = 'danger';
    detail = server.lastError ?? 'The panel could not be reached on the last attempt.';
  } else if (conflicts > 0) {
    state = 'conflict';
    label = 'Conflict detected';
    tone = 'danger';
    detail = `${conflicts} file${conflicts === 1 ? '' : 's'} changed both remotely and in a local draft. Nothing was overwritten.`;
  } else if (running) {
    state = running.mode === 'scan' ? 'scanning' : 'synchronizing';
    label = running.mode === 'scan' ? 'Scanning server' : 'Synchronizing';
    tone = 'busy';
    detail = `Started ${new Date(running.started_at).toLocaleString()} — ${running.message ?? 'in progress'}.`;
  } else if (pendingDeployments > 0 || lock) {
    state = 'deployment_pending';
    label = 'Deployment pending';
    tone = 'warn';
    detail = lock
      ? `A deployment holds the lock until ${new Date(lock.expiresAt).toLocaleString()}.`
      : 'A deployment is queued or running.';
  } else if (drafts > 0) {
    state = 'local_draft';
    label = 'Local draft';
    tone = 'warn';
    detail = `${drafts} draft${drafts === 1 ? '' : 's'} not yet deployed. Production is unchanged until you deploy.`;
  } else if (pendingChanges > 0) {
    state = 'remote_changes';
    label = 'Remote changes detected';
    tone = 'warn';
    detail = `${pendingChanges} change${pendingChanges === 1 ? '' : 's'} found in the last scan${
      mode === 'polling' ? ' (detected by scheduled polling, not instant events)' : ''
    }.`;
  } else if (!lastRun) {
    state = 'connected';
    label = 'Connected';
    tone = 'idle';
    detail = 'No scan has completed yet. Run SCAN SERVER NOW to index the real project files.';
  } else {
    state = 'synchronized';
    label = 'Fully synchronized';
    tone = 'ok';
    detail = `Index matches the last scan (${new Date(lastRun.started_at).toLocaleString()}).`;
  }

  return {
    state,
    label,
    tone,
    detail,
    mode,
    modeLabel:
      mode === 'polling'
        ? 'Scheduled polling — changes made directly in the panel are detected on the next scan, not instantly.'
        : 'Server events were requested, but the panel Client API does not expose file change events; polling is still the detection mechanism.',
    lastScanAt: lastScan?.at ?? server.lastScanAt,
    lastSyncAt: lastRun?.started_at ?? server.lastSyncAt,
    lastFullScanAt: lastScan?.at ?? null,
    indexedFiles,
    indexedFolders,
    changedFiles,
    addedFiles,
    deletedFiles,
    pendingChanges,
    drafts,
    conflicts,
    pendingDeployments,
    failedAccess,
    deploymentLock: lock,
    lastError: server.lastError,
    syncIntervalSeconds: server.syncIntervalS,
  };
}

export async function triggerSync(options: {
  server: ServerRecord;
  userId?: string | null;
  mode?: 'scan' | 'poll' | 'manual';
}): Promise<ScanResult> {
  return scanServer({ server: options.server, user: options.userId ? { id: options.userId } : null, mode: options.mode ?? 'manual' });
}

export async function acknowledgeChanges(serverId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `update update_events set acknowledged = true where server_id = $1 and acknowledged = false returning id`,
    [serverId],
  );
  return rows.length;
}

export interface ConflictRecord {
  id: string;
  path: string;
  fileName: string;
  draftId: string | null;
  baseSha256: string | null;
  remoteSha256: string | null;
  localContent: string | null;
  remoteContent: string | null;
  detectedAt: string;
  resolution: string | null;
  resolvedAt: string | null;
}

export async function listConflicts(serverId: string, includeResolved = false): Promise<ConflictRecord[]> {
  const rows = await query<{
    id: string;
    path: string;
    draft_id: string | null;
    base_sha256: string | null;
    remote_sha256: string | null;
    local_content: string | null;
    remote_content: string | null;
    detected_at: string;
    resolution: string | null;
    resolved_at: string | null;
  }>(
    `select id, path, draft_id, base_sha256, remote_sha256, local_content, remote_content, detected_at,
            resolution, resolved_at
       from sync_conflicts
      where server_id = $1 ${includeResolved ? '' : 'and resolution is null'}
      order by detected_at desc limit 100`,
    [serverId],
  );
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    fileName: baseName(row.path),
    draftId: row.draft_id,
    baseSha256: row.base_sha256,
    remoteSha256: row.remote_sha256,
    localContent: row.local_content,
    remoteContent: row.remote_content,
    detectedAt: row.detected_at,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
  }));
}

/**
 * Resolve a conflict without ever discarding a version silently.
 * keep_remote  → the draft is discarded, production is untouched.
 * keep_local   → the draft is written over production, but only after a fresh
 *                read confirms the remote hash that the admin was shown.
 * merged       → the admin-supplied merged text is written with that same check.
 */
export async function resolveConflict(options: {
  server: ServerRecord;
  conflictId: string;
  resolution: 'keep_remote' | 'keep_local' | 'merged' | 'dismissed';
  mergedContent?: string;
  userId: string | null;
  note?: string;
}): Promise<{ resolution: string; wroteProduction: boolean; hash?: string }> {
  const { server, conflictId, resolution } = options;
  const conflict = await queryOne<{
    id: string;
    path: string;
    draft_id: string | null;
    remote_sha256: string | null;
    local_content: string | null;
  }>(
    'select id, path, draft_id, remote_sha256, local_content from sync_conflicts where id = $1 and server_id = $2',
    [conflictId, server.id],
  );
  if (!conflict) throw new ApiError('Conflict not found for this server.', 404, 'conflict_not_found');

  let wroteProduction = false;
  let hash: string | undefined;

  if (resolution === 'keep_local' || resolution === 'merged') {
    const content =
      resolution === 'merged' ? options.mergedContent : conflict.local_content;
    if (content === undefined || content === null) {
      throw new ApiError('There is no local content to keep for this conflict.', 409, 'no_local_content');
    }
    // Re-read production: if it moved again, refuse rather than clobber.
    const remote = await fetchRemoteFile(server, conflict.path, { withStat: false });
    if (conflict.remote_sha256 && remote.sha256 !== conflict.remote_sha256) {
      throw new ApiError(
        'Production changed again while you were resolving this conflict. Refresh the comparison and resolve again — nothing was written.',
        409,
        'conflict_moved',
      );
    }
    const result = await writeProductionFile({
      server,
      path: conflict.path,
      content,
      expectedHash: remote.sha256,
      note: options.note ?? `Conflict resolved (${resolution})`,
      userId: options.userId,
      // The chosen side may be an intentionally empty file.
      allowEmpty: true,
    });
    wroteProduction = true;
    hash = result.hash;
  }

  await query(
    `update sync_conflicts set resolution = $2, resolved_by = $3, resolved_at = now() where id = $1`,
    [conflict.id, resolution, options.userId],
  );
  if (resolution !== 'merged' && conflict.draft_id) {
    await query(
      `update editor_drafts set status = $2, updated_at = now() where id = $1`,
      [conflict.draft_id, resolution === 'keep_local' ? 'deployed' : 'discarded'],
    );
  }
  return { resolution, wroteProduction, hash };
}

/** Verify a production file's current hash without modifying anything. */
export async function verifyProductionHash(
  server: ServerRecord,
  path: string,
): Promise<{ path: string; sha256: string; sizeBytes: number; modifiedAt: string | null }> {
  const snapshot = await fetchRemoteFile(server, path, { withStat: true });
  return { path: snapshot.path, sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, modifiedAt: snapshot.modifiedAt };
}

export async function startSyncRun(serverId: string, mode: 'scan' | 'poll' | 'manual'): Promise<string> {
  const id = randomToken(16);
  await query(
    `insert into sync_history (id, server_id, mode, status, started_at) values ($1,$2,$3,'running', now())`,
    [id, serverId, mode],
  );
  return id;
}

export async function finishSyncRun(
  id: string,
  result: { status: 'succeeded' | 'partial' | 'failed'; scanned: number; indexed: number; added: number; changed: number; deleted: number; failed: number; message: string },
): Promise<void> {
  await query(
    `update sync_history set status = $2, files_scanned = $3, files_indexed = $4, files_added = $5,
       files_changed = $6, files_deleted = $7, files_failed = $8, message = $9, finished_at = now()
     where id = $1`,
    [id, result.status, result.scanned, result.indexed, result.added, result.changed, result.deleted, result.failed, result.message],
  );
}

export function checksum(content: string): string {
  return sha256(content);
}

/**
 * Load one open conflict for a path and make sure the "remote" side really is
 * what production holds right now. If the panel cannot be read, the stored copy
 * is returned and the UI shows it as a snapshot.
 */
export async function conflictForPath(
  server: ServerRecord,
  path: string,
): Promise<ConflictRecord | null> {
  const rows = await query<{
    id: string;
    path: string;
    draft_id: string | null;
    base_sha256: string | null;
    remote_sha256: string | null;
    local_content: string | null;
    remote_content: string | null;
    detected_at: string;
    resolution: string | null;
    resolved_at: string | null;
  }>(
    `select id, path, draft_id, base_sha256, remote_sha256, local_content, remote_content, detected_at,
            resolution, resolved_at
       from sync_conflicts
      where server_id = $1 and path = $2 and resolution is null
      order by detected_at desc limit 1`,
    [server.id, path],
  );
  const row = rows[0];
  if (!row) return null;

  let remoteContent = row.remote_content;
  let remoteSha = row.remote_sha256;
  try {
    const fresh = await fetchRemoteFile(server, path, { withStat: false });
    remoteContent = fresh.content;
    remoteSha = fresh.sha256;
  } catch {
    /* keep the stored snapshot; the UI labels where it came from */
  }

  return {
    id: row.id,
    path: row.path,
    fileName: baseName(row.path),
    draftId: row.draft_id,
    baseSha256: row.base_sha256,
    remoteSha256: remoteSha,
    localContent: row.local_content,
    remoteContent,
    detectedAt: row.detected_at,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
  };
}
