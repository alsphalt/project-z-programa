/**
 * Create (or reset) an administrator without the web UI.
 *
 *   npm run create-admin -- --email you@example.com --name "You" --role owner
 *
 * The password is read from DARKNOTE_ADMIN_PASSWORD, or prompted for on a TTY.
 * This script never prints the password and never writes it to disk.
 */
import { createInterface } from 'node:readline/promises';
import { query, queryOne } from '../src/lib/db.ts';
import { uuid } from '../src/lib/crypto.ts';
import { hashPassword, passwordProblems } from '../src/lib/auth/passwords.ts';
import { ROLES } from '../src/lib/auth/permissions.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1];
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function main() {
  const email = arg('email') ?? (await prompt('Admin email: '));
  const name = arg('name') ?? (await prompt('Display name: '));
  const role = (arg('role') ?? 'owner').toLowerCase();
  const password = process.env.DARKNOTE_ADMIN_PASSWORD ?? (await prompt('Password (min 12 chars): '));

  if (!email?.includes('@')) throw new Error('A valid email is required');
  if (!name?.trim()) throw new Error('A display name is required');
  if (!ROLES.includes(role as never)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);

  const problems = passwordProblems(password ?? '');
  if (problems.length) throw new Error(`Password rejected: ${problems.join('; ')}`);

  const existing = await queryOne<{ id: string }>('select id from admin_users where lower(email) = lower($1)', [email]);
  const hash = await hashPassword(password);

  if (existing) {
    await query('update admin_users set password_hash = $2, role = $3, name = $4, is_active = true, updated_at = now() where id = $1', [
      existing.id,
      hash,
      role,
      name,
      ]);
    await query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [existing.id]);
    console.log(`Updated ${email} (role: ${role}). Existing sessions revoked.`);
  } else {
    await query(
      `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,$5)`,
      [uuid(), email.toLowerCase(), name, hash, role],
    );
    console.log(`Created ${email} (role: ${role}).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
