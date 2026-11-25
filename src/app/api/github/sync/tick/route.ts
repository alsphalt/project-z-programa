import { ok, rateLimit, route } from '@/lib/api';
import { runDueSyncJobs } from '@/lib/github/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Drains due synchronization jobs. Called by the in-process worker (see
 * instrumentation.ts) and by the panel while a sync is pending, so the debounce
 * also works where serverless functions cannot keep a timer alive.
 */
export const POST = route({ permission: 'file.write' }, async ({ user }) => {
  rateLimit(`sync-tick:${user.id}`, 120, 60_000);
  const result = await runDueSyncJobs(3);
  return ok(result);
});
