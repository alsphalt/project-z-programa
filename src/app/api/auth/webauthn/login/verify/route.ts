import { z } from 'zod';
import { ApiError, ok, publicRoute, rateLimit } from '@/lib/api';
import { authenticatePasskey } from '@/lib/auth/passkeys';
import { relyingPartyFrom, requestIp, requestUserAgent } from '@/lib/auth/request';
import { startSessionForUser } from '@/lib/auth/session';
import { buildSessionPayload } from '@/lib/session-payload';
import { getPlatformSettings } from '@/lib/settings/store';
import { logActivity } from '@/lib/audit';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  response: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().nullish(),
    }),
    authenticatorAttachment: z.string().nullish(),
    clientExtensionResults: z.unknown().optional(),
  }),
});

/**
 * Public: finish a passkey ceremony and open a session.
 *
 * Password sign-in remains the fallback and is unaffected by anything here.
 */
export const POST = publicRoute(async (req) => {
  const ip = requestIp(req);
  rateLimit(`webauthn-verify:${ip}`, 20, 5 * 60_000);

  const settings = await getPlatformSettings();
  if (!settings.security.passkeysEnabled || !settings.security.biometricLoginEnabled) {
    throw new ApiError('Biometric sign-in is disabled on this deployment.', 403, 'biometric_disabled');
  }

  const body = schema.parse(await req.json());

  let authenticated;
  try {
    authenticated = await authenticatePasskey({
      response: body.response,
      rp: relyingPartyFrom(req),
      requireUserVerification: settings.security.requireUserVerification,
      ip,
      userAgent: requestUserAgent(req),
    });
  } catch (error) {
    await query('insert into login_attempts (email, ip, success, reason) values (null,$1,false,$2)', [
      ip,
      error instanceof ApiError ? error.code : 'biometric_failed',
    ]).catch(() => undefined);
    throw error;
  }

  const started = await startSessionForUser(authenticated.userId);
  if (!started) {
    throw new ApiError('The account for that credential is not available.', 403, 'account_unavailable');
  }

  await logActivity({
    user: started.user,
    action: 'auth.biometric_login',
    target: authenticated.label,
    detail: { credentialId: authenticated.credentialRowId, ip },
  });

  return ok({
    session: await buildSessionPayload(started.user),
    method: 'passkey',
    device: authenticated.label,
  });
});
