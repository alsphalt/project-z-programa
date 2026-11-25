import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess, setConnectionState } from '@/lib/servers/repo';
import { scanServer, type ScanResult } from '@/lib/services/discovery';
import { detectEntryPoint } from '@/lib/services/explorer';
import { query, queryOne } from '@/lib/db';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface Params extends Record<string, string> {
  id: string;
}



function scanSummary(result: ScanResult) {
  const added = result.files.filter((file) => file.added).map((file) => file.path);
  const changed = result.files.filter((file) => file.changed).map((file) => file.path);
  // Deleted paths are not reported per-file by the scanner; only the count is known.
  const deleted: string[] = [];
  return {
    scannedFiles: result.scannedFiles,
    scannedFolders: result.scannedDirectories,
    indexed: result.indexed,
    deletedCount: result.deleted,
    added,
    changed,
    deleted,
    failed: result.accessErrors.map((error) => ({ path: error.path, message: error.error })),
    skipped: [],
    conflicts: 0,
    commands: result.casesFound,
    functions: result.functionsFound,
    truncated: result.truncated,
    rootPath: '/',
    finishedAt: new Date().toISOString(),
    message: result.message,
    durationMs: result.durationMs,
  };
}

export const GET = route<Params>({ permission: 'file.read' }, async ({ user, params }) => {
  const server = await assertServerAccess(user, params.id, 'file.read');

  // The entry point comes from the panel startup command, never from a fixed list
  // of "usual suspects" — a project may start from any file.
  const entry = await detectEntryPoint(server);
  const importantPaths = [entry.path, entry.packagePath].filter((value): value is string => Boolean(value));

  const [lastScan, counts, important] = await Promise.all([
    queryOne<{
      id: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      files_scanned: string | number;
      files_added: string | number;
      files_changed: string | number;
      files_deleted: string | number;
      files_failed: string | number;
      message: string | null;
    }>(
      `select id, status, started_at, finished_at, files_scanned, files_added, files_changed, files_deleted,
              files_failed, message
         from sync_history where server_id = $1 order by started_at desc limit 1`,
      [server.id],
    ),
    queryOne<{ files: string | number; folders: string | number }>(
      `select
         (select count(*)::int from file_indexes where server_id = $1 and is_directory = false and deleted_at is null) as files,
         (select count(*)::int from file_indexes where server_id = $1 and is_directory = true and deleted_at is null) as folders`,
      [server.id],
    ),
    query<{ path: string; name: string; size_bytes: string | number; sha256: string | null; remote_modified_at: string | null }>(
      `select path, name, size_bytes, sha256, remote_modified_at from file_indexes
        where server_id = $1 and deleted_at is null and path = any($2::text[])
        order by path asc`,
      [server.id, importantPaths],
    ),
  ]);

  const conflictRow = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from sync_conflicts where server_id = $1 and resolution is null`,
    [server.id],
  );

  return ok({
    method: server.syncMode === 'events' ? 'scheduled reconciliation (events unavailable)' : 'scheduled reconciliation',
    methodNote:
      'The Pterodactyl Client API exposes no file-change webhook, so discovery is a real recursive walk performed on demand and on a schedule. Changes made in the panel are detected by the next scan, not instantly.',
    lastScan: lastScan
      ? {
          id: lastScan.id,
          status: lastScan.status,
          startedAt: lastScan.started_at,
          finishedAt: lastScan.finished_at,
          scanned: Number(lastScan.files_scanned ?? 0),
          added: Number(lastScan.files_added ?? 0),
          changed: Number(lastScan.files_changed ?? 0),
          deleted: Number(lastScan.files_deleted ?? 0),
          failed: Number(lastScan.files_failed ?? 0),
          conflicts: Number(conflictRow?.count ?? 0),
          message: lastScan.message,
        }
      : null,
    counts: { files: Number(counts?.files ?? 0), folders: Number(counts?.folders ?? 0) },
    importantFiles: important.map((file) => ({
      path: file.path,
      name: file.name,
      size: Number(file.size_bytes ?? 0),
      sha256: file.sha256,
      mtime: file.remote_modified_at,
    })),
    rootPath: server.projectRoot,
    intervalSeconds: server.syncIntervalS,
  });
});

/** SCAN SERVER NOW — walks the real filesystem and rebuilds the index. */
export const POST = route<Params>({ permission: 'file.write' }, async ({ user, params }) => {
  const server = await assertServerAccess(user, params.id, 'file.write');
  await logActivity({ user, serverId: server.id, action: 'server.scan_started', target: server.projectRoot });

  let result: ScanResult;
  try {
    result = await scanServer({ server, user, mode: 'manual' });
  } catch (error) {
    await setConnectionState(server.id, 'unreachable', error instanceof Error ? error.message : String(error));
    throw new ApiError(
      `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
      'scan_failed',
    );
  }

  await setConnectionState(server.id, 'connected', null, { scannedNow: true, syncedNow: true, connectedNow: true });
  await logActivity({
    user,
    serverId: server.id,
    action: 'server.scan_finished',
    target: server.projectRoot,
    detail: {
      scanned: result.scannedFiles,
      added: result.added,
      changed: result.changed,
      deleted: result.deleted,
      failed: result.failed,
      cases: result.casesFound,
    },
  });

  return ok({ summary: scanSummary(result) });
});
