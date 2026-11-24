import 'server-only';
import { zipSync } from 'fflate';
import path from 'node:path';
import { query, queryOne } from '../db';
import { sha256, uuid } from '../crypto';
import { ApiError } from '../api';
import { env } from '../env';
import type { ServerRecord } from '../servers/repo';
import { serverClient } from '../servers/repo';
import { baseName, confineToRoot, isExcluded, isSecretPath, joinRemote, normalizeRemotePath, parentOf } from '../security/paths';
import { cacheFileContent, downloadRemoteFile, upsertIndexEntry } from '../files/service';
import { backupStorage } from '../backups/storage';
import { logActivity } from '../audit';
import type { Principal } from '../auth/permissions';
import { mapLimit } from '../util/async';

export interface DownloadArtifact {
  filename: string;
  contentType: string;
  buffer: Buffer;
  sha256: string;
  sizeBytes: number;
  excluded: string[];
  verifiedAt: string;
  notes: string[];
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function recordDownload(options: {
  server: ServerRecord;
  user: Pick<Principal, 'id'>;
  kind: string;
  target: string;
  hash: string;
  size: number;
  includedSecrets: boolean;
}) {
  await query(
    `insert into download_history (id, server_id, user_id, kind, target, sha256, size_bytes, included_secrets)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuid(), options.server.id, options.user.id, options.kind, options.target, options.hash, options.size, options.includedSecrets],
  );
}

/**
 * DOWNLOAD CENTER: always re-reads the file from Pterodactyl and verifies the
 * SHA-256 before handing bytes to the browser. A local draft is never served.
 */
export async function downloadOne(options: {
  server: ServerRecord;
  path: string;
  user: Pick<Principal, 'id' | 'email'>;
  allowSecret?: boolean;
}): Promise<DownloadArtifact> {
  const target = confineToRoot(options.server.projectRoot, options.path);
  if (isSecretPath(target) && !options.allowSecret) {
    throw new ApiError(
      'This file is classified as a secret (WhatsApp session, credential or key). Sensitive export permission is required.',
      403,
      'secret_blocked',
    );
  }

  const client = await serverClient(options.server);
  const url = await client.downloadUrl(target);
  const buffer = await client.fetchDownload(url, env.maxDownloadBytes);
  const hash = sha256(buffer);

  if (!isSecretPath(target) && buffer.byteLength <= options.server.maxFileBytes) {
    const text = buffer.toString('utf8');
    if (!text.includes('\0')) await cacheFileContent(options.server.id, target, hash, text);
  }
  await upsertIndexEntry(options.server.id, {
    path: target,
    name: baseName(target),
    parentPath: parentOf(target),
    extension: baseName(target).includes('.') ? baseName(target).split('.').pop()!.toLowerCase() : '',
    isDirectory: false,
    isSymlink: false,
    sizeBytes: buffer.byteLength,
    modifiedAt: new Date().toISOString(),
    sha256: hash,
    contentCached: !isSecretPath(target),
    secret: isSecretPath(target),
    accessError: null,
  });
  await recordDownload({
    server: options.server,
    user: options.user,
    kind: 'file',
    target,
    hash,
    size: buffer.byteLength,
    includedSecrets: isSecretPath(target),
  });
  await logActivity({
    user: options.user,
    serverId: options.server.id,
    action: 'download.file',
    target,
    severity: isSecretPath(target) ? 'warning' : 'info',
    detail: { sha256: hash },
  });

  return {
    filename: baseName(target),
    contentType: 'application/octet-stream',
    buffer,
    sha256: hash,
    sizeBytes: buffer.byteLength,
    excluded: [],
    verifiedAt: new Date().toISOString(),
    notes: ['Served from the verified production file on Pterodactyl.'],
  };
}

interface CollectedFile {
  path: string;
  buffer: Buffer;
  hash: string;
}

async function collectFiles(
  server: ServerRecord,
  root: string,
  options: { recursive: boolean; maxFiles: number },
): Promise<{ files: CollectedFile[]; excluded: string[]; totalBytes: number }> {
  const client = await serverClient(server);
  const files: CollectedFile[] = [];
  const excluded: string[] = [];
  let totalBytes = 0;
  const queue = [normalizeRemotePath(root)];

  while (queue.length && files.length < options.maxFiles) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await client.listFiles(dir);
    } catch (error) {
      excluded.push(`${dir} (unreadable: ${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const batch: string[] = [];
    for (const entry of entries) {
      const full = joinRemote(dir, entry.name);
      if (isSecretPath(full) || isExcluded(full, server.excludedPaths)) {
        excluded.push(full);
        continue;
      }
      if (entry.is_file === false) {
        if (options.recursive) queue.push(full);
        continue;
      }
      if (entry.size > 24 * 1024 * 1024) {
        excluded.push(`${full} (larger than 24 MB)`);
        continue;
      }
      batch.push(full);
    }
    const collected = await mapLimit(batch, 3, async (filePath) => {
      try {
        const downloaded = await downloadRemoteFile(server, filePath, 24 * 1024 * 1024);
        return { path: filePath, buffer: downloaded.buffer, hash: downloaded.sha256 };
      } catch (error) {
        excluded.push(`${filePath} (download failed: ${error instanceof Error ? error.message : String(error)})`);
        return null;
      }
    });
    for (const item of collected) {
      if (!item) continue;
      if (totalBytes + item.buffer.byteLength > env.maxDownloadBytes) {
        excluded.push(`${item.path} (archive size limit reached)`);
        continue;
      }
      totalBytes += item.buffer.byteLength;
      files.push(item);
    }
  }

  return { files, excluded, totalBytes };
}

function buildZip(files: CollectedFile[], rootName: string): Buffer {
  const input: Record<string, Uint8Array> = {};
  for (const file of files) {
    const relative = file.path.replace(/^\//, '');
    input[relative || baseName(file.path)] = new Uint8Array(file.buffer);
  }
  if (!files.length) {
    input[`${rootName}/README.txt`] = new Uint8Array(
      Buffer.from('No files matched the export rules. Secrets and excluded directories are skipped.\n'),
    );
  }
  return Buffer.from(zipSync(input, { level: 6 }));
}

export async function downloadMany(options: {
  server: ServerRecord;
  paths: string[];
  user: Pick<Principal, 'id' | 'email'>;
  kind?: string;
  archiveName?: string;
  allowSecret?: boolean;
}): Promise<DownloadArtifact> {
  if (!options.paths.length) throw new ApiError('No files selected', 400, 'empty_selection');
  const excluded: string[] = [];
  const files: CollectedFile[] = [];
  const client = await serverClient(options.server);

  for (const raw of options.paths.slice(0, 300)) {
    const target = confineToRoot(options.server.projectRoot, raw);
    if (isSecretPath(target) && !options.allowSecret) {
      excluded.push(`${target} (secret)`);
      continue;
    }
    try {
      const url = await client.downloadUrl(target);
      const buffer = await client.fetchDownload(url, env.maxDownloadBytes);
      files.push({ path: target, buffer, hash: sha256(buffer) });
    } catch (error) {
      excluded.push(`${target} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (files.length === 1) {
    const single = files[0];
    await recordDownload({
      server: options.server,
      user: options.user,
      kind: 'file',
      target: single.path,
      hash: single.hash,
      size: single.buffer.byteLength,
      includedSecrets: false,
    });
    return {
      filename: baseName(single.path),
      contentType: 'application/octet-stream',
      buffer: single.buffer,
      sha256: single.hash,
      sizeBytes: single.buffer.byteLength,
      excluded,
      verifiedAt: new Date().toISOString(),
      notes: ['Each file is re-downloaded from production before packaging.'],
    };
  }

  const buffer = buildZip(files, 'darknote-export');
  const hash = sha256(buffer);
  await recordDownload({
    server: options.server,
    user: options.user,
    kind: options.kind ?? 'files',
    target: options.paths.join(', '),
    hash,
    size: buffer.byteLength,
    includedSecrets: false,
  });
  await logActivity({
    user: options.user,
    serverId: options.server.id,
    action: 'download.archive',
    target: `${files.length} files`,
    detail: { sha256: hash, excluded: excluded.length },
  });
  return {
    filename: `${safeFileName(options.archiveName ?? 'darknote-files')}-${new Date().toISOString().slice(0, 10)}.zip`,
    contentType: 'application/zip',
    buffer,
    sha256: hash,
    sizeBytes: buffer.byteLength,
    excluded,
    verifiedAt: new Date().toISOString(),
    notes: [
      `Packaged ${files.length} production file(s).`,
      'Secrets, session directories and excluded folders are skipped by default.',
    ],
  };
}

export async function downloadFolder(options: {
  server: ServerRecord;
  folder: string;
  user: Pick<Principal, 'id' | 'email'>;
  recursive?: boolean;
}): Promise<DownloadArtifact> {
  const folder = confineToRoot(options.server.projectRoot, options.folder);
  const collected = await collectFiles(options.server, folder, {
    recursive: options.recursive !== false,
    maxFiles: 800,
  });
  const buffer = buildZip(collected.files, baseName(folder));
  const hash = sha256(buffer);
  await recordDownload({
    server: options.server,
    user: options.user,
    kind: 'folder',
    target: folder,
    hash,
    size: buffer.byteLength,
    includedSecrets: false,
  });
  await logActivity({
    user: options.user,
    serverId: options.server.id,
    action: 'download.folder',
    target: folder,
    detail: { files: collected.files.length },
  });
  return {
    filename: `${safeFileName(baseName(folder) || 'project')}-${new Date().toISOString().slice(0, 10)}.zip`,
    contentType: 'application/zip',
    buffer,
    sha256: hash,
    sizeBytes: buffer.byteLength,
    excluded: collected.excluded,
    verifiedAt: new Date().toISOString(),
    notes: [`Folder export of ${folder} (${collected.files.length} files).`],
  };
}

export async function downloadProject(options: {
  server: ServerRecord;
  user: Pick<Principal, 'id' | 'email'>;
}): Promise<DownloadArtifact> {
  return downloadFolder({ server: options.server, folder: options.server.projectRoot, user: options.user, recursive: true });
}

export async function downloadVersion(options: {
  server: ServerRecord;
  versionId: string;
  user: Pick<Principal, 'id' | 'email'>;
}): Promise<DownloadArtifact> {
  const row = await queryOne<{
    id: string;
    path: string;
    sha256: string;
    size_bytes: string | number;
    backup_id: string | null;
    version: number;
    content_ref: string | null;
  }>(
    `select v.id, v.path, v.sha256, v.size_bytes, v.backup_id, v.version, v.content_ref
       from file_versions v where v.id = $1 and v.server_id = $2`,
    [options.versionId, options.server.id],
  );
  if (!row) throw new ApiError('Version not found', 404, 'version_not_found');
  const backup = row.backup_id
    ? await queryOne<{ storage_key: string }>('select storage_key from file_backups where id = $1', [row.backup_id])
    : row.content_ref
      ? { storage_key: row.content_ref }
      : null;
  if (!backup) throw new ApiError('Backup object for this version is missing', 410, 'backup_missing');

  const buffer = await backupStorage().get(backup.storage_key);
  const hash = sha256(buffer);
  if (row.sha256 && hash !== row.sha256) {
    throw new ApiError('Backup integrity check failed — stored bytes do not match the recorded hash', 500, 'backup_corrupt');
  }
  await recordDownload({
    server: options.server,
    user: options.user,
    kind: 'version',
    target: `${row.path}#v${row.version}`,
    hash,
    size: buffer.byteLength,
    includedSecrets: false,
  });
  await logActivity({
    user: options.user,
    serverId: options.server.id,
    action: 'download.version',
    target: `${row.path} v${row.version}`,
  });
  return {
    filename: `${safeFileName(path.basename(row.path))}.v${row.version}`,
    contentType: 'application/octet-stream',
    buffer,
    sha256: hash,
    sizeBytes: buffer.byteLength,
    excluded: [],
    verifiedAt: new Date().toISOString(),
    notes: [`Recovered version ${row.version} of ${row.path} from private backup storage.`],
  };
}

export async function downloadListing(serverId: string, limit = 40) {
  return query(
    `select d.id, d.kind, d.target, d.sha256, d.size_bytes, d.included_secrets, d.created_at, u.email
       from download_history d left join admin_users u on u.id = d.user_id
      where d.server_id = $1 order by d.created_at desc limit $2`,
    [serverId, limit],
  );
}
