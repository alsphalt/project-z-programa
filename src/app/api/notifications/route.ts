import { ok, route, searchParams } from '@/lib/api';
import { queryOne } from '@/lib/db';
import { errorStats } from '@/lib/errors/store';
import { serversVisibleTo } from '@/lib/servers/repo';
import { activitySummary } from '@/lib/services/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One cheap read behind the header bell.
 *
 * The counter is the number of *open* problems in Error Intelligence, scoped to
 * the caller's server grants — the same number the Error Center shows, not a
 * separate tally that could disagree with it. Two aggregate queries, no rows,
 * so polling this is cheap on a phone; the client still polls only on focus and
 * after a deliberate refresh, never on a timer.
 */
export const GET = route({ permission: 'console.read' }, async ({ req, user }) => {
  const requestedServer = searchParams(req).get('serverId');
  const visible =
    !requestedServer && !['owner', 'admin'].includes(user.role)
      ? (await serversVisibleTo(user)).map((server) => server.id)
      : undefined;

  const [errors, activity] = await Promise.all([
    errorStats(requestedServer, visible),
    activitySummary(requestedServer, visible),
  ]);

  const deploymentsFailed =
    requestedServer
      ? await queryOne<{ count: string | number }>(
          `select count(*)::int as count from deployments
            where server_id = $1 and status = 'failed' and started_at > now() - interval '24 hours'`,
          [requestedServer],
        )
      : visible
        ? await queryOne<{ count: string | number }>(
            `select count(*)::int as count from deployments
              where ${visible.length ? 'server_id = any($1::text[])' : 'false'}
                and status = 'failed' and started_at > now() - interval '24 hours'`,
            visible.length ? [visible] : [],
          )
        : await queryOne<{ count: string | number }>(
            `select count(*)::int as count from deployments
              where status = 'failed' and started_at > now() - interval '24 hours'`,
          );

  return ok({
    errors: {
      open: errors.active,
      critical: errors.criticalOpen,
      moderate: errors.moderateOpen,
      minor: errors.minorOpen,
      last24h: errors.last24h,
    },
    activity,
    deployments: { failed24h: Number(deploymentsFailed?.count ?? 0) },
    /** Badge value: everything the user should look at right now. */
    total: errors.active + Number(deploymentsFailed?.count ?? 0),
  });
});
