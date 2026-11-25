import { z } from 'zod';
import { route, ok, ApiError, rateLimit } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { beginScan, endScan, scanProject } from '@/lib/services/explorer';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const schema = z.object({ serverId: z.string().min(1), deep: z.boolean().optional() });

/**
 * Re-scan the real project.
 *
 * This walks the panel filesystem (adding/changing/deleting index rows), re-reads
 * content, re-parses cases/functions and reports renames where a delete and an add
 * share a SHA-256. It never edits a project file.
 */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(schema);
  const server = await assertServerAccess(user, input.serverId, 'file.write');
  rateLimit(`explorer-scan:${user.id}`, 6, 60_000);

  if (!beginScan(server.id)) {
    throw new ApiError('A scan is already running for this server. Wait for it to finish.', 409, 'scan_running');
  }
  try {
    await logActivity({ user, serverId: server.id, action: 'explorer.scan_started', target: server.projectRoot });
    const result = await scanProject(server, user);
    await logActivity({
      user,
      serverId: server.id,
      action: 'explorer.scan_finished',
      target: server.projectRoot,
      detail: {
        added: result.added.length,
        changed: result.changed.length,
        deleted: result.deleted.length,
        renamed: result.renamed.length,
        cases: result.cases,
        functions: result.functions,
      },
    });
    return ok(result);
  } catch (error) {
    throw new ApiError(
      `Scan failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
      'scan_failed',
    );
  } finally {
    endScan(server.id);
  }
});
