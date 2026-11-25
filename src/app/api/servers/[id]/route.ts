import { z } from 'zod';
import { route, ok } from '@/lib/api';
import { assertServerAccess, deleteServer, updateServer } from '@/lib/servers/repo';
import { logActivity } from '@/lib/audit';
import { serverPolicyView, serverStateView } from '@/lib/views';
import { maxEditorCeiling } from '@/lib/pterodactyl/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const policySchema = z.object({
  autoRestart: z.boolean().optional(),
  healthTimeoutMs: z.number().int().min(5_000).max(900_000).optional(),
  ignore: z.array(z.string()).optional(),
  maxScanDepth: z.number().int().min(1).max(40).optional(),
  maxScanFiles: z.number().int().min(50).max(50_000).optional(),
  indexContent: z.boolean().optional(),
  healthyPatterns: z.array(z.string()).optional(),
  failurePatterns: z.array(z.string()).optional(),
});

const patchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  panelUrl: z.string().min(4).optional(),
  serverIdentifier: z.string().min(4).max(64).optional(),
  apiKey: z.string().min(20).optional(),
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
  isActive: z.boolean().optional(),
  policy: policySchema.optional(),
});

interface Params extends Record<string, string> {
  id: string;
}

export const GET = route<Params>({ permission: 'file.read' }, async ({ user, params }) => {
  const server = await assertServerAccess(user, params.id, 'file.read');
  return ok({
    server: {
      id: server.id,
      name: server.name,
      panelUrl: server.panelUrl,
      serverIdentifier: server.serverIdentifier,
      rootPath: server.projectRoot,
      projectRoot: server.projectRoot,
      apiKeyHint: server.apiKeyHint,
      state: serverStateView(server),
      connectionState: server.connectionState,
      lastSeenAt: server.lastConnectedAt,
      lastScanAt: server.lastScanAt,
      lastSyncAt: server.lastSyncAt,
      lastError: server.lastError,
      autoRestart: server.autoRestart,
      atomicWrites: server.atomicWrites,
      startupTimeoutS: server.startupTimeoutS,
      maxFileBytes: server.maxFileBytes,
      editorCeilingBytes: maxEditorCeiling(),
      syncMode: server.syncMode,
      syncIntervalS: server.syncIntervalS,
      policy: serverPolicyView(server),
    },
  });
});

export const PATCH = route<Params>({ permission: 'server.manage' }, async ({ user, params, body }) => {
  await assertServerAccess(user, params.id, 'server.manage');
  const patch = await body(patchSchema);

  // The UI edits a policy object; map the supported fields onto stored columns.
  const mapped = {
    name: patch.name,
    panelUrl: patch.panelUrl,
    serverIdentifier: patch.serverIdentifier,
    apiKey: patch.apiKey,
    projectRoot: patch.rootPath ?? patch.projectRoot,
    excludedPaths: patch.excludedPaths ?? patch.policy?.ignore,
    allowedExtensions: patch.allowedExtensions,
    autoRestart: patch.autoRestart ?? patch.policy?.autoRestart,
    atomicWrites: patch.atomicWrites,
    maxFileBytes: patch.maxFileBytes,
    startupTimeoutS:
      patch.startupTimeoutS ??
      (patch.policy?.healthTimeoutMs ? Math.max(15, Math.round(patch.policy.healthTimeoutMs / 1000)) : undefined),
    syncMode: patch.syncMode,
    syncIntervalS: patch.syncIntervalS,
    isActive: patch.isActive,
  };

  const server = await updateServer(params.id, mapped);
  await logActivity({
    user,
    serverId: server.id,
    action: 'server.updated',
    target: server.name,
    detail: { fields: Object.entries(mapped).filter(([, value]) => value !== undefined).map(([key]) => key) },
  });
  return ok({
    server: {
      id: server.id,
      name: server.name,
      rootPath: server.projectRoot,
      state: serverStateView(server),
      policy: serverPolicyView(server),
    },
  });
});

export const DELETE = route<Params>({ permission: 'server.manage' }, async ({ user, params }) => {
  const server = await assertServerAccess(user, params.id, 'server.manage');
  await deleteServer(params.id);
  await logActivity({
    user,
    action: 'server.deleted',
    target: `${server.name} (${server.panelUrl})`,
    severity: 'warning',
  });
  return ok({ deleted: true });
});
