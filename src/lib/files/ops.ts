import 'server-only';
import { unzipSync } from 'fflate';
import { query } from '../db';
import { sha256, uuid } from '../crypto';
import { ApiError } from '../api';
import type { ServerRecord } from '../servers/repo';
import { serverClient } from '../servers/repo';
import {
  baseName,
  confineToRoot,
  extensionOf,
  isProbablyBinary,
  isSecretPath,
  joinRemote,
  parentOf,
  normalizeRemotePath,
  assertNotProtectedOperation,
} from '../security/paths';
import { createBackup, downloadRemoteFile, upsertIndexEntry } from './service';
import { deployChanges } from '../services/deploy';
import { logActivity } from '../audit';
import type { Principal } from '../auth/permissions';

export interface DirEntryView {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string | null;
  extension: string;
  secret: boolean;
  sha256: string | null;
  contentCached: boolean;
  accessError?: string | null;
}

export async function listDirectory(
  server: ServerRecord,
  directory: string,
): Promise<{
  path: string;
  parent: string;
  entries: DirEntryView[];
  source: 'pterodactyl';
  fetchedAt: string;
}> {
  const dir = confineToRoot(server.projectRoot, directory || server.projectRoot);
  const client = await serverClient(server);
  const entries = await client.listFiles(dir);
  const indexRows = await query<{
    path: string;
    sha256: string | null;
    content_cached: boolean;
    access_error: string | null;
  }>('select path, sha256, content_cached, access_error from file_indexes where server_id = $1 and parent_path = $2', [
    server.id,
    dir,
  ]);
  const index = new Map(indexRows.map((row) => [row.path, row]));

  return {
    path: dir,
    parent: parentOf(dir),
    source: 'pterodactyl',
    fetchedAt: new Date().toISOString(),
    entries: entries.map((entry) => {
      const fullPath = joinRemote(dir, entry.name);
      const cached = index.get(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.is_file === false,
        isSymlink: Boolean(entry.is_symlink),
        size: Number(entry.size ?? 0),
        modifiedAt: entry.modified_at ?? null,
        extension: entry.is_file === false ? '' : extensionOf(entry.name),
        secret: isSecretPath(fullPath),
        sha256: cached?.sha256 ?? null,
        contentCached: cached?.content_cached ?? false,
        accessError: cached?.access_error ?? null,
      };
    }),
  };
}

export async function indexedChildren(
  serverId: string,
  directory: string,
): Promise<DirEntryView[]> {
  const dir = normalizeRemotePath(directory || '/');
  const rows = await query<{
    path: string;
    name: string;
    is_directory: boolean;
    is_symlink: boolean;
    size_bytes: string | number;
    remote_modified_at: string | null;
    extension: string | null;
    is_secret: boolean;
    sha256: string | null;
    content_cached: boolean;
    access_error: string | null;
  }>(
    `select path, name, is_directory, is_symlink, size_bytes, remote_modified_at, extension, is_secret,
            sha256, content_cached, access_error
       from file_indexes where server_id = $1 and parent_path = $2 and deleted_at is null
      order by is_directory desc, name asc`,
    [serverId, dir],
  );
  return rows.map((row) => ({
    name: row.name,
    path: row.path,
    isDirectory: row.is_directory,
    isSymlink: row.is_symlink,
    size: Number(row.size_bytes ?? 0),
    modifiedAt: row.remote_modified_at,
    extension: row.extension ?? '',
    secret: row.is_secret,
    sha256: row.sha256,
    contentCached: row.content_cached,
    accessError: row.access_error,
  }));
}

function assertWritable(server: ServerRecord, target: string): string {
  const path = confineToRoot(server.projectRoot, target);
  if (isSecretPath(path)) {
    throw new ApiError('Protected session/credential paths cannot be modified from the control center.', 403, 'secret_blocked');
  }
  return path;
}

export async function createFolder(server: ServerRecord, parent: string, name: string): Promise<string> {
  const dir = confineToRoot(server.projectRoot, parent);
  const clean = name.trim();
  if (!clean || clean.includes('/') || clean === '.' || clean === '..') {
    throw new ApiError('Folder name is not valid', 400, 'invalid_name');
  }
  const target = assertWritable(server, joinRemote(dir, clean));
  const client = await serverClient(server);
  await client.createFolder(dir, clean);
  await upsertIndexEntry(server.id, {
    path: target,
    name: clean,
    parentPath: dir,
    extension: '',
    isDirectory: true,
    isSymlink: false,
    sizeBytes: 0,
    modifiedAt: null,
    sha256: null,
    contentCached: false,
    secret: false,
    accessError: null,
  });
  return target;
}

export async function renamePath(server: ServerRecord, from: string, to: string, user: Principal) {
  const source = assertWritable(server, from);
  assertNotProtectedOperation([source]);
  const destination = assertWritable(server, to);
  const parent = parentOf(source);
  if (parentOf(destination) !== parent) {
    throw new ApiError('Use the move operation to change directories.', 400, 'different_directory');
  }
  const client = await serverClient(server);
  await client.rename('/', [
    { from: source.replace(/^\//, ''), to: destination.replace(/^\//, '') },
  ]);
  await query('update file_indexes set path = $3, name = $4, parent_path = $5 where server_id = $1 and path = $2', [
    server.id,
    source,
    destination,
    baseName(destination),
    parent,
  ]);
  await logActivity({
    user,
    serverId: server.id,
    action: 'file.rename',
    target: `${source} → ${destination}`,
  });
  return destination;
}

export async function movePath(server: ServerRecord, from: string, toDirectory: string, user: Principal) {
  const source = assertWritable(server, from);
  assertNotProtectedOperation([source]);
  const destinationDir = confineToRoot(server.projectRoot, toDirectory);
  const destination = joinRemote(destinationDir, baseName(source));
  const client = await serverClient(server);
  await client.rename('/', [{ from: source.replace(/^\//, ''), to: destination.replace(/^\//, '') }]);
  await query(
    'update file_indexes set path = $3, parent_path = $4 where server_id = $1 and (path = $2 or path like $2 || \'/%\')',
    [server.id, source, destination, destinationDir],
  );
  await logActivity({ user, serverId: server.id, action: 'file.move', target: `${source} → ${destination}` });
  return destination;
}

export async function deletePaths(
  server: ServerRecord,
  paths: string[],
  user: Principal,
  options: { backup?: boolean } = { backup: true },
) {
  if (!paths.length) throw new ApiError('No files selected', 400, 'empty_selection');
  const targets = paths.map((path) => assertWritable(server, path));
  assertNotProtectedOperation(targets);
  const client = await serverClient(server);
  const backedUp: string[] = [];

  for (const target of targets) {
    const stat = await client.listFiles(parentOf(target)).then((entries) =>
      entries.find((entry) => entry.name === baseName(target)),
    );
    if (stat?.is_file && options.backup !== false) {
      try {
        await createBackup({ server, path: target, reason: 'pre-delete', userId: user.id, note: 'Backup before delete' });
        backedUp.push(target);
      } catch {
        throw new ApiError(
          `Could not back up ${target}; delete aborted so the file stays recoverable.`,
          502,
          'backup_failed',
        );
      }
    }
    await client.deleteFiles(parentOf(target), [baseName(target)]);
    await query(
      `update file_indexes set deleted_at = now(), sha256 = null, content_cached = false
        where server_id = $1 and (path = $2 or path like $2 || '/%')`,
      [server.id, target],
    );
    await query('delete from file_contents where server_id = $1 and (path = $2 or path like $2 || \'/%\')', [
      server.id,
      target,
    ]);
  }

  await logActivity({
    user,
    serverId: server.id,
    action: 'file.delete',
    target: targets.join(', '),
    severity: 'warning',
    detail: { backedUp },
  });
  return { deleted: targets, backedUp };
}

export async function copyPath(server: ServerRecord, from: string, toDirectory: string, newName: string, user: Principal) {
  const source = assertWritable(server, from);
  const dir = confineToRoot(server.projectRoot, toDirectory);
  const destination = assertWritable(server, joinRemote(dir, newName));
  const client = await serverClient(server);

  let buffer: Buffer;
  const isBinary = isProbablyBinary(source);
  if (isBinary) {
    buffer = (await downloadRemoteFile(server, source)).buffer;
  } else {
    buffer = Buffer.from(await client.readFile(source), 'utf8');
  }
  await client.uploadFile(dir, baseName(destination), buffer);
  const verify = await client.downloadUrl(destination).then((url) => client.fetchDownload(url, 64 * 1024 * 1024));
  if (sha256(verify) !== sha256(buffer)) {
    throw new ApiError('Copy verification failed — the destination hash does not match the source.', 502, 'copy_failed');
  }
  await logActivity({ user, serverId: server.id, action: 'file.copy', target: `${source} → ${destination}` });
  return destination;
}

/** Slice the raw bytes of an upload and hand them to the panel's signed upload URL. */
export async function uploadFile(
  server: ServerRecord,
  directory: string,
  fileName: string,
  buffer: Buffer,
  user: Principal,
) {
  const dir = confineToRoot(server.projectRoot, directory);
  if (fileName.includes('/') || fileName.includes('..')) {
    throw new ApiError('Invalid upload file name', 400, 'invalid_name');
  }
  const target = assertWritable(server, joinRemote(dir, fileName));
  if (buffer.byteLength > 64 * 1024 * 1024) {
    throw new ApiError('Uploads are limited to 64 MB', 413, 'file_too_large');
  }
  const client = await serverClient(server);
  const existing = await client
    .listFiles(dir)
    .then((entries) => entries.find((entry) => entry.name === fileName))
    .catch(() => undefined);

  let backupId: string | null = null;
  if (existing?.is_file) {
    const backup = await createBackup({
      server,
      path: target,
      reason: 'pre-upload',
      userId: user.id,
      note: `Backup before uploading ${fileName}`,
    });
    backupId = backup.id;
  }

  await client.uploadFile(dir, fileName, buffer);
  const verify = await client.downloadUrl(target).then((url) => client.fetchDownload(url, 64 * 1024 * 1024));
  const hash = sha256(verify);
  if (hash !== sha256(buffer)) {
    throw new ApiError('Upload verification failed — production bytes do not match the upload.', 502, 'upload_unverified');
  }
  await query(
    `insert into file_versions (id, server_id, path, version, sha256, size_bytes, backup_id, change_note, created_by)
     values ($1,$2,$3,(select coalesce(max(version),0)+1 from file_versions where server_id=$2 and path=$3),$4,$5,$6,'Uploaded file',$7)`,
    [uuid(), server.id, target, hash, buffer.byteLength, backupId, user.id],
  );
  await logActivity({ user, serverId: server.id, action: 'file.upload', target, detail: { bytes: buffer.byteLength } });
  return { path: target, sha256: hash, bytes: buffer.byteLength, backupId };
}

// ---------------------------------------------------------------------------
// ZIP import
// ---------------------------------------------------------------------------
export interface ZipEntryPreview {
  name: string;
  path: string;
  bytes: number;
  isDirectory: boolean;
  binary: boolean;
  exists: boolean;
  unsafe?: string;
}

export function inspectZip(buffer: Buffer, destination: string): { entries: ZipEntryPreview[]; rejected: ZipEntryPreview[] } {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(buffer));
  } catch (error) {
    throw new ApiError(`Archive could not be read: ${error instanceof Error ? error.message : String(error)}`, 422, 'bad_zip');
  }
  const dest = normalizeRemotePath(destination);
  const entries: ZipEntryPreview[] = [];
  const rejected: ZipEntryPreview[] = [];
  let total = 0;

  for (const [rawName, data] of Object.entries(archive)) {
    const isDirectory = rawName.endsWith('/');
    const normalized = rawName.replace(/\\/g, '/');
    const unsafe =
      normalized.startsWith('/') || normalized.includes('..') || normalized.includes('\0')
        ? 'path traversal or absolute path'
        : isSecretPath(joinRemote(dest, normalized))
          ? 'protected secret path'
          : null;
    const bytes = data?.byteLength ?? 0;
    total += bytes;
    const entry: ZipEntryPreview = {
      name: rawName,
      path: joinRemote(dest, normalized),
      bytes,
      isDirectory,
      binary: !isDirectory && isProbablyBinary(normalized),
      exists: false,
      unsafe: unsafe ?? undefined,
    };
    if (unsafe) rejected.push(entry);
    else entries.push(entry);
  }
  if (total > 64 * 1024 * 1024) throw new ApiError('Archive expands beyond the 64 MB import limit', 413, 'zip_too_large');
  if (entries.length > 800) throw new ApiError('Archive contains more than 800 files', 413, 'zip_too_many');
  return { entries, rejected };
}

export async function applyZipImport(options: {
  server: ServerRecord;
  user: Principal;
  buffer: Buffer;
  destination: string;
  only?: string[];
  note?: string;
}) {
  const { entries, rejected } = inspectZip(options.buffer, options.destination);
  const selected = options.only?.length ? entries.filter((entry) => options.only!.includes(entry.name)) : entries;
  const archive = unzipSync(new Uint8Array(options.buffer));
  const textChanges: Array<{ path: string; content: string }> = [];
  const binaryUploads: Array<{ entry: ZipEntryPreview; data: Uint8Array }> = [];
  const skipped: Array<{ path: string; reason: string }> = rejected.map((entry) => ({
    path: entry.path,
    reason: entry.unsafe ?? 'rejected',
  }));

  for (const entry of selected) {
    if (entry.isDirectory) continue;
    const data = archive[entry.name];
    if (!data) continue;
    if (entry.binary) {
      const buffer = Buffer.from(data);
      await uploadFile(options.server, parentOf(entry.path), baseName(entry.path), buffer, options.user);
    } else {
      textChanges.push({ path: entry.path, content: Buffer.from(data).toString('utf8') });
    }
  }

  let deploymentId: string | null = null;
  if (textChanges.length) {
    const result = await deployChanges({
      server: options.server,
      user: options.user,
      changes: textChanges,
      note: options.note ?? `ZIP import (${textChanges.length} text files)`,
      restartMode: 'auto',
    });
    deploymentId = result.id;
    if (result.status !== 'succeeded') {
      throw new ApiError(
        `Import deployment ${result.status}: ${result.error ?? 'see deployment logs'}`,
        result.status === 'rolled_back' ? 409 : 502,
        'import_deploy_failed',
      );
    }
  }

  const touchedDirectories = [...new Set(selected.map((entry) => parentOf(entry.path)))];
  for (const dir of touchedDirectories) {
    await upsertIndexEntry(options.server.id, {
      path: dir,
      name: baseName(dir),
      parentPath: parentOf(dir),
      extension: '',
      isDirectory: true,
      isSymlink: false,
      sizeBytes: 0,
      modifiedAt: null,
      sha256: null,
      contentCached: false,
      secret: isSecretPath(dir),
      accessError: null,
    }).catch(() => undefined);
  }

  await logActivity({
    user: options.user,
    serverId: options.server.id,
    action: 'file.zip_import',
    target: options.destination,
    detail: { files: selected.length, skipped: skipped.length, deploymentId },
  });

  return {
    imported: selected.filter((entry) => !entry.isDirectory).length,
    skipped,
    deploymentId,
  };
}

/**
 * Compress files into an archive *on the server* using the panel's compress
 * endpoint. The archive lands next to the first selection, exactly as the panel
 * would do it, and is then indexed like any other file.
 */
export async function zipPaths(server: ServerRecord, paths: string[], user: Principal) {
  if (!paths.length) throw new ApiError('Select at least one file to compress', 400, 'empty_selection');
  const targets = paths.map((path) => assertWritable(server, path));
  const parents = new Set(targets.map((target) => parentOf(target)));
  if (parents.size > 1) {
    throw new ApiError(
      'All selected items must share the same parent folder before they can be compressed.',
      400,
      'mixed_parents',
    );
  }
  const [root] = [...parents];
  const client = await serverClient(server);
  const names = targets.map((target) => baseName(target));
  const before = await client.listFiles(root).catch(() => []);
  await client.compress(root, names);
  const after = await client.listFiles(root);
  const created = after
    .filter((entry) => !before.some((old) => old.name === entry.name))
    .filter((entry) => /\.(zip|tar\.gz|tar)$/i.test(entry.name));
  await logActivity({
    user,
    serverId: server.id,
    action: 'file.compress',
    target: `${root} (${names.join(', ')})`,
  });
  return {
    root,
    created: created.map((entry) => joinRemote(root, entry.name)),
    note: created.length
      ? 'Archive created on the server.'
      : 'The panel accepted the compress request. Refresh the folder to see the archive name the panel chose.',
  };
}
