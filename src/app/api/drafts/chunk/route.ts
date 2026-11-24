import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { query, queryOne } from '@/lib/db';
import { sha256, uuid } from '@/lib/crypto';
import { confineToRoot, isSecretPath } from '@/lib/security/paths';
import { editorLimitFor } from '@/lib/files/service';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  serverId: z.string().min(1),
  path: z.string().min(1),
  action: z.literal('create'),
  totalBytes: z.number().int().min(1),
  /** UTF-16 length of the text; lets the server predict the exact chunk count. */
  totalChars: z.number().int().min(1).optional(),
  baseSha: z.string().nullable().optional(),
  note: z.string().max(300).optional(),
});

const finalizeSchema = z.object({
  serverId: z.string().min(1),
  draftId: z.string().min(1),
  action: z.literal('finalize'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

const chunkSchema = z.object({
  serverId: z.string().min(1),
  draftId: z.string().min(1),
  index: z.number().int().min(0),
  content: z.string(),
});

interface DraftRow {
  id: string;
  server_id: string;
  path: string;
  user_id: string;
  status: string;
  expected_bytes: string | number | null;
  expected_sha256: string | null;
  chunk_count: number | null;
}

async function loadDraft(serverId: string, draftId: string, userId: string): Promise<DraftRow> {
  const draft = await queryOne<DraftRow>(
    'select id, server_id, path, user_id, status, expected_bytes, expected_sha256, chunk_count from editor_drafts where id = $1',
    [draftId],
  );
  if (!draft || draft.server_id !== serverId || draft.user_id !== userId) {
    throw new ApiError('Draft upload not found for this server.', 404, 'draft_not_found');
  }
  return draft;
}

/**
 * Chunked draft upload.
 *
 * A 20 MB file is sent as N ordered chunks and joined exactly once, server-side.
 * Nothing is concatenated in the browser and no request carries the whole file,
 * which is what keeps mobile Safari from dying on large edits.
 */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(z.union([createSchema, finalizeSchema]));

  if (input.action === 'create') {
    const server = await assertServerAccess(user, input.serverId, 'file.write');
    const path = confineToRoot(server.projectRoot, input.path);
    if (isSecretPath(path)) {
      throw new ApiError('Refusing to store a draft for a protected session/credential path.', 403, 'secret_blocked');
    }
    const limit = editorLimitFor(server);
    if (input.totalBytes > limit) {
      throw new ApiError(
        `This file is ${Math.round(input.totalBytes / 1024)} KB — above the ${Math.round(limit / 1024 / 1024)} MB editor limit for this server. ` +
          'Raise “Editor file limit” in Settings (process ceiling ' +
          `${Math.round(env.maxEditorBytes / 1024 / 1024)} MB) or edit it over SFTP.`,
        413,
        'file_too_large',
        { bytes: input.totalBytes, limitBytes: limit, ceilingBytes: env.maxEditorBytes },
      );
    }

    const existing = await queryOne<{ id: string }>(
      'select id from editor_drafts where server_id = $1 and path = $2 and user_id = $3',
      [server.id, path, user.id],
    );
    const draftId = existing?.id ?? uuid();
    // Chunks are sliced by the client in UTF-16 code units, so the expected
    // count comes from the character length (bytes would differ for non-ASCII).
    const chunks = input.totalChars
      ? Math.ceil(input.totalChars / env.editorChunkBytes)
      : Math.ceil(input.totalBytes / env.editorChunkBytes);
    await query(
      `insert into editor_drafts
         (id, server_id, path, user_id, content, base_sha256, status, note, expected_bytes, expected_sha256, chunk_count, updated_at)
       values ($1,$2,$3,$4,'',$5,'uploading',$6,$7,null,$8, now())
       on conflict (server_id, path, user_id) do update set content = '', base_sha256 = excluded.base_sha256,
         status = 'uploading', note = excluded.note, expected_bytes = excluded.expected_bytes,
         expected_sha256 = null, chunk_count = excluded.chunk_count, updated_at = now()`,
      [draftId, server.id, path, user.id, input.baseSha ?? null, input.note ?? null, input.totalBytes, chunks],
    );
    await query('delete from editor_draft_chunks where draft_id = $1', [draftId]);

    return ok({
      action: 'create',
      draftId,
      path,
      totalBytes: input.totalBytes,
      chunkBytes: env.editorChunkBytes,
      chunks,
      limitBytes: limit,
    });
  }

  const server = await assertServerAccess(user, input.serverId, 'file.write');
  const draft = await loadDraft(server.id, input.draftId, user.id);
  if (draft.status !== 'uploading') {
    throw new ApiError('This draft is not waiting for chunks.', 409, 'draft_not_uploading');
  }
  const rows = await query<{ idx: number; content: string; bytes: string | number }>(
    'select idx, content, bytes from editor_draft_chunks where draft_id = $1 order by idx asc',
    [draft.id],
  );
  const declaredChunks = Number(draft.chunk_count ?? 0);
  const expectedChunks = declaredChunks > 0 ? declaredChunks : rows.length;
  // Contiguity is checked by position, not by count: a gap must never be joined
  // into a draft that silently lost a slice.
  const contiguous = rows.every((row, index) => Number(row.idx) === index);
  if (!rows.length || rows.length !== expectedChunks || !contiguous) {
    const missing: number[] = [];
    for (let index = 0; index < expectedChunks; index += 1) {
      if (!rows.some((row) => Number(row.idx) === index)) missing.push(index);
    }
    throw new ApiError(
      `Upload is incomplete: ${rows.length}/${expectedChunks} chunks received${missing.length ? ` (missing ${missing.slice(0, 8).join(', ')})` : ''}. Nothing was stored as a draft.`,
      409,
      'chunks_missing',
      { received: rows.length, expected: expectedChunks, missing },
    );
  }

  const content = rows.map((row) => row.content).join('');
  const bytes = Buffer.byteLength(content, 'utf8');
  const expectedBytes = Number(draft.expected_bytes ?? 0);
  if (bytes !== expectedBytes) {
    throw new ApiError(
      `Reassembled draft is ${bytes} bytes but the upload declared ${expectedBytes}. Nothing was stored — retry the save.`,
      409,
      'size_mismatch',
      { bytes, expectedBytes },
    );
  }
  const hash = sha256(content);
  if (input.sha256 && input.sha256.toLowerCase() !== hash) {
    throw new ApiError(
      `Reassembled draft hash ${hash.slice(0, 12)}… does not match the browser's ${input.sha256.slice(0, 12)}…. Nothing was stored.`,
      409,
      'draft_hash_mismatch',
      { sha256: hash },
    );
  }

  await query(
    `update editor_drafts set content = $2, expected_sha256 = $3, status = 'draft', updated_at = now() where id = $1`,
    [draft.id, content, hash],
  );
  await query('delete from editor_draft_chunks where draft_id = $1', [draft.id]);

  return ok({
    action: 'finalize',
    draftId: draft.id,
    path: draft.path,
    saved: true,
    status: 'draft',
    bytes,
    sha256: hash,
    chunks: rows.length,
  });
});

export const PUT = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(chunkSchema);
  const server = await assertServerAccess(user, input.serverId, 'file.write');
  const draft = await loadDraft(server.id, input.draftId, user.id);
  if (draft.status !== 'uploading') {
    throw new ApiError('This draft is no longer accepting chunks. Start the upload again.', 409, 'draft_not_uploading');
  }
  const maxChunkBytes = Buffer.byteLength(input.content, 'utf8');
  if (maxChunkBytes > env.editorChunkBytes * 4 + 4096) {
    throw new ApiError(
      `Chunk ${input.index} is ${Math.round(maxChunkBytes / 1024)} KB — larger than the configured chunk size.`,
      413,
      'chunk_too_large',
    );
  }
  const chunks = Number(draft.chunk_count ?? 0);
  if (chunks > 0 && input.index >= chunks) {
    throw new ApiError(`Chunk index ${input.index} is outside this upload (0…${chunks - 1}).`, 400, 'chunk_out_of_range');
  }

  await query(
    `insert into editor_draft_chunks (draft_id, idx, content, bytes) values ($1,$2,$3,$4)
     on conflict (draft_id, idx) do update set content = excluded.content, bytes = excluded.bytes`,
    [draft.id, input.index, input.content, maxChunkBytes],
  );
  const received = await queryOne<{ count: string | number }>(
    'select count(*)::int as count from editor_draft_chunks where draft_id = $1',
    [draft.id],
  );
  return ok({ draftId: draft.id, index: input.index, received: Number(received?.count ?? 0), chunks });
});

/**
 * Read a stored draft in slices.
 *
 * A 20 MB draft is never sent to the browser in one response: the editor asks
 * for one chunk at a time and builds the buffer itself. Offsets are UTF-16 code
 * units, matching `String.prototype.slice`, so a chunk boundary can never split
 * a surrogate pair owned by the server (the client joins the exact same units).
 */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const draftId = url.searchParams.get('draftId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!draftId) throw new ApiError('draftId is required', 400, 'draft_required');
  const server = await assertServerAccess(user, serverId, 'file.read');

  const draft = await queryOne<{ id: string; path: string; content: string; status: string; base_sha256: string | null; updated_at: string }>(
    'select id, path, content, status, base_sha256, updated_at from editor_drafts where id = $1 and server_id = $2',
    [draftId, server.id],
  );
  if (!draft) throw new ApiError('Draft not found for this server.', 404, 'draft_not_found');
  if (draft.status === 'uploading') {
    throw new ApiError('This draft is still uploading and cannot be read yet.', 409, 'draft_incomplete');
  }

  const mode = url.searchParams.get('mode') ?? 'chunk';
  const totalChars = draft.content.length;
  const bytes = Buffer.byteLength(draft.content, 'utf8');
  const meta = {
    draftId: draft.id,
    path: draft.path,
    status: draft.status,
    baseSha: draft.base_sha256,
    updatedAt: draft.updated_at,
    totalChars,
    bytes,
    chunkBytes: env.editorChunkBytes,
    sha256: sha256(draft.content),
  };

  if (mode === 'meta') return ok({ ...meta, content: null, mode: 'meta' });

  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const requestedLength = Number.parseInt(url.searchParams.get('length') ?? String(env.editorChunkBytes), 10) || env.editorChunkBytes;
  const length = Math.max(1, Math.min(requestedLength, 2 * 1024 * 1024));
  const end = Math.min(totalChars, offset + length);
  return ok({
    ...meta,
    mode: 'chunk',
    offset,
    length: Math.max(0, end - offset),
    nextOffset: end < totalChars ? end : null,
    content: draft.content.slice(offset, end),
  });
});
