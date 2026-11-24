import { z } from 'zod';
import { ApiError, ok, route } from '@/lib/api';
import {
  importRepoToPanel,
  pullServerPaths,
  recordServerChanges,
  serverSyncView,
} from '@/lib/github/files';
import { requireBinding } from '@/lib/github/bindings';
import { cancelScheduledSync, resolveConflict, runDueSyncJobs, syncProjectNow } from '@/lib/github/sync';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GitHub for a live server filesystem.
 *
 * One route for the File Manager, the Code Editor and anything else that works
 * on panel files. Every action ends in the same working copy and the same queue
 * that CRASH AND FIX uses, so there is one connection, one repository, one
 * history.
 */
export const GET = route({ permission: 'file.read' }, async ({ req }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required.', 400, 'server_required');
  if (url.searchParams.get('tick') === '1') {
    // Drain the queue opportunistically: this is what makes the debounce fire on
    // serverless deployments where an in-process timer cannot run.
    await runDueSyncJobs(2).catch(() => undefined);
  }
  return ok({ sync: await serverSyncView(serverId) });
});

const schema = z.object({
  serverId: z.string().min(1),
  action: z.enum(['detect', 'push', 'pull', 'import', 'sync', 'cancel', 'resolve']),
  paths: z.array(z.string().min(1)).max(200).optional(),
  deletes: z.array(z.string().min(1)).max(200).optional(),
  message: z.string().trim().max(200).nullish(),
  mode: z.enum(['merge-remote', 'discard-local']).optional(),
  expectedHashes: z.record(z.string()).nullish(),
  owner: z.string().trim().max(120).optional(),
  repo: z.string().trim().max(120).optional(),
  branch: z.string().trim().max(200).optional(),
  repoPrefix: z.string().trim().max(300).optional(),
  destination: z.string().trim().max(600).optional(),
  limit: z.number().int().min(1).max(120).optional(),
});

export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(schema);

  if (input.action === 'import') {
    const result = await importRepoToPanel({
      serverId: input.serverId,
      owner: input.owner ?? null,
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      repoPrefix: input.repoPrefix ?? null,
      destination: input.destination ?? '/',
      limit: input.limit,
      userId: user.id,
    });
    await logActivity({
      user,
      serverId: input.serverId,
      action: 'github.import_to_panel',
      target: result.repo,
      detail: { imported: result.imported.length, skipped: result.skipped.length, failed: result.failed.length },
    });
    return ok({ result, sync: await serverSyncView(input.serverId) });
  }

  const { project } = await requireBinding(input.serverId);

  if (input.action === 'cancel') {
    await cancelScheduledSync(project.id);
    return ok({ message: 'Scheduled push cancelled. Local changes are kept.', sync: await serverSyncView(input.serverId) });
  }

  if (input.action === 'resolve') {
    if (!input.mode) throw new ApiError('Choose how to resolve the conflict.', 400, 'mode_required');
    const resolved = await resolveConflict(project.id, input.mode);
    return ok({ message: resolved.message, sync: await serverSyncView(input.serverId) });
  }

  if (input.action === 'sync') {
    const state = await syncProjectNow(project.id, 'manual', input.message ?? null);
    return ok({ message: 'Manual synchronization finished.', sync: await serverSyncView(input.serverId), project: state });
  }

  if (input.action === 'pull') {
    const result = await pullServerPaths({
      serverId: input.serverId,
      paths: input.paths ?? [],
      expectedHashes: input.expectedHashes ?? undefined,
      userId: user.id,
    });
    await logActivity({
      user,
      serverId: input.serverId,
      action: 'github.pull_files',
      detail: { restored: result.restored.length, skipped: result.skipped.length },
    });
    return ok({ result, sync: await serverSyncView(input.serverId) });
  }

  const recorded = await recordServerChanges({
    serverId: input.serverId,
    paths: input.paths ?? [],
    deletes: input.deletes ?? [],
    mode: input.action === 'push' ? 'now' : 'auto',
    message: input.message ?? null,
    userId: user.id,
  });

  if (input.action === 'push') {
    await logActivity({
      user,
      serverId: input.serverId,
      action: 'github.push_files',
      detail: {
        detected: recorded.detected,
        skipped: recorded.skipped.length,
        status: recorded.sync.syncStatus,
      },
    });
  }

  return ok({ result: recorded, sync: await serverSyncView(input.serverId) });
});
