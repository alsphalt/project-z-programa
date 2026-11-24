export async function registerNodeWorkers(): Promise<void> {
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
      pruneCache(200);
    }, 3_000);
    timer.unref?.();
  } catch {
    // A missing database at boot must not stop the server from starting.
  }

  if (process.env.DARKNOTE_DISABLE_GITHUB_PULL_POLL === '1') return;
  if (cache.__darknotePullWorker) return;
  cache.__darknotePullWorker = true;

  try {
    const { pollRemoteProjects } = await import('./lib/github/pull');
    const { getConnectionView } = await import('./lib/github/credentials');

    const everyMs = Math.max(5_000, Number(process.env.DARKNOTE_GITHUB_POLL_MS ?? 10_000));
    let running = false;

    const tick = async () => {
      if (running) return;
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
