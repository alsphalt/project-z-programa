import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { getVersion, readVersionText, buildDiff } from '@/lib/versions';
import { fetchRemoteFile } from '@/lib/files/service';
import { deployChanges } from '@/lib/services/deploy';
import { publicId, toUiStatus } from '@/lib/deploy-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Compare a stored version with what is running in production right now. */
export const GET = route({ permission: 'backup.manage' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const id = url.searchParams.get('id');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!id) throw new ApiError('id is required', 400, 'version_required');
  const server = await assertServerAccess(user, serverId, 'backup.manage');

  const version = await getVersion(server.id, id);
  const content = await readVersionText(version);

  let current: { content: string; sha256: string } | null = null;
  try {
    const snapshot = await fetchRemoteFile(server, version.path, { withStat: false });
    current = { content: snapshot.content, sha256: snapshot.sha256 };
  } catch {
    current = null;
  }

  return ok({
    version: {
      id: version.id,
      path: version.path,
      version: version.version,
      sha256: version.sha256,
      createdAt: version.createdAt,
      source: version.changeNote ?? 'automatic backup',
      message: version.changeNote,
      author: version.authorEmail,
    },
    content,
    current,
    identical: current ? current.sha256 === version.sha256 : false,
    diff: current ? buildDiff(content, current.content) : null,
  });
});

const restoreSchema = z.object({
  serverId: z.string().min(1),
  versionId: z.string().min(1),
  message: z.string().max(300).optional(),
});

/**
 * Restore a version through the normal deployment pipeline: the current file is
 * backed up, the restored bytes are written and hash-verified, the bot restarts
 * and startup output is checked. The Backups page has always sent POST here;
 * without this handler Next answered 405.
 */
export const POST = route({ permission: 'rollback' }, async ({ user, body }) => {
  const input = await body(restoreSchema);
  const server = await assertServerAccess(user, input.serverId, 'rollback');
  const version = await getVersion(server.id, input.versionId);
  const content = await readVersionText(version);

  const outcome = await deployChanges({
    server,
    user,
    changes: [{ path: version.path, content, expectedHash: null }],
    note: input.message ?? `Restore ${version.path} to v${version.version}`,
    restartMode: 'auto',
  });

  return ok({
    deployment: {
      id: outcome.id,
      publicId: publicId(outcome.id),
      status: toUiStatus(outcome.status),
      healthOk: outcome.health.verdict === 'healthy' ? true : outcome.health.verdict === 'unknown' ? null : false,
      error: outcome.error ?? null,
      restarted: outcome.restarted,
      health: outcome.health.verdict,
      detail: outcome.health.detail,
      version: { id: version.id, version: version.version, path: version.path },
    },
  });
});
