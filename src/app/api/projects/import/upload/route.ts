import { ApiError, fail, ok, rateLimit, route } from '@/lib/api';
import { importFromFiles, importFromZip, MAX_UPLOAD_BYTES } from '@/lib/projects/import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Device upload: one ZIP archive is extracted and registered as a project;
 * individual files are stored as a small project. Nothing is executed and no
 * path can escape the project root (see projects/import.ts).
 */
export const POST = route({ permission: 'file.write' }, async ({ req, user }) => {
  rateLimit(`project-upload:${user.id}`, 30, 60_000);

  const form = await req.formData().catch(() => {
    throw new ApiError('Expected multipart/form-data.', 415, 'bad_upload');
  });

  const jobId = String(form.get('jobId') ?? '') || undefined;
  const projectName = String(form.get('projectName') ?? '') || undefined;
  const entries = form.getAll('files').filter((item): item is File => item instanceof File);

  if (!entries.length) throw new ApiError('No files were included in the upload.', 400, 'missing_files');
  for (const entry of entries) {
    if (entry.size > MAX_UPLOAD_BYTES) {
      throw new ApiError(`${entry.name} is larger than the 64 MB upload limit.`, 413, 'file_too_large');
    }
    if (entry.size === 0) throw new ApiError(`${entry.name} is empty.`, 400, 'empty_file');
  }

  const isArchive = entries.length === 1 && entries[0].name.toLowerCase().endsWith('.zip');
  try {
    if (isArchive) {
      const buffer = Buffer.from(await entries[0].arrayBuffer());
      const result = await importFromZip({
        buffer,
        filename: entries[0].name,
        userId: user.id,
        jobId,
      });
      return ok({
        kind: 'archive',
        project: result.project,
        summary: result.summary,
        note: 'The archive was extracted and stored in the panel.',
      });
    }

    const files = await Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        buffer: Buffer.from(await entry.arrayBuffer()),
      })),
    );
    const result = await importFromFiles({ files, userId: user.id, jobId, projectName });
    return ok({
      kind: 'files',
      project: result.project,
      summary: result.summary,
      note: 'The selected files were stored in the panel.',
    });
  } catch (error) {
    return fail(error);
  }
});
