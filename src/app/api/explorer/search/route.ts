import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { explorerSearch } from '@/lib/services/explorer';
import { rateLimit } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Project-wide search: symbols, file names and code locations in one response. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!query) throw new ApiError('Enter something to search for.', 400, 'query_required');
  rateLimit(`explorer-search:${user.id}`, 60, 60_000);
  const server = await assertServerAccess(user, serverId, 'file.read');
  const result = await explorerSearch(server, query, {
    limit: Number(url.searchParams.get('limit') ?? 300),
  });
  return ok(result);
});
