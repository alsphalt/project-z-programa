import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { indexedChildren, listDirectory } from '@/lib/files/ops';
import { breadcrumbsOf, isEditable } from '@/lib/security/paths';
import { languageFor, secretKindFor } from '@/lib/views';
import { baseName } from '@/lib/security/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Remote directory listing, read live from Pterodactyl with an index fallback. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const requested = url.searchParams.get('path') || '/';
  const server = await assertServerAccess(user, serverId, 'file.read');

  let path = requested;
  let parent: string | null = null;
  let entries: Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    mtime: string | null;
    sha256: string | null;
    language: string | null;
    isSecret: boolean;
    secretKind: string | null;
    editable: boolean;
  }> = [];
  let notice: string | null = null;

  try {
    const listing = await listDirectory(server, requested);
    path = listing.path;
    parent = listing.parent;
    entries = listing.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      size: entry.size,
      mtime: entry.modifiedAt,
      sha256: entry.sha256,
      language: entry.isDirectory ? null : languageFor(entry.name),
      isSecret: entry.secret,
      secretKind: entry.secret ? secretKindFor(entry.path) : null,
      editable: !entry.isDirectory && !entry.secret && isEditable(entry.path),
    }));
  } catch (error) {
    // The index is a snapshot, so say so rather than passing it off as live.
    path = requested;
    const fallback = await indexedChildren(server.id, requested);
    if (!fallback.length) throw error;
    entries = fallback.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      size: entry.size,
      mtime: entry.modifiedAt,
      sha256: entry.sha256,
      language: entry.isDirectory ? null : languageFor(entry.name),
      isSecret: entry.secret,
      secretKind: entry.secret ? secretKindFor(entry.path) : null,
      editable: !entry.isDirectory && !entry.secret && isEditable(entry.path),
    }));
    notice =
      'Showing the indexed snapshot because the panel could not be reached. Sizes and hashes may be stale — use Refresh after reconnecting.';
  }

  const rootPath = server.projectRoot;
  return ok({
    path,
    rootPath,
    parent,
    breadcrumbs: breadcrumbsOf(rootPath, path),
    entries,
    counts: {
      files: entries.filter((entry) => !entry.isDirectory).length,
      folders: entries.filter((entry) => entry.isDirectory).length,
      secrets: entries.filter((entry) => entry.isSecret).length,
    },
    notice,
    source: notice ? 'index' : 'pterodactyl',
    rootName: baseName(rootPath),
  });
});
