import 'server-only';
import { ApiError } from '../api';
import { decryptSecret, encryptSecret, hintSecret } from '../crypto';
import { jsonb, parseJsonb, queryOne } from '../db';
import { GitHubClient, GitHubError } from './client';

/**
 * The GitHub connection lives in one row (`github_connection.id = 'default'`).
 *
 * The token is encrypted with the same AES-256-GCM envelope as the Pterodactyl
 * keys, no API route ever returns it, and only the last four characters are
 * exposed as a hint. Emails play no part in authorisation: the account is
 * whatever GitHub resolves the token to.
 */

export interface GitHubConnectionRow {
  id: string;
  auth_mode: string | null;
  token_encrypted: string | null;
  token_hint: string | null;
  token_scopes: unknown;
  account_login: string | null;
  account_name: string | null;
  account_id: string | null;
  account_avatar: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  repo_branch: string | null;
  oauth_client_id: string | null;
  oauth_client_secret_encrypted: string | null;
  oauth_state: string | null;
  oauth_state_expires_at: string | null;
  auto_sync: boolean;
  sync_delay_seconds: number;
  connected_at: string | null;
  last_verified_at: string | null;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_error: string | null;
  updated_at: string | null;
}

export interface GitHubConnectionView {
  connected: boolean;
  status: 'connected' | 'disconnected' | 'failed';
  authMode: 'token' | 'oauth' | null;
  tokenConfigured: boolean;
  tokenHint: string | null;
  scopes: string[];
  account: { login: string; name: string | null; avatar: string | null; id: string | null } | null;
  repository: { owner: string; name: string; branch: string | null } | null;
  repositoryConfigured: boolean;
  oauthAppConfigured: boolean;
  oauthClientId: string | null;
  autoSync: boolean;
  syncDelaySeconds: number;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  updatedAt: string | null;
}

async function readRow(): Promise<GitHubConnectionRow | null> {
  return queryOne<GitHubConnectionRow>(`select * from github_connection where id = 'default'`);
}

async function ensureRow(): Promise<GitHubConnectionRow> {
  const existing = await readRow();
  if (existing) return existing;
  const created = await queryOne<GitHubConnectionRow>(
    `insert into github_connection (id, auto_sync, sync_delay_seconds)
     values ('default', true, 5)
     on conflict (id) do update set updated_at = now()
     returning *`,
  );
  if (!created) throw new ApiError('Could not initialise the GitHub connection row.', 500, 'github_row_failed');
  return created;
}

export function toView(row: GitHubConnectionRow | null): GitHubConnectionView {
  const tokenConfigured = Boolean(row?.token_encrypted);
  const repositoryConfigured = Boolean(row?.repo_owner && row?.repo_name);
  const connected = tokenConfigured && Boolean(row?.account_login);
  const status: GitHubConnectionView['status'] = !tokenConfigured
    ? 'disconnected'
    : row?.last_error && row?.last_test_ok === false
      ? 'failed'
      : connected
        ? 'connected'
        : 'disconnected';
  return {
    connected,
    status,
    authMode: (row?.auth_mode as 'token' | 'oauth' | null) ?? null,
    tokenConfigured,
    tokenHint: row?.token_hint ?? null,
    scopes: parseJsonb<string[]>(row?.token_scopes, []),
    account: row?.account_login
      ? {
          login: row.account_login,
          name: row.account_name,
          avatar: row.account_avatar,
          id: row.account_id,
        }
      : null,
    repository: repositoryConfigured
      ? { owner: row!.repo_owner!, name: row!.repo_name!, branch: row?.repo_branch ?? null }
      : null,
    repositoryConfigured,
    oauthAppConfigured: Boolean(row?.oauth_client_id && row?.oauth_client_secret_encrypted),
    oauthClientId: row?.oauth_client_id ?? null,
    autoSync: row?.auto_sync ?? true,
    syncDelaySeconds: Math.min(120, Math.max(2, Number(row?.sync_delay_seconds ?? 5))),
    connectedAt: row?.connected_at ?? null,
    lastVerifiedAt: row?.last_verified_at ?? null,
    lastTestAt: row?.last_test_at ?? null,
    lastTestOk: row?.last_test_ok ?? null,
    lastError: row?.last_error ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function getConnectionView(): Promise<GitHubConnectionView> {
  return toView(await readRow());
}

/** Decrypted token, or null when nothing is configured. */
export async function resolveToken(): Promise<string | null> {
  const row = await readRow();
  if (!row?.token_encrypted) return null;
  try {
    return decryptSecret(row.token_encrypted);
  } catch {
    throw new ApiError(
      'The stored GitHub token cannot be decrypted (DARKNOTE_SECRET changed). Reconnect GitHub in Admin Settings.',
      424,
      'github_token_unreadable',
    );
  }
}

export async function requireToken(): Promise<string> {
  const token = await resolveToken();
  if (!token) {
    throw new ApiError(
      'GitHub is not connected. Add a token or authorise the account in Admin Settings → GitHub Connection.',
      424,
      'github_not_connected',
    );
  }
  return token;
}

export async function requireClient(): Promise<GitHubClient> {
  return new GitHubClient(await requireToken());
}

function describeError(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Verifies the token against GitHub before storing it. A token that does not
 * authenticate is never persisted, so "connected" always means "GitHub said so".
 */
export async function saveToken(options: {
  token: string;
  mode?: 'token' | 'oauth';
  userId?: string | null;
}): Promise<GitHubConnectionView> {
  const token = options.token.trim();
  if (!token) throw new ApiError('Paste a GitHub token first.', 400, 'token_required');
  if (/\s/.test(token)) throw new ApiError('That does not look like a token — it contains whitespace.', 400, 'token_malformed');

  const client = new GitHubClient(token);
  let user;
  let scopes: string[] = [];
  try {
    const result = await client.getAuthenticatedUser();
    user = result.user;
    scopes = result.scopes;
  } catch (error) {
    throw new ApiError(
      `GitHub rejected that token: ${describeError(error)}`,
      400,
      'github_token_invalid',
    );
  }

  await ensureRow();
  const view = await queryOne<GitHubConnectionRow>(
    `update github_connection set
       auth_mode = $1,
       token_encrypted = $2,
       token_hint = $3,
       token_scopes = $4,
       account_login = $5,
       account_name = $6,
       account_id = $7,
       account_avatar = $8,
       connected_at = now(),
       last_verified_at = now(),
       last_test_at = now(),
       last_test_ok = true,
       last_error = null,
       updated_at = now(),
       updated_by = $9
     where id = 'default'
     returning *`,
    [
      options.mode ?? 'token',
      encryptSecret(token),
      hintSecret(token),
      jsonb(scopes),
      user.login,
      user.name,
      String(user.id),
      user.avatar_url,
      options.userId ?? null,
    ],
  );
  return toView(view);
}

export async function clearCredentials(): Promise<GitHubConnectionView> {
  await ensureRow();
  const view = await queryOne<GitHubConnectionRow>(
    `update github_connection set
       auth_mode = null,
       token_encrypted = null,
       token_hint = null,
       token_scopes = '[]'::jsonb,
       account_login = null,
       account_name = null,
       account_id = null,
       account_avatar = null,
       last_verified_at = null,
       last_error = null,
       updated_at = now()
     where id = 'default'
     returning *`,
  );
  return toView(view);
}

export async function saveRepositoryConfig(options: {
  owner: string;
  name: string;
  branch?: string | null;
  verifiedDefaultBranch?: string | null;
  userId?: string | null;
}): Promise<GitHubConnectionView> {
  const owner = options.owner.trim();
  const name = options.name.trim().replace(/\.git$/i, '');
  if (!owner || !name) throw new ApiError('Both the repository owner and name are required.', 400, 'repository_required');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new ApiError('Owner and repository name may only contain letters, digits, dot, dash and underscore.', 400, 'repository_invalid');
  }
  await ensureRow();
  const view = await queryOne<GitHubConnectionRow>(
    `update github_connection set
       repo_owner = $1,
       repo_name = $2,
       repo_branch = $3,
       updated_at = now(),
       updated_by = $4
     where id = 'default'
     returning *`,
    [owner, name, options.branch?.trim() || options.verifiedDefaultBranch || null, options.userId ?? null],
  );
  return toView(view);
}

export async function clearRepositoryConfig(): Promise<GitHubConnectionView> {
  await ensureRow();
  const view = await queryOne<GitHubConnectionRow>(
    `update github_connection set repo_owner = null, repo_name = null, repo_branch = null, updated_at = now()
     where id = 'default' returning *`,
  );
  return toView(view);
}

export async function saveSyncConfig(options: {
  autoSync?: boolean;
  delaySeconds?: number;
  userId?: string | null;
}): Promise<GitHubConnectionView> {
  await ensureRow();
  const delay =
    options.delaySeconds === undefined
      ? null
      : Math.min(120, Math.max(2, Math.round(Number(options.delaySeconds) || 5)));
  const view = await queryOne<GitHubConnectionRow>(
    `update github_connection set
       auto_sync = coalesce($1, auto_sync),
       sync_delay_seconds = coalesce($2, sync_delay_seconds),
       updated_at = now(),
       updated_by = $3
     where id = 'default'
     returning *`,
    [options.autoSync ?? null, delay, options.userId ?? null],
  );
  return toView(view);
}

export async function saveOAuthApp(options: {
  clientId: string;
  clientSecret?: string;
  userId?: string | null;
}): Promise<GitHubConnectionView> {
  const clientId = options.clientId.trim();
  await ensureRow();
  const secret = options.clientSecret?.trim();
  const view = await queryOne<GitHubConnectionRow>(
    `update github_connection set
       oauth_client_id = $1,
       oauth_client_secret_encrypted = coalesce($2, oauth_client_secret_encrypted),
       updated_at = now(),
       updated_by = $3
     where id = 'default'
     returning *`,
    [clientId || null, secret ? encryptSecret(secret) : null, options.userId ?? null],
  );
  return toView(view);
}

export async function getOAuthApp(): Promise<{ clientId: string; clientSecret: string } | null> {
  const row = await readRow();
  if (!row?.oauth_client_id || !row.oauth_client_secret_encrypted) return null;
  try {
    return {
      clientId: row.oauth_client_id,
      clientSecret: decryptSecret(row.oauth_client_secret_encrypted),
    };
  } catch {
    return null;
  }
}

export async function startOAuthState(state: string): Promise<void> {
  await ensureRow();
  await queryOne(
    `update github_connection set oauth_state = $1, oauth_state_expires_at = now() + interval '10 minutes', updated_at = now()
     where id = 'default' returning id`,
    [state],
  );
}

/** One-shot state check: the value is cleared as soon as it is read. */
export async function consumeOAuthState(state: string): Promise<boolean> {
  const row = await readRow();
  if (!row?.oauth_state || !row.oauth_state_expires_at) return false;
  if (row.oauth_state !== state) return false;
  if (new Date(row.oauth_state_expires_at).getTime() < Date.now()) {
    await queryOne(`update github_connection set oauth_state = null where id = 'default' returning id`);
    return false;
  }
  await queryOne(`update github_connection set oauth_state = null, oauth_state_expires_at = null where id = 'default' returning id`);
  return true;
}

export async function noteConnectionTest(ok: boolean, error: string | null): Promise<void> {
  await ensureRow();
  await queryOne(
    `update github_connection set last_test_at = now(), last_test_ok = $1, last_error = $2,
       last_verified_at = case when $1 then now() else last_verified_at end,
       updated_at = now()
     where id = 'default' returning id`,
    [ok, ok ? null : error],
  );
}
