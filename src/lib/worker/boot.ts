import 'server-only';

/**
 * Process-level background workers.
 *
 * Two independent loops, both `unref`ed so they never keep a process alive:
 *
 *   1. The debounced GitHub push queue: drains jobs whose 5 s delay has elapsed.
 *   2. The GitHub pull poller: asks each synchronized project for its branch head
 *      every 10 s. Webhooks are the fast path, but a delivery can be missed — a
 *      rotated secret, a firewalled endpoint, a GitHub incident — and the
 *      requirement is that a missed webhook costs seconds, not a manual click.
 *
 * ## Why this is not started from `instrumentation.ts`
 *
 * Next compiles `instrumentation.ts` in its own bundle, and that bundle does not
 * honour `serverExternalPackages`. A static (or even dynamic) reference to the
 * database from there drags `pg` into the graph, `pg` requires `fs`, and the
 * compilation dies with:
 *
 *     Module not found: Can't resolve 'fs'
 *     ./node_modules/pg-connection-string/index.js
 *     Import trace: … src/lib/db.ts → instrumentation.ts
 *
 * The failed compilation aborts the dev server's boot, so every URL answered
 * with a blank page. `ensureBackgroundWorkers()` is therefore called from the
 * normal server graph instead — the root layout and `/api/health` — where `pg` is
 * external and the bundle builds. Both call sites are idempotent through a
 * `globalThis` flag, and neither blocks a response.
 */

interface WorkerFlags {
  __darknoteSyncWorker?: boolean;
  __darknotePullWorker?: boolean;
  __darknoteWorkersStarted?: boolean;
}

/**
 * True where the process may be frozen between requests.
 *
 * On a serverless host a `setInterval` is not a scheduler: the instance is
 * suspended after the response, so the timer never fires again. The same work is
 * driven by `/api/cron/tick` there (see vercel.json).
 */
export function isServerlessRuntime(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.NETLIFY ||
      process.env.DARKNOTE_SERVERLESS === '1',
  );
}

export function ensureBackgroundWorkers(): void {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
  const cache = globalThis as unknown as WorkerFlags;
  if (cache.__darknoteWorkersStarted) return;
  cache.__darknoteWorkersStarted = true;

  // Deferred to the next tick so importing this module never delays a response.
  const start = () => {
    void startSyncWorker();
    void startPullPoller();
  };
  if (typeof setImmediate === 'function') setImmediate(start);
  else setTimeout(start, 0);
}

async function startSyncWorker(): Promise<void> {
  const cache = globalThis as unknown as WorkerFlags;
  if (process.env.DARKNOTE_DISABLE_GITHUB_WORKER === '1') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  // No long-lived process: /api/cron/tick drains the queue instead.
  if (isServerlessRuntime()) return;
  if (cache.__darknoteSyncWorker) return;
  cache.__darknoteSyncWorker = true;

  try {
    const { runDueSyncJobs } = await import('../github/sync');
    const { pruneCache } = await import('../cache');
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
    cache.__darknoteSyncWorker = false;
  }
}

async function startPullPoller(): Promise<void> {
  const cache = globalThis as unknown as WorkerFlags;
  if (process.env.DARKNOTE_DISABLE_GITHUB_PULL_POLL === '1') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (isServerlessRuntime()) return;
  if (cache.__darknotePullWorker) return;
  cache.__darknotePullWorker = true;

  try {
    const { pollRemoteProjects } = await import('../github/pull');
    const { getConnectionView } = await import('../github/credentials');

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
    cache.__darknotePullWorker = false;
  }
}
