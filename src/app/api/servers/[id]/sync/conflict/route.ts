import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { conflictForPath, resolveConflict } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params extends Record<string, string> {
  id: string;
}

/** Both sides of one conflict, so the admin can compare before choosing. */
export const GET = route<Params>({ permission: 'file.read' }, async ({ req, user, params }) => {
  const server = await assertServerAccess(user, params.id, 'file.read');
  const path = new URL(req.url).searchParams.get('path');
  if (!path) throw new ApiError('path is required', 400, 'path_required');

  const conflict = await conflictForPath(server, path);
  if (!conflict) {
    return ok({
      conflict: { path, remoteSha: null, baseSha: null, note: 'No open conflict for this path.' },
      remote: null,
      local: null,
      open: false,
    });
  }

  return ok({
    conflict: {
      id: conflict.id,
      path: conflict.path,
      remoteSha: conflict.remoteSha256,
      baseSha: conflict.baseSha256,
      note: `Detected ${new Date(conflict.detectedAt).toLocaleString()}`,
    },
    remote: conflict.remoteContent,
    local: conflict.localContent,
    open: true,
  });
});

const schema = z.object({
  conflictId: z.string().min(1),
  resolution: z.enum(['keep_remote', 'keep_local', 'merged', 'dismissed']),
  mergedContent: z.string().optional(),
});

export const POST = route<Params>({ permission: 'deploy' }, async ({ user, params, body }) => {
  const server = await assertServerAccess(user, params.id, 'deploy');
  const input = await body(schema);
  const result = await resolveConflict({
    server,
    conflictId: input.conflictId,
    resolution: input.resolution,
    mergedContent: input.mergedContent,
    userId: user.id,
  });
  return ok(result);
});
