import { NextResponse } from 'next/server';
import { route } from '@/lib/api';
import { env } from '@/lib/env';
import { consumeOAuthState, saveToken } from '@/lib/github/credentials';
import { exchangeCode } from '@/lib/github/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function back(origin: string, params: Record<string, string>): NextResponse {
  const url = new URL('/settings', origin);
  url.searchParams.set('tab', 'github');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url, { status: 302 });
}

/**
 * OAuth callback. The state value is single-use and expires after ten minutes,
 * which is what stops an attacker from replaying someone else's authorization
 * code into this account.
 */
export const GET = route({ permission: 'settings.manage' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const origin = env.appUrl?.trim() || url.origin;

  const error = url.searchParams.get('error');
  if (error) {
    return back(origin, {
      github_error: url.searchParams.get('error_description') ?? error,
    });
  }

  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';

  const validState = await consumeOAuthState(state);
  if (!validState) {
    return back(origin, { github_error: 'Authorization state was missing, expired or did not match. Start the connection again.' });
  }

  try {
    const { token } = await exchangeCode(code, origin);
    const view = await saveToken({ token, mode: 'oauth', userId: user.id });
    return back(origin, { github: 'connected', account: view.account?.login ?? '' });
  } catch (exchangeError) {
    return back(origin, {
      github_error: exchangeError instanceof Error ? exchangeError.message : String(exchangeError),
    });
  }
});
