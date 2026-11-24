/**
 * Operational database maintenance.
 *
 *   npm run db:maintenance             # health report + retention + row counts
 *   npm run db:maintenance -- --backup # include a logical backup
 *   npm run db:backup                  # backup only
 *   npm run db:restore -- <dir> --replace
 *
 * Intended for an external cron (or a manual run before a release). It is the
 * only thing that prunes rows, so retention windows are auditable in one place
 * (see retentionPolicy() in src/lib/db/maintenance.ts).
 */
process.env.DARKNOTE_NO_AUTO_MIGRATE = '1';

import { closeDatabase, dbHealth } from '../src/lib/db.ts';
import {
  backupDatabase,
  listBackups,
  pruneOperationalData,
  recordHealthReport,
  retentionPolicy,
  restoreDatabase,
  tableRowCounts,
} from '../src/lib/db/maintenance.ts';

const args = process.argv.slice(2);
const withBackup = args.includes('--backup');
const command = args.find((arg) => !arg.startsWith('--')) ?? 'maintain';

if (command === 'restore') {
  const directory = args[args.indexOf('restore') + 1];
  if (!directory) {
    console.error('usage: npm run db:restore -- <backup-directory> [--replace]');
    process.exit(2);
  }
  const result = await restoreDatabase(directory, { replace: args.includes('--replace') });
  console.log(`restored ${result.restored.reduce((sum, entry) => sum + entry.rows, 0)} rows`);
  for (const entry of result.restored) console.log(`  ${entry.table}: ${entry.rows}`);
  await closeDatabase();
  process.exit(0);
}

const health = await dbHealth();
const reportId = await recordHealthReport(health, 'cli');

console.log('--- database health -------------------------------------------');
console.log(`driver:      ${health.kind}`);
console.log(`target:      ${health.target}`);
console.log(`connected:   ${health.ok}`);
console.log(`postgres:    ${health.serverVersion ?? 'unknown'}`);
console.log(`latency:     ${health.latencyMs === null ? '?' : `${health.latencyMs} ms`}`);
console.log(`tables:      ${health.tables ?? '?'}`);
console.log(`migrations:  ${health.migrations.applied} applied, ${health.migrations.pending.length} pending`);
console.log(`pool:        ${health.pool.total ?? '?'} total / ${health.pool.idle ?? '?'} idle / ${health.pool.waiting ?? '?'} waiting`);
if (health.error) console.log(`error:       ${health.error}`);
if (reportId) console.log(`recorded:    system_health_reports/${reportId}`);

if (!health.ok) {
  await closeDatabase();
  process.exit(1);
}

console.log('\n--- retention --------------------------------------------------');
const policy = retentionPolicy();
for (const entry of await pruneOperationalData(policy)) {
  console.log(`  ${entry.table.padEnd(22)} deleted ${String(entry.deleted).padStart(5)}  (keep ${entry.kept})`);
}

console.log('\n--- tables -----------------------------------------------------');
const counts = await tableRowCounts();
for (const row of counts) {
  console.log(`  ${row.table.padEnd(28)} ${String(row.rows).padStart(8)} rows`);
}

if (withBackup) {
  console.log('\n--- backup -----------------------------------------------------');
  const backup = await backupDatabase('maintenance');
  console.log(`  ${backup.manifest.totalRows} rows from ${backup.manifest.tables.length} tables`);
  console.log(`  ${backup.directory}`);
} else {
  const existing = listBackups();
  if (existing.length) console.log(`\nlatest backup: ${existing[0].path} (${existing[0].rows} rows)`);
}

await closeDatabase();
process.exit(0);
