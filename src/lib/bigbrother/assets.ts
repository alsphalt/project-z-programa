import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, queryOne } from '../db';
import { uuid } from '../crypto';
import { env, ensureDataDirs } from '../env';
import { ApiError } from '../api';
import { pageExists } from '../errors/routes';

/**
 * Instructional image storage.
 *
 * Files live outside public/ under DARKNOTE_DATA_DIR, are written 0600 and are
 * served only through an authenticated route that re-checks ownership on every
 * request. The file type is decided from magic bytes, not the uploaded name.
 */

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export type AssetMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

interface AssetRow {
  id: string;
  user_id: string;
  filename: string;
  mime: string;
  size_bytes: number | string;
  storage_key: string;
  created_at: string;
}

export interface AssetView {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

function detectMime(buffer: Buffer): { mime: AssetMime; ext: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

function assetDir(userId: string): string {
  return path.join(env.uploadDir, 'bigbrother', userId.replace(/[^a-zA-Z0-9_-]/g, ''));
}

function view(row: AssetRow): AssetView {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    url: `/api/bigbrother/assets/${row.id}`,
    createdAt: row.created_at,
  };
}

export async function saveAsset(
  userId: string,
  input: { filename: string; buffer: Buffer },
): Promise<AssetView> {
  if (!input.buffer.length) throw new ApiError('The uploaded image is empty.', 400, 'empty_upload');
  if (input.buffer.length > MAX_ASSET_BYTES) {
    throw new ApiError(
      `The image is ${(input.buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ASSET_BYTES / 1024 / 1024} MB.`,
      413,
      'asset_too_large',
    );
  }
  const detected = detectMime(input.buffer);
  if (!detected) {
    throw new ApiError('Only PNG, JPEG, GIF or WebP images are accepted (the file type is verified from its bytes).', 415, 'unsupported_image');
  }

  ensureDataDirs();
  const id = `ast_${uuid().replace(/-/g, '').slice(0, 20)}`;
  const dir = assetDir(userId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const storageKey = path.join(dir, `${id}.${detected.ext}`);
  await fs.writeFile(storageKey, input.buffer, { mode: 0o600 });

  const safeName = input.filename.replace(/[^\w.-]+/g, '_').slice(0, 120) || `image.${detected.ext}`;
  await query(
    `insert into bigbrother_assets (id, user_id, kind, filename, mime, size_bytes, storage_key)
     values ($1,$2,'image',$3,$4,$5,$6)`,
    [id, userId, safeName, detected.mime, input.buffer.length, storageKey],
  );

  const row = await queryOne<AssetRow>('select * from bigbrother_assets where id = $1 and user_id = $2', [id, userId]);
  if (!row) throw new ApiError('The image could not be stored.', 500, 'asset_store_failed');
  return view(row);
}

export async function readAsset(
  userId: string,
  id: string,
): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  const row = await queryOne<AssetRow>(
    'select * from bigbrother_assets where id = $1 and user_id = $2',
    [id, userId],
  );
  if (!row) throw new ApiError('Image not found.', 404, 'asset_not_found');

  const expectedDir = assetDir(userId);
  const resolved = path.resolve(row.storage_key);
  if (!resolved.startsWith(path.resolve(expectedDir) + path.sep)) {
    // A stored key that escapes the account folder is never served.
    throw new ApiError('Image path rejected.', 403, 'asset_path_rejected');
  }
  try {
    const buffer = await fs.readFile(resolved);
    return { buffer, mime: row.mime, filename: row.filename };
  } catch {
    throw new ApiError('The image file is missing from the private store.', 404, 'asset_missing');
  }
}

export async function deleteAsset(userId: string, id: string): Promise<void> {
  const row = await queryOne<AssetRow>(
    'delete from bigbrother_assets where id = $1 and user_id = $2 returning storage_key',
    [id, userId],
  );
  if (!row) return;
  await fs.unlink(row.storage_key).catch(() => undefined);
}

export async function listAssets(userId: string, limit = 60): Promise<AssetView[]> {
  const rows = await query<AssetRow>(
    'select * from bigbrother_assets where user_id = $1 order by created_at desc limit $2',
    [userId, limit],
  );
  return rows.map(view);
}

/** Internal links attached to tutorial steps are validated before storage. */
export function assertValidInternalLink(href: string | null | undefined): void {
  if (!href) return;
  if (!href.startsWith('/')) {
    throw new ApiError('Tutorial links must be internal DARKNOTE paths starting with "/".', 400, 'invalid_link');
  }
  if (!pageExists(href)) {
    throw new ApiError(`The link ${href} does not match a page in this application.`, 400, 'unknown_page');
  }
}
