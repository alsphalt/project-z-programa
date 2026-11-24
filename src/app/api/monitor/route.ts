import { z } from 'zod';
import { route, ok, ApiError, rateLimit } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { buildMonitor } from '@/lib/views';
import { power, attachConsole } from '@/lib/services/console';
import { logActivity } from '@/lib/audit';
import { PterodactylError } from '@/lib/pterodactyl/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live status for one server. Container state, WhatsApp state and console output
 * are collected from the panel on every call — nothing is cached or simulated.
 */
export const GET = route({ permission: 'console.read' }, async ({ req, user }) => {
  const params = new URL(req.url).searchParams;
  const serverId = params.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  // Only the terminal needs a long tail; every other page polls for the badges.
  const requestedLines = Number(params.get('lines') ?? '');
  const lineLimit = Number.isFinite(requestedLines) && requestedLines > 0 ? Math.floor(requestedLines) : 120;
  const server = await assertServerAccess(user, serverId, 'console.read');
  // Attaching is cheap and idempotent; it is what keeps the console tail alive.
  attachConsole(server);
  const payload = await buildMonitor(server, { lineLimit });
  return ok(payload);
});

const powerSchema = z.object({
  serverId: z.string().min(1),
  action: z.enum(['start', 'stop', 'restart', 'kill']),
  confirm: z.string().optional(),
});

/**
 * Power actions from Overview and Live Monitor.
 *
 * This route previously did not exist, so the browser's POST /api/monitor was
 * answered by Next.js with HTTP 405 and no request ever reached Pterodactyl.
 * It forwards to the Client API as POST /api/client/servers/{identifier}/power
 * with {"signal":"..."} (see PterodactylClient.sendPower).
 */
export const POST = route({ permission: 'server.power' }, async ({ user, body, req }) => {
  const input = await body(powerSchema);
  if (!['CONFIRM', 'yes', input.action.toUpperCase()].includes((input.confirm ?? '').toUpperCase())) {
    throw new ApiError(
      `Confirm the ${input.action} action before it is sent to the panel.`,
      400,
      'confirmation_required',
    );
  }

  const server = await assertServerAccess(user, input.serverId, 'server.power');
  rateLimit(`power:${server.id}`, 10, 60_000);

  try {
    await power(server, input.action);
  } catch (error) {
    await logActivity({
      user,
      serverId: server.id,
      action: `power.${input.action}_failed`,
      target: server.name,
      severity: 'critical',
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
    if (error instanceof PterodactylError) throw error;
    throw new ApiError(
      `The panel rejected the ${input.action} signal: ${error instanceof Error ? error.message : String(error)}`,
      502,
      'power_failed',
    );
  }

  await logActivity({
    user,
    serverId: server.id,
    action: `power.${input.action}`,
    target: server.name,
    detail: { identifier: server.serverIdentifier, endpoint: `/api/client/servers/${server.serverIdentifier}/power` },
  });

  // Give the panel a moment, then report the state it actually reached instead of
  // claiming success on the browser's behalf.
  let observedState: string | null = null;
  try {
    const { serverClient } = await import('@/lib/servers/repo');
    const client = await serverClient(server);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const resources = await client.getResources();
      observedState = String(resources.current_state ?? '').toLowerCase() || null;
      const expected =
        input.action === 'stop' || input.action === 'kill'
          ? ['offline', 'stopping']
          : input.action === 'start'
            ? ['running', 'starting']
            : ['starting', 'running'];
      if (observedState && expected.includes(observedState)) break;
    }
  } catch {
    observedState = null;
  }

  return ok({
    serverId: server.id,
    identifier: server.serverIdentifier,
    action: input.action,
    signal: input.action,
    endpoint: `/api/client/servers/${server.serverIdentifier}/power`,
    method: 'POST',
    acceptedAt: new Date().toISOString(),
    observedState,
  });
});
