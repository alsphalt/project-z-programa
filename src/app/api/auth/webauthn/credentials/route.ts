import { ApiError, ok, route } from '@/lib/api';
import { listCredentials, revokeCredential } from '@/lib/auth/passkeys';
import { getPlatformSettings } from '@/lib/settings/store';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The signed-in account's enrolled devices. Never includes a public key. */
export const GET = route({ permission: null }, async ({ user }) => {
  const settings = await getPlatformSettings();
  return ok({
    credentials: await listCredentials(user.id),
    policy: {
      passkeysEnabled: settings.security.passkeysEnabled,
      biometricLoginEnabled: settings.security.biometricLoginEnabled,
      requireUserVerification: settings.security.requireUserVerification,
    },
  });
});

/**
 * Remove one of my devices. An administrator can revoke any credential by
 * passing `userId`, so a lost phone can be dealt with from another account.
 */
export const DELETE = route({ permission: null }, async ({ req, user }) => {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) throw new ApiError('id is required.', 400, 'id_required');
  const isAdmin = user.role === 'owner' || user.role === 'admin';

  const removed = await revokeCredential({
    credentialRowId: id,
    userId: user.id,
    actorId: user.id,
    allowAnyUser: isAdmin,
  });
  if (!removed) throw new ApiError('That device is not enrolled on this account.', 404, 'credential_not_found');

  await logActivity({ user, action: 'auth.biometric_revoked', target: id, severity: 'warning' });
  return ok({ credentials: await listCredentials(user.id) });
});
