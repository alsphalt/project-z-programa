/**
 * Controlled database migrations.
 *
 *   npm run db:migrate                 # back up (if data exists), then apply
 *   npm run db:migrate -- --status     # report only, change nothing
 *   npm run db:migrate -- --dry-run    # list what would be applied
 *   npm run db:migrate -- --no-backup  # skip the pre-migration backup
 *
 * This is the path a deployment should use. The application also verifies the
 * registry on boot (see `bootMigrations` in src/lib/db.ts) and only applies
 * pending files when no deployment step has done it.
 */
// The CLI owns migrations: it takes the backup first, then applies. Without
// this the very first `db()` call would migrate before the backup is written.
process.env.DARKNOTE_NO_AUTO_MIGRATE = '1';

import { closeDatabase, db, dbHealth } from '../src/lib/db.ts';
import { migrate, migrationStatus } from '../src/lib/db/migrate.ts';
import { backupDatabase, tableRowCounts } from '../src/lib/db/maintenance.ts';

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status') || args.has('--check');
const dryRun = args.has('--dry-run');
const noBackup = args.has('--no-backup');
const allowDrift = args.has('--allow-drift');

const client = await db();

if (statusOnly) {
  const status = await migrationStatus(client);
  console.log(`driver:     ${client.kind}`);
  console.log(`target:     ${client.target}`);
  console.log(`applied:    ${status.applied.length ? status.applied.map((m) => m.name).join(', ') : 'none'}`);
  console.log(`pending:    ${status.pending.length ? status.pending.join(', ') : 'none'}`);
  console.log(`drift:      ${status.drifted.length ? status.drifted.join(', ') : 'none'}`);
  await closeDatabase();
  process.exit(status.pending.length === 0 ? 0 : 1);
}

console.log(`driver:     ${client.kind}`);
console.log(`target:     ${client.target}`);

if (!dryRun && !noBackup) {
  const counts = await tableRowCounts();
  const total = counts.reduce((sum, row) => sum + Math.max(0, row.rows), 0);
  if (total > 0) {
    console.log('backup:     writing a logical backup before migrating…');
    const backup = await backupDatabase('pre-migrate');
    console.log(`backup:     ${backup.manifest.tables.length} tables, ${backup.manifest.totalRows} rows → ${backup.directory}`);
  } else {
    console.log('backup:     skipped (database is empty)');
  }
}

const result = await migrate(client, { dryRun, allowDrift });
console.log(`applied:    ${result.appliedNow.length ? result.appliedNow.join(', ') : 'nothing to do (already current)'}`);
console.log(`pending:    ${result.pending.length ? result.pending.join(', ') : 'none'}`);

// Real read/write check — not just "the migration table exists".
const health = await dbHealth();
console.log(`healthy:    ${health.ok}`);
console.log(`postgres:   ${health.serverVersion ?? 'unknown'}`);
console.log(`tables:     ${health.tables ?? '?'}`);
console.log(`latency:    ${health.latencyMs === null ? '?' : `${health.latencyMs} ms`}`);

await closeDatabase();
process.exit(health.ok && result.pending.length === 0 ? 0 : 1);
