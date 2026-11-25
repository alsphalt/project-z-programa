import { z } from 'zod';
import { ApiError, ok, route } from '@/lib/api';
import { query, queryOne } from '@/lib/db';
import { sha256 } from '@/lib/crypto';
import { addSyncEvent, purgeDeletedFiles, refreshStats, requireProject, updateProject, upsertProjectFile } from '@/lib/projects/repo';
import { scheduleSync } from '@/lib/github/sync';
import { pullRemoteChanges } from '@/lib/github/pull';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

const schema = z.object({
  resolution: z.enum(['local', 'remote', 'merged']),
  /** Required for `merged`: the exact text the administrator approved. */
  content: z.string().max(4_000_000).optional(),
});

interface ConflictRow {
  id: string;
  project_id: string;
  path: string;
  reason: string;
  local_content: string | null;
  remote_content: string | null;
  remote_sha: string | null;
  status: string;
}

/**
 * Resolve one synchronized conflict.
 *
 * Both versions already exist in the database, so resolution is a choice, not a
 * merge by guesswork:
 *   local  → keep what is in DARKNOTE and push it on the next tick
 *   remote → take GitHub's version as the working copy
 *   merged → write the text the administrator composed, then push it
 *
 * Nothing is deleted from `github_sync_backups`, and the conflict row keeps both
 * original sides for the audit trail.
 */
export const POST = route<Params>({ permission: 'file.write' }, async ({ params, body, user }) => {
  const input = await body(schema);

  const conflict = await queryOne<ConflictRow>(
    `select id, project_id, path, reason, local_content, remote_content, remote_sha, status
       from github_sync_conflicts where id = $1`,
    [params.id],
  );
  if (!conflict) throw new ApiError('That conflict no longer exists.', 404, 'conflict_not_found');
  if (conflict.status !== 'open') throw new ApiError('That conflict is already resolved.', 409, 'conflict_closed');

  const project = await requireProject(conflict.project_id);

  if (input.resolution === 'remote') {
    if (conflict.remote_sha === null) {
      // GitHub deleted the file: removing it here is the resolution.
      await purgeDeletedFiles(project.id, [conflict.path]);
    } else {
      const content = conflict.remote_content;
      if (content === null) {
        throw new ApiError(
          'GitHub’s version is binary or too large to store as text; download it from the repository instead.',
          409,
          'conflict_binary_remote',
        );
      }
      await upsertProjectFile({
        projectId: project.id,
        path: conflict.path,
        content,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sha256: sha256(content),
        remoteSha: conflict.remote_sha,
        dirty: false,
        pendingDelete: false,
      });
    }
  } else {
    const content = input.resolution === 'merged' ? input.content : conflict.local_content;
    if (content === null || content === undefined) {
      throw new ApiError(
        input.resolution === 'merged'
          ? 'Provide the merged text before saving.'
          : 'There is no local version to keep for this file.',
        400,
        'conflict_missing_content',
      );
    }
    await upsertProjectFile({
      projectId: project.id,
      path: conflict.path,
      content,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(content),
      remoteSha: conflict.remote_sha,
      dirty: true,
      pendingDelete: false,
    });
  }

  await query(
    `update github_sync_conflicts
        set status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now()
      where id = $1`,
    [conflict.id, input.resolution, user.id],
  );

  await addSyncEvent(project.id, 'success', 'resolve', `[✓] Conflict on “${conflict.path}” resolved (${input.resolution}).`, {
    path: conflict.path,
    resolution: input.resolution,
    by: user.id,
  });

  const remaining = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from github_sync_conflicts where project_id = $1 and status = 'open'`,
    [project.id],
  );
  const openCount = Number(remaining?.count ?? 0);

  if (openCount === 0) {
    await updateProject(project.id, { syncStatus: 'pending', syncError: null });
    if (input.resolution === 'remote') {
      // Continue applying whatever else moved while the conflict was open.
      await pullRemoteChanges(project.id, { trigger: 'manual' }).catch(() => undefined);
    } else {
      await scheduleSync(project.id, [conflict.path], 'auto', `Resolve conflict on ${conflict.path}`);
    }
  }
  await refreshStats(project.id);

  return ok({ resolved: conflict.id, resolution: input.resolution, openConflicts: openCount });
});
