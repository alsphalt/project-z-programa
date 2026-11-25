import 'server-only';
import { unzipSync } from 'fflate';
import { ApiError } from '../api';
import { sha256, uuid } from '../crypto';
import { jsonb, queryOne } from '../db';
import { isProbablyBinary, isSecretPath } from '../security/paths';
import { GitHubClient } from '../github/client';
import { requireClient } from '../github/credentials';
import * as repo from './repo';

/**
 * Project import: device uploads and GitHub repositories.
 *
 * Safety rules that apply to both paths:
 *  - paths are normalised and refused when absolute, containing `..` or NUL;
 *  - credential-shaped paths (.env, auth/, sessions/, keys) are never stored;
 *  - dependency and build folders are skipped;
 *  - text is stored for editing up to MAX_TEXT_FILE_BYTES, everything else is
 *    recorded with its metadata (and its git blob sha) but never rewritten;
 *  - nothing is executed.
 */

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PROJECT_FILES = 4000;
export const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
export const MAX_GITHUB_FILES = 2000;
/** Files written per batched import request; keeps one request short and resumable. */
export const IMPORT_BATCH_SIZE = 20;

const SKIP_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  'vendor',
  '.turbo',
  '.vercel',
  '__pycache__',
]);

export interface ImportSummary {
  files: number;
  textFiles: number;
  skipped: number;
  bytes: number;
  branch?: string;
  commitSha?: string;
  truncated?: boolean;
  note?: string;
}

interface PreparedFile extends repo.NewProjectFile {
  path: string;
}

function decodeUtf8(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return text;
  } catch {
    return null;
  }
}

/** Rejects anything that could escape the project root once written. */
export function normalizeArchivePath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, '/').trim();
  if (!normalized || normalized.endsWith('/')) return null;
  if (normalized.includes('\0')) return null;
  if (/^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.startsWith('/')) return null;
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (!segments.length) return null;
  if (segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

function isSkippedPath(path: string): boolean {
  return path
    .toLowerCase()
    .split('/')
    .slice(0, -1)
    .some((segment) => SKIP_SEGMENTS.has(segment));
}

/** A single wrapping folder (`myproject/src/...`) is stripped, nothing else. */
export function stripCommonRoot(paths: string[]): { root: string | null; strip: boolean } {
  if (!paths.length) return { root: null, strip: false };
  const first = paths[0].split('/')[0];
  if (!first) return { root: null, strip: false };
  const every = paths.every((path) => path.split('/').length > 1 && path.split('/')[0] === first);
  return { root: first, strip: every };
}

export function prepareFile(path: string, data: Buffer, remoteSha: string | null = null): PreparedFile | null {
  if (isSkippedPath(path)) return null;
  if (isSecretPath(path)) return null;

  const size = data.byteLength;
  const looksBinary = isProbablyBinary(path);
  const decoded = looksBinary ? null : decodeUtf8(data);

  if (decoded === null) {
    return {
      path,
      sizeBytes: size,
      sha256: sha256(data),
      content: null,
      isText: false,
      contentOmitted: true,
      remoteSha,
    };
  }

  if (size > MAX_TEXT_FILE_BYTES) {
    return {
      path,
      sizeBytes: size,
      sha256: sha256(data),
      content: null,
      isText: true,
      contentOmitted: true,
      remoteSha,
    };
  }

  return {
    path,
    sizeBytes: size,
    sha256: sha256(decoded),
    content: decoded,
    isText: true,
    contentOmitted: false,
    remoteSha,
  };
}

// ---------------------------------------------------------------- import jobs

export interface ImportJobRecord {
  id: string;
  projectId: string | null;
  source: 'github' | 'upload';
  status: 'running' | 'succeeded' | 'failed';
  phase: string | null;
  totalFiles: number;
  fetchedFiles: number;
  totalBytes: number;
  skippedFiles: number;
  message: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

type JobRow = Record<string, unknown>;

function mapJob(row: JobRow): ImportJobRecord {
  return {
    id: String(row.id),
    projectId: (row.project_id as string) ?? null,
    source: row.source as 'github' | 'upload',
    status: (row.status as ImportJobRecord['status']) ?? 'running',
    phase: (row.phase as string) ?? null,
    totalFiles: Number(row.total_files ?? 0),
    fetchedFiles: Number(row.fetched_files ?? 0),
    totalBytes: Number(row.total_bytes ?? 0),
    skippedFiles: Number(row.skipped_files ?? 0),
    message: (row.message as string) ?? null,
    error: (row.error as string) ?? null,
    startedAt: String(row.started_at ?? ''),
    finishedAt: (row.finished_at as string) ?? null,
  };
}

export async function createImportJob(options: {
  source: 'github' | 'upload';
  userId?: string | null;
  message?: string;
}): Promise<string> {
  const row = await queryOne<JobRow>(
    `insert into project_import_jobs (id, source, status, phase, message, created_by)
     values ($1,$2,'running','preparing',$3,$4) returning *`,
    [uuid(), options.source, options.message ?? 'Preparing import', options.userId ?? null],
  );
  return String(row!.id);
}

export async function updateImportJob(
  id: string,
  patch: Partial<{
    projectId: string;
    status: 'running' | 'succeeded' | 'failed';
    phase: string;
    totalFiles: number;
    fetchedFiles: number;
    totalBytes: number;
    skippedFiles: number;
    message: string;
    error: string | null;
    detail: unknown;
  }>,
): Promise<void> {
  const columns: Record<string, string> = {
    projectId: 'project_id',
    status: 'status',
    phase: 'phase',
    totalFiles: 'total_files',
    fetchedFiles: 'fetched_files',
    totalBytes: 'total_bytes',
    skippedFiles: 'skipped_files',
    message: 'message',
    error: 'error',
    detail: 'detail',
  };
  const sets: string[] = [];
  const params: Array<string | number | boolean | null> = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    const value = (patch as Record<string, unknown>)[key];
    params.push(key === 'detail' ? jsonb(value) : (value as string | number | boolean | null));
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return;
  sets.push(`finished_at = case when $${params.length + 1} in ('succeeded','failed') then now() else finished_at end`);
  params.push(patch.status ?? 'running');
  params.push(id);
  await queryOne(
    `update project_import_jobs set ${sets.join(', ')} where id = $${params.length} returning id`,
    params,
  );
}

export async function getImportJob(id: string): Promise<ImportJobRecord> {
  const row = await queryOne<JobRow>(`select * from project_import_jobs where id = $1`, [id]);
  if (!row) throw new ApiError('That import job no longer exists.', 404, 'import_job_not_found');
  return mapJob(row);
}

// --------------------------------------------------------------- device upload

export async function importFromZip(options: {
  buffer: Buffer;
  filename: string;
  userId?: string | null;
  jobId?: string;
}): Promise<{ project: repo.ProjectRecord; summary: ImportSummary }> {
  if (options.buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ApiError('That archive is larger than the 64 MB upload limit.', 413, 'archive_too_large');
  }

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(options.buffer));
  } catch (error) {
    throw new ApiError(
      `That archive could not be extracted: ${error instanceof Error ? error.message : String(error)}`,
      422,
      'zip_unreadable',
    );
  }

  const rawEntries = Object.entries(archive).filter(([name]) => !name.endsWith('/'));
  if (!rawEntries.length) throw new ApiError('The archive is empty.', 422, 'zip_empty');

  const resolved = rawEntries
    .map(([name, data]) => ({ path: normalizeArchivePath(name), data, raw: name }))
    .filter((entry): entry is { path: string; data: Uint8Array; raw: string } => Boolean(entry.path));

  const rejected = rawEntries.length - resolved.length;
  if (!resolved.length) {
    throw new ApiError('Every entry in that archive was rejected (absolute paths or path traversal).', 422, 'zip_unsafe');
  }

  const { root, strip } = stripCommonRoot(resolved.map((entry) => entry.path));
  const prepared: PreparedFile[] = [];
  let skipped = rejected;
  let bytes = 0;

  for (const entry of resolved) {
    if (bytes > MAX_EXTRACTED_BYTES) {
      throw new ApiError('That archive expands beyond the 128 MB import limit.', 413, 'zip_too_large');
    }
    const relative = strip && root ? entry.path.slice(root.length + 1) : entry.path;
    const file = prepareFile(relative, Buffer.from(entry.data));
    if (!file) {
      skipped += 1;
      continue;
    }
    bytes += file.sizeBytes;
    prepared.push(file);
    if (prepared.length > MAX_PROJECT_FILES) {
      throw new ApiError(`That archive contains more than ${MAX_PROJECT_FILES} importable files.`, 413, 'zip_too_many');
    }
  }

  if (!prepared.length) {
    throw new ApiError(
      'No importable files were found — the archive only contained dependencies, build output or credentials.',
      422,
      'zip_no_files',
    );
  }

  const name = repo.projectNameFromPath(strip && root ? root : options.filename.replace(/\.zip$/i, ''));
  const project = await repo.createProject({
    name,
    source: 'upload',
    sourceLabel: options.filename,
    description: `${prepared.length} files imported from ${options.filename}`,
    createdBy: options.userId ?? null,
    status: 'importing',
    statusMessage: 'Extracting archive',
  });

  if (options.jobId) {
    await updateImportJob(options.jobId, {
      projectId: project.id,
      phase: 'extracting',
      totalFiles: prepared.length,
      message: 'Writing extracted files',
    });
  }

  await repo.replaceProjectFiles(project.id, prepared);
  const ready = await repo.updateProject(project.id, {
    status: 'ready',
    statusMessage: null,
    syncStatus: 'idle',
  });

  const summary: ImportSummary = {
    files: prepared.length,
    textFiles: prepared.filter((file) => file.isText && file.content !== null).length,
    skipped,
    bytes,
    note: strip && root ? `Stripped the single top-level folder “${root}”.` : undefined,
  };

  if (options.jobId) {
    await updateImportJob(options.jobId, {
      status: 'succeeded',
      phase: 'done',
      fetchedFiles: prepared.length,
      totalBytes: bytes,
      skippedFiles: skipped,
      message: 'Project imported',
      detail: summary,
    });
  }

  return { project: ready, summary };
}

export async function importFromFiles(options: {
  files: Array<{ name: string; buffer: Buffer }>;
  userId?: string | null;
  jobId?: string;
  projectName?: string;
}): Promise<{ project: repo.ProjectRecord; summary: ImportSummary }> {
  if (!options.files.length) throw new ApiError('No files were received.', 400, 'missing_files');

  const prepared: PreparedFile[] = [];
  let skipped = 0;
  let bytes = 0;

  for (const item of options.files) {
    if (item.buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new ApiError(`${item.name} is larger than the 64 MB upload limit.`, 413, 'file_too_large');
    }
    const path = normalizeArchivePath(item.name);
    if (!path) {
      skipped += 1;
      continue;
    }
    const file = prepareFile(path, item.buffer);
    if (!file) {
      skipped += 1;
      continue;
    }
    bytes += file.sizeBytes;
    prepared.push(file);
  }

  if (!prepared.length) {
    throw new ApiError(
      'None of the selected files could be imported (unsupported, credential-shaped or unreadable).',
      422,
      'no_importable_files',
    );
  }

  const name =
    options.projectName ??
    (prepared.length === 1 ? repo.projectNameFromPath(prepared[0].path) : `Upload ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);

  const project = await repo.createProject({
    name,
    source: 'upload',
    sourceLabel: options.files.map((file) => file.name).slice(0, 4).join(', '),
    description: `${prepared.length} file(s) uploaded from this device`,
    createdBy: options.userId ?? null,
    status: 'importing',
    statusMessage: 'Storing uploaded files',
  });

  if (options.jobId) {
    await updateImportJob(options.jobId, {
      projectId: project.id,
      phase: 'storing',
      totalFiles: prepared.length,
      message: 'Writing uploaded files',
    });
  }

  await repo.replaceProjectFiles(project.id, prepared);
  const ready = await repo.updateProject(project.id, { status: 'ready', statusMessage: null, syncStatus: 'idle' });

  const summary: ImportSummary = {
    files: prepared.length,
    textFiles: prepared.filter((file) => file.isText && file.content !== null).length,
    skipped,
    bytes,
  };

  if (options.jobId) {
    await updateImportJob(options.jobId, {
      status: 'succeeded',
      phase: 'done',
      fetchedFiles: prepared.length,
      totalBytes: bytes,
      skippedFiles: skipped,
      message: 'Files imported',
      detail: summary,
    });
  }

  return { project: ready, summary };
}

// -------------------------------------------------------------- github import

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function importFromGitHub(options: {
  owner: string;
  repoName: string;
  branch?: string | null;
  userId?: string | null;
  jobId?: string;
}): Promise<{ project: repo.ProjectRecord; summary: ImportSummary }> {
  const client: GitHubClient = await requireClient();
  const owner = options.owner.trim();
  const repoName = options.repoName.trim();

  const repository = await client.getRepository(owner, repoName);
  const branch = (options.branch ?? repository.default_branch).trim() || repository.default_branch;

  const head = await client.getBranchHead(owner, repoName, branch);
  const commit = await client.getCommit(owner, repoName, head.sha);
  const tree = await client.getTree(owner, repoName, commit.tree.sha);

  if (tree.truncated) {
    throw new ApiError(
      'This repository is too large for a single recursive tree read (GitHub truncated it). Import a subproject or upload an archive instead.',
      413,
      'repository_too_large',
    );
  }

  const blobs = tree.tree.filter((entry) => entry.type === 'blob');
  const usable = blobs.filter((entry) => !isSkippedPath(entry.path) && !isSecretPath(entry.path));
  const skipped = blobs.length - usable.length;

  if (!usable.length) {
    throw new ApiError('That repository has no importable files (only dependencies, build output or credentials).', 422, 'repository_no_files');
  }
  if (usable.length > MAX_GITHUB_FILES) {
    throw new ApiError(
      `That repository has ${usable.length} importable files; the limit is ${MAX_GITHUB_FILES}.`,
      413,
      'repository_too_many_files',
    );
  }

  if (options.jobId) {
    await updateImportJob(options.jobId, {
      phase: 'fetching',
      totalFiles: usable.length,
      message: `Reading ${usable.length} files from ${owner}/${repoName}@${branch}`,
    });
  }

  let bytes = 0;
  let fetched = 0;
  const prepared = await mapLimit(usable, 6, async (entry) => {
    const blob = await client.getBlob(owner, repoName, entry.sha);
    const buffer =
      blob.encoding === 'base64'
        ? Buffer.from(blob.content, 'base64')
        : Buffer.from(blob.content, 'utf8');
    const file = prepareFile(entry.path, buffer, entry.sha);
    fetched += 1;
    bytes += buffer.byteLength;
    if (options.jobId && (fetched % 20 === 0 || fetched === usable.length)) {
      await updateImportJob(options.jobId, {
        fetchedFiles: fetched,
        totalBytes: bytes,
        message: `Fetched ${fetched}/${usable.length} files`,
      }).catch(() => undefined);
    }
    return file;
  });

  const preparedFiles = prepared.filter((file): file is PreparedFile => file !== null);

  // Re-importing the same repository and branch refreshes the existing working
  // copy instead of creating a second project bound to the same branch.
  const existing = await repo.findProjectByRepo(owner, repoName, branch);
  let project: repo.ProjectRecord;
  if (existing) {
    await repo.clearProjectFiles(existing.id);
    project = await repo.updateProject(existing.id, {
      status: 'importing',
      statusMessage: 'Refreshing from GitHub',
      githubBranch: branch,
      baseCommitSha: head.sha,
      syncStatus: 'idle',
      syncError: null,
    });
  } else {
    project = await repo.createProject({
      name: repoName,
      description: repository.description ?? `${owner}/${repoName}`,
      source: 'github',
      sourceLabel: `${owner}/${repoName}`,
      github: {
        owner,
        repo: repoName,
        branch,
        defaultBranch: repository.default_branch,
        private: repository.private,
        commitSha: head.sha,
      },
      createdBy: options.userId ?? null,
      status: 'importing',
      statusMessage: 'Reading repository',
    });
  }

  if (options.jobId) {
    await updateImportJob(options.jobId, {
      projectId: project.id,
      phase: 'storing',
      message: 'Writing the working copy',
    });
  }

  await repo.replaceProjectFiles(project.id, preparedFiles);
  const ready = await repo.updateProject(project.id, {
    status: 'ready',
    statusMessage: null,
    syncStatus: 'idle',
    syncError: null,
    baseCommitSha: head.sha,
  });

  await repo.addSyncEvent(
    project.id,
    'success',
    'import',
    `Imported ${preparedFiles.length} files from ${owner}/${repoName}@${branch} (${head.sha.slice(0, 7)})`,
    { files: preparedFiles.length, skipped, bytes },
  );

  const summary: ImportSummary = {
    files: preparedFiles.length,
    textFiles: preparedFiles.filter((file) => file.isText && file.content !== null).length,
    skipped,
    bytes,
    branch,
    commitSha: head.sha,
  };

  if (options.jobId) {
    await updateImportJob(options.jobId, {
      status: 'succeeded',
      phase: 'done',
      fetchedFiles: preparedFiles.length,
      totalBytes: bytes,
      skippedFiles: skipped,
      message: 'Repository imported',
      detail: summary,
    });
  }

  return { project: ready, summary };
}
