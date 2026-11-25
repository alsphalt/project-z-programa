import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { query, queryOne, jsonb, parseJsonb } from '../db';
import { env } from '../env';
import { hashSessionToken, randomToken, safeEqual, uuid } from '../crypto';
import { hashPassword, verifyPassword } from './passwords';
import { captureError } from '../errors/store';
import {
  assertPermission,
  hasPermission,
  permissionsFor,
  type Permission,
  type Principal,
  type Role,
} from './permissions';

export const SESSION_COOKIE = 'dn_session';
export const CSRF_COOKIE = 'dn_csrf';

export interface SessionUser extends Principal {
  isActive: boolean;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  permissions: unknown;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string;
}

function toPrincipal(row: { id: string; email: string; name: string; role: string; permissions: unknown }): Principal {
  const role = (['owner', 'admin', 'operator', 'viewer'].includes(row.role) ? row.role : 'viewer') as Role;
  const extra = parseJsonb<string[]>(row.permissions, []);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    permissions: permissionsFor(role, extra),
  };
}

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ count: string | number }>('select count(*)::int as count from admin_users');
  return Number(row?.count ?? 0);
}

/**
 * Create the first owner account from environment variables when the database
 * has no administrators yet. Returns the created email or null.
 */
export async function ensureBootstrapAdmin(): Promise<{ created: boolean; email?: string; reason?: string }> {
  if ((await countUsers()) > 0) return { created: false };
  if (!env.adminEmail || !env.adminPassword) {
    return {
      created: false,
      reason:
        'No administrator exists. Set DARKNOTE_ADMIN_EMAIL and DARKNOTE_ADMIN_PASSWORD, or run `npm run create-admin`.',
    };
  }
  if (env.adminPassword.length < 10) {
    return { created: false, reason: 'DARKNOTE_ADMIN_PASSWORD must be at least 10 characters.' };
  }
  const id = uuid();
  await query(
    `insert into admin_users (id, email, name, password_hash, role, permissions)
     values ($1,$2,$3,$4,'owner',$5::jsonb)`,
    [id, env.adminEmail.toLowerCase(), env.adminName, await hashPassword(env.adminPassword), jsonb([])],
  );
  return { created: true, email: env.adminEmail.toLowerCase() };
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  retryAfterSeconds?: number;
}

function clientIp(h: Headers): string {
  if (env.trustProxy) {
    const forwarded = h.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    const real = h.get('x-real-ip');
    if (real) return real;
  }
  return h.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
}

export interface StartedSession {
  user: SessionUser;
  csrfToken: string;
  expiresAt: string;
}

/**
 * Open an authenticated session for an already-proven identity.
 *
 * Shared by password sign-in and by passkey/biometric sign-in so both paths get
 * the same cookie flags, the same CSRF token, the same IP/User-Agent recording,
 * and the same failure surface. The caller is responsible for having verified
 * the identity — this function never checks a password or a credential.
 */
export async function startSessionForUser(userId: string): Promise<StartedSession | null> {
  const h = await headers();
  const ip = clientIp(h);
  const user = await queryOne<UserRow>('select * from admin_users where id = $1', [userId]);
  if (!user || !user.is_active) return null;
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) return null;

  const sessionId = uuid();
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + env.sessionHours * 3600_000);
  await query(
    `insert into sessions (id, user_id, token_hash, csrf_token, ip, user_agent, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
    [sessionId, user.id, hashSessionToken(token), csrfToken, ip, h.get('user-agent') ?? '', expiresAt.toISOString()],
  );
  await query(
    `update admin_users set failed_attempts = 0, locked_until = null, last_login_at = now() where id = $1`,
    [user.id],
  );

  const store = await cookies();
  const secure = env.isProd;
  store.set(SESSION_COOKIE, `${sessionId}.${token}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  });
  // Readable by the app's own JS only to echo back as the CSRF header.
  store.set(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  });

  return {
    user: { ...toPrincipal(user), isActive: user.is_active },
    csrfToken,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function login(
  email: string,
  password: string,
): Promise<LoginResult & { csrfToken?: string; user?: SessionUser }> {
  const h = await headers();
  const ip = clientIp(h);
  const normalized = email.trim().toLowerCase();
  const windowStart = new Date(Date.now() - env.loginWindowMinutes * 60_000).toISOString();

  const recent = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from login_attempts
     where success = false and created_at > $1::timestamptz and (lower(email) = $2 or ip = $3)`,
    [windowStart, normalized, ip],
  );
  if (Number(recent?.count ?? 0) >= env.loginMaxAttempts) {
    return {
      ok: false,
      error: `Too many failed attempts. Try again in ${env.loginWindowMinutes} minutes.`,
      retryAfterSeconds: env.loginWindowMinutes * 60,
    };
  }

  const user = await queryOne<UserRow>('select * from admin_users where lower(email) = $1', [normalized]);
  const fail = async (reason: string) => {
    await query('insert into login_attempts (email, ip, success, reason) values ($1,$2,false,$3)', [
      normalized,
      ip,
      reason,
    ]);
    if (user) {
      await query(
        `update admin_users set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= $2 then $3::timestamptz else locked_until end
         where id = $1`,
        [user.id, env.loginMaxAttempts, new Date(Date.now() + 15 * 60_000).toISOString()],
      );
    }
    captureError({
      message:
        reason === 'locked'
          ? `Sign-in refused for ${normalized}: the account is locked after repeated failed attempts (${ip}).`
          : reason === 'unknown_user'
            ? `Sign-in attempt for an unknown account (${normalized}) from ${ip}.`
            : `Sign-in failed for ${normalized} from ${ip}: the password did not match.`,
      source: 'auth',
      code: reason,
      userId: user?.id ?? null,
      httpStatus: reason === 'locked' ? 429 : 401,
      context: { email: normalized, ip, reason },
      evidence: [`reason: ${reason}`, `ip: ${ip}`],
    });
    return { ok: false, error: 'Invalid email or password.' };
  };

  if (!user || !user.is_active) return fail('unknown_user');
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return fail('locked');
  }
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return fail('bad_password');

  const started = await startSessionForUser(user.id);
  if (!started) return fail('locked');
  await query('insert into login_attempts (email, ip, success) values ($1,$2,true)', [normalized, ip]);

  return {
    ok: true,
    csrfToken: started.csrfToken,
    user: started.user,
  };
}

/** Resolved once per request. */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const [sessionId, token] = raw.split('.');
  if (!sessionId || !token) return null;

  const session = await queryOne<SessionRow>(
    `select id, user_id, token_hash, csrf_token, expires_at, revoked_at, last_seen_at
       from sessions where id = $1`,
    [sessionId],
  );
  if (!session || session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  const user = await queryOne<UserRow>('select * from admin_users where id = $1', [session.user_id]);
  if (!user || !user.is_active) return null;

  // Cookie carries id.secret; the database only stores the HMAC of the secret.
  if (!safeEqual(session.token_hash, hashSessionToken(token))) return null;

  if (Date.now() - new Date(session.last_seen_at).getTime() > 60_000) {
    await query('update sessions set last_seen_at = now() where id = $1', [sessionId]);
  }

  return { ...toPrincipal(user), isActive: true };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    const error = new Error('Not authenticated') as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return user;
}

export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireUser();
  assertPermission(user, permission);
  return user;
}

export async function isAllowed(permission: Permission): Promise<boolean> {
  const user = await currentUser();
  if (!user) return false;
  return hasPermission(user, permission);
}

export async function currentCsrfToken(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const [sessionId] = raw.split('.');
  if (!sessionId) return null;
  const row = await queryOne<{ csrf_token: string }>('select csrf_token from sessions where id = $1', [sessionId]);
  return row?.csrf_token ?? null;
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (raw) {
    const [sessionId] = raw.split('.');
    if (sessionId) {
      await query('update sessions set revoked_at = now() where id = $1', [sessionId]);
    }
  }
  store.delete(SESSION_COOKIE);
  store.delete(CSRF_COOKIE);
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
}
