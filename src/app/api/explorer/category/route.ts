import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { explorerCategory } from '@/lib/services/explorer';
import { EXPLORER_CATEGORIES, type ExplorerCategoryId } from '@/lib/explorer/classify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** One discovered category (plugins, cases, functions, config, database, …). */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const id = (url.searchParams.get('id') ?? '') as ExplorerCategoryId;
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!EXPLORER_CATEGORIES.some((category) => category.id === id)) {
    throw new ApiError(`Unknown category "${id}"`, 400, 'unknown_category');
  }
  const server = await assertServerAccess(user, serverId, 'file.read');
  const view = await explorerCategory(server, id, {
    q: url.searchParams.get('q') ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? 200),
    offset: Number(url.searchParams.get('offset') ?? 0),
  });
  return ok(view);
});
