/**
 * Process-level background workers.
 *
 * Two independent loops, both `unref`ed so they never keep a process alive:
 *
 *   1. The debounced GitHub push queue (existing): drains jobs whose 5 s delay
 *      has elapsed.
 *   2. The GitHub pull poller (new): asks each synchronized project for its
 *      branch head every 10 s. Webhooks are the fast path, but a delivery can be
 *      missed — a rotated secret, a firewalled endpoint, a GitHub incident — and
 *      the requirement is that a missed webhook costs seconds, not a manual
 *      click.
 *
 * The poller only calls GitHub; it applies a pull only when the head actually
 * moved, so the steady-state cost is one request per project per 10 s.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.DARKNOTE_DISABLE_GITHUB_WORKER === '1') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const cache = globalThis as unknown as { __darknoteSyncWorker?: boolean; __darknotePullWorker?: boolean };
  if (cache.__darknoteSyncWorker) return;
  cache.__darknoteSyncWorker = true;

  try {
    const { runDueSyncJobs } = await import('./lib/github/sync');
    const { pruneCache } = await import('./lib/cache');
    const timer = setInterval(() => {
      void runDueSyncJobs(2).catch(() => undefined);
      // Cheap housekeeping on the same tick: expired settings/server cache
      // entries are dropped instead of accumulating for the process lifetime.
      pruneCache(200);
    }, 3_000);
    // Never keep the process alive just for the poller.
    timer.unref?.();
  } catch {
    // A missing database at boot must not stop the server from starting.
  }

  // ---------------------------------------------------------------- pull poller
  if (process.env.DARKNOTE_DISABLE_GITHUB_PULL_POLL === '1') return;
  if (cache.__darknotePullWorker) return;
  cache.__darknotePullWorker = true;

  try {
    const { pollRemoteProjects } = await import('./lib/github/pull');
    const { getConnectionView } = await import('./lib/github/credentials');

    const everyMs = Math.max(5_000, Number(process.env.DARKNOTE_GITHUB_POLL_MS ?? 10_000));
    let running = false;

    const tick = async () => {
      if (running) return; // a slow pull must not stack up behind the timer
      running = true;
      try {
        const connection = await getConnectionView();
        if (!connection.connected || !connection.autoSync) return;
        const result = await pollRemoteProjects();
        if (result.errors.length) {
          console.warn(`[github-poll] ${result.errors.length} project(s) failed: ${result.errors[0]}`);
        }
      } catch {
        // The next tick retries; an unreachable database is not fatal here.
      } finally {
        running = false;
      }
    };

    const poller = setInterval(() => void tick(), everyMs);
    poller.unref?.();
  } catch {
    // Without a database there is nothing to poll.
  }
}
