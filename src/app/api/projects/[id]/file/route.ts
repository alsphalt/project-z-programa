import { z } from 'zod';
import { ApiError, ok, route } from '@/lib/api';
import { getProjectFile, requireProject, writeProjectFile } from '@/lib/projects/repo';
import { afterLocalSave } from '@/lib/github/sync';
import { isSecretPath } from '@/lib/security/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const GET = route<{ id: string }>({ permission: 'file.read' }, async ({ params, req }) => {
  const project = await requireProject(params.id);
  const fileId = new URL(req.url).searchParams.get('fileId');
  if (!fileId) throw new ApiError('fileId is required.', 400, 'file_required');
  const file = await getProjectFile(project.id, fileId);
  if (isSecretPath(file.path)) throw new ApiError('Credential-shaped paths are not readable from the panel.', 403, 'protected_path');
  if (file.content === null) {
    throw new ApiError(
      file.isText
        ? 'This file is larger than the inline limit and has no editable copy in the panel.'
        : 'This file is binary; only its metadata was imported.',
      400,
      'file_not_editable',
    );
  }
  return ok({
    project: { id: project.id, name: project.name },
    file: {
      id: file.id,
      path: file.path,
      name: file.name,
      extension: file.extension,
      content: file.content,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      dirty: file.dirty,
      changedAt: file.changedAt,
    },
  });
});

const putSchema = z.object({
  fileId: z.string().min(1),
  content: z.string(),
  expectedSha: z.string().optional(),
});

/** Whole-file save from the project browser. Marks the file for GitHub sync. */
export const PUT = route<{ id: string }>({ permission: 'file.write' }, async ({ params, body }) => {
  const input = await body(putSchema);
  const project = await requireProject(params.id);
  const file = await getProjectFile(project.id, input.fileId);
  if (isSecretPath(file.path)) throw new ApiError('Credential-shaped paths are not writable.', 403, 'protected_path');
  if (file.content !== null && input.content.trim() === '' ) {
    throw new ApiError('Refusing to overwrite a non-empty file with an empty buffer.', 400, 'empty_write_blocked');
  }

  const written = await writeProjectFile({
    projectId: project.id,
    fileId: file.id,
    content: input.content,
    expectedSha: input.expectedSha ?? null,
    markDirty: true,
  });

  const sync = await afterLocalSave(project.id, [file.path]).catch((error) => ({
    applicable: true,
    scheduled: false,
    at: null,
    reason: `Saved locally, but the GitHub push could not be queued: ${error instanceof Error ? error.message : String(error)}`,
  }));

  return ok({
    file: {
      id: written.file.id,
      path: written.file.path,
      sha256: written.file.sha256,
      sizeBytes: written.file.sizeBytes,
      dirty: written.file.dirty,
    },
    sync,
  });
});
