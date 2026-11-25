import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { requireProject } from '@/lib/projects/repo';
import { createProjectSnapshot, listProjectSnapshots } from '@/lib/projects/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Snapshots of a project's stored files, newest first. */
export const GET = route<{ id: string }>({ permission: 'file.read' }, async ({ params }) => {
  const project = await requireProject(params.id);
  const snapshots = await listProjectSnapshots(project.id);
  return ok({
    projectId: project.id,
    projectName: project.name,
    snapshots,
    note: snapshots.length
      ? `${snapshots.length} snapshot(s). The archive is verified by manifest before any restore.`
      : 'No snapshots yet. One is taken automatically before an import replaces existing files.',
  });
});

const schema = z.object({
  label: z.string().trim().max(160).optional(),
});

/** Manual snapshot: the same verified archive the import flow uses. */
export const POST = route<{ id: string }>({ permission: 'file.write' }, async ({ params, body, user }) => {
  rateLimit(`project-snapshot:${user.id}`, 10, 60_000);
  const input = await body(schema);
  const project = await requireProject(params.id);
  const snapshot = await createProjectSnapshot({
    projectId: project.id,
    kind: 'manual',
    label: input.label ?? `Manual snapshot by ${user.email}`,
    userId: user.id,
  });
  return ok({
    snapshot,
    note: `Backed up ${snapshot.filesCount} files (${snapshot.bytes} bytes) and verified the manifest.`,
  });
});
