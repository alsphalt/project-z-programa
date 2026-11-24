import { publicRoute, ok, ApiError, route } from '@/lib/api';
import { countUsers, currentUser, ensureBootstrapAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SessionUser = Awaited<ReturnType<typeof currentUser>>;

/**
 * Unauthenticated probe used by the login screen: who am I (if anyone), whether
 * the deployment still needs a first-run owner, and which configuration is
 * missing. Never returns credentials or panel keys.
 *
 * A database that cannot be reached must not turn this into a bare 500. The
 * login page is the only screen an operator has when the deployment is broken,
 * and "db/schema.sql not found — cannot initialise the database" told them
 * nothing about the actual cause (an unset DATABASE_URL, an unpulled migration, a
 * suspended Neon project). The probe therefore always answers 200 with
 * `database.ok: false` and the reason, so the page renders that reason verbatim.
 */
export const GET = publicRoute(async () => {
  const missing: string[] = [];
  if (!env.databaseUrl && env.dbDriver !== 'pglite') {
    missing.push('DATABASE_URL (Neon PostgreSQL)');
  }
  if (!env.secret) missing.push('DARKNOTE_SECRET');

  let user: SessionUser = null;
  let total = 0;
  let databaseError: string | null = null;

  try {
    // Initialise the database first (and run the boot migrations once). This is
    // also what proves the failure is the database rather than the request
    // context: `currentUser()` reads cookies before it queries.
    await db();
    user = await currentUser();
    total = await countUsers();
  } catch (error) {
    databaseError = error instanceof Error ? error.message : String(error);
  }

  return ok({
    user: user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null,
    // A failed probe is not proof that the deployment is unconfigured; offering
    // first-run setup while the database is down would invite a second owner.
    needsBootstrap: !databaseError && total === 0,
    setupTokenConfigured: Boolean(env.setupToken),
    env: { ok: missing.length === 0 && !databaseError, missing, backupDriver: 'local' },
    database: { ok: !databaseError, error: databaseError },
  });
});

/** Environment-driven bootstrap, kept for `npm run`-less deployments. */
export const POST = route({ permission: null }, async () => {
  const total = await countUsers();
  if (total > 0) throw new ApiError('An administrator already exists.', 409, 'already_bootstrapped');
  const result = await ensureBootstrapAdmin();
  return ok(result);
});
