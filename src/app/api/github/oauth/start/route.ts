import { NextResponse } from 'next/server';
import { ok, route } from '@/lib/api';
import { env } from '@/lib/env';
import { buildAuthorizeUrl } from '@/lib/github/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Redirects the administrator to GitHub's authorization page. The client secret
 * and the resulting token stay on the server; the browser only ever sees the
 * one-time `state` value.
 */
export const GET = route({ permission: 'settings.manage' }, async ({ req }) => {
  const url = new URL(req.url);
  const origin = env.appUrl?.trim() || url.origin;
  const authorize = await buildAuthorizeUrl(origin);
  if (url.searchParams.get('json') === '1') {
    return ok({ authorizeUrl: authorize });
  }
  return NextResponse.redirect(authorize, { status: 302 });
});
