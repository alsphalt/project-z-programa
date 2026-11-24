import { route, ApiError } from '@/lib/api';
import { assertServerAccess, serverClient } from '@/lib/servers/repo';
import { sha256 } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Download a panel-side backup archive through its signed URL. */
export const GET = route({ permission: 'backup.manage' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const uuid = url.searchParams.get('uuid');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!uuid) throw new ApiError('uuid is required', 400, 'uuid_required');
  const server = await assertServerAccess(user, serverId, 'backup.manage');

  const client = await serverClient(server);
  const signed = await client.backupDownloadUrl(uuid);
  const buffer = await client.fetchDownload(signed, 512 * 1024 * 1024);

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="panel-backup-${uuid.slice(0, 8)}.tar.gz"`,
      'Content-Length': String(buffer.byteLength),
      'x-darknote-sha256': sha256(buffer),
      'Cache-Control': 'no-store',
    },
  });
});
