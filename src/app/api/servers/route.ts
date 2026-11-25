import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import {
  createServer,
  getServer,
  serversVisibleTo,
  setConnectionState,
  testConnection,
} from '@/lib/servers/repo';
import { logActivity } from '@/lib/audit';
import { query } from '@/lib/db';
import { countsFor, serverStateView } from '@/lib/views';
import { maxEditorCeiling } from '@/lib/pterodactyl/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().min(2).max(80),
  panelUrl: z.string().min(4),
  serverIdentifier: z.string().min(4).max(64),
  apiKey: z.string().min(20),
  rootPath: z.string().optional(),
  projectRoot: z.string().optional(),
  excludedPaths: z.array(z.string()).optional(),
  allowedExtensions: z.array(z.string()).optional(),
  autoRestart: z.boolean().optional(),
  atomicWrites: z.boolean().optional(),
  startupTimeoutS: z.number().int().min(15).max(600).optional(),
  maxFileBytes: z.number().int().min(65536).max(256 * 1024 * 1024).optional(),
  syncMode: z.enum(['polling', 'events']).optional(),
  syncIntervalS: z.number().int().min(60).max(86400).optional(),
});

export const GET = route({ permission: 'file.read' }, async ({ user }) => {
  const servers = await serversVisibleTo(user);
  const counts = await query<{ server_id: string; files: string | number; deployments: string | number; scans: string | number }>(
    `select s.id as server_id,
            (select count(*)::int from file_indexes i where i.server_id = s.id and i.is_directory = false and i.deleted_at is null) as files,
            (select count(*)::int from deployments d where d.server_id = s.id) as deployments,
            (select count(*)::int from sync_history h where h.server_id = s.id) as scans
       from connected_servers s`,
  );
  const byId = new Map(counts.map((row) => [row.server_id, row]));

  return ok({
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      panelUrl: server.panelUrl,
      serverIdentifier: server.serverIdentifier,
      rootPath: server.projectRoot,
      projectRoot: server.projectRoot,
      state: serverStateView(server),
      connectionState: server.connectionState,
      lastSeenAt: server.lastConnectedAt,
      lastScanAt: server.lastScanAt,
      lastError: server.lastError,
      apiKeyHint: server.apiKeyHint,
      maxFileBytes: server.maxFileBytes,
      editorCeilingBytes: maxEditorCeiling(),
      counts: {
        files: Number(byId.get(server.id)?.files ?? 0),
        deployments: Number(byId.get(server.id)?.deployments ?? 0),
        scans: Number(byId.get(server.id)?.scans ?? 0),
      },
      myLevel: user.role,
    })),
  });
});

export const POST = route({ permission: 'server.manage' }, async ({ user, body }) => {
  const input = await body(createSchema);
  const identifier = input.serverIdentifier.trim();
  if (!/^[a-zA-Z0-9-]{6,64}$/.test(identifier)) {
    throw new ApiError(
      'Server identifier must be the short identifier shown in the panel URL (for example 1a2b3c4d), not the server name.',
      400,
      'invalid_identifier',
    );
  }
  const server = await createServer(
    {
      name: input.name,
      panelUrl: input.panelUrl,
      serverIdentifier: identifier,
      apiKey: input.apiKey,
      projectRoot: input.rootPath ?? input.projectRoot ?? '/',
      excludedPaths: input.excludedPaths,
      allowedExtensions: input.allowedExtensions,
      autoRestart: input.autoRestart,
      atomicWrites: input.atomicWrites,
      startupTimeoutS: input.startupTimeoutS,
      maxFileBytes: input.maxFileBytes,
      syncMode: input.syncMode,
      syncIntervalS: input.syncIntervalS,
    },
    user,
  );

  // Prove the credentials immediately instead of trusting the form.
  const test = await testConnection(server);
  await setConnectionState(server.id, test.ok ? 'connected' : 'failed', test.ok ? null : (test.error ?? 'Connection failed'), {
    connectedNow: test.ok,
  });
  await logActivity({
    user,
    serverId: server.id,
    action: 'server.created',
    target: `${server.name} (${server.panelUrl})`,
    detail: { connectionOk: test.ok, error: test.error ?? null },
  });

  const refreshed = (await getServer(server.id)) ?? server;
  const counts = await countsFor(server.id);
  return ok({
    server: {
      id: refreshed.id,
      name: refreshed.name,
      panelUrl: refreshed.panelUrl,
      serverIdentifier: refreshed.serverIdentifier,
      rootPath: refreshed.projectRoot,
      state: serverStateView(refreshed),
      lastSeenAt: refreshed.lastConnectedAt,
      lastError: refreshed.lastError,
      apiKeyHint: refreshed.apiKeyHint,
      counts,
      myLevel: user.role,
    },
    connection: test,
  });
});
