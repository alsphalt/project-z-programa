import 'server-only';
import { cookies } from 'next/headers';
import { dbKind } from './db';
import { warnMissingConfig } from './env';
import { CSRF_COOKIE, type SessionUser } from './auth/session';
import { serversVisibleTo } from './servers/repo';
import { PERMISSIONS, ROLE_PERMISSIONS } from './auth/permissions';

export interface SessionPayload {
  user: SessionUser;
  csrfToken: string;
  servers: Array<{
    id: string;
    name: string;
    panelUrl: string;
    serverIdentifier: string;
    projectRoot: string;
    connectionState: string;
    lastScanAt: string | null;
    lastSyncAt: string | null;
    autoRestart: boolean;
    syncMode: string;
    apiKeyHint: string;
    lastError: string | null;
  }>;
  database: string;
  configurationWarnings: string[];
  roles: Record<string, string[]>;
  permissionCatalog: readonly string[];
}

export async function buildSessionPayload(user: SessionUser): Promise<SessionPayload> {
  const store = await cookies();
  const csrfToken = store.get(CSRF_COOKIE)?.value ?? '';
  const servers = await serversVisibleTo(user);
  return {
    user,
    csrfToken,
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      panelUrl: server.panelUrl,
      serverIdentifier: server.serverIdentifier,
      projectRoot: server.projectRoot,
      connectionState: server.connectionState,
      lastScanAt: server.lastScanAt,
      lastSyncAt: server.lastSyncAt,
      autoRestart: server.autoRestart,
      syncMode: server.syncMode,
      apiKeyHint: server.apiKeyHint,
      lastError: server.lastError,
    })),
    database: dbKind(),
    configurationWarnings: warnMissingConfig(),
    roles: ROLE_PERMISSIONS,
    permissionCatalog: PERMISSIONS,
  };
}
