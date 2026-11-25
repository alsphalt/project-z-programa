import 'server-only';

/**
 * Minimal, dependency-free GitHub REST client.
 *
 * Only the endpoints this panel actually needs are wrapped, and every failure is
 * translated into a `GitHubError` whose `kind` drives the message the operator
 * sees (expired token, missing scope, rate limit, non-fast-forward …). Nothing
 * here logs the token: the Authorization header is only ever built in one place.
 */

export type GitHubErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'conflict'
  | 'validation'
  | 'network'
  | 'unknown';

export class GitHubError extends Error {
  kind: GitHubErrorKind;
  status: number;
  endpoint: string;
  detail?: unknown;
  retryAfterSeconds?: number;

  constructor(
    message: string,
    kind: GitHubErrorKind,
    status: number,
    endpoint: string,
    detail?: unknown,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
    this.endpoint = endpoint;
    this.detail = detail;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function githubApiBase(): string {
  return (process.env.DARKNOTE_GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '');
}

export function githubOAuthBase(): string {
  return (process.env.DARKNOTE_GITHUB_OAUTH_BASE ?? 'https://github.com').replace(/\/+$/, '');
}

const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 25_000;

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  language: string | null;
  default_branch: string;
  updated_at: string;
  pushed_at: string | null;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
  size?: number;
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  html_url: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
}

export interface GitHubBlob {
  sha: string;
  size: number;
  content: string;
  encoding: string;
}

export interface GitHubRef {
  ref: string;
  object: { sha: string; type: string };
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skip JSON decoding (used for endpoints that answer 204/empty). */
  expectEmpty?: boolean;
}

function errorKind(status: number, code: string, body: unknown): GitHubErrorKind {
  const message = typeof body === 'object' && body ? String((body as { message?: string }).message ?? '') : '';
  if (status === 401) return 'auth';
  if (status === 403) return /rate limit/i.test(message) || code === 'rate_limit' ? 'rate_limit' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  if (status === 429) return 'rate_limit';
  return 'unknown';
}

const KIND_MESSAGES: Record<GitHubErrorKind, string> = {
  auth: 'GitHub rejected the token (401). It is invalid, revoked or expired — reconnect in Admin Settings → GitHub Connection.',
  forbidden: 'GitHub refused the request (403). The token is missing the repository permission this operation needs.',
  not_found: 'GitHub could not find the repository, branch or file (404). Check the owner, repository name and branch, or the token’s access to a private repository.',
  rate_limit: 'GitHub API rate limit reached. Wait for the window to reset, then retry.',
  conflict: 'GitHub reported a conflict (409) — the remote changed while the operation was running.',
  validation: 'GitHub rejected the request (422). The branch may have moved (non-fast-forward) or the payload was refused.',
  network: 'Could not reach GitHub. Check the outbound network connection and try again.',
  unknown: 'GitHub returned an unexpected response.',
};

export class GitHubClient {
  private token: string;

  constructor(token: string) {
    if (!token || token.trim().length < 8) throw new GitHubError(KIND_MESSAGES.auth, 'auth', 401, '/user');
    this.token = token.trim();
  }

  private async raw(pathname: string, options: RequestOptions = {}): Promise<Response> {
    const url = pathname.startsWith('http') ? pathname : `${githubApiBase()}${pathname}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'darknote-control-center',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GitHubError(
        `${KIND_MESSAGES.network} (${message})`,
        'network',
        0,
        pathname,
      );
    }
    return response;
  }

  private async decode<T>(pathname: string, response: Response, expectEmpty?: boolean): Promise<T> {
    if (response.status === 204 || expectEmpty) {
      // Read the body so the socket can be reused; an empty body is expected here.
      await response.text().catch(() => '');
      return undefined as T;
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text.slice(0, 400) };
      }
    }

    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0);
      const retryAfter = Number(response.headers.get('retry-after') ?? 0);
      const kind =
        response.status === 403 && remaining === '0' ? 'rate_limit' : errorKind(response.status, '', parsed);
      const retrySeconds = retryAfter
        ? retryAfter
        : reset
          ? Math.max(1, reset - Math.floor(Date.now() / 1000))
          : undefined;
      const detailMessage =
        typeof parsed === 'object' && parsed && typeof (parsed as { message?: string }).message === 'string'
          ? (parsed as { message: string }).message
          : '';
      const base = KIND_MESSAGES[kind];
      const suffix =
        kind === 'rate_limit' && retrySeconds ? ` Resets in ${retrySeconds}s.` : detailMessage ? ` GitHub says: ${detailMessage}` : '';
      throw new GitHubError(`${base}${suffix}`, kind, response.status, pathname, parsed, retrySeconds);
    }

    return parsed as T;
  }

  private async request<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(pathname, options);
    return this.decode<T>(pathname, response, options.expectEmpty);
  }

  /** Token → account. Also returns the OAuth scopes GitHub reports for the token. */
  async getAuthenticatedUser(): Promise<{ user: GitHubUser; scopes: string[] }> {
    const response = await this.raw('/user');
    const user = await this.decode<GitHubUser>('/user', response);
    const scopes = (response.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
    return { user, scopes };
  }

  /** Every repository the token can see, newest activity first. */
  async listRepositories(page = 1, perPage = 100): Promise<GitHubRepo[]> {
    const query = new URLSearchParams({
      affiliation: 'owner,collaborator,organization_member',
      sort: 'updated',
      direction: 'desc',
      per_page: String(perPage),
      page: String(page),
    });
    return this.request<GitHubRepo[]>(`/user/repos?${query.toString()}`);
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request<GitHubRepo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  async listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
    return this.request<GitHubBranch[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    );
  }

  async getBranchHead(owner: string, repo: string, branch: string): Promise<{ sha: string }> {
    const ref = await this.request<GitHubRef>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return { sha: ref.object.sha };
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<GitHubCommit> {
    return this.request<GitHubCommit>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${sha}`,
    );
  }

  /** Repository hooks. Used to register the DARKNOTE webhook on connect. */
  async listHooks(owner: string, repo: string): Promise<Array<{ id: number; config?: { url?: string } }>> {
    return this.request<Array<{ id: number; config?: { url?: string } }>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    );
  }

  async createHook(
    owner: string,
    repo: string,
    options: { url: string; secret: string; events?: string[] },
  ): Promise<{ id: number }> {
    return this.request<{ id: number }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`, {
      method: 'POST',
      body: {
        name: 'web',
        active: true,
        events: options.events ?? ['push'],
        config: {
          url: options.url,
          content_type: 'json',
          secret: options.secret,
          insecure_ssl: '0',
        },
      },
    });
  }

  async updateHook(
    owner: string,
    repo: string,
    hookId: number,
    options: { url: string; secret: string; events?: string[] },
  ): Promise<{ id: number }> {
    return this.request<{ id: number }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`,
      {
        method: 'PATCH',
        body: {
          active: true,
          events: options.events ?? ['push'],
          config: {
            url: options.url,
            content_type: 'json',
            secret: options.secret,
            insecure_ssl: '0',
          },
        },
      },
    );
  }

  /** Full recursive tree. Truncated responses are reported by `truncated`. */
  async getTree(owner: string, repo: string, treeSha: string): Promise<{ tree: GitHubTreeEntry[]; truncated: boolean }> {
    return this.request<{ tree: GitHubTreeEntry[]; truncated: boolean }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeSha}?recursive=1`,
    );
  }

  async getBlob(owner: string, repo: string, blobSha: string): Promise<GitHubBlob> {
    return this.request<GitHubBlob>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${blobSha}`,
    );
  }

  /** Current blob sha of one path, used to verify a push actually landed. */
  async getContentSha(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const data = await this.request<{ sha: string } | Array<{ sha: string }>>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${encodeURIComponent(ref)}`,
      );
      if (Array.isArray(data)) return null;
      return data?.sha ?? null;
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  async createBlob(owner: string, repo: string, content: string, encoding: 'utf-8' | 'base64'): Promise<{ sha: string }> {
    return this.request<{ sha: string }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, {
      method: 'POST',
      body: { content, encoding },
    });
  }

  async createTree(
    owner: string,
    repo: string,
    /**
     * `sha: null` deletes the path from the tree. That is the documented way to
     * remove a file through the Git Data API, and it is the only deletion this
     * console ever performs.
     */
    body: {
      base_tree?: string;
      tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }>;
    },
  ): Promise<{ sha: string }> {
    return this.request<{ sha: string }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, {
      method: 'POST',
      body,
    });
  }

  async createCommit(
    owner: string,
    repo: string,
    body: { message: string; tree: string; parents: string[] },
  ): Promise<GitHubCommit> {
    return this.request<GitHubCommit>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
      { method: 'POST', body },
    );
  }

  /**
   * Fast-forward only. `force` is deliberately never set: if someone pushed to
   * the branch first, GitHub answers 422 and the local edit stays local.
   */
  async updateBranchRef(owner: string, repo: string, branch: string, sha: string): Promise<GitHubRef> {
    return this.request<GitHubRef>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: 'PATCH', body: { sha, force: false } },
    );
  }
}
