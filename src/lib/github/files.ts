import 'server-only';
import { ApiError } from '../api';
import { sha256 } from '../crypto';
import { fetchRemoteFile, writeProductionFile, editorLimitFor } from '../files/service';
import { confineToRoot, isExcluded, isProbablyBinary, isSecretPath, DEFAULT_EXCLUDED_PATHS } from '../security/paths';
import type { ServerRecord } from '../servers/repo';
import { requireServer } from '../servers/repo';
import {
  getProjectFileByPath,
  listDirtyFiles,
  markProjectTreeDeleted,
  requireProject,
  updateProject,
  upsertProjectFile,
  listSyncEvents,
  type ProjectRecord,
} from '../projects/repo';
import { getConnectionView, requireClient } from './credentials';
import type { GitHubClient } from './client';
import { getBinding, requireBinding } from './bindings';
import { getSyncState, scheduleSync, syncProjectNow, type SyncStateView } from './sync';
import { isInsidePrefix, repoPathToServerPath, serverPathToRepoPath } from './paths';

/**
 * The bridge between a live Pterodactyl filesystem and the GitHub engine.
 *
 * FILE MANAGER and the CODE EDITOR already read and write real panel files. This
 * module turns those file writes into entries in the *existing* working copy and
 * lets the *existing* queue push them — it does not talk to GitHub on its own
 * except to read the remote tree it must compare against.
 *
 * Two properties matter and are enforced here:
 *  1. A change is recorded before it is pushed. If the push fails or conflicts,
 *     the pending file is still known and still visible.
 *  2. A path is mapped through the same prefix rules that the UI displays, and a
 *     path that escapes the prefix/root is refused instead of guessed.
 */

const MAX_PATHS_PER_CALL = 200;
const MAX_IMPORT_FILES = 120;
const MAX_IMPORT_BYTES = 384 * 1024;

export interface ServerSyncView {
  serverId: string;
  bound: boolean;
  connection: {
    connected: boolean;
    accountLogin: string | null;
    repository: string | null;
    branch: string | null;
    autoSync: boolean;
    syncDelaySeconds: number;
    reason: string | null;
  };
  binding: { id: string; pathPrefix: string; autoSync: boolean; projectId: string } | null;
  project: {
    id: string;
    name: string;
    repo: string | null;
    branch: string | null;
    syncStatus: string;
    syncError: string | null;
    lastSyncAt: string | null;
    lastCommitSha: string | null;
    lastCommitUrl: string | null;
    lastCommitMessage: string | null;
    pendingFiles: number;
  } | null;
  pending: SyncStateView['pending'];
  events: SyncStateView['events'];
  limits: { maxPathsPerCall: number; maxImportFiles: number };
}

export async function serverSyncView(serverId: string): Promise<ServerSyncView> {
  await requireServer(serverId);
  const connection = await getConnectionView();
  const binding = await getBinding(serverId);

  const base: ServerSyncView = {
    serverId,
    bound: Boolean(binding),
    connection: {
      connected: connection.connected,
      accountLogin: connection.account?.login ?? null,
      repository: connection.repository
        ? `${connection.repository.owner}/${connection.repository.name}`
        : null,
      branch: connection.repository?.branch ?? null,
      autoSync: connection.autoSync,
      syncDelaySeconds: connection.syncDelaySeconds,
      reason: connection.connected ? null : 'GitHub is not connected.',
    },
    binding: binding
      ? { id: binding.id, pathPrefix: binding.pathPrefix, autoSync: binding.autoSync, projectId: binding.projectId }
      : null,
    project: null,
    pending: null,
    events: [],
    limits: { maxPathsPerCall: MAX_PATHS_PER_CALL, maxImportFiles: MAX_IMPORT_FILES },
  };

  if (!binding) return base;

  const project = await requireProject(binding.projectId).catch(() => null);
  if (!project) {
    return { ...base, bound: false, connection: { ...base.connection, reason: 'The bound repository no longer exists.' } };
  }

  const [state, dirty] = await Promise.all([getSyncState(project.id), listDirtyFiles(project.id)]);
  return {
    ...base,
    project: {
      id: project.id,
      name: project.name,
      repo: project.githubOwner && project.githubRepo ? `${project.githubOwner}/${project.githubRepo}` : null,
      branch: project.githubBranch ?? project.githubDefaultBranch,
      syncStatus: project.syncStatus,
      syncError: project.syncError,
      lastSyncAt: project.lastSyncAt,
      lastCommitSha: project.lastCommitSha,
      lastCommitUrl: project.lastCommitUrl,
      lastCommitMessage: project.lastCommitMessage,
      pendingFiles: dirty.length,
    },
    pending: state.pending,
    events: state.events,
  };
}

interface RemoteState {
  headSha: string;
  treeSha: string;
  blobs: Map<string, string>;
}

/** The remote tree is read at most once per call, and only when it is needed. */
class RemoteReader {
  private cache: RemoteState | null = null;
  constructor(
    private readonly client: GitHubClient,
    private readonly project: ProjectRecord,
  ) {}

  private get coordinates(): { owner: string; repo: string; branch: string } {
    const owner = this.project.githubOwner;
    const repo = this.project.githubRepo;
    const branch = this.project.githubBranch || this.project.githubDefaultBranch;
    if (!owner || !repo || !branch) {
      throw new ApiError('The working copy has no repository or branch recorded.', 409, 'project_not_github');
    }
    return { owner, repo, branch };
  }

  async state(): Promise<RemoteState> {
    if (this.cache) return this.cache;
    const { owner, repo, branch } = this.coordinates;
    const head = await this.client.getBranchHead(owner, repo, branch);
    const commit = await this.client.getCommit(owner, repo, head.sha);
    const tree = await this.client.getTree(owner, repo, commit.tree.sha);
    const blobs = new Map<string, string>();
    for (const entry of tree.tree) {
      if (entry.type === 'blob') blobs.set(entry.path, entry.sha);
    }
    this.cache = { headSha: head.sha, treeSha: commit.tree.sha, blobs };
    return this.cache;
  }

  async blob(path: string): Promise<string | null> {
    const { owner, repo } = this.coordinates;
    const state = await this.state();
    const sha = state.blobs.get(path);
    if (!sha) return null;
    const blob = await this.client.getBlob(owner, repo, sha);
    const buffer =
      blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64') : Buffer.from(blob.content, 'utf8');
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return text.includes('\u0000') ? null : text;
    } catch {
      return null;
    }
  }
}

export type ChangeMode = 'auto' | 'now' | 'none';

export interface RecordedChange {
  detected: number;
  skipped: Array<{ path: string; reason: string }>;
  scheduled: { at: string | null; delaySeconds: number } | null;
  pushed: boolean;
  reason: string;
  sync: SyncStateView;
}

/**
 * Record local panel changes in the working copy and let the shared queue push
 * them.
 *
 * `mode: 'auto'` honours the debounce (5 s of inactivity → one commit, provided
 * automatic synchronization is on). `'now'` pushes immediately — that is the
 * explicit "Push to GitHub" / "Save and push" button. `'none'` only marks the
 * files so the status panel can show them without sending anything.
 */
export async function recordServerChanges(options: {
  serverId: string;
  paths: string[];
  deletes?: string[];
  mode?: ChangeMode;
  message?: string | null;
  userId?: string | null;
}): Promise<RecordedChange> {
  const { binding, project, server } = await requireBinding(options.serverId);
  const connection = await getConnectionView();

  const paths = Array.from(new Set(options.paths.filter(Boolean))).slice(0, MAX_PATHS_PER_CALL);
  const deletes = Array.from(new Set((options.deletes ?? []).filter(Boolean))).slice(0, MAX_PATHS_PER_CALL);
  if (!paths.length && !deletes.length) {
    throw new ApiError('Select at least one file to synchronize.', 400, 'no_paths');
  }

  const skipped: Array<{ path: string; reason: string }> = [];
  const repoPaths: string[] = [];
  let detected = 0;

  const client = connection.connected ? await requireClient() : null;
  const reader = client ? new RemoteReader(client, project) : null;

  for (const path of paths) {
    if (isSecretPath(path)) {
      skipped.push({ path, reason: 'Credential/session files are never pushed to GitHub.' });
      continue;
    }
    if (isProbablyBinary(path)) {
      skipped.push({ path, reason: 'Binary files are not pushed as text.' });
      continue;
    }

    let repoPath: string;
    try {
      repoPath = serverPathToRepoPath({ prefix: binding.pathPrefix, projectRoot: server.projectRoot, serverPath: path });
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    let content: string;
    try {
      const snapshot = await fetchRemoteFile(server, path, { maxBytes: editorLimitFor(server) });
      content = snapshot.content;
    } catch (error) {
      skipped.push({ path, reason: `Could not read the file from the panel: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    const existing = await getProjectFileByPath(project.id, repoPath);
    const baseSha = existing?.remoteSha ?? (reader ? (await reader.state()).blobs.get(repoPath) ?? null : null);
    const nextSha = sha256(content);
    const bytes = Buffer.byteLength(content, 'utf8');

    if (existing && existing.sha256 === nextSha && !existing.pendingDelete && !existing.dirty) {
      // Identical to what is already recorded: nothing to synchronize.
      skipped.push({ path, reason: 'No change since the last synchronization.' });
      continue;
    }

    await upsertProjectFile({
      projectId: project.id,
      path: repoPath,
      content,
      sizeBytes: bytes,
      sha256: nextSha,
      remoteSha: baseSha,
      dirty: true,
      pendingDelete: false,
    });
    repoPaths.push(repoPath);
    detected += 1;
  }

  for (const path of deletes) {
    let repoPath: string;
    try {
      repoPath = serverPathToRepoPath({ prefix: binding.pathPrefix, projectRoot: server.projectRoot, serverPath: path });
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const existing = await getProjectFileByPath(project.id, repoPath);
    const baseSha = existing?.remoteSha ?? (reader ? (await reader.state()).blobs.get(repoPath) ?? null : null);
    if (!baseSha && !existing) {
      skipped.push({ path, reason: 'That file does not exist on GitHub or in the working copy, so there is nothing to delete.' });
      continue;
    }
    // A deleted folder marks every tracked file below it.
    const marked = await markProjectTreeDeleted({ projectId: project.id, path: repoPath, remoteSha: baseSha });
    if (marked) {
      repoPaths.push(repoPath);
      detected += marked;
    }
  }

  // Adopt the remote head as the base when the working copy has none, so the
  // very first push from this server compares against something real.
  if (reader && !project.baseCommitSha) {
    const state = await reader.state().catch(() => null);
    if (state) await updateProject(project.id, { baseCommitSha: state.headSha });
  }

  const mode = options.mode ?? 'auto';
  let scheduled: RecordedChange['scheduled'] = null;
  let pushed = false;
  let reason: string;

  if (!detected) {
    reason = skipped.length ? skipped[0].reason : 'Nothing changed.';
    await updateProject(project.id, { syncStatus: 'idle' }).catch(() => undefined);
  } else if (mode === 'none') {
    reason = `${detected} file${detected === 1 ? '' : 's'} marked for the next push.`;
    await updateProject(project.id, { syncStatus: 'pending' });
  } else if (mode === 'now') {
    await updateProject(project.id, { syncStatus: 'pending' });
    pushed = true;
    reason = 'Pushing to GitHub now.';
  } else if (!connection.connected) {
    reason = 'Saved locally. GitHub is not connected, so nothing was pushed.';
    await updateProject(project.id, { syncStatus: 'pending' });
  } else if (!connection.autoSync || !binding.autoSync) {
    reason = 'Saved locally. Automatic synchronization is off — use Push to GitHub when you are ready.';
    await updateProject(project.id, { syncStatus: 'pending' });
  } else {
    const queued = await scheduleSync(project.id, repoPaths, 'auto', options.message ?? null);
    scheduled = { at: queued.notBefore, delaySeconds: queued.delaySeconds };
    reason = `Queued for GitHub in ${queued.delaySeconds}s unless another save arrives.`;
  }

  if (pushed) {
    await syncProjectNow(project.id, 'manual', options.message ?? null);
  }

  return {
    detected,
    skipped,
    scheduled,
    pushed,
    reason,
    sync: await getSyncState(project.id),
  };
}

export interface PulledFile {
  path: string;
  repoPath: string;
  bytes: number;
  hash: string;
}

export interface PullResult {
  restored: PulledFile[];
  skipped: Array<{ path: string; reason: string }>;
  commit: string | null;
}

/**
 * Pull the current remote content of specific files onto the panel.
 *
 * Media and credential paths are refused, an expected hash (when the caller
 * sends the one the editor is displaying) turns a concurrent panel edit into a
 * refusal instead of an overwrite, and every write goes through the normal
 * backup + version + read-back path.
 */
export async function pullServerPaths(options: {
  serverId: string;
  paths: string[];
  expectedHashes?: Record<string, string | null | undefined>;
  userId?: string | null;
}): Promise<PullResult> {
  const { binding, project, server } = await requireBinding(options.serverId);
  const client = await requireClient();
  const reader = new RemoteReader(client, project);

  const restored: PulledFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const paths = Array.from(new Set(options.paths.filter(Boolean))).slice(0, MAX_PATHS_PER_CALL);
  if (!paths.length) throw new ApiError('Select at least one file to pull.', 400, 'no_paths');

  for (const path of paths) {
    if (isSecretPath(path)) {
      skipped.push({ path, reason: 'Credential/session files are never overwritten from a repository.' });
      continue;
    }
    if (isProbablyBinary(path)) {
      skipped.push({ path, reason: 'Binary files cannot be replaced from GitHub here.' });
      continue;
    }

    let repoPath: string;
    try {
      repoPath = serverPathToRepoPath({ prefix: binding.pathPrefix, projectRoot: server.projectRoot, serverPath: path });
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const text = await reader.blob(repoPath);
    if (text === null) {
      skipped.push({ path, reason: `“${repoPath}” does not exist on the remote branch (or is not text).` });
      continue;
    }

    try {
      const written = await writeProductionFile({
        server,
        path,
        content: text,
        expectedHash: options.expectedHashes?.[path] ?? null,
        note: `Pulled ${repoPath} from GitHub`,
        userId: options.userId ?? null,
      });
      const state = await reader.state();
      await upsertProjectFile({
        projectId: project.id,
        path: repoPath,
        content: text,
        sizeBytes: Buffer.byteLength(text, 'utf8'),
        sha256: sha256(text),
        remoteSha: state.blobs.get(repoPath) ?? null,
        dirty: false,
        pendingDelete: false,
      });
      restored.push({ path, repoPath, bytes: Buffer.byteLength(text, 'utf8'), hash: written.hash });
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const state = await reader.state().catch(() => null);
  if (state) await updateProject(project.id, { baseCommitSha: state.headSha, syncError: null });
  await updateProject(project.id, {
    syncStatus: (await listDirtyFiles(project.id)).length ? 'pending' : 'idle',
  });

  return { restored, skipped, commit: state?.headSha ?? null };
}

export interface ImportResult {
  imported: PulledFile[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; reason: string }>;
  truncated: boolean;
  repo: string;
  branch: string;
}

/**
 * Import files from a repository into a panel folder.
 *
 * This is the File Manager's "Import from GitHub". It writes real files through
 * the normal write path (backup, read-back hash, version), skips credentials,
 * binary and excluded directories, and stops at a bounded number of files so a
 * huge repository cannot hold the request open indefinitely.
 */
export async function importRepoToPanel(options: {
  serverId: string;
  owner?: string | null;
  repo?: string | null;
  branch?: string | null;
  repoPrefix?: string | null;
  destination?: string | null;
  limit?: number;
  userId?: string | null;
}): Promise<ImportResult> {
  const server = await requireServer(options.serverId);
  const connection = await getConnectionView();
  if (!connection.connected) {
    throw new ApiError('GitHub is not connected. Configure it in Admin Settings → GitHub.', 424, 'github_not_connected');
  }
  const client = await requireClient();

  const owner = options.owner ?? connection.repository?.owner;
  const repo = options.repo ?? connection.repository?.name;
  const branch = options.branch ?? connection.repository?.branch;
  if (!owner || !repo) {
    throw new ApiError('Choose a repository to import from.', 400, 'repository_required');
  }

  const head = await client.getBranchHead(owner, repo, branch || '');
  const commit = await client.getCommit(owner, repo, head.sha);
  const tree = await client.getTree(owner, repo, commit.tree.sha);
  if (tree.truncated) {
    throw new ApiError(
      'GitHub returned a truncated file tree for that repository, so a partial import was refused. Import from a narrower folder.',
      422,
      'tree_truncated',
    );
  }

  const prefix = (options.repoPrefix ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const destination = options.destination ?? '/';
  const limit = Math.min(Math.max(options.limit ?? 40, 1), MAX_IMPORT_FILES);

  const candidates = tree.tree
    .filter((entry) => entry.type === 'blob')
    .filter((entry) => (prefix ? entry.path === prefix || entry.path.startsWith(`${prefix}/`) : true))
    .filter((entry) => isInsidePrefix(prefix, entry.path));

  const skipped: Array<{ path: string; reason: string }> = [];
  const failed: Array<{ path: string; reason: string }> = [];
  const imported: PulledFile[] = [];
  let truncated = false;

  for (const entry of candidates) {
    if (imported.length >= limit) {
      truncated = true;
      break;
    }
    if (isProbablyBinary(entry.path)) {
      skipped.push({ path: entry.path, reason: 'Binary file' });
      continue;
    }
    if (isExcluded(entry.path, DEFAULT_EXCLUDED_PATHS)) {
      skipped.push({ path: entry.path, reason: 'Excluded directory (dependencies, build output, sessions)' });
      continue;
    }
    if (entry.size !== undefined && entry.size > MAX_IMPORT_BYTES) {
      skipped.push({ path: entry.path, reason: 'Larger than the 384 KB text limit' });
      continue;
    }

    const relative = prefix ? entry.path.slice(prefix.length).replace(/^\//, '') : entry.path;
    if (!relative) continue;

    let target: string;
    try {
      target = confineToRoot(server.projectRoot, `${destination.replace(/\/+$/, '')}/${relative}`);
    } catch (error) {
      failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (isSecretPath(target)) {
      skipped.push({ path: entry.path, reason: 'Credential path' });
      continue;
    }

    const blob = await client.getBlob(owner, repo, entry.sha);
    const buffer = blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64') : Buffer.from(blob.content, 'utf8');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      skipped.push({ path: entry.path, reason: 'Not valid UTF-8 text' });
      continue;
    }
    if (text.includes('\u0000')) {
      skipped.push({ path: entry.path, reason: 'Binary content' });
      continue;
    }

    try {
      const written = await writeProductionFile({
        server,
        path: target,
        content: text,
        note: `Imported ${entry.path} from ${owner}/${repo}`,
        userId: options.userId ?? null,
      });
      imported.push({ path: target, repoPath: entry.path, bytes: buffer.length, hash: written.hash });

      // If this repository is also the bound working copy, record the file as
      // clean with its real remote sha — the import is not a local change.
      const binding = await getBinding(options.serverId);
      if (binding) {
        const project = await requireProject(binding.projectId).catch(() => null);
        if (
          project &&
          project.githubOwner?.toLowerCase() === owner.toLowerCase() &&
          project.githubRepo?.toLowerCase() === repo.toLowerCase() &&
          (project.githubBranch ?? project.githubDefaultBranch) === (branch || project.githubDefaultBranch)
        ) {
          await upsertProjectFile({
            projectId: project.id,
            path: entry.path,
            content: text,
            sizeBytes: buffer.length,
            sha256: sha256(text),
            remoteSha: entry.sha,
            dirty: false,
            pendingDelete: false,
          }).catch(() => undefined);
        }
      }
    } catch (error) {
      failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { imported, skipped, failed, truncated, repo: `${owner}/${repo}`, branch: branch ?? '' };
}

/** Cheap sanity check used by the API before scheduling work. */
export async function assertServerBound(serverId: string): Promise<{ projectId: string; pathPrefix: string }> {
  const binding = await requireBinding(serverId);
  return { projectId: binding.project.id, pathPrefix: binding.binding.pathPrefix };
}

/** Utility for tests and diagnostics: how many files are waiting, and what. */
export async function pendingServerFiles(serverId: string): Promise<{ path: string; pendingDelete: boolean }[]> {
  const binding = await getBinding(serverId);
  if (!binding) return [];
  const files = await listDirtyFiles(binding.projectId);
  return files.map((file) => ({ path: file.path, pendingDelete: file.pendingDelete }));
}

/** Repository-side existence check used by the editor's "Pull latest". */
export async function remoteFileExists(options: {
  serverId: string;
  path: string;
}): Promise<{ exists: boolean; repoPath: string; serverPath: string }> {
  const { binding, project, server } = await requireBinding(options.serverId);
  const repoPath = serverPathToRepoPath({
    prefix: binding.pathPrefix,
    projectRoot: server.projectRoot,
    serverPath: options.path,
  });
  const client = await requireClient();
  const head = await client.getBranchHead(
    project.githubOwner ?? '',
    project.githubRepo ?? '',
    project.githubBranch || project.githubDefaultBranch || '',
  );
  const sha = await client.getContentSha(
    project.githubOwner ?? '',
    project.githubRepo ?? '',
    repoPath,
    project.githubBranch || project.githubDefaultBranch || head.sha,
  );
  return {
    exists: Boolean(sha),
    repoPath,
    serverPath: repoPathToServerPath({ prefix: binding.pathPrefix, projectRoot: server.projectRoot, repoPath }),
  };
}
