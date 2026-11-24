import 'server-only';
import { ApiError } from '../api';
import { jsonb, query, queryOne } from '../db';
import { requireClient } from '../github/credentials';
import { isProbablyBinary, isSecretPath, DEFAULT_EXCLUDED_PATHS, isExcluded } from '../security/paths';
import * as repo from './repo';
import {
  IMPORT_BATCH_SIZE,
  MAX_GITHUB_FILES,
  createImportJob,
  getImportJob,
  prepareFile,
  updateImportJob,
  type ImportJobRecord,
} from './import';

/**
 * Batched GitHub import.
 *
 * The previous design did the whole job inside one POST: read the tree, download
 * every blob, then insert thousands of rows before responding. On a deployed
 * function that request is capped by the platform's execution limit, so a
 * repository of any size produced the behaviour the operator reported — the
 * dialog sat on "wait for the repository" while the request was being killed
 * underneath it, and the client polled a job that would never finish.
 *
 * The import is now a resumable state machine:
 *
 *   start()  → one tree read, no file contents, returns a job immediately
 *   runBatch() → downloads and stores the next N files, advances a cursor
 *   cancel()  → stops the job, keeps what was already written
 *
 * Each batch is a short request, so no platform timeout can truncate the work,
 * progress is real (counts come from rows actually written), and a closed tab
 * only pauses the import instead of losing it.
 */

/**
 * A `running` job older than this is treated as abandoned.
 *
 * A job only advances while a browser tab drives its batches, so a closed tab
 * leaves the row `running` with nothing to move it. Fifteen minutes is far
 * beyond a healthy import (2000 files at 20 per request) and short enough that
 * an operator retrying does not wait on a corpse.
 */
const IMPORT_JOB_STALE_MS = 15 * 60_000;

export interface ImportPlan {
  owner: string;
  repo: string;
  branch: string;
  headSha: string;
  defaultBranch: string;
  description: string | null;
  private: boolean;
  /** `[path, blobSha]` pairs, in tree order. */
  plan: Array<[string, string]>;
  cursor: number;
  /** Claim token: a batch must own the job before touching it. */
  lock?: string | null;
  skippedPaths?: number;
}

interface JobWithDetail extends ImportJobRecord {
  detail: ImportPlan | null;
}

async function loadJob(jobId: string): Promise<JobWithDetail> {
  const row = await queryOne<Record<string, unknown>>(`select * from project_import_jobs where id = $1`, [jobId]);
  if (!row) throw new ApiError('That import job no longer exists.', 404, 'import_job_not_found');
  const job = await getImportJob(jobId);
  return { ...job, detail: (row.detail as ImportPlan | null) ?? null };
}

/**
 * Creates the job and the project record, then reads the tree once.
 * No blob is downloaded here.
 */
export async function startGitHubImport(options: {
  owner: string;
  repoName: string;
  branch?: string | null;
  userId?: string | null;
}): Promise<{ job: ImportJobRecord; reused: boolean }> {
  const client = await requireClient();
  const owner = options.owner.trim();
  const repoName = options.repoName.trim();

  const metadata = await client.getRepository(owner, repoName);
  const branch = options.branch || metadata.default_branch;
  const head = await client.getBranchHead(owner, repoName, branch);
  const commit = await client.getCommit(owner, repoName, head.sha);

  // A running import of the same repository is reused instead of queued twice:
  // double-clicking "Import" must not start two writers on one project.
  const running = await queryOne<{ id: string; started_at: string | Date }>(
    `select id, started_at from project_import_jobs
      where status = 'running' and source = 'github'
        and detail->>'owner' = $1 and detail->>'repo' = $2 and detail->>'branch' = $3
      order by started_at desc
      limit 1`,
    [owner, repoName, branch],
  );
  if (running) {
    const ageMs = Date.now() - new Date(running.started_at).getTime();
    /**
     * Reuse only a job that can still be advanced.
     *
     * A job is advanced by whichever tab is driving it. If that tab was closed
     * (or the phone killed it), the row stays `running` forever and every later
     * import of the same repository returns it — the dialog then polls a job
     * nothing is moving, which is exactly what "the import is stuck" looked
     * like on the phone. Past the stale window the old job is failed
     * explicitly, so the operator sees a new attempt start instead of a hang.
     */
    if (ageMs < IMPORT_JOB_STALE_MS) {
      return { job: await getImportJob(running.id), reused: true };
    }
    await updateImportJob(running.id, {
      status: 'failed',
      phase: 'abandoned',
      error: 'The previous import stopped advancing and was abandoned.',
      message: 'Abandoned a stalled import; a new one was started.',
    });
  }

  const tree = await client.getTree(owner, repoName, commit.tree.sha);
  if (tree.truncated) {
    throw new ApiError(
      'GitHub returned a truncated file tree for that repository, so a partial import was refused. Import from a narrower folder instead.',
      422,
      'tree_truncated',
    );
  }

  const plan: Array<[string, string]> = [];
  let skippedPaths = 0;
  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    if (isProbablyBinary(entry.path) || isExcluded(entry.path, DEFAULT_EXCLUDED_PATHS) || isSecretPath(entry.path)) {
      skippedPaths += 1;
      continue;
    }
    plan.push([entry.path, entry.sha]);
    if (plan.length > MAX_GITHUB_FILES) break;
  }

  if (plan.length > MAX_GITHUB_FILES) {
    throw new ApiError(
      `That repository has more than ${MAX_GITHUB_FILES} importable files. Import a folder instead, or raise the limit deliberately.`,
      413,
      'github_too_many_files',
    );
  }

  const jobId = await createImportJob({
    source: 'github',
    userId: options.userId ?? null,
    message: `Prepared ${owner}/${repoName}@${branch}`,
  });

  // Re-importing the same repository refreshes the working copy in place. Files
  // are not cleared up front: a cancelled import must leave the previous version
  // usable rather than an empty project.
  const existing = await repo.findProjectByRepo(owner, repoName, branch);
  const project = existing
    ? await repo.updateProject(existing.id, {
        status: 'importing',
        statusMessage: 'Importing from GitHub',
        githubBranch: branch,
        syncError: null,
      })
    : await repo.createProject({
        name: repoName,
        description: metadata.description ?? `${owner}/${repoName}`,
        source: 'github',
        sourceLabel: `${owner}/${repoName}`,
        github: {
          owner,
          repo: repoName,
          branch,
          defaultBranch: metadata.default_branch,
          private: metadata.private,
          commitSha: head.sha,
        },
        createdBy: options.userId ?? null,
        status: 'importing',
        statusMessage: 'Importing from GitHub',
      });

  const detail: ImportPlan = {
    owner,
    repo: repoName,
    branch,
    headSha: head.sha,
    defaultBranch: metadata.default_branch,
    description: metadata.description ?? null,
    private: metadata.private,
    plan,
    cursor: 0,
    skippedPaths,
  };

  await query(
    `update project_import_jobs
        set project_id = $2, phase = 'fetching', total_files = $3, detail = $4, message = $5
      where id = $1`,
    [jobId, project.id, plan.length, jsonb(detail), `Fetching ${plan.length} files from ${owner}/${repoName}@${branch}`],
  );

  return { job: await getImportJob(jobId), reused: false };
}

/**
 * Downloads and stores the next batch, then finalises when the plan is done.
 *
 * The job is claimed for 20 seconds before work starts, so two tabs polling the
 * same job cannot write the same files concurrently.
 */
export async function runImportBatch(jobId: string): Promise<ImportJobRecord> {
  // Claim the job for 30 s. The claim is cleared at the end of every batch, so
  // it only guards against two tabs running the same batch at the same time.
  const claimed = await query<{ id: string }>(
    `update project_import_jobs
        set detail = jsonb_set(detail, '{lockUntil}', to_jsonb(now() + interval '30 seconds'))
      where id = $1
        and status = 'running'
        and coalesce((detail->>'lockUntil')::timestamptz, to_timestamp(0)) < now()
      returning id`,
    [jobId],
  );

  const job0 = await loadJob(jobId);
  if (claimed.length === 0) {
    // Either another worker owns it, or it is no longer running.
    return job0;
  }
  if (job0.status !== 'running' || !job0.detail) return job0;

  const detail = job0.detail;
  const { plan, cursor } = detail;
  if (!plan?.length) {
    /**
     * Zero importable files (every path excluded, secret-shaped or binary).
     * Finish the job *and* release the project: leaving it on `importing`
     * meant the project card never left its spinner and the next import of the
     * same repository looked like it had never finished.
     */
    await updateImportJob(jobId, { status: 'succeeded', phase: 'done', message: 'Nothing to import.' });
    if (job0.projectId) {
      await repo.updateProject(job0.projectId, {
        status: 'import_failed',
        statusMessage:
          'Nothing in that repository could be imported — every file is binary, excluded or credential-shaped.',
      });
    }
    return getImportJob(jobId);
  }

  try {
    const client = await requireClient();
    const slice = plan.slice(cursor, cursor + IMPORT_BATCH_SIZE);

    let written = 0;
    let bytes = 0;
    let skipped = 0;

    const prepared = [];
    for (const [path, sha] of slice) {
      try {
        const blob = await client.getBlob(detail.owner, detail.repo, sha);
        const buffer = blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64') : Buffer.from(blob.content, 'utf8');
        const file = prepareFile(path, buffer, sha);
        if (!file) {
          skipped += 1;
          continue;
        }
        prepared.push(file);
        bytes += buffer.byteLength;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // A single unreadable blob must not abort the whole import.
        skipped += 1;
      }
    }

    if (prepared.length) {
      await repo.upsertProjectFiles(job0.projectId as string, prepared);
      written = prepared.length;
    }

    const nextCursor = cursor + slice.length;
    const finished = nextCursor >= plan.length;
    const fetched = job0.fetchedFiles + written;

    if (!finished) {
      await query(
        `update project_import_jobs
            set detail = jsonb_set(
                  jsonb_set(detail, '{cursor}', to_jsonb($2::int)),
                  '{lockUntil}', to_jsonb('1970-01-01T00:00:00Z'::timestamptz)),
                fetched_files = $3,
                total_bytes = total_bytes + $4,
                skipped_files = skipped_files + $5,
                message = $6
          where id = $1`,
        [
          jobId,
          nextCursor,
          fetched,
          bytes,
          skipped,
          `Fetched ${fetched}/${plan.length} files`,
        ],
      );
      return getImportJob(jobId);
    }

    // Final batch: drop files that no longer exist in the repository, so a
    // refresh never leaves stale paths behind. Only done at the very end, so a
    // cancelled import keeps the previous version intact.
    const keep = new Set(plan.map(([path]) => path));
    const current = await repo.listProjectFilePaths(job0.projectId as string);
    const stale = current.filter((path) => !keep.has(path));
    if (stale.length) await repo.purgeDeletedFiles(job0.projectId as string, stale);

    await repo.updateProject(job0.projectId as string, {
      status: 'ready',
      statusMessage: null,
      syncStatus: 'idle',
      syncError: null,
      baseCommitSha: detail.headSha,
    });
    await repo.refreshStats(job0.projectId as string);
    await repo.addSyncEvent(job0.projectId as string, 'success', 'import', `[✓] Imported ${plan.length} files from ${detail.owner}/${detail.repo}@${detail.branch}.`);

    await query(
      `update project_import_jobs
          set status = 'succeeded', phase = 'done', finished_at = now(),
              detail = jsonb_set(
                jsonb_set(detail, '{cursor}', to_jsonb($2::int)),
                '{lockUntil}', to_jsonb('1970-01-01T00:00:00Z'::timestamptz)),
              fetched_files = $3, total_bytes = total_bytes + $4,
              skipped_files = skipped_files + $5, message = $6, error = null
        where id = $1`,
      [jobId, nextCursor, fetched, bytes, skipped, `Imported ${plan.length} files.`],
    );

    return getImportJob(jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateImportJob(jobId, { status: 'failed', phase: 'failed', error: message, message });
    if (job0.projectId) {
      await repo.updateProject(job0.projectId, { status: 'ready', statusMessage: null, syncError: message });
    }
    throw error;
  }
}

/** Stops a running import. Everything already written stays usable. */
export async function cancelImport(jobId: string): Promise<ImportJobRecord> {
  const job = await loadJob(jobId);
  if (job.status !== 'running') return job;
  await updateImportJob(jobId, {
    status: 'failed',
    phase: 'cancelled',
    error: 'Cancelled by the administrator.',
    message: 'Import cancelled.',
  });
  if (job.projectId) {
    const files = await repo.listProjectFilePaths(job.projectId);
    await repo.updateProject(job.projectId, {
      status: files.length ? 'ready' : 'import_failed',
      statusMessage: files.length ? null : 'Import cancelled before any file was stored',
      syncError: null,
    });
  }
  return getImportJob(jobId);
}
