/**
 * Verify the configured database and apply the schema.
 *
 *   npm run db:check
 *
 * Uses DATABASE_URL from the environment (loaded from .env.local by the caller).
 * Prints the driver, the table count and anything still missing.
 */
import { query, dbKind } from '../src/lib/db.ts';

const one = await query<{ ok: number }>('select 1 as ok');
const tables = await query<{ table_name: string }>(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
);
const users = await query<{ count: number }>('select count(*)::int as count from admin_users');

console.log(`driver:     ${dbKind()}`);
console.log(`connection: ${one[0]?.ok === 1 ? 'ok' : 'failed'}`);
console.log(`tables:     ${tables.length}`);
console.log(`administrators: ${Number(users[0]?.count ?? 0)}`);
console.log('');
console.log(tables.map((row) => row.table_name).join('\n'));

if (Number(users[0]?.count ?? 0) === 0) {
  console.log('\nNo administrator yet. Create one with: npm run create-admin -- --email you@example.com --name "You"');
}

process.exit(0);
