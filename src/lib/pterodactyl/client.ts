/**
 * Pterodactyl Client API client (panel v1).
 *
 * Endpoints implemented against the official panel routes
 * (`routes/api-client.php`): server view, resources, websocket, command,
 * power, startup, activity and the full `/files` group.
 *
 * Credentials live only on the server. This module is never imported by a
 * client component.
 */

export interface PteroConnection {
  baseUrl: string;
  apiKey: string;
  serverId: string;
  timeoutMs?: number;
}

export class PterodactylError extends Error {
  status: number;
  code: string;
  endpoint: string;
  detail?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; endpoint?: string; detail?: unknown } = {}) {
    super(message);
    this.name = 'PterodactylError';
    this.status = opts.status ?? 0;
    this.code = opts.code ?? 'unknown';
    this.endpoint = opts.endpoint ?? '';
    this.detail = opts.detail;
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
  get isPermissionDenied() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isRateLimited() {
    return this.status === 429;
  }
  get isConnectionError() {
    return this.status === 0;
  }
}

export interface PteroFileEntry {
  name: string;
  mode: string;
  mode_bits: string;
  size: number;
  is_file: boolean;
  is_symlink: boolean;
  mimetype: string;
  created_at: string;
  modified_at: string;
  directory?: boolean;
}

export interface PteroServerAttributes {
  identifier: string;
  name: string;
  description?: string;
  node?: string;
  status?: string | null;
  is_suspended?: boolean;
  limits?: { memory: number; swap: number; disk: number; io: number; cpu: number };
  sftp_details?: { ip: string; port: number; username: string };
  relationships?: { allocations?: { data: Array<{ attributes: { ip: string; port: number; is_default: boolean } }> } };
}

export interface PteroResources {
  current_state: string;
  is_suspended?: boolean;
  resources?: {
    memory_bytes: number;
    memory_limit_bytes: number;
    cpu_absolute: number;
    disk_bytes: number;
    network_rx_bytes: number;
    network_tx_bytes: number;
    uptime: number;
  };
}

export interface PteroWebsocketCredentials {
  token: string;
  socket: string;
}

export function normalizePanelUrl(raw: string): string {
  let url = (raw ?? '').trim();
  if (!url) throw new PterodactylError('Panel URL is required');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/api\/client$/i, '');
  const parsed = new URL(url);
  if (!parsed.hostname) throw new PterodactylError('Panel URL is not a valid URL');
  return `${parsed.protocol}//${parsed.host}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) ? 1 : 0)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Process-wide ceiling; mirrors env.maxEditorBytes without importing env here. */
export function maxEditorCeiling(): number {
  return Number(process.env.DARKNOTE_MAX_EDITOR_BYTES ?? 64 * 1024 * 1024);
}

export class PterodactylClient {
  private baseUrl: string;
  private apiKey: string;
  readonly serverId: string;
  private timeoutMs: number;
  /** Number of HTTP calls made by this instance — surfaced in diagnostics. */
  calls = 0;

  constructor(conn: PteroConnection) {
    this.baseUrl = normalizePanelUrl(conn.baseUrl);
    this.apiKey = conn.apiKey.trim();
    this.serverId = conn.serverId;
    this.timeoutMs = conn.timeoutMs ?? 20_000;
    if (!this.apiKey) throw new PterodactylError('Pterodactyl API key is required');
    // Application keys (ptla_) authenticate /api/application and are rejected by
    // every /api/client route. Catching that here turns a confusing 401 into an
    // actionable message.
    if (/^ptla_/i.test(this.apiKey)) {
      throw new PterodactylError(
        'This is an Application API key (ptla_…). The control center talks to the Client API: create a key under Account → API Credentials in the panel (it starts with ptlc_).',
        { status: 401, code: 'application_key_used' },
      );
    }
    if (!this.serverId) throw new PterodactylError('Pterodactyl server identifier is required');
  }

  get panelHost(): string {
    return new URL(this.baseUrl).host;
  }

  private async raw(pathname: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const url = `${this.baseUrl}/api/client${pathname}`;
    this.calls += 1;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'DarknoteControlCenter/1.0',
          ...(init.headers ?? {}),
        },
        cache: 'no-store',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PterodactylError(
        `Cannot reach ${this.panelHost}: ${message}. Check the panel URL, DNS, TLS certificate and that the panel allows API access from this server.`,
        { endpoint: pathname, code: 'connection_failed' },
      );
    }

    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '2');
      await sleep(Math.min(Math.max(retryAfter, 1), 10) * 1000);
      return this.raw(pathname, init, attempt + 1);
    }
    if (response.status >= 500 && attempt < 1) {
      await sleep(600);
      return this.raw(pathname, init, attempt + 1);
    }
    return response;
  }

  private async failure(response: Response, pathname: string): Promise<PterodactylError> {
    let detail: unknown = undefined;
    let message = `Pterodactyl responded ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          detail = parsed;
          const first = parsed?.errors?.[0];
          if (first?.detail) message = String(first.detail);
          else if (parsed?.error) message = String(parsed.error);
        } catch {
          message = `${message}: ${text.slice(0, 200)}`;
        }
      }
    } catch {
      /* ignore body read failure */
    }
    const code =
      response.status === 401
        ? 'invalid_api_key'
        : response.status === 403
          ? 'permission_denied'
          : response.status === 404
            ? 'not_found'
            : response.status === 429
              ? 'rate_limited'
              : 'api_error';
    return new PterodactylError(message, { status: response.status, code, endpoint: pathname, detail });
  }

  private async json<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(pathname, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) throw await this.failure(response, pathname);
    if (response.status === 204) return {} as T;
    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PterodactylError('Panel returned a non-JSON response. Is this a Pterodactyl panel URL?', {
        endpoint: pathname,
        code: 'invalid_response',
      });
    }
  }

  private filesPath(suffix: string): string {
    return `/servers/${encodeURIComponent(this.serverId)}/files${suffix}`;
  }

  private serverPath(suffix = ''): string {
    return `/servers/${encodeURIComponent(this.serverId)}${suffix}`;
  }

  // ---- account / panel -----------------------------------------------------
  /**
   * `GET /api/client` is the account's server list on a real panel, not panel
   * metadata, so this deliberately tolerates several shapes. The authoritative
   * connection proof is `getServer()` + `getResources()`, not this call.
   */
  async getPanelInfo(): Promise<{ name?: string; version?: string; node?: string }> {
    const res = await this.json<{ meta?: { version?: string }; name?: string; object?: string }>('/');
    return {
      name: res?.name ?? (res?.object === 'list' ? 'Pterodactyl' : 'Pterodactyl'),
      version: res?.meta?.version,
    };
  }

  async getAccount(): Promise<{ id: number; email: string; username: string; root_admin: boolean }> {
    const res = await this.json<{ attributes: { id: number; email: string; username: string; root_admin: boolean } }>(
      '/account',
    );
    return res.attributes;
  }

  /** Panel-side permission map for the authenticated account on this server. */
  async getPermissions(): Promise<Record<string, string[]>> {
    return this.json<Record<string, string[]>>('/permissions');
  }

  // ---- server --------------------------------------------------------------
  async getServer(): Promise<PteroServerAttributes> {
    const res = await this.json<{ attributes: PteroServerAttributes }>(this.serverPath(''));
    return res.attributes;
  }

  async getResources(): Promise<PteroResources> {
    return this.json<PteroResources>(this.serverPath('/resources'));
  }

  async getStartup(): Promise<{
    current_startup_command?: string;
    docker_image?: string;
    variables?: Array<{ env_variable: string; name: string; server_value: string; default_value: string }>;
  }> {
    const res = await this.json<{ attributes: Record<string, unknown> }>(this.serverPath('/startup'));
    return res.attributes as never;
  }

  /** Panel-side backups (may be disabled on the host). */
  async backups(): Promise<
    Array<{
      uuid: string;
      name: string;
      bytes: number;
      createdAt: string | null;
      completedAt: string | null;
      isSuccessful: boolean;
      isLocked: boolean;
    }>
  > {
    const res = await this.json<{
      data: Array<{
        attributes: {
          uuid: string;
          name: string;
          bytes: number;
          created_at: string | null;
          completed_at: string | null;
          is_successful: boolean;
          is_locked: boolean;
        };
      }>;
    }>(this.serverPath('/backups'));
    return (res.data ?? []).map((item) => ({
      uuid: item.attributes.uuid,
      name: item.attributes.name,
      bytes: Number(item.attributes.bytes ?? 0),
      createdAt: item.attributes.created_at,
      completedAt: item.attributes.completed_at,
      isSuccessful: Boolean(item.attributes.is_successful),
      isLocked: Boolean(item.attributes.is_locked),
    }));
  }

  /** Ask the panel to build a whole-server backup. It completes asynchronously. */
  async createBackup(name: string): Promise<{ uuid: string | null; name: string }> {
    const res = await this.json<{ attributes?: { uuid?: string; name?: string } }>(this.serverPath('/backups'), {
      method: 'POST',
      body: JSON.stringify({ name: name.trim().slice(0, 100), ignored_files: [] }),
    });
    return { uuid: res?.attributes?.uuid ?? null, name: res?.attributes?.name ?? name };
  }

  async backupDownloadUrl(uuid: string): Promise<string> {
    const res = await this.json<{ attributes: { url: string } }>(
      this.serverPath(`/backups/${encodeURIComponent(uuid)}/download`),
    );
    if (!res?.attributes?.url) {
      throw new PterodactylError('Panel did not return a backup download URL', {
        endpoint: '/backups/download',
        code: 'download_unavailable',
      });
    }
    return res.attributes.url;
  }

  async getActivity(page = 1, perPage = 30): Promise<unknown> {
    return this.json(this.serverPath(`/activity?page=${page}&per_page=${perPage}`));
  }

  async getWebsocketCredentials(): Promise<PteroWebsocketCredentials> {
    const res = await this.json<{ data: PteroWebsocketCredentials }>(this.serverPath('/websocket'));
    if (!res?.data?.token || !res?.data?.socket) {
      throw new PterodactylError('Panel did not return websocket credentials', {
        endpoint: this.serverPath('/websocket'),
        code: 'websocket_unavailable',
      });
    }
    return res.data;
  }

  async sendPower(signal: 'start' | 'stop' | 'restart' | 'kill'): Promise<void> {
    await this.json(this.serverPath('/power'), { method: 'POST', body: JSON.stringify({ signal }) });
  }

  async sendCommand(command: string): Promise<void> {
    await this.json(this.serverPath('/command'), { method: 'POST', body: JSON.stringify({ command }) });
  }

  // ---- files ---------------------------------------------------------------
  async listFiles(directory = '/'): Promise<PteroFileEntry[]> {
    const qs = new URLSearchParams({ directory });
    const res = await this.json<{ data: Array<{ attributes: PteroFileEntry }> }>(this.filesPath('/list?' + qs));
    return (res.data ?? []).map((item) => item.attributes);
  }

  /**
   * Read a file's bytes. The panel route has no range support, so the whole file
   * is transferred once; the caller is expected to cache it and slice chunks for
   * the browser (see src/lib/files/read-cache.ts).
   */
  async readFile(file: string, maxBytes = 64 * 1024 * 1024): Promise<string> {
    const qs = new URLSearchParams({ file });
    const response = await this.raw(this.filesPath('/contents?' + qs), {
      headers: { Accept: 'text/plain, */*' },
    });
    if (!response.ok) throw await this.failure(response, '/files/contents');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new PterodactylError(
        `${file} is ${formatBytes(buffer.byteLength)} — larger than the ${formatBytes(maxBytes)} editor limit. ` +
          `Raise “Editor file limit” for this server (maximum ${formatBytes(maxEditorCeiling())}) or edit it over SFTP.`,
        { status: 413, endpoint: '/files/contents', code: 'file_too_large' },
      );
    }
    // Decoding must be lossless: `buffer.toString('utf8')` silently rewrites
    // invalid sequences to U+FFFD, which would then be saved back over the file as
    // corruption. `ignoreBOM: true` keeps a BOM so a round-trip stays byte-exact.
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      throw new PterodactylError(
        `${file} is not valid UTF-8 text (binary or a legacy encoding). It cannot be edited as code without corrupting it — download it or use SFTP.`,
        { status: 415, endpoint: '/files/contents', code: 'not_utf8_text' },
      );
    }
  }

  async writeFile(file: string, content: string): Promise<void> {
    const qs = new URLSearchParams({ file });
    const response = await this.raw(this.filesPath('/write?' + qs), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
    });
    if (!response.ok) throw await this.failure(response, '/files/write');
  }

  async downloadUrl(file: string): Promise<string> {
    const qs = new URLSearchParams({ file });
    const res = await this.json<{ attributes: { url: string } }>(this.filesPath('/download?' + qs));
    if (!res?.attributes?.url) {
      throw new PterodactylError('Panel did not return a download URL', {
        endpoint: '/files/download',
        code: 'download_unavailable',
      });
    }
    return res.attributes.url;
  }

  async deleteFiles(root: string, files: string[]): Promise<void> {
    await this.json(this.filesPath('/delete'), {
      method: 'POST',
      body: JSON.stringify({ root, files }),
    });
  }

  async createFolder(root: string, name: string): Promise<void> {
    await this.json(this.filesPath('/create-folder'), {
      method: 'POST',
      body: JSON.stringify({ root, name }),
    });
  }

  /** Rename or move files. `from`/`to` are names relative to the same root. */
  async rename(root: string, files: Array<{ from: string; to: string }>): Promise<void> {
    await this.json(this.filesPath('/rename'), { method: 'PUT', body: JSON.stringify({ root, files }) });
  }

  async copy(location: string): Promise<void> {
    await this.json(this.filesPath('/copy'), { method: 'POST', body: JSON.stringify({ location }) });
  }

  async chmod(root: string, files: Array<{ file: string; mode: string }>): Promise<void> {
    await this.json(this.filesPath('/chmod'), { method: 'PUT', body: JSON.stringify({ root, files }) });
  }

  async compress(root: string, files: string[]): Promise<void> {
    await this.json(this.filesPath('/compress'), { method: 'POST', body: JSON.stringify({ root, files }) });
  }

  async decompress(root: string, file: string): Promise<void> {
    await this.json(this.filesPath('/decompress'), { method: 'POST', body: JSON.stringify({ root, file }) });
  }

  /** Two-step signed upload, as documented for the client API. */
  async uploadFile(directory: string, fileName: string, data: Buffer | Uint8Array): Promise<void> {
    const qs = new URLSearchParams({ directory });
    const res = await this.json<{ attributes: { url: string } }>(this.filesPath('/upload?' + qs));
    const signedUrl = res?.attributes?.url;
    if (!signedUrl) {
      throw new PterodactylError('Panel did not return an upload URL', {
        endpoint: '/files/upload',
        code: 'upload_unavailable',
      });
    }
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(data)]), fileName);
    let response: Response;
    try {
      response = await fetch(signedUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new PterodactylError(
        `Upload to the panel's signed URL failed: ${error instanceof Error ? error.message : String(error)}`,
        { endpoint: '/files/upload', code: 'upload_failed' },
      );
    }
    if (!response.ok) {
      throw new PterodactylError(`Upload rejected by panel (${response.status})`, {
        status: response.status,
        endpoint: '/files/upload',
        code: 'upload_rejected',
      });
    }
  }

  async fetchDownload(url: string, maxBytes: number): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(60_000), cache: 'no-store' });
    } catch (error) {
      throw new PterodactylError(
        `Download from panel storage failed: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'download_failed' },
      );
    }
    if (!response.ok) {
      throw new PterodactylError(`Download link rejected (${response.status})`, {
        status: response.status,
        code: 'download_failed',
      });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new PterodactylError(`Download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`, {
        code: 'file_too_large',
      });
    }
    return buffer;
  }
}

export interface ServerConnectionConfig {
  panelUrl: string;
  apiKey: string;
  serverIdentifier: string;
  timeoutMs?: number;
}

export function createClient(config: ServerConnectionConfig): PterodactylClient {
  return new PterodactylClient({
    baseUrl: config.panelUrl,
    apiKey: config.apiKey,
    serverId: config.serverIdentifier,
    timeoutMs: config.timeoutMs,
  });
}
