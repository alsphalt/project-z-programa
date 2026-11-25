import { z } from 'zod';
import { ApiError, ok, rateLimit, route } from '@/lib/api';
import { getError } from '@/lib/errors/store';
import { assertServerAccess } from '@/lib/servers/repo';
import { applyRepair, buildProposal, discardRepair } from '@/lib/errors/repair';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

const schema = z.object({
  action: z.enum(['propose', 'apply', 'discard']),
  confirm: z.string().max(40).optional(),
  path: z.string().max(1000).optional(),
  content: z.string().max(2_000_000).optional(),
});

/**
 * Repair workflow.
 *
 * propose → (backup + validation happen here) → apply requires an explicit
 * confirmation token, the operation permission and, for production changes,
 * owner/admin. Nothing is written on `propose`.
 */
export const POST = route<Params>({ permission: 'console.read' }, async ({ params, body, user }) => {
  const input = await body(schema);
  rateLimit(`repair:${user.id}`, 20, 60_000);

  const error = await getError(params.id);
  if (!error) throw new ApiError('Error record not found.', 404, 'error_not_found');
  if (error.serverId && !['owner', 'admin'].includes(user.role)) {
    await assertServerAccess(user, error.serverId, 'console.read');
  }

  if (input.action === 'propose') {
    const repair = await buildProposal(error, user, { path: input.path, content: input.content });
    return ok({ repair, error: { ...error, repair } });
  }
  if (input.action === 'discard') {
    const repair = await discardRepair(error, user);
    return ok({ repair });
  }

  const outcome = await applyRepair(error, user, input);
  return ok(outcome);
});
