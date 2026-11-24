import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { assertServerAccess, serversVisibleTo } from '@/lib/servers/repo';
import { scanServer, type ScanSummary } from '@/lib/errors/collect';
import { consoleBuffer } from '@/lib/services/console';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ serverId: z.string().min(1).optional() });

/**
 * Run the diagnostic scan now.
 *
 * Console lines come from the live buffer; deployments and bot status come from
 * the database; the panel check is one real API round-trip. A server that is not
 * connected is skipped rather than reported as healthy.
 */
export const POST = route({ permission: 'console.read' }, async ({ body, user }) => {
  const input = await body(schema);
  rateLimit(`error-scan:${user.id}`, 6, 60_000);

  const targets = input.serverId
    ? [await assertServerAccess(user, input.serverId, 'console.read')]
    : (await serversVisibleTo(user)).filter((server) => server.isActive);

  const summaries: ScanSummary[] = [];
  for (const server of targets) {
    const lines = consoleBuffer(server.id).lines;
    summaries.push(await scanServer(server, lines));
  }

  await logActivity({
    user,
    serverId: input.serverId ?? null,
    action: 'error.scan',
    target: input.serverId ?? 'all-servers',
    detail: {
      servers: summaries.length,
      consoleEvents: summaries.reduce((sum, item) => sum + item.consoleEvents, 0),
    },
  });

  return ok({
    scannedAt: new Date().toISOString(),
    servers: summaries.length,
    summaries,
    note:
      summaries.length === 0
        ? 'No active server is registered, so only API, auth and browser failures can be diagnosed.'
        : 'Scanned console buffer, deployments, bot status and panel reachability. Sources with no data are reported as skipped, never as healthy.',
  });
});
