import { ok, route, searchParams } from '@/lib/api';
import { assertServerAccess, serversVisibleTo } from '@/lib/servers/repo';
import { errorStats, listErrors } from '@/lib/errors/store';
import { ERROR_SOURCES, SEVERITIES, type ErrorSource, type Severity } from '@/lib/errors/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Error Center feed. Filters are applied in SQL; stats describe the whole set,
 * not just the page the browser asked for.
 */
export const GET = route({ permission: 'console.read' }, async ({ req, user }) => {
  const params = searchParams(req);
  const statusParam = params.get('status') ?? 'active';
  const severityParam = params.get('severity') ?? 'all';
  const sourceParam = params.get('source') ?? 'all';

  const requestedServer = params.get('serverId');
  if (requestedServer) {
    // A server filter must be an authorised server, not just any id.
    await assertServerAccess(user, requestedServer, 'console.read');
  }
  // Without an explicit server, an owner/admin sees every server; anyone else
  // sees only the servers they hold a grant for, plus server-less events.
  const visible =
    !requestedServer && !['owner', 'admin'].includes(user.role)
      ? (await serversVisibleTo(user)).map((server) => server.id)
      : undefined;

  const { errors, total } = await listErrors({
    serverId: requestedServer,
    serverIds: visible,
    status: ['active', 'resolved', 'ignored', 'all'].includes(statusParam) ? (statusParam as never) : 'active',
    severity: SEVERITIES.includes(severityParam as Severity) ? (severityParam as Severity) : 'all',
    source: ERROR_SOURCES.includes(sourceParam as ErrorSource) ? (sourceParam as ErrorSource) : 'all',
    q: params.get('q') ?? undefined,
    limit: Number(params.get('limit') ?? 100),
    offset: Number(params.get('offset') ?? 0),
  });

  return ok({
    errors,
    total,
    stats: await errorStats(requestedServer, visible),
    filters: { status: statusParam, severity: severityParam, source: sourceParam },
  });
});
