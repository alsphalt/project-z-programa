import { z } from 'zod';
import { ApiError, ok, rateLimit, route } from '@/lib/api';
import { getConnectionView } from '@/lib/github/credentials';
import { findProjectByRepo } from '@/lib/projects/repo';
import { pullRemoteChanges } from '@/lib/github/pull';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ projectId: z.string().min(1).max(80).optional() });

/**
 * "Sync now" / "Retry": pull the remote head on demand.
 *
 * The same engine the webhook and the poller use, so a manual sync exercises the
 * identical code path — including conflict detection and verification.
 */
export const POST = route({ permission: 'file.write' }, async ({ body }) => {
  rateLimit('github-pull', 20, 60_000);
  const input = (await body(schema)) ?? {};

  let projectId = input.projectId;
  if (!projectId) {
    const connection = await getConnectionView();
    const owner = connection.repository?.owner;
    const repo = connection.repository?.name;
    if (!owner || !repo) {
      throw new ApiError('No GitHub repository is connected.', 424, 'github_not_connected');
    }
    const project = await findProjectByRepo(owner, repo, connection.repository?.branch ?? null);
    if (!project) throw new ApiError('That repository is not imported as a project yet.', 404, 'project_not_found');
    projectId = project.id;
  }

  const outcome = await pullRemoteChanges(projectId, { trigger: 'manual' });
  return ok(outcome);
});
