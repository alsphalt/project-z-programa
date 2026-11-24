import { NextRequest } from 'next/server';
import { z } from 'zod';
import { publicRoute, ok, ApiError, rateLimit } from '@/lib/api';
import { ensureBootstrapAdmin, login } from '@/lib/auth/session';
import { buildSessionPayload } from '@/lib/session-payload';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const POST = publicRoute(async (req: NextRequest) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  rateLimit(`login:${ip}`, 20, 5 * 60_000);
  const body = schema.parse(await req.json());

  const bootstrap = await ensureBootstrapAdmin();
  const result = await login(body.email, body.password);
  if (!result.ok || !result.user) {
    await logActivity({
      action: 'auth.login_failed',
      target: body.email,
      severity: 'warning',
      detail: { reason: result.error },
    });
    throw new ApiError(result.error ?? 'Login failed', 401, 'login_failed');
  }

  await logActivity({ user: result.user, action: 'auth.login', target: result.user.email });
  return ok({ session: await buildSessionPayload(result.user), bootstrapped: bootstrap.created });
});
