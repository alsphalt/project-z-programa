import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { getConnectionView } from '@/lib/github/credentials';
import { importFromGitHub } from '@/lib/projects/import';
import { runImportBatch, startGitHubImport } from '@/lib/projects/import-batch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const schema = z.object({
  owner: z.string().trim().min(1).max(120).optional(),
  repo: z.string().trim().min(1).max(120).optional(),
  branch: z.string().trim().max(200).optional(),
  jobId: z.string().min(1).optional(),
});

/**
 * Starts importing a repository through the GitHub API.
 *
 * Two modes:
 *  - **batched (default)**: reads the tree and returns a job id immediately. The
 *    client then drives `/api/projects/import/batch` until the job completes.
 *    This is what the File Manager uses, because a single request that downloads
 *    and stores thousands of files is exactly what a serverless execution limit
 *    cuts off — the "wait for the repository" symptom.
 *  - **legacy (`jobId` supplied)**: the pre-existing synchronous path, kept for
 *    callers that already created a job.
 */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  rateLimit(`project-import-github:${user.id}`, 20, 60_000);
  const input = await body(schema);

  const view = await getConnectionView();
  if (!view.connected) {
    const error = new Error('GitHub is not connected. Connect it in Admin Settings → GitHub Connection before importing.');
    (error as Error & { statusCode?: number }).statusCode = 424;
    throw error;
  }

  const owner = input.owner ?? view.repository?.owner;
  const repoName = input.repo ?? view.repository?.name;
  if (!owner || !repoName) {
    const error = new Error('No repository selected and none configured in Admin Settings.');
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  if (input.jobId) {
    const result = await importFromGitHub({
      owner,
      repoName,
      branch: input.branch ?? view.repository?.branch ?? null,
      userId: user.id,
      jobId: input.jobId,
    });

    return ok({
      project: result.project,
      summary: result.summary,
      note: `Imported ${result.summary.files} files from ${owner}/${repoName}@${result.summary.branch ?? ''}.`,
    });
  }

  const started = await startGitHubImport({
    owner,
    repoName,
    branch: input.branch ?? view.repository?.branch ?? null,
    userId: user.id,
  });

  // Run the first batch inside this request so small repositories finish without
  // a second round trip, and large ones return a job the client can resume.
  const job = started.reused ? started.job : await runImportBatch(started.job.id);

  return ok({
    jobId: job.id,
    job,
    totalFiles: job.totalFiles,
    reused: started.reused,
    note: `Prepared ${job.totalFiles} files from ${owner}/${repoName}.`,
  });
});
