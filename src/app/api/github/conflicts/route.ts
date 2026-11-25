import { ok, route } from '@/lib/api';
import { query } from '@/lib/db';
import { getConnectionView } from '@/lib/github/credentials';
import { findProjectByRepo } from '@/lib/projects/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Open conflicts for the connected repository, newest first. */
export const GET = route({ permission: 'file.read' }, async () => {
  const connection = await getConnectionView();
  const owner = connection.repository?.owner ?? null;
  const repo = connection.repository?.name ?? null;
  const project = owner && repo ? await findProjectByRepo(owner, repo, connection.repository?.branch ?? null) : null;

  if (!project) return ok({ projectId: null, conflicts: [] });

  const rows = await query<{
    id: string;
    path: string;
    reason: string;
    local_sha: string | null;
    remote_sha: string | null;
    local_content: string | null;
    remote_content: string | null;
    head_commit: string | null;
    base_commit: string | null;
    created_at: string;
  }>(
    `select id, path, reason, local_sha, remote_sha, local_content, remote_content,
            head_commit, base_commit, created_at
       from github_sync_conflicts
      where project_id = $1 and status = 'open'
      order by created_at desc`,
    [project.id],
  );

  return ok({
    projectId: project.id,
    conflicts: rows.map((row) => ({
      id: row.id,
      path: row.path,
      reason: row.reason,
      localSha: row.local_sha,
      remoteSha: row.remote_sha,
      // Both versions are returned so the UI can show a real side-by-side diff
      // instead of asking the administrator to trust a summary.
      localContent: row.local_content,
      remoteContent: row.remote_content,
      headCommit: row.head_commit,
      baseCommit: row.base_commit,
      createdAt: row.created_at,
    })),
  });
});
