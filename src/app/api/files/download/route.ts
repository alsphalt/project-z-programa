import { route, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { downloadOne, downloadMany, downloadProject, downloadVersion } from '@/lib/services/downloads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function attachment(name: string, buffer: Buffer, sha256: string, notes: string[]) {
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      'Content-Length': String(buffer.byteLength),
      'x-darknote-sha256': sha256,
      'x-darknote-verified-at': new Date().toISOString(),
      'x-darknote-notes': notes.join(' | ').slice(0, 900),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Downloads are always served from freshly-read production bytes whose SHA-256
 * was verified against what the panel returned. A cached draft is never served.
 */
export const GET = route({ permission: 'download' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'download');
  const mode = url.searchParams.get('mode') ?? 'file';

  if (mode === 'file') {
    const path = url.searchParams.get('path');
    if (!path) throw new ApiError('path is required', 400, 'path_required');
    const artifact = await downloadOne({ server, path, user });
    return attachment(artifact.filename, artifact.buffer, artifact.sha256, artifact.notes);
  }

  if (mode === 'zip') {
    const raw = url.searchParams.get('paths') ?? '';
    const paths = raw.split(',').map((item) => item.trim()).filter(Boolean);
    if (!paths.length) throw new ApiError('paths is required', 400, 'path_required');
    const artifact = await downloadMany({
      server,
      paths,
      user,
      archiveName: `${server.name.replace(/[^a-zA-Z0-9._-]/g, '_')}-selection.zip`,
    });
    return attachment(artifact.filename, artifact.buffer, artifact.sha256, artifact.notes);
  }

  if (mode === 'project') {
    const artifact = await downloadProject({ server, user });
    return attachment(artifact.filename, artifact.buffer, artifact.sha256, artifact.notes);
  }

  if (mode === 'version') {
    const versionId = url.searchParams.get('versionId');
    if (!versionId) throw new ApiError('versionId is required', 400, 'version_required');
    const artifact = await downloadVersion({ server, versionId, user });
    return attachment(artifact.filename, artifact.buffer, artifact.sha256, artifact.notes);
  }

  throw new ApiError(`Unknown download mode "${mode}"`, 400, 'unknown_mode');
});
