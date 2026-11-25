import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { createConversation, listConversations } from '@/lib/bigbrother/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ permission: null }, async ({ user }) => {
  return ok({ conversations: await listConversations(user.id, 50) });
});

const schema = z.object({
  title: z.string().max(120).optional(),
  serverId: z.string().max(120).optional().nullable(),
});

export const POST = route({ permission: null }, async ({ body, user }) => {
  const input = await body(schema);
  rateLimit(`bb-conversation:${user.id}`, 30, 60_000);
  const conversation = await createConversation(user.id, {
    title: input.title?.trim() || 'New conversation',
    serverId: input.serverId ?? null,
  });
  return ok({ conversation });
});
