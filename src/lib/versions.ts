import 'server-only';
import { diffLines } from 'diff';
import { ApiError } from './api';
import { query, queryOne } from './db';
import { sha256 } from './crypto';
import { backupStorage } from './backups/storage';
import type { ServerRecord } from './servers/repo';
import { writeProductionFile } from './files/service';
import { baseName, isSecretPath } from './security/paths';

export interface VersionSummary {
  id: string;
  path: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  changeNote: string | null;
  createdBy: string | null;
  deploymentId: string | null;
  createdAt: string;
  remoteModifiedAt: string | null;
  backupId: string | null;
  storageKey: string | null;
  hasContent: boolean;
  authorEmail: string | null;
}

interface VersionRow {
  id: string;
  path: string;
  version: number;
  sha256: string;
  size_bytes: string | number;
  change_note: string | null;
  created_by: string | null;
  deployment_id: string | null;
  created_at: string;
  remote_modified_at: string | null;
  backup_id: string | null;
  storage_key: string | null;
  author_email: string | null;
}

function mapVersion(row: VersionRow): VersionSummary {
  return {
    id: row.id,
    path: row.path,
    version: Number(row.version),
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes ?? 0),
    changeNote: row.change_note,
    createdBy: row.created_by,
    deploymentId: row.deployment_id,
    createdAt: row.created_at,
    remoteModifiedAt: row.remote_modified_at,
    backupId: row.backup_id,
    storageKey: row.storage_key,
    hasContent: Boolean(row.storage_key),
    authorEmail: row.author_email,
  };
}

const VERSION_SELECT = `
  select v.id, v.path, v.version, v.sha256, v.size_bytes, v.change_note, v.created_by,
         v.deployment_id, v.created_at, v.remote_modified_at, v.backup_id,
         b.storage_key, u.email as author_email
    from file_versions v
    left join file_backups b on b.id = v.backup_id
    left join admin_users u on u.id = v.created_by
`;

export async function listVersions(
  serverId: string,
  options: { path?: string; limit?: number } = {},
): Promise<VersionSummary[]> {
  const limit = Math.min(options.limit ?? 60, 200);
  const rows = options.path
    ? await query<VersionRow>(
        `${VERSION_SELECT} where v.server_id = $1 and v.path = $2 order by v.version desc limit $3`,
        [serverId, options.path, limit],
      )
    : await query<VersionRow>(
        `${VERSION_SELECT} where v.server_id = $1 order by v.created_at desc limit $2`,
        [serverId, limit],
      );
  return rows.map(mapVersion);
}

export async function getVersion(serverId: string, versionId: string): Promise<VersionSummary> {
  const row = await queryOne<VersionRow>(`${VERSION_SELECT} where v.server_id = $1 and v.id = $2`, [
    serverId,
    versionId,
  ]);
  if (!row) throw new ApiError('Version not found for this server.', 404, 'version_not_found');
  return mapVersion(row);
}

/**
 * Read a stored version back from private backup storage and prove its integrity
 * against the hash recorded when it was created.
 */
export async function readVersion(version: VersionSummary): Promise<Buffer> {
  if (!version.storageKey) {
    throw new ApiError(
      'This version has no stored content (it was recorded from metadata only), so it cannot be restored or downloaded.',
      409,
      'version_content_missing',
    );
  }
  const buffer = await backupStorage().get(version.storageKey);
  const actual = sha256(buffer);
  if (actual !== version.sha256) {
    throw new ApiError(
      `Stored version is corrupt: expected ${version.sha256.slice(0, 12)}… but storage returned ${actual.slice(0, 12)}….`,
      500,
      'version_corrupt',
    );
  }
  return buffer;
}

export async function readVersionText(version: VersionSummary): Promise<string> {
  return (await readVersion(version)).toString('utf8');
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  text: string;
  leftNo: number | null;
  rightNo: number | null;
}

/** Structured line diff for the comparison view. */
export function buildDiff(before: string, after: string): {
  lines: DiffLine[];
  added: number;
  removed: number;
} {
  const parts = diffLines(before ?? '', after ?? '');
  const lines: DiffLine[] = [];
  let leftNo = 1;
  let rightNo = 1;
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const chunk = part.value.split('\n');
    if (chunk[chunk.length - 1] === '') chunk.pop();
    for (const text of chunk) {
      if (part.added) {
        lines.push({ type: 'add', text, leftNo: null, rightNo: rightNo++ });
        added += 1;
      } else if (part.removed) {
        lines.push({ type: 'remove', text, leftNo: leftNo++, rightNo: null });
        removed += 1;
      } else {
        lines.push({ type: 'context', text, leftNo: leftNo++, rightNo: rightNo++ });
      }
    }
  }
  return { lines, added, removed };
}

export async function diffVersionAgainstProduction(
  server: ServerRecord,
  versionId: string,
  productionContent: string,
): Promise<{
  version: VersionSummary;
  diff: ReturnType<typeof buildDiff>;
}> {
  const version = await getVersion(server.id, versionId);
  const stored = await readVersionText(version);
  return { version, diff: buildDiff(stored, productionContent) };
}

export interface RestoreResult {
  path: string;
  hash: string;
  version: number;
  backupId: string;
}

/**
 * Restore a previous version back into production. This goes through the same
 * guarded write path as any other edit: a backup of the *current* production
 * content is created first, the write is hash-verified, and a new version row
 * records who restored what.
 */
export async function restoreVersion(options: {
  server: ServerRecord;
  versionId: string;
  userId: string | null;
  note?: string;
}): Promise<RestoreResult> {
  const { server, versionId } = options;
  const version = await getVersion(server.id, versionId);
  if (isSecretPath(version.path)) {
    throw new ApiError('Session and credential files are never versioned or restored.', 403, 'secret_blocked');
  }
  const content = await readVersionText(version);
  const result = await writeProductionFile({
    server,
    path: version.path,
    content,
    expectedHash: null,
    note: options.note ?? `Restored version ${version.version} (${version.sha256.slice(0, 10)}…)`,
    userId: options.userId,
    // A backup can legitimately be an empty file; replaying it is explicit.
    allowEmpty: true,
  });
  return { path: result.path, hash: result.hash, version: result.version, backupId: result.backupId };
}

export async function versionsForFile(serverId: string, path: string): Promise<VersionSummary[]> {
  return listVersions(serverId, { path, limit: 100 });
}

export function downloadName(version: VersionSummary): string {
  const name = baseName(version.path);
  return `${name}.v${version.version}`;
}
