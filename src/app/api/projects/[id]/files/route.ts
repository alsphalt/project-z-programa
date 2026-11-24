import { ok, route } from '@/lib/api';
import { listProjectFiles, requireProject } from '@/lib/projects/repo';
import { isSecretPath } from '@/lib/security/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** File list for browsing an imported project. Credential paths are never listed. */
export const GET = route<{ id: string }>({ permission: 'file.read' }, async ({ params, req }) => {
  const project = await requireProject(params.id);
  const search = (new URL(req.url).searchParams.get('q') ?? '').trim().toLowerCase();
  const files = (await listProjectFiles(project.id)).filter((file) => !isSecretPath(file.path));
  const filtered = search ? files.filter((file) => file.path.toLowerCase().includes(search)) : files;
  return ok({
    project: { id: project.id, name: project.name, source: project.source },
    files: filtered.slice(0, 2000).map((file) => ({
      id: file.id,
      path: file.path,
      name: file.name,
      extension: file.extension,
      sizeBytes: file.sizeBytes,
      isText: file.isText,
      editable: file.isText && !file.contentOmitted,
      dirty: file.dirty,
      changedAt: file.changedAt,
    })),
    total: filtered.length,
    truncated: filtered.length > 2000,
  });
});
