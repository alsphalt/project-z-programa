import { ok, publicRoute } from '@/lib/api';
import { dbHealth } from '@/lib/db';
import { warnMissingConfig } from '@/lib/env';
import { backupStorage } from '@/lib/backups/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness and diagnostics.
 *
 * Everything here is measured at request time: the PostgreSQL version, the
 * round-trip latency, the migration registry, the pool counters and whether the
 * backup store is writable. Missing configuration is listed rather than hidden
 * behind a blanket "ok", and credentials are never part of the payload.
 */
export const GET = publicRoute(async () => {
  const missing = warnMissingConfig();
  const database = await dbHealth();

  let storage = 'unreachable';
  let storageError: string | null = null;
  try {
    await backupStorage().list('');
    storage = 'ok';
  } catch (error) {
    storage = 'error';
    storageError = error instanceof Error ? error.message : String(error);
  }

  const migrationsPending = database.migrations.pending.length > 0;
  const ok_ = database.ok && storage === 'ok' && !migrationsPending;

  return ok(
    {
      ok: ok_,
      database: database.ok ? 'ok' : 'error',
      databaseDriver: database.kind,
      databaseTarget: database.target,
      databaseError: database.error,
      databaseLatencyMs: database.latencyMs,
      databaseVersion: database.serverVersion,
      tables: database.tables,
      administrators: database.administrators,
      pool: database.pool,
      migrations: database.migrations,
      migrationsPending,
      storage,
      storageError,
      storageDriver: backupStorage().kind,
      missing,
      pterodactylConfigured: Boolean(process.env.DARKNOTE_PANEL_URL),
      node: process.version,
      time: new Date().toISOString(),
      note:
        'Pterodactyl credentials are stored encrypted per server; this endpoint never reports them. Configure a server under Admin Settings to connect.',
    },
    { status: ok_ ? 200 : 503 },
  );
});
