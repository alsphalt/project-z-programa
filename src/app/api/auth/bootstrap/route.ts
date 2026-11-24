import { z } from 'zod';
import { ApiError, ok, publicRoute, rateLimit } from '@/lib/api';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword, passwordProblems } from '@/lib/auth/passwords';
import { env } from '@/lib/env';
import { jsonb, withTransaction } from '@/lib/db';
import { safeEqual, uuid } from '@/lib/crypto';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  setupToken: z.string().min(1).max(200),
});

export const POST = publicRoute(async (req) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  rateLimit(`bootstrap:${ip}`, 10, 10 * 60_000);

  const body = schema.parse(await req.json());
  if (!env.setupToken) {
    throw new ApiError(
      'First-run setup is disabled: set DARKNOTE_SETUP_TOKEN (or SETUP_TOKEN) in the environment, or run `npm run create-admin`.',
      503,
      'setup_disabled',
    );
  }
  if (!safeEqual(body.setupToken, env.setupToken)) {
    await logActivity({
      action: 'auth.bootstrap_failed',
      target: body.email.toLowerCase(),
      severity: 'warning',
      detail: { reason: 'invalid_setup_token' },
    });
    throw new ApiError('Invalid setup token.', 403, 'invalid_setup_token');
  }

  const problems = passwordProblems(body.password);
  if (problems.length > 0) {
    throw new ApiError(`Password does not meet the policy: ${problems.join('; ')}`, 422, 'weak_password');
  }

  const email = body.email.toLowerCase();
  const id = uuid();
  const passwordHash = await hashPassword(body.password);
  try {
    await withTransaction(async (client) => {
      await client.query('lock table admin_users in exclusive mode');
      const existing = await client.query<{ count: string | number }>(
        'select count(*)::int as count from admin_users',
      );
      if (Number(existing.rows[0]?.count ?? 0) > 0) {
        throw new ApiError('An administrator already exists. Sign in instead.', 409, 'already_bootstrapped');
      }
      await client.query(
        `insert into admin_users (id, email, name, password_hash, role, permissions)
         values ($1,$2,$3,$4,'owner',$5::jsonb)`,
        [id, email, body.name, passwordHash, jsonb([])],
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/duplicate key|unique/i.test(message)) {
      throw new ApiError('An administrator already exists. Sign in instead.', 409, 'already_bootstrapped');
    }
    throw error;
  }

  await logActivity({
    action: 'auth.bootstrap',
    target: email,
    severity: 'critical',
    detail: { role: 'owner', via: 'setup_token' },
  });

  return ok({ created: true, email });
});
