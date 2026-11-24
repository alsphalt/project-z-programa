import { ApiError, ok, route } from '@/lib/api';
import { registrationOptions } from '@/lib/auth/passkeys';
import { relyingPartyFrom, requestIp, requestUserAgent } from '@/lib/auth/request';
import { getPlatformSettings } from '@/lib/settings/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Step 1 of enrolment: issue a challenge and the browser options. */
export const POST = route({ permission: null }, async ({ req, user }) => {
  const settings = await getPlatformSettings();
  if (!settings.security.passkeysEnabled) {
    throw new ApiError(
      'Passkeys and biometric sign-in are disabled in Admin Settings → Security.',
      403,
      'passkeys_disabled',
    );
  }

  const result = await registrationOptions({
    user: { id: user.id, email: user.email, name: user.name },
    rp: relyingPartyFrom(req),
    ip: requestIp(req),
    userAgent: requestUserAgent(req),
    requireUserVerification: settings.security.requireUserVerification,
  });

  return ok({
    options: result.options,
    relyingParty: result.relyingParty,
    requireUserVerification: settings.security.requireUserVerification,
  });
});
