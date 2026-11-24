import { ok, route, searchParams } from '@/lib/api';
import { assertServerAccess, serversVisibleTo } from '@/lib/servers/repo';
import {
  ACTIVITY_SEVERITIES,
  activitySummary,
  listActivity,
  type ActivitySeverity,
} from '@/lib/services/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Activity Logs feed.
 *
 * Everything is filtered in SQL and scoped to the caller: an owner/admin sees
 * every server, everyone else sees the servers they hold a grant for plus
 * account-level events (a null `server_id`). Filtering happens server-side so a
 * mobile client never downloads history it is not allowed to read.
 */
export const GET = route({ permission: 'console.read' }, async ({ req, user }) => {
  const params = searchParams(req);
  const requestedServer = params.get('serverId');
  if (requestedServer) {
    await assertServerAccess(user, requestedServer, 'console.read');
  }

  const visible =
    !requestedServer && !['owner', 'admin'].includes(user.role)
      ? (await serversVisibleTo(user)).map((server) => server.id)
      : undefined;

  const severityParam = params.get('severity') ?? 'all';
  const limit = Number(params.get('limit') ?? 50);
  const offset = Number(params.get('offset') ?? 0);

  const filters = {
    serverId: requestedServer,
    serverIds: visible,
    severity: (ACTIVITY_SEVERITIES as readonly string[]).includes(severityParam)
      ? (severityParam as ActivitySeverity)
      : ('all' as const),
    action: params.get('action') || null,
    q: params.get('q') || null,
    since: params.get('since') || null,
    until: params.get('until') || null,
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  };

  const page = await listActivity(filters);
  return ok({
    ...page,
    summary: await activitySummary(requestedServer, visible),
    filters: {
      serverId: requestedServer,
      severity: filters.severity,
      action: filters.action,
      q: filters.q,
      since: filters.since,
      until: filters.until,
    },
  });
});
