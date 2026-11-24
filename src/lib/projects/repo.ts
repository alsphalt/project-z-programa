import 'server-only';
import { ApiError } from '../api';
import { jsonb, parseJsonb, query, queryOne, withTransaction } from '../db';
import { sha256, uuid } from '../crypto';

/**
 * Storage for imported projects.
 *
 * A project is a working copy of someone else's repository (or an uploaded
 * archive) kept in PostgreSQL. Nothing is executed, and nothing is written to the
 * serverless filesystem: the panel owns the rows, GitHub owns the origin.
 */

export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  source: 'github' | 'upload';
  sourceLabel: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  githubBranch: string | null;
  githubDefaultBranch: string | null;
  githubPrivate: boolean;
  baseCommitSha: string | null;
  lastPushedSha: string | null;
  lastCommitSha: string | null;
  lastCommitUrl: string | null;
  lastCommitMessage: string | null;
  syncEnabled: boolean;
  syncStatus: 'idle' | 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict' | 'disabled';
  syncError: string | null;
  lastSyncAt: string | null;
  status: 'importing' | 'ready' | 'import_failed' | 'removed';
  statusMessage: string | null;
  fileCount: number;
  textFileCount: number;
  totalBytes: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFileRecord {
  id: string;
  projectId: string;
  path: string;
  name: string;
  extension: string | null;
  sizeBytes: number;
  sha256: string | null;
  content: string | null;
  isText: boolean;
  contentOmitted: boolean;
  remoteSha: string | null;
  dirty: boolean;
  /** Removed in the console; the next push deletes it on GitHub. */
  pendingDelete: boolean;
  changedAt: string | null;
}

export interface NewProjectFile {
  path: string;
  sizeBytes: number;
  sha256: string | null;
  content: string | null;
  isText: boolean;
  contentOmitted: boolean;
  remoteSha: string | null;
}

type Row = Record<string, unknown>;

function mapProject(row: Row): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: (row.description as string) ?? null,
    source: row.source as 'github' | 'upload',
    sourceLabel: (row.source_label as string) ?? null,
    githubOwner: (row.github_owner as string) ?? null,
    githubRepo: (row.github_repo as string) ?? null,
    githubBranch: (row.github_branch as string) ?? null,
    githubDefaultBranch: (row.github_default_branch as string) ?? null,
    githubPrivate: Boolean(row.github_private),
    baseCommitSha: (row.base_commit_sha as string) ?? null,
    lastPushedSha: (row.last_pushed_sha as string) ?? null,
    lastCommitSha: (row.last_commit_sha as string) ?? null,
    lastCommitUrl: (row.last_commit_url as string) ?? null,
    lastCommitMessage: (row.last_commit_message as string) ?? null,
    syncEnabled: row.sync_enabled === undefined ? true : Boolean(row.sync_enabled),
    syncStatus: (row.sync_status as ProjectRecord['syncStatus']) ?? 'idle',
    syncError: (row.sync_error as string) ?? null,
    lastSyncAt: (row.last_sync_at as string) ?? null,
    status: (row.status as ProjectRecord['status']) ?? 'ready',
    statusMessage: (row.status_message as string) ?? null,
    fileCount: Number(row.file_count ?? 0),
    textFileCount: Number(row.text_file_count ?? 0),
    totalBytes: Number(row.total_bytes ?? 0),
    createdBy: (row.created_by as string) ?? null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

function mapFile(row: Row): ProjectFileRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    path: String(row.path),
    name: String(row.name),
    extension: (row.extension as string) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    sha256: (row.sha256 as string) ?? null,
    content: (row.content as string) ?? null,
    isText: row.is_text === undefined ? true : Boolean(row.is_text),
    contentOmitted: Boolean(row.content_omitted),
    remoteSha: (row.remote_sha as string) ?? null,
    dirty: Boolean(row.dirty),
    pendingDelete: Boolean(row.pending_delete),
    changedAt: (row.changed_at as string) ?? null,
  };
}

export function projectNameFromPath(path: string): string {
  const trimmed = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const withoutExtension = trimmed.replace(/\.[a-z0-9]+$/i, '');
  return (withoutExtension || trimmed || 'imported-project').slice(0, 80);
}

export function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function extensionOf(path: string): string {
  const name = baseNameOf(path).toLowerCase();
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const rows = await query<Row>(
    `select * from imported_projects where status <> 'removed' order by created_at desc`,
  );
  return rows.map(mapProject);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const row = await queryOne<Row>(`select * from imported_projects where id = $1 and status <> 'removed'`, [id]);
  return row ? mapProject(row) : null;
}

export async function requireProject(id: string): Promise<ProjectRecord> {
  const project = await getProject(id);
  if (!project) throw new ApiError('That imported project does not exist (it may have been removed).', 404, 'project_not_found');
  return project;
}

export async function findProjectByRepo(owner: string, repo: string, branch: string | null): Promise<ProjectRecord | null> {
  const row = await queryOne<Row>(
    `select * from imported_projects
      where lower(github_owner) = lower($1) and lower(github_repo) = lower($2)
        and lower(coalesce(github_branch, '')) = lower($3) and status <> 'removed'
      limit 1`,
    [owner, repo, branch ?? ''],
  );
  return row ? mapProject(row) : null;
}

export async function createProject(input: {
  name: string;
  description?: string | null;
  source: 'github' | 'upload';
  sourceLabel?: string | null;
  github?: {
    owner: string;
    repo: string;
    branch: string;
    defaultBranch: string;
    private: boolean;
    commitSha: string;
  } | null;
  createdBy?: string | null;
  status?: ProjectRecord['status'];
  statusMessage?: string | null;
}): Promise<ProjectRecord> {
  const row = await queryOne<Row>(
    `insert into imported_projects (
       id, name, description, source, source_label,
       github_owner, github_repo, github_branch, github_default_branch, github_private, base_commit_sha,
       sync_enabled, sync_status, status, status_message, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [
      uuid(),
      input.name,
      input.description ?? null,
      input.source,
      input.sourceLabel ?? null,
      input.github?.owner ?? null,
      input.github?.repo ?? null,
      input.github?.branch ?? null,
      input.github?.defaultBranch ?? null,
      input.github?.private ?? false,
      input.github?.commitSha ?? null,
      Boolean(input.github),
      input.github ? 'pending' : 'idle',
      input.status ?? 'ready',
      input.statusMessage ?? null,
      input.createdBy ?? null,
    ],
  );
  if (!row) throw new ApiError('Could not create the imported project.', 500, 'project_create_failed');
  return mapProject(row);
}

export async function updateProject(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    syncEnabled: boolean;
    syncStatus: ProjectRecord['syncStatus'];
    syncError: string | null;
    lastSyncAt: string | null;
    lastCommitSha: string | null;
    lastCommitUrl: string | null;
    lastCommitMessage: string | null;
    baseCommitSha: string | null;
    lastPushedSha: string | null;
    status: ProjectRecord['status'];
    statusMessage: string | null;
    githubBranch: string | null;
  }>,
): Promise<ProjectRecord> {
  const mapping: Record<string, string> = {
    name: 'name',
    description: 'description',
    syncEnabled: 'sync_enabled',
    syncStatus: 'sync_status',
    syncError: 'sync_error',
    lastSyncAt: 'last_sync_at',
    lastCommitSha: 'last_commit_sha',
    lastCommitUrl: 'last_commit_url',
    lastCommitMessage: 'last_commit_message',
    baseCommitSha: 'base_commit_sha',
    lastPushedSha: 'last_pushed_sha',
    status: 'status',
    statusMessage: 'status_message',
    githubBranch: 'github_branch',
  };
  const sets: string[] = [];
  const params: Array<string | number | boolean | null> = [];
  for (const [key, column] of Object.entries(mapping)) {
    if (!(key in patch)) continue;
    params.push((patch as Record<string, unknown>)[key] as string | number | boolean | null);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return requireProject(id);
  params.push(id);
  const row = await queryOne<Row>(
    `update imported_projects set ${sets.join(', ')}, updated_at = now() where id = $${params.length} returning *`,
    params,
  );
  if (!row) throw new ApiError('That imported project no longer exists.', 404, 'project_not_found');
  return mapProject(row);
}

/** Deletes the working copy. The GitHub repository is never touched. */
export async function removeProject(id: string): Promise<void> {
  await requireProject(id);
  await withTransaction(async (connection) => {
    await connection.query(`delete from github_sync_jobs where project_id = $1`, [id]);
    await connection.query(`delete from project_import_jobs where project_id = $1`, [id]);
    await connection.query(
      `update imported_projects set status = 'removed', updated_at = now() where id = $1`,
      [id],
    );
  });
}

export async function replaceProjectFiles(projectId: string, files: NewProjectFile[]): Promise<void> {
  for (let index = 0; index < files.length; index += 40) {
    const chunk = files.slice(index, index + 40);
    await withTransaction(async (connection) => {
      const values: string[] = [];
      const params: Array<string | number | boolean | null> = [];
      chunk.forEach((file) => {
        const offset = params.length;
        values.push(
          `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10})`,
        );
        params.push(
          uuid(),
          projectId,
          file.path,
          baseNameOf(file.path),
          extensionOf(file.path),
          file.sizeBytes,
          file.sha256,
          file.content,
          file.isText,
          file.remoteSha,
        );
      });
      await connection.query(
        `insert into imported_project_files (id, project_id, path, name, extension, size_bytes, sha256, content, is_text, remote_sha)
         values ${values.join(',')}
         on conflict (project_id, path) do update set
           name = excluded.name, extension = excluded.extension, size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256, content = excluded.content, is_text = excluded.is_text,
           remote_sha = excluded.remote_sha, content_omitted = false, dirty = false,
           changed_at = null, updated_at = now()`,
        params,
      );
    });
  }
  await refreshStats(projectId);
}

export async function clearProjectFiles(projectId: string): Promise<void> {
  await query(`delete from imported_project_files where project_id = $1`, [projectId]);
}

export async function listProjectFiles(
  projectId: string,
  options: { withContent?: boolean } = {},
): Promise<ProjectFileRecord[]> {
  const columns = options.withContent
    ? '*'
    : 'id, project_id, path, name, extension, size_bytes, sha256, null::text as content, is_text, content_omitted, remote_sha, dirty, changed_at';
  const rows = await query<Row>(
    `select ${columns} from imported_project_files where project_id = $1 order by path asc`,
    [projectId],
  );
  return rows.map(mapFile);
}

/** Text files that the case scanner can parse. */
export async function listScriptFiles(projectId: string | null): Promise<ProjectFileRecord[]> {
  const rows = await query<Row>(
    `select id, project_id, path, name, extension, size_bytes, sha256, content, is_text, content_omitted, remote_sha, dirty, changed_at
       from imported_project_files
      where is_text = true and content is not null and content_omitted = false
        and (extension in ('js','cjs','mjs','jsx') ${projectId ? 'and project_id = $1' : ''})
      order by project_id asc, path asc`,
    projectId ? [projectId] : [],
  );
  return rows.map(mapFile);
}

export async function getProjectFile(projectId: string, fileId: string): Promise<ProjectFileRecord> {
  const row = await queryOne<Row>(
    `select * from imported_project_files where project_id = $1 and id = $2`,
    [projectId, fileId],
  );
  if (!row) throw new ApiError('That file is not part of the imported project.', 404, 'project_file_not_found');
  return mapFile(row);
}

export async function getProjectFileByPath(projectId: string, path: string): Promise<ProjectFileRecord | null> {
  const row = await queryOne<Row>(
    `select * from imported_project_files where project_id = $1 and path = $2`,
    [projectId, path],
  );
  return row ? mapFile(row) : null;
}

export async function listDirtyFiles(projectId: string): Promise<ProjectFileRecord[]> {
  const rows = await query<Row>(
    `select * from imported_project_files where project_id = $1 and dirty = true order by path asc`,
    [projectId],
  );
  return rows.map(mapFile);
}

/**
 * Content write. The `and sha256 = $expected` guard is what makes a concurrent
 * edit impossible: if the row changed since it was read, zero rows come back and
 * the caller raises a conflict instead of overwriting someone else's save.
 */
export async function writeProjectFile(options: {
  projectId: string;
  fileId: string;
  content: string;
  expectedSha?: string | null;
  markDirty?: boolean;
}): Promise<{ file: ProjectFileRecord; previousSha: string | null }> {
  const current = await getProjectFile(options.projectId, options.fileId);
  const nextSha = sha256(options.content);
  const bytes = Buffer.byteLength(options.content, 'utf8');
  const guard = options.expectedSha ?? null;

  const row = await queryOne<Row>(
    `update imported_project_files set
       content = $1, sha256 = $2, size_bytes = $3, is_text = true, content_omitted = false,
       dirty = $4, changed_at = case when $4 then now() else changed_at end, updated_at = now()
     where project_id = $5 and id = $6 ${guard ? 'and sha256 = $7' : ''}
     returning *`,
    guard
      ? [options.content, nextSha, bytes, options.markDirty !== false, options.projectId, options.fileId, guard]
      : [options.content, nextSha, bytes, options.markDirty !== false, options.projectId, options.fileId],
  );

  if (!row) {
    throw new ApiError(
      'This file changed since you loaded it. Reload it and apply your edit again — nothing was overwritten.',
      409,
      'project_file_changed',
    );
  }
  await refreshStats(options.projectId);
  return { file: mapFile(row), previousSha: current.sha256 };
}

/**
 * Write a working-copy row from an outside source (a live panel file that the
 * File Manager just saved, or a blob read back from GitHub).
 *
 * `dirty: false` means "record this as the new base without queueing a push" —
 * used after a pull, so the file is not immediately pushed back.
 */
export async function upsertProjectFile(options: {
  projectId: string;
  path: string;
  content: string | null;
  sizeBytes: number;
  sha256: string | null;
  remoteSha: string | null;
  dirty: boolean;
  pendingDelete?: boolean;
}): Promise<{ file: ProjectFileRecord; changed: boolean }> {
  const existing = await getProjectFileByPath(options.projectId, options.path);
  const pendingDelete = options.pendingDelete ?? false;
  const changed = !existing || existing.content !== options.content || existing.pendingDelete !== pendingDelete;

  if (!existing) {
    const row = await queryOne<Row>(
      `insert into imported_project_files
         (id, project_id, path, name, extension, size_bytes, sha256, content, is_text, content_omitted,
          remote_sha, dirty, pending_delete, changed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12,case when $11 then now() else null end)
       returning *`,
      [
        uuid(),
        options.projectId,
        options.path,
        baseNameOf(options.path),
        extensionOf(options.path) || null,
        options.sizeBytes,
        options.sha256,
        options.content,
        options.content === null,
        options.remoteSha,
        options.dirty,
        pendingDelete,
      ],
    );
    if (!row) throw new ApiError('Could not store the file in the working copy.', 500, 'file_upsert_failed');
    await refreshStats(options.projectId);
    return { file: mapFile(row), changed: true };
  }

  if (!options.dirty) {
    // Base update only: keep the content the working copy already holds unless
    // the caller supplied new bytes.
    const row = await queryOne<Row>(
      `update imported_project_files
          set content = coalesce($2, content),
              sha256 = coalesce($3, sha256),
              size_bytes = case when $2 is null then size_bytes else $4 end,
              remote_sha = coalesce($5, remote_sha),
              pending_delete = false,
              dirty = false,
              changed_at = null,
              updated_at = now()
        where project_id = $1 and id = $6
        returning *`,
      [options.projectId, options.content, options.sha256, options.sizeBytes, options.remoteSha, existing.id],
    );
    if (!row) throw new ApiError('Could not update the working copy.', 500, 'file_upsert_failed');
    return { file: mapFile(row), changed };
  }

  const row = await queryOne<Row>(
    `update imported_project_files
        set content = $2, sha256 = $3, size_bytes = $4, is_text = $5, content_omitted = $6,
            remote_sha = coalesce($7, remote_sha), dirty = true, pending_delete = $8,
            changed_at = now(), updated_at = now()
      where project_id = $1 and id = $9
      returning *`,
    [
      options.projectId,
      options.content,
      options.sha256,
      options.sizeBytes,
      options.content !== null,
      options.content === null,
      options.remoteSha,
      pendingDelete,
      existing.id,
    ],
  );
  if (!row) throw new ApiError('Could not update the working copy.', 500, 'file_upsert_failed');
  await refreshStats(options.projectId);
  return { file: mapFile(row), changed };
}

/**
 * Record a local deletion.
 *
 * The row survives (`pending_delete`) until the commit that removes the file
 * lands: if the push fails or conflicts, the fact that the file was deleted is
 * not lost, and the operator can still see what is waiting.
 */
export async function markProjectFileDeleted(options: {
  projectId: string;
  path: string;
  remoteSha: string | null;
}): Promise<boolean> {
  const existing = await getProjectFileByPath(options.projectId, options.path);
  if (!existing) {
    const row = await queryOne<Row>(
      `insert into imported_project_files
         (id, project_id, path, name, extension, size_bytes, sha256, content, is_text, content_omitted,
          remote_sha, dirty, pending_delete, changed_at)
       values ($1,$2,$3,$4,$5,0,null,null,true,true,$6,true,true,now())
       returning *`,
      [
        uuid(),
        options.projectId,
        options.path,
        baseNameOf(options.path),
        extensionOf(options.path) || null,
        options.remoteSha,
      ],
    );
    return Boolean(row);
  }
  if (existing.pendingDelete) return false;
  await query(
    `update imported_project_files
        set pending_delete = true, dirty = true, changed_at = now(), updated_at = now()
      where project_id = $1 and id = $2`,
    [options.projectId, existing.id],
  );
  return true;
}

/**
 * Record the deletion of a path *and everything under it*.
 *
 * FILE MANAGER can delete a folder, and the working copy only tracks files. This
 * marks every tracked descendant so the push removes them from the repository
 * instead of silently leaving them behind.
 */
export async function markProjectTreeDeleted(options: {
  projectId: string;
  path: string;
  remoteSha: string | null;
}): Promise<number> {
  const rows = await query<Row>(
    `select id, path, remote_sha from imported_project_files
      where project_id = $1 and (path = $2 or path like $3) and pending_delete = false`,
    [options.projectId, options.path, `${options.path}/%`],
  );
  if (!rows.length) {
    const inserted = await markProjectFileDeleted({
      projectId: options.projectId,
      path: options.path,
      remoteSha: options.remoteSha,
    });
    return inserted ? 1 : 0;
  }
  for (const row of rows) {
    await query(
      `update imported_project_files
          set pending_delete = true, dirty = true, changed_at = now(), updated_at = now()
        where project_id = $1 and id = $2`,
      [options.projectId, String(row.id)],
    );
  }
  await refreshStats(options.projectId);
  return rows.length;
}

/** Drop the tombstones whose deletion is now committed on GitHub. */
export async function purgeDeletedFiles(projectId: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const placeholders = paths.map((_, index) => `$${index + 2}`).join(',');
  await query(
    `delete from imported_project_files where project_id = $1 and pending_delete = true and path in (${placeholders})`,
    [projectId, ...paths],
  );
  await refreshStats(projectId);
}

export async function markFilesClean(projectId: string, fileIds: string[]): Promise<void> {
  if (!fileIds.length) return;
  const placeholders = fileIds.map((_, index) => `$${index + 2}`).join(',');
  await query(
    `update imported_project_files set dirty = false, changed_at = null, updated_at = now()
      where project_id = $1 and id in (${placeholders})`,
    [projectId, ...fileIds],
  );
}

export async function setRemoteShas(projectId: string, entries: Array<{ path: string; remoteSha: string }>): Promise<void> {
  for (const entry of entries) {
    await query(
      `update imported_project_files set remote_sha = $3, updated_at = now()
        where project_id = $1 and path = $2`,
      [projectId, entry.path, entry.remoteSha],
    );
  }
}

export async function refreshStats(projectId: string): Promise<void> {
  await query(
    `update imported_projects set
       file_count = (select count(*) from imported_project_files where project_id = $1),
       text_file_count = (select count(*) from imported_project_files where project_id = $1 and is_text = true and content is not null),
       total_bytes = (select coalesce(sum(size_bytes), 0) from imported_project_files where project_id = $1),
       updated_at = now()
     where id = $1`,
    [projectId],
  );
}

export async function addSyncEvent(
  projectId: string,
  level: 'info' | 'success' | 'error' | 'warn',
  phase: string,
  message: string,
  detail?: unknown,
): Promise<void> {
  await query(
    `insert into github_sync_events (project_id, level, phase, message, detail) values ($1,$2,$3,$4,$5)`,
    [projectId, level, phase, message, jsonb(detail ?? {})],
  );
}

export async function listSyncEvents(
  projectId: string,
  limit = 40,
): Promise<Array<{ id: number; level: string; phase: string | null; message: string; at: string }>> {
  const rows = await query<Row>(
    `select id, level, phase, message, created_at from github_sync_events
      where project_id = $1 order by id desc limit $2`,
    [projectId, limit],
  );
  return rows
    .map((row) => ({
      id: Number(row.id),
      level: String(row.level),
      phase: (row.phase as string) ?? null,
      message: String(row.message),
      at: String(row.created_at),
    }))
    .reverse();
}

export interface ProjectSummary extends ProjectRecord {
  pendingChanges: number;
  pendingSince: string | null;
  lastSyncedFiles: number;
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  const projects = await listProjects();
  if (!projects.length) return [];
  // `= any(string_to_array(...))` keeps the parameter a plain string, which both
  // the pg pool and the embedded PGlite driver bind without array coercion.
  const rows = await query<Row>(
    `select project_id,
            count(*) filter (where dirty) as pending,
            max(changed_at) filter (where dirty) as pending_since
       from imported_project_files
      where project_id = any(string_to_array($1, ','))
      group by project_id`,
    [projects.map((project) => project.id).join(',')],
  );
  const byProject = new Map(rows.map((row) => [String(row.project_id), row]));
  return projects.map((project) => {
    const row = byProject.get(project.id);
    return {
      ...project,
      pendingChanges: Number(row?.pending ?? 0),
      pendingSince: (row?.pending_since as string) ?? null,
      lastSyncedFiles: 0,
    };
  });
}

export function parseDetail(value: unknown): Record<string, unknown> {
  return parseJsonb<Record<string, unknown>>(value, {});
}

/** Paths only: used by import finalisation to find stale rows without loading contents. */
export async function listProjectFilePaths(projectId: string): Promise<string[]> {
  const rows = await query<{ path: string }>(
    `select path from imported_project_files where project_id = $1 order by path asc`,
    [projectId],
  );
  return rows.map((row) => row.path);
}

/**
 * Bulk upsert for batched imports.
 *
 * Sequential on purpose: a batch is small (tens of files), and one statement per
 * file keeps the existing change detection (`changed`) and the dirty-flag rules
 * in exactly one place.
 */
export async function upsertProjectFiles(
  projectId: string,
  files: Array<{
    path: string;
    content: string | null;
    sizeBytes: number;
    sha256: string | null;
    remoteSha: string | null;
  }>,
): Promise<number> {
  let written = 0;
  for (const file of files) {
    await upsertProjectFile({
      projectId,
      path: file.path,
      content: file.content,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      remoteSha: file.remoteSha,
      dirty: false,
      pendingDelete: false,
    });
    written += 1;
  }
  return written;
}
