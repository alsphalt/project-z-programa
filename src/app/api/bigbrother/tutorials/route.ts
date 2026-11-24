import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { createTutorial, listTutorials } from '@/lib/bigbrother/tutorials';
import { listAssets } from '@/lib/bigbrother/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ permission: null }, async ({ user }) => {
  const [tutorials, assets] = await Promise.all([listTutorials(user.id), listAssets(user.id)]);
  return ok({ tutorials, assets });
});

const stepSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  assetId: z.string().max(80).nullable().optional(),
  link: z.string().max(300).nullable().optional(),
});

const schema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(600).optional(),
  keywords: z.array(z.string().max(60)).max(24).optional(),
  published: z.boolean().optional(),
  steps: z.array(stepSchema).min(1).max(30),
});

export const POST = route({ permission: null }, async ({ body, user }) => {
  rateLimit(`bb-tutorial:${user.id}`, 20, 60_000);
  const input = await body(schema);
  return ok({ tutorial: await createTutorial(user.id, input) });
});
