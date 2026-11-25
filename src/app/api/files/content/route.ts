import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import {
  cachedFileContent,
  editorLimitFor,
  indexedFile,
  readFileCached,
  validateContent,
} from '@/lib/files/service';
import { confineToRoot, isEditable, isSecretPath } from '@/lib/security/paths';
import { queryOne } from '@/lib/db';
import { languageFor, secretKindFor } from '@/lib/views';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Open a production file.
 *
 * Modes:
 *  - `meta`            metadata + hashes only (the file is downloaded once and
 *                      cached server-side for 90 s)
 *  - `chunk`           `offset`/`length` slice of the cached text, in UTF-16 code
 *                      units, so the browser never receives a 20 MB response
 *  - default           the whole file (kept for small callers and scripts)
 *
 * Pterodactyl has no ranged read, so the first request necessarily transfers the
 * whole file to this server. It is never held in the browser in one piece.
 */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const requested = url.searchParams.get('path');
  const mode = url.searchParams.get('mode') ?? 'full';
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!requested) throw new ApiError('path is required', 400, 'path_required');
  const server = await assertServerAccess(user, serverId, 'file.read');
  const path = confineToRoot(server.projectRoot, requested);

  if (isSecretPath(path)) {
    throw new ApiError(
      'This path is a WhatsApp session, credential or key file. It is protected and cannot be opened in the editor.',
      403,
      'secret_blocked',
    );
  }

  const limitBytes = editorLimitFor(server);
  const snapshot = await readFileCached(server, path, { maxBytes: limitBytes, force: url.searchParams.get('fresh') === '1' });
  const indexRow = await indexedFile(server.id, path);
  const cached = await cachedFileContent(server.id, path);
  const draft = await queryOne<{
    id: string;
    content: string;
    base_sha256: string | null;
    updated_at: string;
    status: string;
    expected_bytes: string | number | null;
  }>(
    `select id, content, base_sha256, updated_at, status, expected_bytes from editor_drafts
      where server_id = $1 and path = $2 and user_id = $3 and status in ('draft','conflict')`,
    [server.id, path, user.id],
  );

  /**
   * A stored draft can be as large as the file. In `meta` mode only its
   * identity and size are returned so opening a big file does not stream a big
   * draft; the editor then pulls the draft through /api/drafts/chunk?mode=read.
   */
  const draftInlineLimit = mode === 'meta' ? 512 * 1024 : Number.POSITIVE_INFINITY;
  const draftBytes = draft ? Buffer.byteLength(draft.content, 'utf8') : 0;

  const base = {
    path,
    sha256: snapshot.sha256,
    language: languageFor(path) ?? 'plaintext',
    modifiedAt: snapshot.modifiedAt,
    sizeBytes: snapshot.sizeBytes,
    totalChars: snapshot.content.length,
    limitBytes,
    ceilingBytes: env.maxEditorBytes,
    chunkBytes: env.editorChunkBytes,
    largeFile: snapshot.sizeBytes > 1024 * 1024,
    indexedSha: indexRow?.sha256 ?? null,
    inSync: Boolean(indexRow?.sha256 && indexRow.sha256 === snapshot.sha256),
    cachedAt: cached?.fetchedAt ?? null,
    draft: draft
      ? {
          id: draft.id,
          content: draftBytes <= draftInlineLimit ? draft.content : null,
          bytes: draftBytes,
          truncated: draftBytes > draftInlineLimit,
          baseSha: draft.base_sha256,
          updatedAt: draft.updated_at,
          status: draft.status,
        }
      : null,
    editable: isEditable(path),
    secretKind: secretKindFor(path),
  };

  if (mode === 'meta') {
    return ok({ ...base, content: null, mode: 'meta' });
  }

  if (mode === 'chunk') {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
    const length = Math.max(1, Math.min(Number.parseInt(url.searchParams.get('length') ?? String(env.editorChunkBytes), 10) || env.editorChunkBytes, 4 * 1024 * 1024));
    const end = Math.min(snapshot.content.length, offset + length);
    const content = snapshot.content.slice(offset, end);
    return ok({
      ...base,
      mode: 'chunk',
      offset,
      length: content.length,
      nextOffset: end < snapshot.content.length ? end : null,
      content,
    });
  }

  const validation = await validateContent(path, snapshot.content);
  return ok({
    ...base,
    mode: 'full',
    content: snapshot.content,
    validation: {
      ok: validation.ok,
      errors: validation.errors.map((message, index) => ({ line: index + 1, message })),
      warnings: validation.warnings,
    },
  });
});
