import { z } from 'zod';
import { ApiError, ok, route } from '@/lib/api';
import { enrolCredential, listCredentials } from '@/lib/auth/passkeys';
import { relyingPartyFrom, requestIp, requestUserAgent } from '@/lib/auth/request';
import { getPlatformSettings } from '@/lib/settings/store';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  label: z.string().trim().max(80).optional(),
  response: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      attestationObject: z.string().min(1),
      transports: z.array(z.string()).optional(),
    }),
    authenticatorAttachment: z.string().nullish(),
    clientExtensionResults: z.unknown().optional(),
  }),
});

/** Step 2 of enrolment: verify the attestation and store the public key. */
export const POST = route({ permission: null }, async ({ req, user, body }) => {
  const settings = await getPlatformSettings();
  if (!settings.security.passkeysEnabled) {
    throw new ApiError('Passkeys are disabled in Admin Settings → Security.', 403, 'passkeys_disabled');
  }

  const input = await body(schema);
  const result = await enrolCredential({
    user: { id: user.id, email: user.email, name: user.name },
    response: input.response,
    rp: relyingPartyFrom(req),
    requireUserVerification: settings.security.requireUserVerification,
    ip: requestIp(req),
    userAgent: requestUserAgent(req),
    label: input.label ?? null,
  });

  await logActivity({
    user,
    action: 'auth.biometric_enrolled',
    target: result.credential.label,
    detail: { credentialId: result.credentialId, attachment: result.credential.attachment },
  });

  return ok({
    credential: result.credential,
    credentials: await listCredentials(user.id),
  });
});
