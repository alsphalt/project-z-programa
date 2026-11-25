import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { query, queryOne } from '@/lib/db';
import { sha256, uuid } from '@/lib/crypto';
import type { Principal } from '@/lib/auth/permissions';
import { confineToRoot, isSecretPath } from '@/lib/security/paths';
import { editorLimitFor } from '@/lib/files/service';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Drafts live only in the database. They are never production content. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const path = url.searchParams.get('path');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'file.read');

  if (path) {
    const target = confineToRoot(server.projectRoot, path);
    const draft = await queryOne<{ id: string; content: string; base_sha256: string | null; updated_at: string; status: string }>(
      `select id, content, base_sha256, updated_at, status from editor_drafts
        where server_id = $1 and path = $2 and user_id = $3`,
      [server.id, target, user.id],
    );
    const mode = url.searchParams.get('mode') ?? 'full';
    if (!draft) return ok({ draft: null });
    const meta = {
      id: draft.id,
      baseSha: draft.base_sha256,
      updatedAt: draft.updated_at,
      status: draft.status,
      bytes: Buffer.byteLength(draft.content, 'utf8'),
      totalChars: draft.content.length,
    };
    if (mode === 'meta') return ok({ draft: meta, content: null, mode: 'meta' });
    if (mode === 'chunk') {
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
      const length = Math.max(1, Math.min(Number.parseInt(url.searchParams.get('length') ?? String(env.editorChunkBytes), 10) || env.editorChunkBytes, 4 * 1024 * 1024));
      const end = Math.min(draft.content.length, offset + length);
      return ok({
        draft: meta,
        content: draft.content.slice(offset, end),
        mode: 'chunk',
        offset,
        nextOffset: end < draft.content.length ? end : null,
      });
    }
    return ok({ draft: { ...meta, content: draft.content }, mode: 'full' });
  }

  const drafts = await query<{ path: string; updated_at: string; base_sha256: string | null; status: string }>(
    `select path, updated_at, base_sha256, status from editor_drafts
      where server_id = $1 and user_id = $2 and status in ('draft','conflict')
      order by updated_at desc limit 100`,
    [server.id, user.id],
  );
  return ok({
    drafts: drafts.map((draft) => ({
      path: draft.path,
      updatedAt: draft.updated_at,
      baseSha: draft.base_sha256,
      status: draft.status,
    })),
  });
});

const saveSchema = z.object({
  serverId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  baseSha: z.string().nullable().optional(),
  note: z.string().max(300).optional(),
});

async function saveDraft(user: Principal, input: z.infer<typeof saveSchema>) {
  const server = await assertServerAccess(user, input.serverId, 'file.write');
  const path = confineToRoot(server.projectRoot, input.path);
  if (isSecretPath(path)) {
    throw new ApiError('Refusing to store a draft for a protected session/credential path.', 403, 'secret_blocked');
  }
  const bytes = Buffer.byteLength(input.content, 'utf8');
  const limit = editorLimitFor(server);
  if (bytes > limit) {
    throw new ApiError(
      `Draft is ${Math.round(bytes / 1024)} KB — above this server's ${Math.round(limit / 1024 / 1024)} MB editor limit.`,
      413,
      'file_too_large',
      { bytes, limitBytes: limit },
    );
  }

  await query(
    `insert into editor_drafts (id, server_id, path, user_id, content, base_sha256, status, note, updated_at)
     values ($1,$2,$3,$4,$5,$6,'draft',$7, now())
     on conflict (server_id, path, user_id) do update set content = excluded.content,
       base_sha256 = excluded.base_sha256, status = 'draft', note = excluded.note, updated_at = now()`,
    [uuid(), server.id, path, user.id, input.content, input.baseSha ?? null, input.note ?? null],
  );
  // A whole-file save replaces any chunked upload in progress for this file.
  await query(
    `delete from editor_draft_chunks where draft_id in
       (select id from editor_drafts where server_id = $1 and path = $2 and user_id = $3)`,
    [server.id, path, user.id],
  );
  return ok({ saved: true, path, status: 'draft', bytes, sha256: sha256(input.content) });
}

export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(saveSchema);
  return saveDraft(user, input);
});

/** The editor has always saved drafts with PUT; without this alias Next answers 405. */
export const PUT = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(saveSchema);
  return saveDraft(user, input);
});

export const DELETE = route({ permission: 'file.write' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const path = url.searchParams.get('path');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'file.write');

  if (path) {
    const target = confineToRoot(server.projectRoot, path);
    await query('delete from editor_drafts where server_id = $1 and path = $2 and user_id = $3', [
      server.id,
      target,
      user.id,
    ]);
    return ok({ discarded: true, path: target });
  }
  await query('delete from editor_drafts where server_id = $1 and user_id = $2', [server.id, user.id]);
  return ok({ discarded: true, all: true });
});
