import { z } from 'zod';
import { ok, route, searchParams } from '@/lib/api';
import { deleteMemory, listMemory, setMemory } from '@/lib/bigbrother/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ permission: null }, async ({ user }) => {
  return ok({ memory: await listMemory(user.id) });
});

const schema = z.object({
  key: z.string().min(1).max(120),
  value: z.unknown(),
});

export const PUT = route({ permission: null }, async ({ body, user }) => {
  const input = await body(schema);
  return ok({ item: await setMemory(user.id, input.key, input.value ?? null) });
});

export const DELETE = route({ permission: null }, async ({ req, user }) => {
  const key = searchParams(req).get('key');
  if (!key) return ok({ deleted: 0 });
  await deleteMemory(user.id, key);
  return ok({ deleted: 1, key });
});
