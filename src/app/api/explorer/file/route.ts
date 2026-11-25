import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess, serverClient } from '@/lib/servers/repo';
import { explorerFileInfo } from '@/lib/services/explorer';
import { deletePaths } from '@/lib/files/ops';
import { baseName, confineToRoot, isSecretPath, parentOf } from '@/lib/security/paths';
import { deletionBlockReason, isDataRecord } from '@/lib/explorer/classify';
import { query, queryOne } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** File detail: metadata, symbols, imports and reverse dependencies. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const path = url.searchParams.get('path');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!path) throw new ApiError('path is required', 400, 'path_required');
  const server = await assertServerAccess(user, serverId, 'file.read');
  const target = confineToRoot(server.projectRoot, path);
  const info = await explorerFileInfo(server, target);
  return ok(info);
});

/**
 * Delete from the explorer.
 *
 * Deleting a file is destructive, so this path is deliberately narrower than the
 * generic file manager: credentials and database records are refused outright,
 * and every deletion is backed up before the panel removes anything.
 */
export const DELETE = route({ permission: 'file.delete' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const path = url.searchParams.get('path');
  const confirm = url.searchParams.get('confirm');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!path) throw new ApiError('path is required', 400, 'path_required');
  if (!confirm) {
    throw new ApiError('Type the confirmation token to remove a production file or folder.', 400, 'confirmation_required');
  }
  const server = await assertServerAccess(user, serverId, 'file.delete');
  const target = confineToRoot(server.projectRoot, path);

  const row = await queryOne<{ is_directory: boolean }>(
    'select is_directory from file_indexes where server_id = $1 and path = $2 and deleted_at is null',
    [server.id, target],
  );
  /**
   * Directory-ness decides how dangerous the delete is, so it must come from the
   * panel, not from an index snapshot that may lag (a folder created after the
   * last scan is not in the index yet).
   */
  let isDirectory = Boolean(row?.is_directory);
  try {
    const client = await serverClient(server);
    const siblings = await client.listFiles(parentOf(target));
    const entry = siblings.find((item) => item.name === baseName(target));
    if (entry) isDirectory = entry.is_file === false;
  } catch {
    /* unreachable panel: fall back to the index answer and keep the guards */
  }

  // A folder needs its own name typed back, not just a generic token: deleting a
  // directory removes everything below it.
  const expectedToken = isDirectory ? baseName(target) : 'DELETE';
  if (confirm !== expectedToken) {
    throw new ApiError(
      isDirectory
        ? `Type the folder name (${expectedToken}) to confirm deleting a folder.`
        : 'Type DELETE to confirm removing a production file.',
      400,
      'confirmation_required',
    );
  }

  if (isSecretPath(target)) {
    throw new ApiError('Credential and session files cannot be deleted from the explorer.', 403, 'secret_blocked');
  }
  if (isDataRecord(target)) {
    throw new ApiError(
      'This is a production data or database file. It is protected from deletion here — download it or use the panel.',
      403,
      'protected_data',
    );
  }

  const structural = deletionBlockReason(target, isDirectory);
  if (structural) throw new ApiError(structural, 403, 'protected_path');

  if (isDirectory) {
    /**
     * Deleting a folder must not take credentials or records with it. Check the
     * indexed descendants before the panel removes anything.
     */
    const descendants = await query<{ path: string; is_secret: boolean }>(
      `select path, is_secret from file_indexes
        where server_id = $1 and deleted_at is null and path like $2 || '/%'`,
      [server.id, target],
    );
    const secret = descendants.find((entry) => entry.is_secret || isSecretPath(entry.path));
    if (secret) {
      throw new ApiError(
        `${target} contains credential data (${secret.path}). Deleting the whole folder would expose or destroy it — remove the source files individually.`,
        403,
        'secret_blocked',
      );
    }
    const record = descendants.find((entry) => isDataRecord(entry.path));
    if (record) {
      throw new ApiError(
        `${target} contains production records (${record.path}). Refusing to delete the folder — export the data or use the panel.`,
        403,
        'protected_data',
      );
    }
  }

  const result = await deletePaths(server, [target], user, { backup: true });
  return ok(result);
});
