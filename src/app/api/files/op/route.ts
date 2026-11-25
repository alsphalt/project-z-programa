import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import {
  copyPath,
  createFolder,
  deletePaths,
  movePath,
  renamePath,
  uploadFile,
  zipPaths,
} from '@/lib/files/ops';
import { joinRemote, parentOf, baseName } from '@/lib/security/paths';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mkdir'), serverId: z.string(), path: z.string().min(1) }),
  z.object({ action: z.literal('create'), serverId: z.string(), path: z.string().min(1), content: z.string().default('') }),
  z.object({ action: z.literal('rename'), serverId: z.string(), path: z.string().min(1), newName: z.string().min(1) }),
  z.object({ action: z.literal('move'), serverId: z.string(), paths: z.array(z.string()).min(1), destination: z.string().min(1) }),
  z.object({ action: z.literal('copy'), serverId: z.string(), path: z.string().min(1), destination: z.string().min(1), newName: z.string().optional() }),
  z.object({ action: z.literal('delete'), serverId: z.string(), paths: z.array(z.string()).min(1) }),
  z.object({ action: z.literal('zip'), serverId: z.string(), paths: z.array(z.string()).min(1) }),
]);

export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(schema);
  const permission = input.action === 'delete' ? 'file.delete' : 'file.write';
  const server = await assertServerAccess(user, input.serverId, permission);

  switch (input.action) {
    case 'mkdir': {
      const path = await createFolder(server, parentOf(input.path), baseName(input.path));
      await logActivity({ user, serverId: server.id, action: 'file.mkdir', target: path });
      return ok({ path });
    }
    case 'create': {
      const path = await createFile(server, input.path, input.content ?? '', user);
      return ok({ path });
    }
    case 'rename': {
      const destination = joinRemote(parentOf(input.path), input.newName.trim());
      const path = await renamePath(server, input.path, destination, user);
      return ok({ path });
    }
    case 'move': {
      const moved: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      for (const source of input.paths) {
        if (parentOf(source) === input.destination) continue;
        try {
          moved.push(await movePath(server, source, input.destination, user));
        } catch (error) {
          failed.push({ path: source, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (failed.length && !moved.length) throw new ApiError(failed[0].error, 502, 'move_failed', failed);
      return ok({ moved, failed });
    }
    case 'copy': {
      const path = await copyPath(
        server,
        input.path,
        input.destination,
        input.newName ?? baseName(input.path),
        user,
      );
      return ok({ path });
    }
    case 'delete': {
      const result = await deletePaths(server, input.paths, user, { backup: true });
      return ok(result);
    }
    case 'zip': {
      return ok(await zipPaths(server, input.paths, user));
    }
    default:
      throw new ApiError('Unsupported action', 400, 'unknown_action');
  }
});

/** Creating a file is an upload of its text so it is backed up and indexed. */
async function createFile(
  server: Parameters<typeof uploadFile>[0],
  path: string,
  content: string,
  user: Parameters<typeof uploadFile>[4],
) {
  const buffer = Buffer.from(content, 'utf8');
  return (await uploadFile(server, parentOf(path), baseName(path), buffer, user)).path;
}
