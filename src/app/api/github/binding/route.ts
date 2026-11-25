import { z } from 'zod';
import { ApiError, ok, route } from '@/lib/api';
import { bindServerToRepository, listBindings, setBindingAutoSync, unbindServer } from '@/lib/github/bindings';
import { serverSyncView } from '@/lib/github/files';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Server ↔ repository binding.
 *
 * Reading is open to anyone who can read files (the File Manager and the Code
 * Editor both need the status); changing the repository is a settings.manage
 * action, because it decides where writes are pushed.
 */
export const GET = route({ permission: 'file.read' }, async ({ req }) => {
  const serverId = new URL(req.url).searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required.', 400, 'server_required');
  return ok({ sync: await serverSyncView(serverId), bindings: await listBindings() });
});

const putSchema = z.object({
  serverId: z.string().min(1),
  owner: z.string().trim().min(1).max(120),
  repo: z.string().trim().min(1).max(120),
  branch: z.string().trim().max(200).optional(),
  pathPrefix: z.string().trim().max(300).optional(),
  autoSync: z.boolean().optional(),
});

export const PUT = route({ permission: 'settings.manage' }, async ({ user, body }) => {
  const input = await body(putSchema);
  const result = await bindServerToRepository({ ...input, userId: user.id });

  await logActivity({
    user,
    serverId: input.serverId,
    action: 'github.binding_created',
    target: `${input.owner}/${input.repo}`,
    detail: { branch: result.project.githubBranch, pathPrefix: result.binding.pathPrefix },
  });

  return ok({ sync: await serverSyncView(input.serverId), binding: result.binding });
});

const patchSchema = z.object({ serverId: z.string().min(1), autoSync: z.boolean() });

export const PATCH = route({ permission: 'settings.manage' }, async ({ user, body }) => {
  const input = await body(patchSchema);
  const binding = await setBindingAutoSync(input.serverId, input.autoSync);
  await logActivity({
    user,
    serverId: input.serverId,
    action: 'github.binding_updated',
    detail: { autoSync: input.autoSync },
  });
  return ok({ binding, sync: await serverSyncView(input.serverId) });
});

export const DELETE = route({ permission: 'settings.manage' }, async ({ user, req }) => {
  const serverId = new URL(req.url).searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required.', 400, 'server_required');
  await unbindServer(serverId);
  await logActivity({ user, serverId, action: 'github.binding_removed', severity: 'warning' });
  return ok({ sync: await serverSyncView(serverId), removed: true });
});
