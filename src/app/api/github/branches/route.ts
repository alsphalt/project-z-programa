import { ApiError, ok, route } from '@/lib/api';
import { listRepositoryBranches } from '@/lib/github/repos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Branches of one repository, used by the branch selector. */
export const GET = route({ permission: 'file.write' }, async ({ req }) => {
  const url = new URL(req.url);
  const owner = url.searchParams.get('owner') ?? '';
  const repo = url.searchParams.get('repo') ?? '';
  if (!owner || !repo) throw new ApiError('owner and repo are required.', 400, 'repository_required');
  const branches = await listRepositoryBranches(owner, repo);
  return ok({
    branches: branches.map((branch) => ({
      name: branch.name,
      sha: branch.commit?.sha ?? null,
      protected: Boolean(branch.protected),
    })),
  });
});
