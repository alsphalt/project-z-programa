import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { recordFrontendError } from '@/lib/errors/collect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  message: z.string().min(1).max(4000),
  stack: z.string().max(20_000).optional(),
  url: z.string().max(1000).optional(),
  code: z.string().max(120).optional(),
  serverId: z.string().max(120).optional(),
  context: z.record(z.unknown()).optional(),
});

/**
 * Browser error sink. Authenticated, rate limited and size limited so a broken
 * render loop cannot flood the database. The reporter itself is careful not to
 * report its own failures back into this route.
 */
export const POST = route({ permission: null }, async ({ body, user }) => {
  const input = await body(schema);
  rateLimit(`frontend-errors:${user.id}`, 30, 60_000);

  await recordFrontendError({
    message: input.message,
    stack: input.stack,
    url: input.url,
    code: input.code,
    serverId: input.serverId ?? null,
    userId: user.id,
    context: input.context,
  });
  return ok({ recorded: true });
});
