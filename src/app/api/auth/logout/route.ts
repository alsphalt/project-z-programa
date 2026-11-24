import { route, ok } from '@/lib/api';
import { currentUser, logout } from '@/lib/auth/session';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';

export const POST = route({ permission: null }, async ({ user }) => {
  await logActivity({ user, action: 'auth.logout', target: user.email });
  await logout();
  return ok({ loggedOut: true });
});

export const GET = route({ permission: null }, async () => {
  const user = await currentUser();
  return ok({ user });
});
