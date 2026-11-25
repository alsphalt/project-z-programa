import { NextRequest } from 'next/server';
import { ApiError, rateLimit } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { applyZipImport, inspectZip, uploadFile } from '@/lib/files/ops';
import { requireUser } from '@/lib/auth/session';
import { currentCsrfToken } from '@/lib/auth/session';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_BYTES = 64 * 1024 * 1024;

/**
 * Multipart upload and imported-archive handling.
 *
 * A ZIP is never expanded blind: `mode=inspect` lists every entry, flags path
 * traversal and existing files, and only `mode=extract` writes anything.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const user = await requireUser();
    const header = req.headers.get('x-csrf-token');
    const expected = await currentCsrfToken();
    if (!expected || header !== expected) {
      throw new ApiError('CSRF validation failed. Reload the page and try again.', 403, 'csrf_failed');
    }
    const serverId = req.nextUrl.searchParams.get('serverId');
    rateLimit(`upload:${user.id}`, 60, 60_000);

    const form = await req.formData().catch(() => {
      throw new ApiError('Expected multipart/form-data', 415, 'bad_upload');
    });
    const targetServerId = serverId ?? String(form.get('serverId') ?? '');
    if (!targetServerId) throw new ApiError('serverId is required', 400, 'server_required');
    const server = await assertServerAccess(user, targetServerId, 'file.write');

    const destination = String(form.get('destination') ?? server.projectRoot);
    const mode = String(form.get('mode') ?? 'upload');
    const files = form.getAll('files').filter((item): item is File => item instanceof File);
    if (!files.length) throw new ApiError('No files were included in the upload', 400, 'missing_files');

    for (const file of files) {
      if (file.size > MAX_BYTES) throw new ApiError(`${file.name} exceeds the 64 MB upload limit`, 413, 'file_too_large');
    }

    if (mode === 'inspect' || mode === 'extract') {
      const archive = files.find((file) => file.name.toLowerCase().endsWith('.zip'));
      if (!archive) throw new ApiError('Archive mode requires a .zip file', 400, 'missing_archive');
      const buffer = Buffer.from(await archive.arrayBuffer());

      if (mode === 'inspect') {
        const { entries, rejected } = inspectZip(buffer, destination);
        return Response.json({
          archive: {
            name: archive.name,
            destination,
            entries: entries.map((entry) => ({
              name: entry.name,
              path: entry.path,
              size: entry.bytes,
              isDirectory: entry.isDirectory,
              binary: entry.binary,
              exists: entry.exists,
              unsafe: entry.unsafe ?? null,
            })),
            rejected: rejected.map((entry) => ({ path: entry.path, reason: entry.unsafe ?? 'rejected' })),
            totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
            existingCount: entries.filter((entry) => entry.exists).length,
            note: 'Nothing has been written yet. Existing files are only replaced when you confirm an overwrite.',
          },
        });
      }

      const result = await applyZipImport({
        server,
        user,
        buffer,
        destination,
        note: `ZIP import into ${destination}`,
      });
      return Response.json({
        summary: {
          extracted: result.imported,
          uploaded: 0,
          skipped: result.skipped.length,
          failed: 0,
        },
        skipped: result.skipped,
        deploymentId: result.deploymentId,
      });
    }

    let uploaded = 0;
    let skipped = 0;
    const failed: Array<{ name: string; error: string }> = [];
    const written: Array<{ path: string; bytes: number }> = [];

    for (const file of files) {
      if (file.name.toLowerCase() === '.env' || file.name.startsWith('.')) {
        skipped += 1;
        failed.push({ name: file.name, error: 'Dotfiles and .env files are blocked by policy' });
        continue;
      }
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await uploadFile(server, destination, file.name, buffer, user);
        written.push({ path: result.path, bytes: result.bytes });
        uploaded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already exists/i.test(message)) skipped += 1;
        else failed.push({ name: file.name, error: message });
      }
    }

    return Response.json({
      summary: { uploaded, skipped, failed: failed.length },
      files: written,
      errors: failed,
    });
  } catch (error) {
    return fail(error);
  }
}
