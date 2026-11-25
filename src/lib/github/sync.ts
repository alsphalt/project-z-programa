import 'server-only';
import { ApiError } from '../api';
import { jsonb, query, queryOne } from '../db';
import { uuid } from '../crypto';
import {
  addSyncEvent,
  getProject,
  listDirtyFiles,
  listSyncEvents,
  markFilesClean,
  purgeDeletedFiles,
  requireProject,
  setRemoteShas,
  updateProject,
  writeProjectFile,
  type ProjectFileRecord,
  type ProjectRecord,
} from '../projects/repo';
import { getConnectionView, requireToken } from './credentials';
import { GitHubClient, GitHubError } from './client';

/**
 * Automatic GitHub synchronization.
 *
 * A save marks the file dirty and schedules one pending job per project whose
 * `not_before` is "now + delay" (5 s by default). Every further save rewrites
 * that deadline, so a burst of edits becomes a single commit. When the deadline
 * passes, the worker:
 *
 *   compare → blob → tree → commit → fast-forward ref → verify → mark clean
 *
 * The remote branch head is compared with the commit the working copy was based
 * on. If somebody else pushed in the meantime, or if a file we are about to
 * overwrite has a different blob sha than the one we imported, the push is
 * refused: local edits are kept, nothing remote is overwritten, and the project is
 * put in `conflict` until an administrator resolves it.
 */

export interface SyncSchedule {
  projectId: string;
  notBefore: string;
  delaySeconds: number;
  pendingFiles: number;
}

export class SyncConflict extends Error {
  code: string;
  detail: unknown;
  constructor(message: string, code = 'sync_conflict', detail?: unknown) {
    super(message);
    this.name = 'SyncConflict';
    this.code = code;
    this.detail = detail;
  }
}

interface JobRow {
  id: string;
  project_id: string;
  status: string;
  not_before: string;
  attempts: number;
  files: unknown;
  trigger: string;
  message: string | null;
  last_error: string | null;
}

export async function scheduleSync(
  projectId: string,
  files: string[],
  trigger: 'auto' | 'manual' | 'retry' = 'auto',
  message: string | null = null,
): Promise<SyncSchedule> {
  const project = await requireProject(projectId);
  if (project.source !== 'github' || !project.githubOwner || !project.githubRepo) {
    throw new ApiError('That project is not connected to a GitHub repository.', 400, 'project_not_github');
  }
  const connection = await getConnectionView();
  if (!connection.connected) {
    throw new ApiError('GitHub is not connected.', 424, 'github_not_connected');
  }

  const delaySeconds = Math.min(120, Math.max(2, connection.syncDelaySeconds || 5));
  const notBefore = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const merged = Array.from(new Set(files.filter(Boolean)));

  const row = await queryOne<JobRow>(
    `insert into github_sync_jobs (id, project_id, status, not_before, attempts, files, trigger, message)
     values ($1,$2,'pending',$3,0,$4,$5,$6)
     on conflict (project_id) where status = 'pending' do update set
       not_before = excluded.not_before,
       files = excluded.files,
       trigger = excluded.trigger,
       message = coalesce(excluded.message, github_sync_jobs.message),
       updated_at = now()
     returning *`,
    [uuid(), projectId, notBefore, jsonb(merged), trigger, message],
  );

  await updateProject(projectId, {
    syncStatus: 'pending',
    syncError: null,
  });
  await addSyncEvent(projectId, 'info', 'queued', `Local change queued — pushing in ${delaySeconds}s unless more saves arrive.`, {
    files: merged,
  });

  return {
    projectId,
    notBefore: row?.not_before ? new Date(row.not_before).toISOString() : notBefore,
    delaySeconds,
    pendingFiles: merged.length,
  };
}

export interface SaveSyncDecision {
  applicable: boolean;
  scheduled: boolean;
  at: string | null;
  reason: string;
}

/**
 * Called after a successful local write. Everything that decides whether a push
 * should happen lives here, so the CRASH AND FIX save path and the file editor
 * behave identically.
 */
export async function afterLocalSave(projectId: string, paths: string[]): Promise<SaveSyncDecision> {
  const project = await requireProject(projectId);
  if (project.source !== 'github' || !project.githubOwner || !project.githubRepo) {
    return {
      applicable: false,
      scheduled: false,
      at: null,
      reason: 'This project was uploaded from a device, so there is no repository to push to.',
    };
  }
  if (!project.syncEnabled) {
    return { applicable: true, scheduled: false, at: null, reason: 'Synchronization is disabled for this project.' };
  }
  const connection = await getConnectionView().catch(() => null);
  if (!connection?.connected) {
    return {
      applicable: true,
      scheduled: false,
      at: null,
      reason: 'GitHub is not connected, so the change stays local until it is.',
    };
  }
  if (!connection.autoSync) {
    return {
      applicable: true,
      scheduled: false,
      at: null,
      reason: 'Automatic synchronization is switched off in Admin Settings — use Manual sync when you are ready.',
    };
  }
  const scheduled = await scheduleSync(projectId, paths, 'auto');
  return {
    applicable: true,
    scheduled: true,
    at: scheduled.notBefore,
    reason: `Queued for GitHub after ${scheduled.delaySeconds}s without further saves.`,
  };
}

export async function cancelScheduledSync(projectId: string): Promise<void> {
  await query(`delete from github_sync_jobs where project_id = $1 and status = 'pending'`, [projectId]);
  await updateProject(projectId, { syncStatus: 'idle' });
}

export interface SyncStateView {
  projectId: string;
  syncStatus: ProjectRecord['syncStatus'];
  syncError: string | null;
  lastSyncAt: string | null;
  lastCommitSha: string | null;
  lastCommitUrl: string | null;
  lastCommitMessage: string | null;
  branch: string | null;
  pending: { count: number; dueAt: string | null; files: string[] } | null;
  events: Array<{ id: number; level: string; phase: string | null; message: string; at: string }>;
}

export async function getSyncState(projectId: string): Promise<SyncStateView> {
  const project = await requireProject(projectId);
  const [job, dirty, events] = await Promise.all([
    queryOne<JobRow>(
      `select * from github_sync_jobs where project_id = $1 and status in ('pending','running') order by not_before asc limit 1`,
      [projectId],
    ),
    listDirtyFiles(projectId),
    listSyncEvents(projectId, 30),
  ]);
  return {
    projectId,
    syncStatus: project.syncStatus,
    syncError: project.syncError,
    lastSyncAt: project.lastSyncAt,
    lastCommitSha: project.lastCommitSha,
    lastCommitUrl: project.lastCommitUrl,
    lastCommitMessage: project.lastCommitMessage,
    branch: project.githubBranch,
    pending: job
      ? {
          count: dirty.length,
          dueAt: new Date(job.not_before).toISOString(),
          files: (job.files as string[]) ?? dirty.map((file) => file.path),
        }
      : dirty.length
        ? { count: dirty.length, dueAt: null, files: dirty.map((file) => file.path) }
        : null,
    events,
  };
}

/**
 * Commit message. An operator-supplied first line (Commit changes…) is kept
 * verbatim so the history stays readable and attributable; the file list is
 * always appended so a commit can be audited without opening it.
 */
function commitMessage(project: ProjectRecord, files: ProjectFileRecord[], custom?: string | null): string {
  const upserts = files.filter((file) => !file.pendingDelete);
  const deletes = files.filter((file) => file.pendingDelete);
  const list = [
    ...upserts.slice(0, 12).map((file) => `- ${file.path}`),
    ...deletes.slice(0, 6).map((file) => `- ${file.path} (deleted)`),
  ].join('\n');
  const shown = Math.min(upserts.length, 12) + Math.min(deletes.length, 6);
  const more = files.length > shown ? `\n- …and ${files.length - shown} more` : '';

  const subject = (custom ?? '').trim().split('\n')[0].slice(0, 120);
  if (subject) {
    return `${subject}\n\nDarknote: ${files.length} file${files.length === 1 ? '' : 's'} in ${project.name}\n\n${list}${more}`;
  }
  return `Darknote: synchronize ${project.name}\n\n${list}${more}\n\nPushed from the DARKNOTE console.`;
}

interface PushOutcome {
  commitSha: string;
  commitUrl: string;
  message: string;
  files: string[];
  deleted: string[];
  blobShas: Array<{ path: string; sha: string }>;
}

async function pushChanges(
  project: ProjectRecord,
  files: ProjectFileRecord[],
  client: GitHubClient,
  customMessage?: string | null,
): Promise<PushOutcome> {
  const owner = project.githubOwner!;
  const repo = project.githubRepo!;
  const branch = project.githubBranch || project.githubDefaultBranch;
  if (!branch) throw new SyncConflict('This project has no branch recorded.', 'sync_no_branch');

  await addSyncEvent(project.id, 'info', 'compare', '[+] Comparing repository changes...');

  const head = await client.getBranchHead(owner, repo, branch);
  const knownBase = project.baseCommitSha;
  const ours = project.lastPushedSha;

  if (knownBase && head.sha !== knownBase && head.sha !== ours) {
    throw new SyncConflict(
      `The remote branch moved: local copy is based on ${knownBase.slice(0, 7)} but ${branch} is now at ${head.sha.slice(0, 7)}. Nothing was pushed — review and resolve the conflict.`,
      'sync_remote_moved',
      { localBase: knownBase, remoteHead: head.sha, branch },
    );
  }

  const remoteCommit = await client.getCommit(owner, repo, head.sha);
  const remoteTree = await client.getTree(owner, repo, remoteCommit.tree.sha);
  const remoteShas = new Map(
    remoteTree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha] as const),
  );

  for (const file of files) {
    const remoteSha = remoteShas.get(file.path) ?? null;

    if (file.pendingDelete) {
      // Deleting a file somebody else edited after we recorded it is exactly the
      // silent-overwrite case this engine exists to prevent.
      if (file.remoteSha && remoteSha && file.remoteSha !== remoteSha) {
        throw new SyncConflict(
          `“${file.path}” was deleted here but changed on GitHub since the working copy was taken. Nothing was pushed — the remote file is untouched.`,
          'sync_delete_conflict',
          { file: file.path, expected: file.remoteSha, remote: remoteSha },
        );
      }
      continue;
    }

    if (file.remoteSha && remoteSha && file.remoteSha !== remoteSha) {
      throw new SyncConflict(
        `A file you edited was also changed on GitHub (its blob sha no longer matches). Nothing was pushed — the local edit is kept.`,
        'sync_file_conflict',
        { file: file.path, expected: file.remoteSha, remote: remoteSha },
      );
    }
    if (!file.remoteSha && remoteSha) {
      throw new SyncConflict(
        'A file that is new locally already exists on the remote branch. Nothing was pushed — resolve the conflict first.',
        'sync_file_conflict',
        { file: file.path, remote: remoteSha },
      );
    }
  }

  await addSyncEvent(project.id, 'info', 'commit', '[+] Creating GitHub commit...', {
    files: files.map((file) => file.path),
  });

  const blobShas: Array<{ path: string; sha: string }> = [];
  const deleted: string[] = [];
  for (const file of files) {
    if (file.pendingDelete) {
      // Only a path that really exists in the base tree can be removed; if it is
      // already gone remotely there is nothing to do and nothing to report.
      if (remoteShas.has(file.path)) deleted.push(file.path);
      continue;
    }
    if (file.content === null) {
      throw new SyncConflict(
        `The file “${file.path}” has no stored text copy, so it cannot be pushed.`,
        'sync_file_unavailable',
      );
    }
    const blob = await client.createBlob(owner, repo, file.content, 'utf-8');
    blobShas.push({ path: file.path, sha: blob.sha });
  }

  const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [
    ...blobShas.map((entry) => ({ path: entry.path, mode: '100644' as const, type: 'blob' as const, sha: entry.sha })),
    ...deleted.map((path) => ({ path, mode: '100644' as const, type: 'blob' as const, sha: null })),
  ];

  const tree = await client.createTree(owner, repo, {
    base_tree: remoteCommit.tree.sha,
    tree: treeEntries,
  });

  const message = commitMessage(project, files, customMessage);
  const commit = await client.createCommit(owner, repo, {
    message,
    tree: tree.sha,
    parents: [head.sha],
  });

  await addSyncEvent(project.id, 'info', 'push', '[+] Pushing changes...', { commit: commit.sha });

  try {
    await client.updateBranchRef(owner, repo, branch, commit.sha);
  } catch (error) {
    if (error instanceof GitHubError) {
      throw new SyncConflict(
        `GitHub refused the branch update (${error.status}). Nothing was overwritten; the local edit is kept. ${error.message}`,
        error.kind === 'validation' ? 'sync_non_fast_forward' : 'sync_push_rejected',
        { status: error.status },
      );
    }
    throw error;
  }

  // A ref update is the only proof of a push. Read it back before reporting
  // success, then confirm the content of the files we touched (bounded).
  const verified = await client.getBranchHead(owner, repo, branch);
  if (verified.sha !== commit.sha) {
    throw new SyncConflict(
      'GitHub accepted the ref update but the branch does not point at the new commit. The push is not confirmed.',
      'sync_unverified',
      { expected: commit.sha, actual: verified.sha },
    );
  }

  for (const entry of blobShas.slice(0, 5)) {
    const remote = await client.getContentSha(owner, repo, entry.path, branch);
    if (remote && remote !== entry.sha) {
      throw new SyncConflict(
        'The commit landed but GitHub reports different content for an updated file. Treat this push as unverified.',
        'sync_content_mismatch',
        { file: entry.path, expected: entry.sha, actual: remote },
      );
    }
  }

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    message,
    files: files.filter((file) => !file.pendingDelete).map((file) => file.path),
    deleted,
    blobShas,
  };
}

async function failJob(
  job: JobRow,
  projectId: string,
  message: string,
  status: 'failed' | 'conflict',
  code: string,
): Promise<void> {
  await query(
    `update github_sync_jobs set status = $2, last_error = $3, updated_at = now(), finished_at = now() where id = $1`,
    [job.id, status, message],
  );
  await updateProject(projectId, { syncStatus: status === 'conflict' ? 'conflict' : 'failed', syncError: message });
  await addSyncEvent(projectId, status === 'conflict' ? 'warn' : 'error', status, `[!] ${message}`, { code });
}

export async function processJob(job: JobRow): Promise<void> {
  const project = await getProject(job.project_id);
  if (!project) {
    await query(
      `update github_sync_jobs set status = 'failed', last_error = 'project removed', finished_at = now() where id = $1`,
      [job.id],
    );
    return;
  }

  if (!project.syncEnabled) {
    await failJob(job, project.id, 'Synchronization is disabled for this project.', 'failed', 'sync_disabled');
    return;
  }

  await updateProject(project.id, { syncStatus: 'syncing', syncError: null });
  await addSyncEvent(project.id, 'info', 'detected', '[+] LOCAL CHANGES DETECTED');
  await addSyncEvent(project.id, 'info', 'prepare', '[+] Preparing GitHub synchronization...');

  try {
    const token = await requireToken();
    const client = new GitHubClient(token);
    const dirty = await listDirtyFiles(project.id);
    const pushable = dirty.filter((file) => !file.pendingDelete && file.content !== null);
    const deletions = dirty.filter((file) => file.pendingDelete);
    if (!pushable.length && !deletions.length) {
      await query(
        `update github_sync_jobs set status = 'succeeded', updated_at = now(), finished_at = now() where id = $1`,
        [job.id],
      );
      await updateProject(project.id, { syncStatus: 'idle', syncError: null });
      await addSyncEvent(project.id, 'info', 'noop', 'Nothing to synchronize — no changed text files.', {});
      return;
    }

    const outcome = await pushChanges(project, [...pushable, ...deletions], client, job.message);

    if (outcome.blobShas.length)
      await setRemoteShas(
        project.id,
        outcome.blobShas.map((entry) => ({ path: entry.path, remoteSha: entry.sha })),
      );
    await markFilesClean(project.id, pushable.map((file) => file.id));
    await purgeDeletedFiles(project.id, outcome.deleted);
    await updateProject(project.id, {
      baseCommitSha: outcome.commitSha,
      lastPushedSha: outcome.commitSha,
      lastCommitSha: outcome.commitSha,
      lastCommitUrl: outcome.commitUrl,
      lastCommitMessage: outcome.message.split('\n')[0],
      lastSyncAt: new Date().toISOString(),
      syncStatus: 'synced',
      syncError: null,
    });
    await query(
      `update github_sync_jobs set status = 'succeeded', last_error = null, updated_at = now(), finished_at = now() where id = $1`,
      [job.id],
    );
    await addSyncEvent(
      project.id,
      'success',
      'done',
      '[+] GITHUB SYNCHRONIZED SUCCESSFULLY',
      {
        commit: outcome.commitSha,
        files: outcome.files.length,
        deleted: outcome.deleted.length,
        url: outcome.commitUrl,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SyncConflict ? 'conflict' : 'failed';
    const code = error instanceof SyncConflict ? error.code : 'sync_failed';
    await failJob(job, project.id, message, status, code);
  }
}

let running = false;

/** Claims due jobs one at a time. Safe to call from a timer and from HTTP. */
export async function runDueSyncJobs(limit = 2): Promise<{ processed: number }> {
  if (running) return { processed: 0 };
  running = true;
  let processed = 0;
  try {
    for (let index = 0; index < limit; index += 1) {
      const job = await queryOne<JobRow>(
        `update github_sync_jobs set status = 'running', attempts = attempts + 1, updated_at = now()
          where id = (
            select id from github_sync_jobs
             where status = 'pending' and not_before <= now()
             order by not_before asc limit 1
          )
          returning *`,
      );
      if (!job) break;
      await processJob(job);
      processed += 1;
    }
  } finally {
    running = false;
  }
  return { processed };
}

/** Manual sync: push now, ignoring the debounce window. */
export async function syncProjectNow(
  projectId: string,
  trigger: 'manual' | 'retry' = 'manual',
  message: string | null = null,
): Promise<SyncStateView> {
  const project = await requireProject(projectId);
  if (project.source !== 'github' || !project.githubOwner || !project.githubRepo) {
    throw new ApiError('That project is not connected to a GitHub repository.', 400, 'project_not_github');
  }
  const connection = await getConnectionView();
  if (!connection.connected) {
    throw new ApiError('GitHub is not connected. Add a token in Admin Settings → GitHub Connection.', 424, 'github_not_connected');
  }

  // Claim the pending job if there is one (it already knows which files are
  // waiting); otherwise open a fresh one so a manual push always runs now.
  const job =
    (await queryOne<JobRow>(
      `update github_sync_jobs set status = 'running', attempts = attempts + 1, updated_at = now(), trigger = $2,
              message = coalesce($3, message)
        where project_id = $1 and status = 'pending'
        returning *`,
      [projectId, trigger, message],
    )) ??
    (await queryOne<JobRow>(
      `insert into github_sync_jobs (id, project_id, status, not_before, attempts, files, trigger, message)
       values ($1,$2,'running',now(),1,'[]'::jsonb,$3,$4)
       returning *`,
      [uuid(), projectId, trigger, message],
    ));
  if (job) await processJob(job);
  return getSyncState(projectId);
}

export interface ConflictResolution {
  projectId: string;
  mode: 'merge-remote' | 'discard-local';
  message: string;
}

/**
 * Conflict resolution that never silently overwrites either side:
 *  - `merge-remote` adopts the remote head as the new base and pushes the local
 *    files on top of it (only the paths we changed are written);
 *  - `discard-local` re-reads the affected files from GitHub and drops the local
 *    edits.
 */
export async function resolveConflict(
  projectId: string,
  mode: 'merge-remote' | 'discard-local',
): Promise<{ message: string; sync: SyncStateView }> {
  const project = await requireProject(projectId);
  if (project.source !== 'github' || !project.githubOwner || !project.githubRepo) {
    throw new ApiError('That project is not connected to a GitHub repository.', 400, 'project_not_github');
  }
  const token = await requireToken();
  const client = new GitHubClient(token);
  const owner = project.githubOwner;
  const repo = project.githubRepo;
  const branch = project.githubBranch || project.githubDefaultBranch;
  if (!branch) throw new ApiError('This project has no branch recorded.', 400, 'sync_no_branch');

  const head = await client.getBranchHead(owner, repo, branch);
  const commit = await client.getCommit(owner, repo, head.sha);
  const tree = await client.getTree(owner, repo, commit.tree.sha);

  if (mode === 'merge-remote') {
    await updateProject(projectId, {
      baseCommitSha: head.sha,
      syncStatus: 'pending',
      syncError: null,
    });
    for (const dirty of await listDirtyFiles(projectId)) {
      const remote = tree.tree.find((entry) => entry.type === 'blob' && entry.path === dirty.path);
      await query(`update imported_project_files set remote_sha = $3, updated_at = now() where project_id = $1 and id = $2`, [
        projectId,
        dirty.id,
        remote?.sha ?? null,
      ]);
    }
    await addSyncEvent(projectId, 'warn', 'resolve', `Rebased the working copy onto ${branch}@${head.sha.slice(0, 7)}. Local files will be pushed on top.`);
    const sync = await syncProjectNow(projectId, 'retry');
    return { message: 'Rebased onto the remote branch and pushed the local changes.', sync };
  }

  // discard-local
  const dirty = await listDirtyFiles(projectId);
  let restored = 0;
  for (const file of dirty) {
    const entry = tree.tree.find((item) => item.type === 'blob' && item.path === file.path);
    if (!entry) continue;
    const blob = await client.getBlob(owner, repo, entry.sha);
    const buffer =
      blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64') : Buffer.from(blob.content, 'utf8');
    let text: string | null = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (text.includes('\u0000')) text = null;
    } catch {
      text = null;
    }
    if (text === null) continue;
    await writeProjectFile({
      projectId,
      fileId: file.id,
      content: text,
      expectedSha: file.sha256,
      markDirty: false,
    });
    await query(`update imported_project_files set remote_sha = $3 where project_id = $1 and id = $2`, [
      projectId,
      file.id,
      entry.sha,
    ]);
    restored += 1;
  }
  await query(`delete from github_sync_jobs where project_id = $1 and status = 'pending'`, [projectId]);
  await updateProject(projectId, {
    baseCommitSha: head.sha,
    syncStatus: 'idle',
    syncError: null,
  });
  await addSyncEvent(projectId, 'warn', 'resolve', `Discarded local edits for ${restored} file(s) and re-read them from ${branch}@${head.sha.slice(0, 7)}.`);
  return { message: `Restored ${restored} file(s) from the remote branch.`, sync: await getSyncState(projectId) };
}
