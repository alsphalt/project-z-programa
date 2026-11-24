import { ok, publicRoute } from '@/lib/api';
import { getPlatformSettings } from '@/lib/settings/store';
import { publicPolicy } from '@/lib/settings/platform';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public policy for the signed-out surfaces.
 *
 * The login screen needs to know whether to render "Create account" and
 * "Sign in with biometrics", and the effects layer needs the appearance
 * defaults before the first paint. None of it is secret: there is deliberately
 * no user list, no credential list and no configuration value here.
 */
export const GET = publicRoute(async () => {
  const settings = await getPlatformSettings();
  return ok(publicPolicy(settings), {
    headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=30' },
  });
});
