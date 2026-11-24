import { z } from 'zod';
import { ok, route } from '@/lib/api';
import {
  MESSAGE_PAGE_SIZE,
  deleteConversation,
  getConversation,
  renameConversation,
} from '@/lib/bigbrother/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

/**
 * One page of a thread.
 *
 * Query parameters:
 *   limit  — messages per page (1-200, default 40)
 *   before — opaque `nextCursor` from the previous page, for older messages
 *
 * The response always contains the newest page when `before` is absent, so a
 * phone never has to download a whole conversation to show the last turn.
 */
export const GET = route<Params>({ permission: null }, async ({ params, req, user }) => {
  const search = new URL(req.url).searchParams;
  const rawLimit = Number(search.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : MESSAGE_PAGE_SIZE;
  const before = search.get('before') ?? undefined;
  const result = await getConversation(user.id, params.id, { limit, before });
  return ok(result);
});

const patchSchema = z.object({ title: z.string().min(1).max(120) });

export const PATCH = route<Params>({ permission: null }, async ({ params, body, user }) => {
  const input = await body(patchSchema);
  return ok({ conversation: await renameConversation(user.id, params.id, input.title) });
});

export const DELETE = route<Params>({ permission: null }, async ({ params, user }) => {
  await deleteConversation(user.id, params.id);
  return ok({ deleted: params.id });
});
