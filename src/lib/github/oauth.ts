import 'server-only';
import { ApiError } from '../api';
import { randomToken } from '../crypto';
import { githubOAuthBase } from './client';
import { getOAuthApp, startOAuthState } from './credentials';

/**
 * Standard GitHub OAuth App authorization-code flow.
 *
 * The administrator registers an OAuth App in GitHub, pastes its client id and
 * secret into Admin Settings, and then presses "Connect GitHub". The callback
 * exchanges the code server-side, so the secret and the access token never touch
 * the browser.
 */

/** `repo` is the minimum GitHub scope that can read *and* push to private repos. */
const SCOPES = 'repo read:user';

export function oauthRedirectUri(origin: string): string {
  const configured = process.env.DARKNOTE_GITHUB_OAUTH_REDIRECT?.trim();
  if (configured) return configured;
  return `${origin.replace(/\/+$/, '')}/api/github/oauth/callback`;
}

export async function buildAuthorizeUrl(origin: string): Promise<string> {
  const app = await getOAuthApp();
  if (!app) {
    throw new ApiError(
      'No GitHub OAuth App is configured. Add its client id and secret in Admin Settings → GitHub Connection, or connect with a personal access token instead.',
      400,
      'oauth_app_missing',
    );
  }
  const state = randomToken(24);
  await startOAuthState(state);
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: oauthRedirectUri(origin),
    scope: SCOPES,
    state,
    allow_signup: 'false',
  });
  return `${githubOAuthBase()}/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeCode(
  code: string,
  origin: string,
): Promise<{ token: string; scopes: string[] }> {
  const app = await getOAuthApp();
  if (!app) throw new ApiError('No GitHub OAuth App is configured.', 400, 'oauth_app_missing');
  if (!code.trim()) throw new ApiError('GitHub did not return an authorization code.', 400, 'oauth_code_missing');

  let response: Response;
  try {
    response = await fetch(`${githubOAuthBase()}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'darknote-control-center' },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: oauthRedirectUri(origin),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new ApiError(
      `Could not reach GitHub to exchange the authorization code: ${error instanceof Error ? error.message : String(error)}`,
      502,
      'oauth_exchange_failed',
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { access_token?: string; scope?: string; error?: string; error_description?: string }
    | null;

  if (!response.ok || !payload?.access_token) {
    throw new ApiError(
      `GitHub refused the authorization: ${payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`}`,
      400,
      'oauth_exchange_rejected',
    );
  }

  return {
    token: payload.access_token,
    scopes: (payload.scope ?? '').split(',').map((scope) => scope.trim()).filter(Boolean),
  };
}
