import 'server-only';
import { jsonb, query, queryOne } from '../db';
import { sha256, uuid } from '../crypto';
import { env } from '../env';
import type { ServerRecord } from '../servers/repo';
import { serverClient, setConnectionState } from '../servers/repo';
import type { PteroFileEntry } from '../pterodactyl/client';
import {
  baseName,
  extensionOf,
  isProbablyBinary,
  isSecretPath,
  isExcluded,
  joinRemote,
  normalizeRemotePath,
} from '../security/paths';
import { cacheFileContent, recordUpdateEvent, upsertIndexEntry } from '../files/service';
import { summarizeJavaScript } from '../search/ast';
import { mapLimit } from '../util/async';
import type { Principal } from '../auth/permissions';

export interface DiscoveredFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string | null;
  extension: string;
  isDirectory: boolean;
  secret: boolean;
  indexed: boolean;
  changed: boolean;
  added: boolean;
  error?: string;
}

export interface ScanResult {
  syncId: string;
  status: 'succeeded' | 'failed' | 'partial';
  scannedFiles: number;
  scannedDirectories: number;
  indexed: number;
  added: number;
  changed: number;
  deleted: number;
  failed: number;
  casesFound: number;
  functionsFound: number;
  durationMs: number;
  message: string;
  files: DiscoveredFile[];
  accessErrors: Array<{ path: string; error: string }>;
  truncated: boolean;
}

interface WalkEntry {
  path: string;
  name: string;
  parentPath: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string | null;
  extension: string;
  secret: boolean;
}

/**
 * LIVE SERVER DISCOVERY.
 *
 * Walks the real Pterodactyl filesystem through the Client API, indexes what it
 * actually finds, caches text content for search/editor hydration and records
 * every add/change/delete. Nothing is assumed to exist.
 */
export async function scanServer(options: {
  server: ServerRecord;
  user?: Pick<Principal, 'id'> | null;
  mode?: 'scan' | 'poll' | 'manual';
  deep?: boolean;
}): Promise<ScanResult> {
  const { server } = options;
  const mode = options.mode ?? 'manual';
  const startedAt = Date.now();
  const syncId = uuid();

  await query(
    `insert into sync_history (id, server_id, mode, status, started_at) values ($1,$2,$3,'running', now())`,
    [syncId, server.id, mode],
  );
  await setConnectionState(server.id, 'scanning', null);

  const client = await serverClient(server);
  const root = normalizeRemotePath(server.projectRoot);
  const exclusions = server.excludedPaths;
  const limit = env.maxIndexFiles;
  const maxDepth = env.maxIndexDepth;

  const files: WalkEntry[] = [];
  const directories: string[] = [];
  const accessErrors: Array<{ path: string; error: string }> = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let truncated = false;

  try {
    while (queue.length) {
      const batch = queue.splice(0, 4);
      const listings = await mapLimit(batch, 4, async (item) => {
        try {
          const entries = await client.listFiles(item.path);
          return { item, entries };
        } catch (error) {
          accessErrors.push({
            path: item.path,
            error: error instanceof Error ? error.message : String(error),
          });
          return { item, entries: [] as PteroFileEntry[] };
        }
      });

      for (const { item, entries } of listings) {
        for (const entry of entries) {
          const fullPath = joinRemote(item.path, entry.name);
          if (isExcluded(fullPath, exclusions)) continue;
          const isDirectory = entry.is_file === false;
          if (isDirectory) {
            if (item.depth < maxDepth) queue.push({ path: fullPath, depth: item.depth + 1 });
            else truncated = true;
            directories.push(fullPath);
            continue;
          }
          if (files.length >= limit) {
            truncated = true;
            continue;
          }
          files.push({
            path: fullPath,
            name: entry.name,
            parentPath: item.path,
            isDirectory: false,
            isSymlink: Boolean(entry.is_symlink),
            size: Number(entry.size ?? 0),
            modifiedAt: entry.modified_at ?? null,
            extension: extensionOf(entry.name),
            secret: isSecretPath(fullPath),
          });
        }
      }
      if (files.length >= limit) break;
    }

    // ---- index + content hashing -------------------------------------------
    const existingRows = await query<{
      path: string;
      sha256: string | null;
      size_bytes: string | number;
      remote_modified_at: string | null;
      content_cached: boolean;
      deleted_at: string | null;
    }>('select path, sha256, size_bytes, remote_modified_at, content_cached, deleted_at from file_indexes where server_id = $1 and is_directory = false', [
      server.id,
    ]);
    const existing = new Map(existingRows.map((row) => [row.path, row]));

    const changedPaths: string[] = [];
    const addedPaths: string[] = [];
    const discovered: DiscoveredFile[] = [];
    let indexed = 0;
    let failed = 0;

    const results = await mapLimit(files, 4, async (file) => {
      const prior = existing.get(file.path);
      const sizeDiffers = !prior || Number(prior.size_bytes) !== file.size;
      const mtimeDiffers = !prior || prior.remote_modified_at !== file.modifiedAt;
      const needsContent =
        !file.secret &&
        !isProbablyBinary(file.path) &&
        file.size <= server.maxFileBytes &&
        (!prior || !prior.content_cached || sizeDiffers || mtimeDiffers || options.deep);

      let hash = prior?.sha256 ?? null;
      let cached = prior?.content_cached ?? false;
      let accessError: string | null = null;

      if (needsContent) {
        try {
          const content = await client.readFile(file.path, server.maxFileBytes);
          hash = sha256(content);
          cached = true;
          await cacheFileContent(server.id, file.path, hash, content);
        } catch (error) {
          accessError = error instanceof Error ? error.message : String(error);
        }
      }

      await upsertIndexEntry(server.id, {
        path: file.path,
        name: file.name,
        parentPath: file.parentPath,
        extension: file.extension,
        isDirectory: false,
        isSymlink: file.isSymlink,
        sizeBytes: file.size,
        modifiedAt: file.modifiedAt,
        sha256: hash,
        contentCached: cached,
        secret: file.secret,
        accessError,
      });

      const isNew = !prior || prior.deleted_at !== null;
      const isChanged = Boolean(prior && prior.sha256 && hash && prior.sha256 !== hash);
      if (isNew) {
        addedPaths.push(file.path);
        await recordUpdateEvent(server.id, 'added', file.path, 'scan', { size: file.size });
      } else if (isChanged) {
        changedPaths.push(file.path);
        await recordUpdateEvent(server.id, 'changed', file.path, 'scan', {
          previousHash: prior?.sha256,
          hash,
        });
        await detectConflict(server.id, file.path, prior?.sha256 ?? null, hash ?? null);
      }
      if (accessError) failed += 1;
      else indexed += 1;

      return {
        path: file.path,
        name: file.name,
        size: file.size,
        modifiedAt: file.modifiedAt,
        extension: file.extension,
        isDirectory: false,
        secret: file.secret,
        indexed: !accessError,
        changed: isChanged,
        added: isNew,
        error: accessError ?? undefined,
      } satisfies DiscoveredFile;
    });

    discovered.push(...results);

    // directories are indexed too so the explorer can render without a scan
    for (const dir of directories) {
      await upsertIndexEntry(server.id, {
        path: dir,
        name: baseName(dir),
        parentPath: dir.slice(0, dir.lastIndexOf('/')) || '/',
        extension: '',
        isDirectory: true,
        isSymlink: false,
        sizeBytes: 0,
        modifiedAt: null,
        sha256: null,
        contentCached: false,
        secret: isSecretPath(dir),
        accessError: null,
      });
    }

    // ---- deletions ---------------------------------------------------------
    let deleted = 0;
    if (!truncated) {
      const seen = new Set(files.map((file) => file.path));
      for (const row of existingRows) {
        if (row.deleted_at) continue;
        if (seen.has(row.path)) continue;
        if (!row.path.startsWith(`${root === '/' ? '' : root}/`)) continue;
        if (isExcluded(row.path, exclusions)) continue;
        await query(
          'update file_indexes set deleted_at = now(), sha256 = null, content_cached = false where server_id = $1 and path = $2',
          [server.id, row.path],
        );
        await query('delete from file_contents where server_id = $1 and path = $2', [server.id, row.path]);
        // Keep the hash so the explorer can pair a delete with a later add and
        // report it as a rename/move instead of two unrelated events.
        await recordUpdateEvent(server.id, 'deleted', row.path, 'scan', {
          sha256: row.sha256,
          size: Number(row.size_bytes ?? 0),
        });
        await query('delete from command_metadata where server_id = $1 and path = $2', [server.id, row.path]);
        deleted += 1;
      }
    }

    // ---- AST metadata for search + case manager ---------------------------
    const meta = await refreshCommandMetadata(server.id, changedPaths.concat(addedPaths));

    // ---- finish ------------------------------------------------------------
    const durationMs = Date.now() - startedAt;
    const status: ScanResult['status'] =
      accessErrors.length > 0 && indexed === 0 ? 'failed' : accessErrors.length > 0 ? 'partial' : 'succeeded';
    const message =
      status === 'failed'
        ? `Scan could not read any files. ${accessErrors[0]?.error ?? ''}`.trim()
        : `${indexed} files indexed, ${addedPaths.length} added, ${changedPaths.length} changed, ${deleted} deleted.`;

    await query(
      `update sync_history set status = $2, files_scanned = $3, files_indexed = $4, files_added = $5,
         files_changed = $6, files_deleted = $7, files_failed = $8, message = $9, finished_at = now()
       where id = $1`,
      [
        syncId,
        status,
        files.length,
        indexed,
        addedPaths.length,
        changedPaths.length,
        deleted,
        failed,
        message,
      ],
    );
    await setConnectionState(
      server.id,
      status === 'failed'
        ? 'failed'
        : changedPaths.length + addedPaths.length + deleted > 0
          ? 'remote_changes'
          : 'synchronized',
      status === 'failed' ? accessErrors[0]?.error ?? message : null,
      { scannedNow: true, connectedNow: true, syncedNow: status !== 'failed' },
    );
    await query(
      `insert into bot_status (id, server_id, container_state, whatsapp_state, checked_at)
       values ($1,$2,'unknown','unknown', now())
       on conflict (server_id) do nothing`,
      [uuid(), server.id],
    );
    return {
      syncId,
      status,
      scannedFiles: files.length,
      scannedDirectories: directories.length,
      indexed,
      added: addedPaths.length,
      changed: changedPaths.length,
      deleted,
      failed,
      casesFound: meta.cases,
      functionsFound: meta.functions,
      durationMs,
      message,
      files: discovered,
      accessErrors,
      truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query(
      `update sync_history set status = 'failed', message = $2, finished_at = now() where id = $1`,
      [syncId, message],
    );
    await setConnectionState(server.id, 'failed', message);
    throw error;
  }
}

async function detectConflict(
  serverId: string,
  filePath: string,
  previousHash: string | null,
  remoteHash: string | null,
): Promise<void> {
  const draft = await queryOne<{ id: string; base_sha256: string | null; content: string }>(
    `select id, base_sha256, content from editor_drafts
      where server_id = $1 and path = $2 and status in ('draft','conflict')`,
    [serverId, filePath],
  );
  if (!draft) return;
  if (draft.base_sha256 && remoteHash && draft.base_sha256 === remoteHash) return;

  const existing = await queryOne<{ id: string }>(
    `select id from sync_conflicts where server_id = $1 and path = $2 and resolution is null`,
    [serverId, filePath],
  );
  if (existing) return;

  const remote = await queryOne<{ content: string }>(
    'select content from file_contents where server_id = $1 and path = $2',
    [serverId, filePath],
  );
  await query(
    `insert into sync_conflicts (id, server_id, path, draft_id, base_sha256, remote_sha256, local_content, remote_content)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuid(), serverId, filePath, draft.id, draft.base_sha256 ?? previousHash, remoteHash, draft.content, remote?.content ?? ''],
  );
  await query(`update editor_drafts set status = 'conflict' where id = $1`, [draft.id]);
  await recordUpdateEvent(serverId, 'conflict', filePath, 'scan', { remoteHash });
}

/**
 * Parse all cached JavaScript/TypeScript files into command + function metadata.
 * Only files passed in (plus, on a full scan, everything cached) are refreshed.
 */
export async function refreshCommandMetadata(
  serverId: string,
  changedPaths: string[],
  options: { limit?: number } = {},
): Promise<{ cases: number; functions: number }> {
  const limit = Math.min(Math.max(options.limit ?? 400, 50), 4000);
  const candidates = await query<{ path: string; content: string; sha256: string }>(
    `select path, content, sha256 from file_contents where server_id = $1
      and (path like '%.js' or path like '%.cjs' or path like '%.mjs' or path like '%.ts')
      order by length(content) desc limit $2`,
    [serverId, Math.max(limit * 2, 800)],
  );
  const wanted = changedPaths.length ? new Set(changedPaths) : null;
  const rows = wanted ? candidates.filter((row) => wanted.has(row.path)) : candidates.slice(0, limit);

  let cases = 0;
  let functions = 0;
  for (const row of rows) {
    const summary = summarizeJavaScript(row.content);
    if (!summary.ok) {
      // Keep a marker so the UI can surface unparseable files instead of hiding them.
      await query('delete from command_metadata where server_id = $1 and path = $2', [serverId, row.path]);
      continue;
    }
    const existingCount = await queryOne<{ count: string | number }>(
      'select count(*)::int as count from command_metadata where server_id = $1 and path = $2',
      [serverId, row.path],
    );
    if (Number(existingCount?.count ?? 0) > 0) {
      const same = await queryOne<{ count: string | number }>(
        'select count(*)::int as count from command_metadata where server_id = $1 and path = $2 and sha256 = $3',
        [serverId, row.path, row.sha256],
      );
      if (Number(same?.count ?? 0) > 0) continue;
    }
    await query('delete from command_metadata where server_id = $1 and path = $2', [serverId, row.path]);

    for (const item of summary.cases) {
      await query(
        `insert into command_metadata (id, server_id, path, kind, name, aliases, line_start, line_end, char_start, char_end, signature, sha256)
         values ($1,$2,$3,'case',$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
        [
          uuid(),
          serverId,
          row.path,
          item.name,
          jsonb(item.aliases),
          item.lineStart,
          item.lineEnd,
          item.charStart,
          item.charEnd,
          `case '${item.name}'`,
          row.sha256,
        ],
      );
      cases += 1;
      for (const alias of item.aliases) {
        await query(
          `insert into command_metadata (id, server_id, path, kind, name, aliases, line_start, line_end, char_start, char_end, signature, sha256)
           values ($1,$2,$3,'case_alias',$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
          [
            uuid(),
            serverId,
            row.path,
            alias,
            jsonb([item.name]),
            item.lineStart,
            item.lineEnd,
            item.charStart,
            item.charEnd,
            `alias of '${item.name}'`,
            row.sha256,
          ],
        );
        cases += 1;
      }
    }
    for (const fn of summary.functions) {
      await query(
        `insert into command_metadata (id, server_id, path, kind, name, aliases, line_start, line_end, char_start, char_end, signature, sha256)
         values ($1,$2,$3,'function',$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
        [
          uuid(),
          serverId,
          row.path,
          fn.name,
          jsonb([]),
          fn.lineStart,
          fn.lineEnd,
          fn.charStart,
          fn.charEnd,
          `${fn.async ? 'async ' : ''}${fn.kind} ${fn.name}(${fn.params.join(', ')})`,
          row.sha256,
        ],
      );
      functions += 1;
    }
  }
  return { cases, functions };
}
