import 'server-only';
import { jsonb, parseJsonb, query, queryOne } from '../db';
import { uuid } from '../crypto';
import { decryptSecret } from '../crypto';
import { ApiError } from '../api';
import type { Permission, Principal } from '../auth/permissions';
import { createClient, maxEditorCeiling, normalizePanelUrl, PterodactylClient, PterodactylError } from '../pterodactyl/client';
import { DEFAULT_EXCLUDED_PATHS, isExcluded, normalizeRoot } from '../security/paths';
import { captureError } from '../errors/store';

export interface ServerRecord {
  id: string;
  name: string;
  panelUrl: string;
  serverIdentifier: string;
  projectRoot: string;
  allowedExtensions: string[];
  excludedPaths: string[];
  autoRestart: boolean;
  atomicWrites: boolean;
  startupTimeoutS: number;
  maxFileBytes: number;
  syncMode: 'polling' | 'events';
  syncIntervalS: number;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
  lastScanAt: string | null;
  lastSyncAt: string | null;
  connectionState: string;
  lastError: string | null;
  apiKeyHint: string;
}

interface Row {
  id: string;
  name: string;
  panel_url: string;
  server_identifier: string;
  api_key_encrypted: string;
  api_key_hint: string;
  project_root: string;
  allowed_extensions: unknown;
  excluded_paths: unknown;
  auto_restart: boolean;
  atomic_writes: boolean;
  startup_timeout_s: number;
  max_file_bytes: number;
  sync_mode: string;
  sync_interval_s: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_connected_at: string | null;
  last_scan_at: string | null;
  last_sync_at: string | null;
  connection_state: string;
  last_error: string | null;
}

function map(row: Row): ServerRecord {
  const excluded = parseJsonb<string[]>(row.excluded_paths, []);
  return {
    id: row.id,
    name: row.name,
    panelUrl: row.panel_url,
    serverIdentifier: row.server_identifier,
    projectRoot: normalizeRoot(row.project_root || '/'),
    allowedExtensions: parseJsonb<string[]>(row.allowed_extensions, []),
    excludedPaths: excluded.length ? excluded : DEFAULT_EXCLUDED_PATHS,
    autoRestart: row.auto_restart,
    atomicWrites: row.atomic_writes,
    startupTimeoutS: Number(row.startup_timeout_s ?? 90),
    maxFileBytes: Number(row.max_file_bytes ?? 16777216),
    syncMode: row.sync_mode === 'events' ? 'events' : 'polling',
    syncIntervalS: Number(row.sync_interval_s ?? 300),
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastConnectedAt: row.last_connected_at,
    lastScanAt: row.last_scan_at,
    lastSyncAt: row.last_sync_at,
    connectionState: row.connection_state,
    lastError: row.last_error,
    apiKeyHint: row.api_key_hint,
  };
}

/** Editor limit is per server but can never exceed the process ceiling. */
export function clampEditorLimit(bytes?: number): number {
  const ceiling = maxEditorCeiling();
  const fallback = Math.min(16 * 1024 * 1024, ceiling);
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return fallback;
  return Math.max(64 * 1024, Math.min(Math.round(bytes), ceiling));
}

export async function listServers(): Promise<ServerRecord[]> {
  const rows = await query<Row>('select * from connected_servers order by created_at asc');
  return rows.map(map);
}

export async function getServer(id: string): Promise<ServerRecord | null> {
  const row = await queryOne<Row>('select * from connected_servers where id = $1', [id]);
  return row ? map(row) : null;
}

export async function requireServer(id: string): Promise<ServerRecord> {
  const server = await getServer(id);
  if (!server) throw new ApiError('Connected server not found', 404, 'server_not_found');
  return server;
}

export interface CreateServerInput {
  name: string;
  panelUrl: string;
  serverIdentifier: string;
  apiKey: string;
  projectRoot?: string;
  excludedPaths?: string[];
  allowedExtensions?: string[];
  autoRestart?: boolean;
  atomicWrites?: boolean;
  startupTimeoutS?: number;
  maxFileBytes?: number;
  syncMode?: 'polling' | 'events';
  syncIntervalS?: number;
}

export async function createServer(input: CreateServerInput, principal: Principal): Promise<ServerRecord> {
  const { encryptSecret, hintSecret } = await import('../crypto');
  const id = uuid();
  const panelUrl = normalizePanelUrl(input.panelUrl);
  const projectRoot = normalizeRoot(input.projectRoot || '/');
  await query(
    `insert into connected_servers
      (id, name, panel_url, server_identifier, api_key_encrypted, api_key_hint, project_root,
        allowed_extensions, excluded_paths, auto_restart, atomic_writes, startup_timeout_s,
        max_file_bytes, sync_mode, sync_interval_s, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      input.name.trim(),
      panelUrl,
      input.serverIdentifier.trim(),
      encryptSecret(input.apiKey.trim()),
      hintSecret(input.apiKey.trim()),
      projectRoot,
      jsonb(input.allowedExtensions ?? []),
      jsonb(input.excludedPaths ?? DEFAULT_EXCLUDED_PATHS),
      input.autoRestart ?? true,
      input.atomicWrites ?? true,
      input.startupTimeoutS ?? 90,
      clampEditorLimit(input.maxFileBytes),
      input.syncMode === 'events' ? 'events' : 'polling',
      input.syncIntervalS ?? 300,
      principal.id,
    ],
  );
  const server = await requireServer(id);
  return server;
}

export async function updateServer(
  id: string,
  patch: Partial<CreateServerInput> & { isActive?: boolean },
): Promise<ServerRecord> {
  await requireServer(id);
  const { encryptSecret, hintSecret } = await import('../crypto');
  const fields: string[] = [];
  const values: Array<string | number | boolean | null> = [];
  const push = (column: string, value: string | number | boolean | null, cast = '') => {
    values.push(value);
    fields.push(`${column} = $${values.length}${cast}`);
  };

  if (patch.name !== undefined) push('name', patch.name.trim());
  if (patch.panelUrl !== undefined) push('panel_url', normalizePanelUrl(patch.panelUrl));
  if (patch.serverIdentifier !== undefined) push('server_identifier', patch.serverIdentifier.trim());
  if (patch.apiKey) {
    push('api_key_encrypted', encryptSecret(patch.apiKey.trim()));
    push('api_key_hint', hintSecret(patch.apiKey.trim()));
  }
  if (patch.projectRoot !== undefined) push('project_root', normalizeRoot(patch.projectRoot));
  if (patch.excludedPaths !== undefined) {
    push('excluded_paths', JSON.stringify(patch.excludedPaths), '::jsonb');
  }
  if (patch.allowedExtensions !== undefined) {
    push('allowed_extensions', JSON.stringify(patch.allowedExtensions), '::jsonb');
  }
  if (patch.autoRestart !== undefined) push('auto_restart', patch.autoRestart);
  if (patch.atomicWrites !== undefined) push('atomic_writes', patch.atomicWrites);
  if (patch.startupTimeoutS !== undefined) push('startup_timeout_s', patch.startupTimeoutS);
  if (patch.maxFileBytes !== undefined) push('max_file_bytes', clampEditorLimit(patch.maxFileBytes));
  if (patch.syncMode !== undefined) push('sync_mode', patch.syncMode);
  if (patch.syncIntervalS !== undefined) push('sync_interval_s', patch.syncIntervalS);
  if (patch.isActive !== undefined) push('is_active', patch.isActive);

  if (fields.length) {
    values.push(id);
    await query(
      `update connected_servers set ${fields.join(', ')}, updated_at = now() where id = $${values.length}`,
      values,
    );
    clientCache.clear();
  }
  return requireServer(id);
}

export async function deleteServer(id: string): Promise<void> {
  clientCache.clear();
  await query('delete from connected_servers where id = $1', [id]);
}

export async function setConnectionState(
  id: string,
  state: string,
  error: string | null,
  options: { connectedNow?: boolean; scannedNow?: boolean; syncedNow?: boolean } = {},
): Promise<void> {
  await query(
    `update connected_servers set connection_state = $2, last_error = $3,
       last_connected_at = case when $4 then now() else last_connected_at end,
       last_scan_at = case when $5 then now() else last_scan_at end,
       last_sync_at = case when $6 then now() else last_sync_at end,
       updated_at = now()
     where id = $1`,
    [id, state, error, options.connectedNow ?? false, options.scannedNow ?? false, options.syncedNow ?? false],
  );
}

const clientCache = new Map<string, PterodactylClient>();

export async function serverClient(server: ServerRecord): Promise<PterodactylClient> {
  const key = `${server.id}:${server.updatedAt}`;
  const cached = clientCache.get(key);
  if (cached) return cached;
  const row = await queryOne<{ api_key_encrypted: string }>(
    'select api_key_encrypted from connected_servers where id = $1',
    [server.id],
  );
  if (!row?.api_key_encrypted) throw new ApiError('Server has no stored credential', 409, 'no_credential');
  let apiKey: string;
  try {
    apiKey = decryptSecret(row.api_key_encrypted);
  } catch {
    throw new ApiError(
      'Stored Pterodactyl credential cannot be decrypted. The DARKNOTE_SECRET may have changed — re-enter the API key in Admin Settings.',
      409,
      'credential_unreadable',
    );
  }
  const client = createClient({
    panelUrl: server.panelUrl,
    apiKey,
    serverIdentifier: server.serverIdentifier,
  });
  clientCache.clear();
  clientCache.set(key, client);
  return client;
}

export async function testConnection(server: ServerRecord): Promise<{
  ok: boolean;
  panel?: { name?: string; version?: string };
  account?: { username: string; rootAdmin: boolean };
  server?: { name: string; identifier: string; suspended: boolean; state: string };
  permissions?: Record<string, string[]>;
  latencyMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    const client = await serverClient(server);
    const [panel, account, attributes, resources, permissions] = await Promise.all([
      client.getPanelInfo(),
      client.getAccount(),
      client.getServer(),
      client.getResources(),
      client.getPermissions().catch(() => ({})),
    ]);
    return {
      ok: true,
      panel,
      account: { username: account.username, rootAdmin: account.root_admin },
      server: {
        name: attributes.name,
        identifier: attributes.identifier,
        suspended: Boolean(attributes.is_suspended),
        state: String(resources.current_state ?? 'unknown'),
      },
      permissions,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    captureError({
      message,
      source: 'panel',
      serverId: server.id,
      code: error instanceof PterodactylError ? error.code : undefined,
      endpoint: error instanceof PterodactylError ? error.endpoint : '/api/client/servers',
      httpMethod: 'GET',
      httpStatus: error instanceof PterodactylError ? error.status : 0,
      context: { panelUrl: server.panelUrl, identifier: server.serverIdentifier, origin: 'connection-test' },
      evidence: [message],
    });
    return { ok: false, latencyMs: Date.now() - started, error: message };
  }
}

export async function serversVisibleTo(principal: Principal): Promise<ServerRecord[]> {
  const all = await listServers();
  if (principal.role === 'owner' || principal.role === 'admin') return all;
  const grants = await query<{ server_id: string }>(
    'select server_id from server_permissions where user_id = $1',
    [principal.id],
  );
  const allowed = new Set(grants.map((g) => g.server_id));
  return all.filter((server) => allowed.has(server.id));
}

export async function assertServerAccess(
  principal: Principal,
  serverId: string,
  permission: Permission,
): Promise<ServerRecord> {
  const server = await requireServer(serverId);
  if (principal.role === 'owner' || principal.role === 'admin') return server;
  const grant = await queryOne<{ permissions: unknown }>(
    'select permissions from server_permissions where server_id = $1 and user_id = $2',
    [serverId, principal.id],
  );
  if (!grant) throw new ApiError('You do not have access to this server.', 403, 'server_forbidden');
  const scoped = parseJsonb<string[]>(grant.permissions, []);
  if (scoped.length && !scoped.includes(permission)) {
    throw new ApiError(`Your server grant does not include "${permission}".`, 403, 'server_permission_denied');
  }
  return server;
}

export function isPathAllowed(server: ServerRecord, path: string): boolean {
  return !isExcluded(path, server.excludedPaths);
}
