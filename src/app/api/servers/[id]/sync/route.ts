import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess, setConnectionState } from '@/lib/servers/repo';
import { scanServer } from '@/lib/services/discovery';
import { listConflicts, syncStatus } from '@/lib/sync';
import { query, queryOne } from '@/lib/db';
import { logActivity } from '@/lib/audit';
import { publicId, toUiStatus } from '@/lib/deploy-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface Params extends Record<string, string> {
  id: string;
}

/** Synchronization state, pending work and open conflicts. */
export const GET = route<Params>({ permission: 'file.read' }, async ({ user, params }) => {
  const server = await assertServerAccess(user, params.id, 'file.read');
  const [status, conflicts] = await Promise.all([syncStatus(server), listConflicts(server.id)]);

  const [drafts, versionCount, lastDeployment, lastScan] = await Promise.all([
    query<{ path: string; updated_at: string; base_sha256: string | null }>(
      `select path, updated_at, base_sha256 from editor_drafts
        where server_id = $1 and status in ('draft','conflict') order by updated_at desc limit 60`,
      [server.id],
    ),
    queryOne<{ count: string | number }>(
      'select count(*)::int as count from file_versions where server_id = $1',
      [server.id],
    ),
    queryOne<{ id: string; status: string; started_at: string }>(
      'select id, status, started_at from deployments where server_id = $1 order by started_at desc limit 1',
      [server.id],
    ),
    queryOne<{
      id: string;
      status: string;
      mode: string;
      started_at: string;
      finished_at: string | null;
      files_added: string | number;
      files_changed: string | number;
      files_deleted: string | number;
      files_scanned: string | number;
      files_failed: string | number;
      message: string | null;
    }>(
      `select id, status, mode, started_at, finished_at, files_added, files_changed, files_deleted,
              files_scanned, files_failed, message
         from sync_history where server_id = $1 order by started_at desc limit 1`,
      [server.id],
    ),
  ]);

  return ok({
    state: status.state,
    label: status.label,
    tone: status.tone,
    detail: status.detail,
    method: status.mode === 'events' ? 'scheduled reconciliation' : 'scheduled polling',
    methodNote: status.modeLabel,
    lastScan: lastScan
      ? {
          id: lastScan.id,
          status: lastScan.status,
          trigger: lastScan.mode,
          method: lastScan.mode,
          startedAt: lastScan.started_at,
          finishedAt: lastScan.finished_at,
          added: Number(lastScan.files_added ?? 0),
          changed: Number(lastScan.files_changed ?? 0),
          deleted: Number(lastScan.files_deleted ?? 0),
          scanned: Number(lastScan.files_scanned ?? 0),
          failed: Number(lastScan.files_failed ?? 0),
          conflicts: conflicts.length,
          message: lastScan.message,
        }
      : null,
    pending: {
      drafts: status.drafts,
      conflicts: status.conflicts,
      events: status.pendingChanges,
      versions: Number(versionCount?.count ?? 0),
      deployment: status.pendingDeployments,
    },
    drafts: drafts.map((draft) => ({ path: draft.path, updatedAt: draft.updated_at, baseSha: draft.base_sha256 })),
    conflicts: conflicts.map((conflict) => ({
      id: conflict.id,
      path: conflict.path,
      fileName: conflict.fileName,
      createdAt: conflict.detectedAt,
      baseSha: conflict.baseSha256,
      remoteSha: conflict.remoteSha256,
    })),
    lastDeployment: lastDeployment
      ? {
          id: lastDeployment.id,
          publicId: publicId(lastDeployment.id),
          status: toUiStatus(lastDeployment.status),
          startedAt: lastDeployment.started_at,
        }
      : null,
    lock: status.deploymentLock,
    indexedFiles: status.indexedFiles,
    changedFiles: status.changedFiles,
    lastScanAt: status.lastScanAt,
    lastSyncAt: status.lastSyncAt,
    syncIntervalSeconds: status.syncIntervalSeconds,
  });
});

/** SYNC NOW — reconciles the index against the live filesystem. */
export const POST = route<Params>({ permission: 'file.write' }, async ({ user, params }) => {
  const server = await assertServerAccess(user, params.id, 'file.write');
  await logActivity({ user, serverId: server.id, action: 'sync.started', target: server.name });

  let result;
  try {
    result = await scanServer({ server, user, mode: 'manual' });
  } catch (error) {
    await setConnectionState(server.id, 'unreachable', error instanceof Error ? error.message : String(error));
    throw new ApiError(`Synchronization failed: ${error instanceof Error ? error.message : String(error)}`, 502, 'sync_failed');
  }

  await setConnectionState(server.id, 'connected', null, { syncedNow: true, scannedNow: true, connectedNow: true });
  await logActivity({
    user,
    serverId: server.id,
    action: 'sync.finished',
    target: server.name,
    detail: { added: result.added, changed: result.changed, deleted: result.deleted, failed: result.failed },
  });

  return ok({
    summary: {
      scanned: result.scannedFiles,
      indexed: result.indexed,
      added: result.files.filter((file) => file.added).map((file) => file.path),
      changed: result.files.filter((file) => file.changed).map((file) => file.path),
      deleted: [] as string[],
      deletedCount: result.deleted,
      failed: result.accessErrors.map((error) => ({ path: error.path, message: error.error })),
      conflicts: 0,
      message: result.message,
    },
  });
});
