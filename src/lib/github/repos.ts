import 'server-only';
import { ApiError } from '../api';
import { GitHubClient, type GitHubBranch, type GitHubRepo } from './client';
import { getConnectionView, requireClient } from './credentials';

/**
 * Repository discovery for the import interface.
 *
 * `GET /user/repos` is scoped by the token, so the list can only ever contain
 * repositories the connected account may access — no other account's private
 * repositories can appear. Results are cached for a minute so opening the import
 * dialog repeatedly does not burn the API rate limit.
 */

export interface RepoOption {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  language: string | null;
  updatedAt: string;
  defaultBranch: string;
  canPush: boolean;
}

interface CacheEntry {
  at: number;
  repos: RepoOption[];
  page: number;
  hasMore: boolean;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function toOption(repo: GitHubRepo): RepoOption {
  return {
    owner: repo.owner?.login ?? repo.full_name.split('/')[0],
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    private: Boolean(repo.private),
    language: repo.language,
    updatedAt: repo.pushed_at ?? repo.updated_at,
    defaultBranch: repo.default_branch,
    canPush: repo.permissions ? repo.permissions.push : true,
  };
}

export async function listRepositories(options: {
  search?: string;
  page?: number;
  perPage?: number;
  refresh?: boolean;
}): Promise<{ repos: RepoOption[]; page: number; hasMore: boolean; note: string }> {
  const client = await requireClient();
  const page = Math.max(1, Math.min(50, Math.round(options.page ?? 1)));
  const perPage = Math.max(10, Math.min(100, Math.round(options.perPage ?? 60)));
  const search = (options.search ?? '').trim().toLowerCase();

  const key = `${page}:${perPage}:${search}`;
  const cached = cache.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { repos: cached.repos, page: cached.page, hasMore: cached.hasMore, note: 'Cached repository list (60 s).' };
  }

  let raw: GitHubRepo[];
  try {
    raw = await client.listRepositories(page, perPage);
  } catch (error) {
    cache.delete(key);
    throw error;
  }

  let repos = raw.map(toOption);
  if (search) {
    // A search is applied to the page that was fetched; the caller can page on.
    repos = repos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(search) ||
        repo.fullName.toLowerCase().includes(search) ||
        (repo.description ?? '').toLowerCase().includes(search) ||
        (repo.language ?? '').toLowerCase().includes(search),
    );
  }

  const hasMore = raw.length === perPage;
  cache.set(key, { at: Date.now(), repos, page, hasMore });
  if (cache.size > 40) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return {
    repos,
    page,
    hasMore,
    note: search ? `Filtered ${raw.length} accessible repositories.` : `${raw.length} accessible repositories.`,
  };
}

export async function listRepositoryBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
  const client = await requireClient();
  if (!owner || !repo) throw new ApiError('Owner and repository are required.', 400, 'repository_required');
  return client.listBranches(owner, repo);
}

export interface ImportOptions {
  mode: 'repository' | 'account' | 'none';
  connected: boolean;
  status: 'connected' | 'disconnected' | 'failed';
  account: { login: string; avatar: string | null } | null;
  repository: RepoOption | null;
  configured: { owner: string; name: string; branch: string | null } | null;
  error: string | null;
  message: string;
}

/**
 * What the GitHub Import tab should show:
 *  - `repository` when a specific repository is configured in Admin Settings;
 *  - `account` when only an account is connected (searchable list);
 *  - `none` when neither is configured.
 */
export async function getImportOptions(): Promise<ImportOptions> {
  const view = await getConnectionView();
  if (!view.connected) {
    return {
      mode: 'none',
      connected: false,
      status: view.status,
      account: null,
      repository: null,
      configured: null,
      error: view.lastError,
      message: 'GITHUB NOT CONNECTED',
    };
  }

  if (view.repositoryConfigured && view.repository) {
    const client = await requireClient();
    try {
      const repo = await client.getRepository(view.repository.owner, view.repository.name);
      const option = toOption(repo);
      return {
        mode: 'repository',
        connected: true,
        status: view.status,
        account: view.account ? { login: view.account.login, avatar: view.account.avatar } : null,
        repository: option,
        configured: view.repository,
        error: null,
        message: 'A specific repository is configured — import it directly.',
      };
    } catch (error) {
      return {
        mode: 'none',
        connected: true,
        status: 'failed',
        account: view.account ? { login: view.account.login, avatar: view.account.avatar } : null,
        repository: null,
        configured: view.repository,
        error: error instanceof Error ? error.message : String(error),
        message: 'CONFIGURED REPOSITORY UNREACHABLE',
      };
    }
  }

  return {
    mode: 'account',
    connected: true,
    status: view.status,
    account: view.account ? { login: view.account.login, avatar: view.account.avatar } : null,
    repository: null,
    configured: null,
    error: null,
    message: 'Choose any repository this account can access.',
  };
}

/** Verifies the connection for real and reports exactly what worked. */
export async function testConnection(): Promise<{
  ok: boolean;
  checks: Array<{ key: string; label: string; ok: boolean | null; detail: string }>;
  account: string | null;
  scopes: string[];
}> {
  const checks: Array<{ key: string; label: string; ok: boolean | null; detail: string }> = [];
  const view = await getConnectionView();
  checks.push({
    key: 'token',
    label: 'Access token stored',
    ok: view.tokenConfigured,
    detail: view.tokenConfigured ? `Stored and encrypted (${view.tokenHint ?? 'hint unavailable'})` : 'No token stored',
  });

  if (!view.tokenConfigured) {
    return { ok: false, checks, account: null, scopes: [] };
  }

  let client: GitHubClient;
  try {
    client = await requireClient();
  } catch (error) {
    checks.push({
      key: 'auth',
      label: 'GitHub authorisation',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, checks, account: null, scopes: [] };
  }

  let login: string | null = null;
  let scopes: string[] = [];
  try {
    const result = await client.getAuthenticatedUser();
    login = result.user.login;
    scopes = result.scopes;
    checks.push({
      key: 'auth',
      label: 'GitHub authorisation',
      ok: true,
      detail: `Authenticated as ${result.user.login}${scopes.length ? ` · scopes: ${scopes.join(', ')}` : ''}`,
    });
  } catch (error) {
    checks.push({
      key: 'auth',
      label: 'GitHub authorisation',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, checks, account: null, scopes: [] };
  }

  try {
    const repos = await client.listRepositories(1, 10);
    checks.push({
      key: 'repositories',
      label: 'Repository access',
      ok: true,
      detail: `${repos.length} repositories visible on the first page`,
    });
  } catch (error) {
    checks.push({
      key: 'repositories',
      label: 'Repository access',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (view.repositoryConfigured && view.repository) {
    try {
      const repo = await client.getRepository(view.repository.owner, view.repository.name);
      checks.push({
        key: 'repository',
        label: 'Configured repository',
        ok: true,
        detail: `${repo.full_name}${repo.private ? ' (private)' : ''} · default branch ${repo.default_branch} · push ${repo.permissions?.push ? 'allowed' : 'not allowed'}`,
      });
      try {
        const head = await client.getBranchHead(
          view.repository.owner,
          view.repository.name,
          view.repository.branch || repo.default_branch,
        );
        checks.push({
          key: 'branch',
          label: 'Branch readable',
          ok: true,
          detail: `${view.repository.branch || repo.default_branch} at ${head.sha.slice(0, 7)}`,
        });
      } catch (error) {
        checks.push({
          key: 'branch',
          label: 'Branch readable',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      checks.push({
        key: 'repository',
        label: 'Configured repository',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({
      key: 'repository',
      label: 'Configured repository',
      ok: null,
      detail: 'No specific repository configured — the account list is used instead',
    });
  }

  return { ok: checks.every((check) => check.ok !== false), checks, account: login, scopes };
}
