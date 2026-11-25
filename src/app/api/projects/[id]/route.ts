import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { removeProject, requireProject, updateProject } from '@/lib/projects/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>({ permission: 'file.read' }, async ({ params }) => {
  const project = await requireProject(params.id);
  return ok({ project });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  syncEnabled: z.boolean().optional(),
});

export const PATCH = route<{ id: string }>({ permission: 'file.write' }, async ({ params, body }) => {
  const input = await body(patchSchema);
  await requireProject(params.id);
  const project = await updateProject(params.id, input);
  return ok({ project });
});

/** Removing the working copy never deletes the GitHub repository. */
export const DELETE = route<{ id: string }>({ permission: 'file.delete' }, async ({ params }) => {
  await removeProject(params.id);
  return ok({ removed: params.id, note: 'The imported working copy was deleted. The GitHub repository was not modified.' });
});
