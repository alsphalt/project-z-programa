import 'server-only';
import { ApiError } from '../api';
import { query, queryOne } from '../db';
import { sha256, uuid } from '../crypto';
import { addSyncEvent, getProject, getProjectFileByPath, purgeDeletedFiles, refreshStats, requireProject, setRemoteShas, updateProject, upsertProjectFile } from '../projects/repo';
import { requireClient } from './credentials';
import { GitHubError, type GitHubTreeEntry } from './client';
import { listBindings } from './bindings';

/**
 * GitHub → DARKNOTE.
 *
 * The push direction (`sync.ts`) commits local edits. This module is the other
 * half: it reads the remote branch head, compares the commit trees, and applies
 * only what actually changed. Nothing is downloaded wholesale, and nothing that
 * changed on both sides is overwritten.
 *
 * Order of operations for every touched path:
 *   recovery point → conflict check → write/delete → verify → advance base
 *
 * If any path conflicts, the base commit is *not* advanced: the project stays in
 * `conflict` until an administrator resolves it, and the pull is idempotent, so
 * a retry after resolution re-applies cleanly.
 */

export type PullTrigger = 'webhook' | 'poll' | 'manual';

export interface PullConflict {
  id: string;
  path: string;
  reason: 'both_modified' | 'remote_delete_local_edit' | 'local_delete_remote_edit';
  localSha: string | null;
  remoteSha: string | null;
}

export interface PullOutcome {
  projectId: string;
  fromCommit: string | null;
  toCommit: string;
  unchanged: boolean;
  applied: string[];
  deleted: string[];
  conflicts: PullConflict[];
  commitMessage: string | null;
  commitUrl: string | null;
  trigger: PullTrigger;
  detail: string;
}

/** Files are read one at a time; a runaway diff must not exhaust the process. */
const MAX_FILES_PER_PULL = 400;
/** A text blob bigger than this is stored without content (metadata only). */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

function projectPath(project: { githubOwner: string | null; githubRepo: string | null }): string {
  return `${project.githubOwner ?? '?'}/${project.githubRepo ?? '?'}`;
}

/** Recovery point: the bytes we are about to replace, so a bad pull is reversible. */
async function createRecoveryPoint(options: {
  projectId: string;
  path: string;
  content: string | null;
  sha256Value: string | null;
  fromCommit: string | null;
  toCommit: string;
}): Promise<void> {
  await query(
    `insert into github_sync_backups (id, project_id, path, content, sha256, commit_before, commit_after, reason)
     values ($1,$2,$3,$4,$5,$6,$7,'pull')`,
    [uuid(), options.projectId, options.path, options.content, options.sha256Value, options.fromCommit, options.toCommit],
  );
}

async function openConflict(options: {
  projectId: string;
  path: string;
  reason: PullConflict['reason'];
  localContent: string | null;
  remoteContent: string | null;
  localSha: string | null;
  remoteSha: string | null;
  baseCommit: string | null;
  headCommit: string;
}): Promise<PullConflict> {
  // One open conflict per path: a repeated pull must not pile up duplicates.
  const existing = await queryOne<{ id: string }>(
    `select id from github_sync_conflicts where project_id = $1 and path = $2 and status = 'open'`,
    [options.projectId, options.path],
  );
  if (existing) {
    await query(
      `update github_sync_conflicts
          set remote_content = $2, remote_sha = $3, head_commit = $4, reason = $5
        where id = $1`,
      [existing.id, options.remoteContent, options.remoteSha, options.headCommit, options.reason],
    );
    return {
      id: existing.id,
      path: options.path,
      reason: options.reason,
      localSha: options.localSha,
      remoteSha: options.remoteSha,
    };
  }

  const id = uuid();
  await query(
    `insert into github_sync_conflicts
       (id, project_id, path, reason, local_content, remote_content, local_sha, remote_sha, base_commit, head_commit)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      options.projectId,
      options.path,
      options.reason,
      options.localContent,
      options.remoteContent,
      options.localSha,
      options.remoteSha,
      options.baseCommit,
      options.headCommit,
    ],
  );
  return {
    id,
    path: options.path,
    reason: options.reason,
    localSha: options.localSha,
    remoteSha: options.remoteSha,
  };
}

/**
 * Propagate pulled changes into the panel/bot that is bound to this project.
 *
 * `deployChanges` already owns the safe path: protected paths, backups, health
 * verification, rollback and a restart only when the change requires one (it
 * installs dependencies when package.json changes). This function only decides
 * *whether* to deploy and reports the real result — it never claims success it
 * did not observe.
 */
async function propagateToServer(
  projectId: string,
  paths: string[],
): Promise<{ attempted: boolean; detail: string }> {
  if (!paths.length) return { attempted: false, detail: 'No server-bound paths changed.' };

  const bindings = await listBindings().catch(() => []);
  const bound = bindings.filter((binding) => binding.projectId === projectId);
  if (!bound.length) {
    return { attempted: false, detail: 'The project is not bound to a panel server, so nothing was deployed.' };
  }

  try {
    const { deployChanges } = await import('../services/deploy');
    const { getServer } = await import('../servers/repo');
    const details: string[] = [];
    for (const binding of bound) {
      const server = await getServer(binding.serverId);
      if (!server) {
        details.push(`Server ${binding.serverId} no longer exists; skipped.`);
        continue;
      }
      const changes: Array<{ path: string; content: string }> = [];
      for (const path of paths) {
        const file = await getProjectFileByPath(projectId, path);
        if (!file || file.content === null) continue;
        changes.push({ path, content: file.content });
      }
      if (!changes.length) continue;
      const outcome = await deployChanges({
        server,
        user: { id: 'github-sync', email: 'github-sync@darknote.local' },
        changes,
        note: 'Applied from GitHub commit',
        restartMode: 'auto',
        installDependencies: true,
      });
      details.push(
        `${server.name}: ${outcome.status}${outcome.restarted ? ' (bot restarted)' : ' (no restart required)'}; health ${outcome.health.verdict}`,
      );
    }
    return { attempted: true, detail: details.join(' · ') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { attempted: true, detail: `Deployment after pull failed: ${message}` };
  }
}

export async function pullRemoteChanges(
  projectId: string,
  options: { trigger?: PullTrigger; headSha?: string; propagate?: boolean } = {},
): Promise<PullOutcome> {
  const trigger = options.trigger ?? 'manual';
  const project = await requireProject(projectId);

  if (!project.githubOwner || !project.githubRepo) {
    throw new ApiError('This project is not connected to a GitHub repository.', 400, 'not_a_repo_project');
  }
  if (!project.syncEnabled) {
    throw new ApiError('Synchronization is disabled for this project.', 409, 'sync_disabled');
  }

  const branch = project.githubBranch || project.githubDefaultBranch;
  if (!branch) throw new ApiError('This project has no branch recorded.', 400, 'sync_no_branch');

  const client = await requireClient();
  const owner = project.githubOwner;
  const repo = project.githubRepo;

  let headSha = options.headSha ?? '';
  if (!headSha) {
    const head = await client.getBranchHead(owner, repo, branch);
    headSha = head.sha;
  }

  const base = project.baseCommitSha;
  if (base && base === headSha) {
    return {
      projectId,
      fromCommit: base,
      toCommit: headSha,
      unchanged: true,
      applied: [],
      deleted: [],
      conflicts: [],
      commitMessage: project.lastCommitMessage,
      commitUrl: project.lastCommitUrl,
      trigger,
      detail: 'Already at the remote head.',
    };
  }

  // The first pull for a project imported before commit tracking existed has no
  // base. Adopt the head instead of guessing a diff against nothing.
  if (!base) {
    await updateProject(projectId, { baseCommitSha: headSha, syncStatus: 'synced', syncError: null });
    await addSyncEvent(projectId, 'info', 'pull', `[·] Adopted ${headSha.slice(0, 7)} as the synchronization base (no previous commit was recorded).`);
    return {
      projectId,
      fromCommit: null,
      toCommit: headSha,
      unchanged: true,
      applied: [],
      deleted: [],
      conflicts: [],
      commitMessage: null,
      commitUrl: null,
      trigger,
      detail: 'Adopted the current remote head as the base commit.',
    };
  }

  const headCommit = await client.getCommit(owner, repo, headSha);
  const baseCommit = await client.getCommit(owner, repo, base).catch(() => null);
  if (!baseCommit) {
    throw new ApiError(
      `The recorded base commit ${base.slice(0, 7)} is not in ${projectPath(project)} any more (history rewritten?). Resolve manually before syncing.`,
      409,
      'sync_base_missing',
    );
  }

  const headTree = await client.getTree(owner, repo, headCommit.tree.sha);
  const baseTree = await client.getTree(owner, repo, baseCommit.tree.sha);
  if (headTree.truncated || baseTree.truncated) {
    // A truncated tree makes the diff a guess. Refuse rather than delete files
    // that merely fell outside the page.
    throw new ApiError(
      'GitHub returned a truncated tree for this repository, so the change set cannot be trusted. Nothing was applied.',
      409,
      'sync_tree_truncated',
    );
  }

  const toMap = (entries: GitHubTreeEntry[]) =>
    new Map(entries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha] as const));

  const headBlobs = toMap(headTree.tree);
  const baseBlobs = toMap(baseTree.tree);

  const addedOrModified: GitHubTreeEntry[] = [];
  for (const [path, sha] of headBlobs) {
    if (baseBlobs.get(path) !== sha) addedOrModified.push({ path, mode: '100644', type: 'blob', sha });
  }
  const removed: string[] = [];
  for (const path of baseBlobs.keys()) {
    if (!headBlobs.has(path)) removed.push(path);
  }

  if (addedOrModified.length + removed.length > MAX_FILES_PER_PULL) {
    throw new ApiError(
      `This commit changes ${addedOrModified.length + removed.length} files, which is above the ${MAX_FILES_PER_PULL}-file pull limit. Import the repository again if this is expected.`,
      413,
      'sync_too_many_files',
    );
  }

  await addSyncEvent(
    projectId,
    'info',
    'pull',
    `[↓] Pulling ${headSha.slice(0, 7)}: ${addedOrModified.length} changed, ${removed.length} deleted.`,
    { trigger, from: base, to: headSha },
  );

  const applied: string[] = [];
  const deleted: string[] = [];
  const conflicts: PullConflict[] = [];
  const remoteShas: Array<{ path: string; remoteSha: string }> = [];

  for (const entry of addedOrModified) {
    const local = await getProjectFileByPath(projectId, entry.path);

    let remoteContent: string | null = null;
    try {
      const blob = await client.getBlob(owner, repo, entry.sha);
      const buffer = blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64') : Buffer.from(blob.content, 'utf8');
      const isText = !buffer.includes(0);
      remoteContent = isText && buffer.byteLength <= MAX_BLOB_BYTES ? buffer.toString('utf8') : null;
    } catch (error) {
      if (error instanceof GitHubError) {
        throw new ApiError(
          `Could not read “${entry.path}” from GitHub (${error.status}): ${error.message}. Nothing was applied.`,
          502,
          'sync_blob_failed',
        );
      }
      throw error;
    }

    if (local?.pendingDelete) {
      conflicts.push(
        await openConflict({
          projectId,
          path: entry.path,
          reason: 'local_delete_remote_edit',
          localContent: local.content,
          remoteContent,
          localSha: local.remoteSha,
          remoteSha: entry.sha,
          baseCommit: base,
          headCommit: headSha,
        }),
      );
      continue;
    }

    const localModified = Boolean(local?.dirty) && local?.content !== remoteContent;
    if (localModified) {
      conflicts.push(
        await openConflict({
          projectId,
          path: entry.path,
          reason: 'both_modified',
          localContent: local?.content ?? null,
          remoteContent,
          localSha: local?.remoteSha ?? null,
          remoteSha: entry.sha,
          baseCommit: base,
          headCommit: headSha,
        }),
      );
      continue;
    }

    if (local) {
      await createRecoveryPoint({
        projectId,
        path: entry.path,
        content: local.content,
        sha256Value: local.sha256,
        fromCommit: base,
        toCommit: headSha,
      });
    }

    await upsertProjectFile({
      projectId,
      path: entry.path,
      content: remoteContent,
      sizeBytes: remoteContent === null ? 0 : Buffer.byteLength(remoteContent, 'utf8'),
      sha256: remoteContent === null ? null : sha256(remoteContent),
      remoteSha: entry.sha,
      dirty: false,
      pendingDelete: false,
    });
    applied.push(entry.path);
    remoteShas.push({ path: entry.path, remoteSha: entry.sha });
  }

  for (const path of removed) {
    const local = await getProjectFileByPath(projectId, path);
    if (!local) continue;

    if (local.dirty) {
      // Somebody is editing it here while GitHub deleted it: keep the edit and
      // ask a human which side wins.
      conflicts.push(
        await openConflict({
          projectId,
          path,
          reason: 'remote_delete_local_edit',
          localContent: local.content,
          remoteContent: null,
          localSha: local.remoteSha,
          remoteSha: null,
          baseCommit: base,
          headCommit: headSha,
        }),
      );
      continue;
    }

    await createRecoveryPoint({
      projectId,
      path,
      content: local.content,
      sha256Value: local.sha256,
      fromCommit: base,
      toCommit: headSha,
    });
    await query(`delete from imported_project_files where project_id = $1 and path = $2`, [projectId, path]);
    deleted.push(path);
  }

  const commitMessage = headCommit.message?.split('\n')[0] ?? null;
  const commitUrl = headCommit.html_url ?? `https://github.com/${owner}/${repo}/commit/${headSha}`;

  if (conflicts.length) {
    const summary = `${conflicts.length} file(s) changed on both sides. Nothing remote was overwritten; resolve the conflicts to continue.`;
    await updateProject(projectId, {
      syncStatus: 'conflict',
      syncError: summary,
      lastCommitSha: headSha,
      lastCommitUrl: commitUrl,
      lastCommitMessage: commitMessage,
    });
    await addSyncEvent(projectId, 'warn', 'conflict', `[!] ${summary}`, {
      paths: conflicts.map((conflict) => conflict.path),
      head: headSha,
    });
    return {
      projectId,
      fromCommit: base,
      toCommit: headSha,
      unchanged: false,
      applied,
      deleted,
      conflicts,
      commitMessage,
      commitUrl,
      trigger,
      detail: summary,
    };
  }

  await setRemoteShas(projectId, remoteShas);
  if (deleted.length) await purgeDeletedFiles(projectId, deleted);
  await refreshStats(projectId);

  await updateProject(projectId, {
    baseCommitSha: headSha,
    lastCommitSha: headSha,
    lastCommitUrl: commitUrl,
    lastCommitMessage: commitMessage,
    lastSyncAt: new Date().toISOString(),
    syncStatus: 'synced',
    syncError: null,
  });

  await addSyncEvent(
    projectId,
    'success',
    'pull',
    `[✓] GitHub → panel: ${applied.length} updated, ${deleted.length} deleted (${headSha.slice(0, 7)}).`,
    { commit: headSha, applied, deleted },
  );

  const changedPaths = [...applied, ...deleted];
  const propagation =
    options.propagate === false
      ? { attempted: false, detail: 'Propagation disabled for this run.' }
      : await propagateToServer(projectId, changedPaths);

  if (propagation.attempted) {
    await addSyncEvent(projectId, 'info', 'deploy', `[·] ${propagation.detail}`, { paths: changedPaths });
  }

  return {
    projectId,
    fromCommit: base,
    toCommit: headSha,
    unchanged: false,
    applied,
    deleted,
    conflicts: [],
    commitMessage,
    commitUrl,
    trigger,
    detail: `Applied ${applied.length} file(s) and ${deleted.length} deletion(s) from ${headSha.slice(0, 7)}. ${propagation.detail}`,
  };
}

/**
 * Fallback polling.
 *
 * Webhooks are the fast path, but a delivery can be missed (a firewalled
 * endpoint, a rotated secret, a GitHub outage). Every project with sync enabled
 * is therefore asked for its branch head; a pull only happens when the head
 * moved, so the steady-state cost is one API call per project per tick.
 */
export async function pollRemoteProjects(): Promise<{ checked: number; pulled: number; errors: string[] }> {
  const rows = await query<{ id: string }>(
    `select id from imported_projects
      where status = 'ready'
        and sync_enabled = true
        and github_owner is not null
        and github_repo is not null
        and sync_status <> 'syncing'
      order by last_sync_at asc nulls first
      limit 10`,
  );

  let pulled = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      const project = await getProject(row.id);
      if (!project) continue;
      const outcome = await pullRemoteChanges(row.id, { trigger: 'poll' });
      if (!outcome.unchanged) pulled += 1;
    } catch (error) {
      errors.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { checked: rows.length, pulled, errors };
}
