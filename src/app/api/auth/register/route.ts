import { z } from 'zod';
import { ApiError, ok, publicRoute, rateLimit } from '@/lib/api';
import { query, queryOne } from '@/lib/db';
import { uuid } from '@/lib/crypto';
import { hashPassword, passwordProblems } from '@/lib/auth/passwords';
import { startSessionForUser } from '@/lib/auth/session';
import { buildSessionPayload } from '@/lib/session-payload';
import { getPlatformSettings } from '@/lib/settings/store';
import { logActivity } from '@/lib/audit';
import { requestIp } from '@/lib/auth/request';

export const runtime = 'nodejs';

/**
 * Self-service registration.
 *
 * Permanent by design: nothing in this application disables, expires or deletes
 * it on a timer, on a deployment, or after a migration. The only switch is the
 * administrator's `registration.enabled` setting, and the account rows live in
 * the same PostgreSQL database as every other account (Neon in production, an
 * on-disk PGlite directory in development) — a restart or a redeploy reads the
 * same rows back.
 */
const schema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export const POST = publicRoute(async (req) => {
  const ip = requestIp(req);
  rateLimit(`register:${ip}`, 10, 15 * 60_000);

  const settings = await getPlatformSettings();
  if (!settings.registration.enabled) {
    throw new ApiError(
      'Registration is currently closed by an administrator. Existing accounts can still sign in.',
      403,
      'registration_closed',
    );
  }

  const body = schema.parse(await req.json());
  const email = body.email.toLowerCase();
  const problems = passwordProblems(body.password);
  if (problems.length) {
    throw new ApiError(`Password does not meet the policy: ${problems.join(', ')}.`, 422, 'weak_password', {
      problems,
    });
  }

  const existing = await queryOne<{ id: string }>('select id from admin_users where lower(email) = $1', [email]);
  if (existing) {
    // Same message as a policy rejection would leak less, but a duplicate email
    // is not a secret the visitor does not already know; a vague error here
    // would only strand them.
    throw new ApiError('An account with that email already exists. Sign in instead.', 409, 'email_taken');
  }

  const role = settings.registration.defaultRole;
  const id = uuid();
  await query(
    `insert into admin_users (id, email, name, password_hash, role, permissions)
     values ($1,$2,$3,$4,$5,'[]'::jsonb)`,
    [id, email, body.name, await hashPassword(body.password), role],
  );

  await logActivity({
    user: { id, email },
    action: 'auth.register',
    target: email,
    detail: { role, ip },
  });

  const started = await startSessionForUser(id);
  if (!started) {
    return ok({ registered: true, signedIn: false, email }, { status: 201 });
  }

  return ok(
    {
      registered: true,
      signedIn: true,
      session: await buildSessionPayload(started.user),
      role,
      biometricPrompt: settings.security.passkeysEnabled,
    },
    { status: 201 },
  );
});
