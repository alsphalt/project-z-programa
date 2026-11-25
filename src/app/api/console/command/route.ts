import { z } from 'zod';
import { route, ok, ApiError, rateLimit } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { sendConsoleCommand } from '@/lib/services/console';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  serverId: z.string().min(1),
  command: z.string().min(1).max(2000),
  confirm: z.literal('EXECUTE'),
});

/**
 * Send a command to the panel console. The panel's acknowledgement is the only
 * proof of delivery — the UI is told the command was *accepted*, not that it
 * succeeded.
 */
export const POST = route({ permission: 'console.command' }, async ({ user, body }) => {
  const input = await body(schema);
  const server = await assertServerAccess(user, input.serverId, 'console.command');
  rateLimit(`console:${user.id}`, 30, 60_000);

  if (/^\s*(rm\s+-rf\s+\/|mkfs|shutdown|reboot|:\(\)\{)/i.test(input.command)) {
    throw new ApiError('That command is blocked by policy.', 403, 'command_blocked');
  }

  await sendConsoleCommand(server, input.command);
  await logActivity({
    user,
    serverId: server.id,
    action: 'console.command',
    target: input.command.slice(0, 200),
    severity: 'warning',
  });
  return ok({ accepted: true, note: 'The panel accepted the command. Watch the console for its output.' });
});
