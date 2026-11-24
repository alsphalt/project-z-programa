import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { query, queryOne } from '@/lib/db';
import { uuid } from '@/lib/crypto';
import { env, warnMissingConfig } from '@/lib/env';
import { backupStorage } from '@/lib/backups/storage';
import { hashPassword, passwordProblems, verifyPassword } from '@/lib/auth/passwords';
import { revokeAllSessions } from '@/lib/auth/session';
import { ROLES, type Role } from '@/lib/auth/permissions';
import { logActivity } from '@/lib/audit';
import { serverPolicyView, serverStateView } from '@/lib/views';
import { listServers } from '@/lib/servers/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ permission: null }, async ({ user }) => {
  const storage = backupStorage();
  let storageReady = true;
  let storageDetail = `${storage.kind} store`;
  try {
    await storage.list('');
  } catch (error) {
    storageReady = false;
    storageDetail = error instanceof Error ? error.message : String(error);
  }

  const users = await query<{
    id: string;
    email: string;
    name: string;
    role: string;
    is_active: boolean;
    last_login_at: string | null;
    sessions: string | number;
  }>(
    `select u.id, u.email, u.name, u.role, u.is_active, u.last_login_at,
            (select count(*)::int from sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as sessions
       from admin_users u order by u.created_at asc`,
  );

  const sessions = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from sessions where revoked_at is null and expires_at > now()`,
  );

  const servers = await listServers();
  const missing = warnMissingConfig();

  const policy = servers[0] ? serverPolicyView(servers[0]) : null;

  return ok({
    me: { name: user.name, email: user.email, role: user.role },
    env: {
      ok: missing.length === 0,
      missing,
      backupDriver: storage.kind,
      autoRestart: servers[0]?.autoRestart ?? true,
    },
    storage: { driver: storage.kind, ready: storageReady, detail: storageDetail },
    limits: {
      maxFileEditBytes: env.maxDownloadBytes,
      indexMaxContentBytes: env.maxIndexFiles,
      scanIntervalSeconds: servers[0]?.syncIntervalS ?? 300,
      deployRestart: policy?.autoRestart ?? true,
      sensitiveExportRole: 'admin (permission download.sensitive)',
    },
    users: users.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role.toUpperCase(),
      isActive: row.is_active,
      lastLoginAt: row.last_login_at,
      activeSessions: Number(row.sessions ?? 0),
    })),
    activeSessions: Number(sessions?.count ?? 0),
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      state: serverStateView(server),
      rootPath: server.projectRoot,
      lastSeenAt: server.lastConnectedAt,
    })),
    security: {
      sessionCookie: 'HttpOnly, SameSite=Lax, Secure in production',
      csrf: 'double-submit token on every mutating request',
      passwordHashing: 'bcrypt, cost 12',
      credentials: 'Pterodactyl API keys are AES-256-GCM encrypted at rest and never returned to the browser',
      rateLimiting: `${env.loginMaxAttempts} failed logins per ${env.loginWindowMinutes} minutes per email/IP`,
      pathConfinement: 'every remote path is resolved inside the configured project root',
      secrets: 'WhatsApp session folders, .env files and private keys are blocked from reading, editing and export',
    },
  });
});

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create-user'),
    name: z.string().min(2).max(80),
    email: z.string().email(),
    password: z.string().min(10),
    role: z.string(),
  }),
  z.object({
    action: z.literal('change-password'),
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10),
  }),
  z.object({
    action: z.literal('update-user'),
    userId: z.string().min(1),
    role: z.string().optional(),
    isActive: z.boolean().optional(),
  }),
]);

export const POST = route({ permission: null }, async ({ user, body }) => {
  const input = await body(schema);

  if (input.action === 'change-password') {
    const row = await queryOne<{ password_hash: string }>('select password_hash from admin_users where id = $1', [user.id]);
    if (!row || !(await verifyPassword(input.currentPassword, row.password_hash))) {
      throw new ApiError('Current password is incorrect.', 401, 'bad_password');
    }
    const problems = passwordProblems(input.newPassword);
    if (problems.length) throw new ApiError(`Password rejected: ${problems.join('; ')}`, 400, 'weak_password');
    await query('update admin_users set password_hash = $2, updated_at = now() where id = $1', [
      user.id,
      await hashPassword(input.newPassword),
    ]);
    await revokeAllSessions(user.id);
    await logActivity({ user, action: 'admin.password_changed', target: user.email, severity: 'warning' });
    return ok({ changed: true, sessionsRevoked: true });
  }

  if (user.role !== 'owner' && !user.permissions.includes('admin.manage')) {
    throw new ApiError('Only an owner or an administrator with admin.manage can manage accounts.', 403, 'forbidden');
  }

  if (input.action === 'create-user') {
    const role = input.role.toLowerCase() as Role;
    if (!ROLES.includes(role)) throw new ApiError('Unknown role.', 400, 'invalid_role');
    if (role === 'owner' && user.role !== 'owner') {
      throw new ApiError('Only an owner can create another owner.', 403, 'forbidden');
    }
    const problems = passwordProblems(input.password);
    if (problems.length) throw new ApiError(`Password rejected: ${problems.join('; ')}`, 400, 'weak_password');
    const existing = await queryOne<{ id: string }>('select id from admin_users where lower(email) = lower($1)', [input.email]);
    if (existing) throw new ApiError('An account with that email already exists.', 409, 'email_taken');
    const id = uuid();
    await query(
      `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,$5)`,
      [id, input.email.toLowerCase(), input.name, await hashPassword(input.password), role],
    );
    await logActivity({ user, action: 'admin.created', target: input.email, severity: 'warning', detail: { role } });
    return ok({ id, email: input.email.toLowerCase(), role: role.toUpperCase() });
  }

  const target = await queryOne<{ id: string; role: string; email: string }>(
    'select id, role, email from admin_users where id = $1',
    [input.userId],
  );
  if (!target) throw new ApiError('Account not found.', 404, 'user_not_found');
  if (target.role === 'owner' && user.role !== 'owner') {
    throw new ApiError('Only an owner can modify another owner.', 403, 'forbidden');
  }
  if (input.role) {
    const role = input.role.toLowerCase() as Role;
    if (!ROLES.includes(role)) throw new ApiError('Unknown role.', 400, 'invalid_role');
    await query('update admin_users set role = $2, updated_at = now() where id = $1', [target.id, role]);
  }
  if (input.isActive !== undefined) {
    await query('update admin_users set is_active = $2, updated_at = now() where id = $1', [target.id, input.isActive]);
    if (!input.isActive) await revokeAllSessions(target.id);
  }
  await logActivity({ user, action: 'admin.updated', target: target.email, severity: 'warning', detail: input });
  return ok({ updated: true, userId: target.id });
});
