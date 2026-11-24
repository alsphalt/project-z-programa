import { z } from 'zod';
import { ApiError, ok, publicRoute, rateLimit } from '@/lib/api';
import { authenticationOptions } from '@/lib/auth/passkeys';
import { relyingPartyFrom, requestIp, requestUserAgent } from '@/lib/auth/request';
import { getPlatformSettings } from '@/lib/settings/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().trim().max(200).optional() }).default({});

/**
 * Public: start a passkey ceremony.
 *
 * An email narrows the offer to that account's credentials; leaving it out lets
 * the device propose any discoverable passkey and the account is resolved from
 * the credential id afterwards.
 */
export const POST = publicRoute(async (req) => {
  const ip = requestIp(req);
  rateLimit(`webauthn-options:${ip}`, 30, 5 * 60_000);

  const settings = await getPlatformSettings();
  if (!settings.security.passkeysEnabled || !settings.security.biometricLoginEnabled) {
    throw new ApiError(
      'Biometric sign-in is disabled on this deployment. Use your password.',
      403,
      'biometric_disabled',
    );
  }

  let payload: { email?: string } = {};
  try {
    payload = schema.parse(await req.json());
  } catch {
    payload = {};
  }

  const result = await authenticationOptions({
    email: payload.email ?? null,
    rp: relyingPartyFrom(req),
    ip,
    userAgent: requestUserAgent(req),
    requireUserVerification: settings.security.requireUserVerification,
  });

  return ok({ options: result.options });
});
