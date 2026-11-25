import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { deleteTutorial, getTutorial, updateTutorial } from '@/lib/bigbrother/tutorials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>({ permission: null }, async ({ params, user }) => {
  return ok({ tutorial: await getTutorial(user.id, params.id) });
});

const stepSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  assetId: z.string().max(80).nullable().optional(),
  link: z.string().max(300).nullable().optional(),
});

const schema = z.object({
  title: z.string().min(1).max(160).optional(),
  summary: z.string().max(600).optional(),
  keywords: z.array(z.string().max(60)).max(24).optional(),
  published: z.boolean().optional(),
  steps: z.array(stepSchema).min(1).max(30).optional(),
});

export const PATCH = route<Params>({ permission: null }, async ({ params, body, user }) => {
  const input = await body(schema);
  return ok({ tutorial: await updateTutorial(user.id, params.id, input) });
});

export const DELETE = route<Params>({ permission: null }, async ({ params, user }) => {
  await deleteTutorial(user.id, params.id);
  return ok({ deleted: params.id });
});
