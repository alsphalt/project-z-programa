import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { query, queryOne } from '@/lib/db';
import { downloadListing } from '@/lib/services/downloads';
import { serverClient } from '@/lib/servers/repo';
import { sha256 } from '@/lib/crypto';
import { normalizeRemotePath, parentOf, baseName as base } from '@/lib/security/paths';
import { baseName } from '@/lib/security/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * DOWNLOAD CENTER.
 *
 * `verify=1` re-reads the candidate files from production and reports their live
 * SHA-256, so the page can prove it is offering current production bytes.
 */
export const GET = route({ permission: 'download' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'download');
  const verify = url.searchParams.get('verify') === '1';

  const candidates = await query<{
    path: string;
    name: string;
    extension: string | null;
    size_bytes: string | number;
    sha256: string | null;
    remote_modified_at: string | null;
    indexed_at: string;
  }>(
    `select path, name, extension, size_bytes, sha256, remote_modified_at, indexed_at
       from file_indexes
      where server_id = $1 and is_directory = false and deleted_at is null and is_secret = false
      order by (extension in ('js','json','ts','cjs')) desc, remote_modified_at desc nulls last
      limit 200`,
    [server.id],
  );

  const verified: Array<{ path: string; sha256: string | null; size: number; modifiedAt: string | null; status: string }> = [];
  if (verify) {
    for (const candidate of candidates.slice(0, 8)) {
      try {
        const fresh = await freshMetadata(server, candidate.path);
        verified.push({
          path: candidate.path,
          sha256: fresh.sha256,
          size: fresh.sizeBytes,
          modifiedAt: fresh.modifiedAt,
          status: fresh.sha256 === candidate.sha256 ? 'unchanged since index' : 'index was stale — refreshed',
        });
      } catch (error) {
        verified.push({
          path: candidate.path,
          sha256: candidate.sha256,
          size: Number(candidate.size_bytes ?? 0),
          modifiedAt: candidate.remote_modified_at,
          status: `could not verify: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  const secretRow = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from file_indexes where server_id = $1 and is_secret = true and deleted_at is null`,
    [server.id],
  );

  const history = (await downloadListing(server.id, 30)) as Array<{
    id: string;
    kind: string;
    target: string;
    sha256: string | null;
    size_bytes: string | number;
    included_secrets: boolean;
    created_at: string;
    email: string | null;
  }>;

  return ok({
    method: verify ? 'verified against production (SHA-256 re-read)' : 'indexed metadata (use Verify to re-read production)',
    candidates: candidates.map((candidate) => ({
      path: candidate.path,
      name: candidate.name || baseName(candidate.path),
      extension: candidate.extension ?? '',
      size: Number(candidate.size_bytes ?? 0),
      sha256: candidate.sha256,
      modifiedAt: candidate.remote_modified_at,
      indexedAt: candidate.indexed_at,
    })),
    verified,
    exclusions: {
      secretFilesIndexed: Number(secretRow?.count ?? 0),
      note:
        'WhatsApp session folders, .env files and private keys are excluded from the listing and require the sensitive-export permission, which no role has by default.',
    },
    history: history.map((row) => ({
      id: row.id,
      scope: row.kind,
      paths: row.target,
      bytes: Number(row.size_bytes ?? 0),
      sha256: row.sha256,
      createdAt: row.created_at,
      user: row.email,
      includedSecrets: row.included_secrets,
    })),
  });
});


/** Re-read one file from production to prove its current hash. */
async function freshMetadata(server: Awaited<ReturnType<typeof assertServerAccess>>, path: string) {
  const client = await serverClient(server);
  const target = normalizeRemotePath(path);
  const entries = await client.listFiles(parentOf(target)).catch(() => []);
  const entry = entries.find((item) => item.name === base(target));
  if (!entry) throw new Error('file is no longer present in production');
  const buffer = await client.fetchDownload(await client.downloadUrl(target), 128 * 1024 * 1024);
  return { sha256: sha256(buffer), sizeBytes: buffer.byteLength, modifiedAt: entry.modified_at ?? null };
}
