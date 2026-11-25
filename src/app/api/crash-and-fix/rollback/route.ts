import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { rollbackEdit } from '@/lib/crashfix/save';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const schema = z.object({ historyId: z.string().min(1) });

/** Restores the previous version of one case, through the same guarded save. */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  rateLimit(`crashfix-rollback:${user.id}`, 40, 60_000);
  const input = await body(schema);
  const result = await rollbackEdit({ historyId: input.historyId, userId: user.id });
  return ok({ ...result, message: 'PREVIOUS VERSION RESTORED' });
});
