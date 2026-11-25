import { z } from 'zod';
import { ApiError, ok, route } from '@/lib/api';
import { cancelScheduledSync, getSyncState, resolveConflict, runDueSyncJobs, syncProjectNow } from '@/lib/github/sync';
import { requireProject } from '@/lib/projects/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const GET = route({ permission: 'file.read' }, async ({ req }) => {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  if (!projectId) throw new ApiError('projectId is required.', 400, 'project_required');
  if (url.searchParams.get('tick') === '1') {
    // Opportunistic worker tick so the queue also drains where no background
    // timer runs (serverless deployments).
    await runDueSyncJobs(2).catch(() => undefined);
  }
  return ok({ sync: await getSyncState(projectId) });
});

const postSchema = z.object({
  projectId: z.string().min(1),
  action: z.enum(['sync', 'retry', 'cancel', 'resolve']),
  mode: z.enum(['merge-remote', 'discard-local']).optional(),
});

export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(postSchema);
  await requireProject(input.projectId);

  if (input.action === 'cancel') {
    await cancelScheduledSync(input.projectId);
    return ok({ sync: await getSyncState(input.projectId), message: 'Scheduled synchronization cancelled.' });
  }

  if (input.action === 'resolve') {
    if (!input.mode) throw new ApiError('Choose how to resolve the conflict.', 400, 'mode_required');
    const result = await resolveConflict(input.projectId, input.mode);
    return ok({ sync: result.sync, message: result.message, resolvedBy: user.id });
  }

  const sync = await syncProjectNow(input.projectId, input.action === 'retry' ? 'retry' : 'manual');
  return ok({ sync });
});
