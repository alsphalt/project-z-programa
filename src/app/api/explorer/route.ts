import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { explorerOverview } from '@/lib/services/explorer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Project Explorer overview: real indexed project, resolved live where needed. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'file.read');
  const overview = await explorerOverview(server);
  return ok(overview);
});
