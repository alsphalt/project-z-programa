import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { requireProject } from '@/lib/projects/repo';
import { analyzeProjectById, executeInstall } from '@/lib/projects/install';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The installation report: runtime, manager, commands, dependency and env counts. */
export const GET = route<{ id: string }>({ permission: 'file.read' }, async ({ params }) => {
  const project = await requireProject(params.id);
  const analysis = await analyzeProjectById(project.id);
  return ok({
    projectId: project.id,
    projectName: project.name,
    analysis,
    note: 'Detection only — nothing was executed. The commands below are what an install would run.',
  });
});

const schema = z.object({
  confirm: z.literal(true),
  command: z.string().trim().max(200).optional(),
});

/**
 * Sends the analysed install command to the server the project is bound to.
 * The response states what was sent, not that it succeeded — the panel console
 * is the only proof of that.
 */
export const POST = route<{ id: string }>({ permission: 'console.command' }, async ({ params, body, user }) => {
  rateLimit(`project-install:${user.id}`, 6, 60_000);
  const input = await body(schema);
  const project = await requireProject(params.id);
  const result = await executeInstall({
    projectId: project.id,
    user: { id: user.id, email: user.email },
    confirm: input.confirm,
    commandOverride: input.command ?? null,
  });
  return ok(result);
});
