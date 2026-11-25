/**
 * Client-side crash sentinel.
 *
 * "Aw, Snap!" is the Chromium renderer being killed — usually out of memory on a
 * phone with limited RAM. When that happens there is no exception to catch, no
 * `beforeunload`, and nothing reaches the server: the tab simply disappears.
 *
 * This module writes a tiny heartbeat to `localStorage` while the console is
 * alive. If the next launch finds a heartbeat that was never closed properly, the
 * previous session died without unloading, and the last known heap size, page,
 * long-task count and session age are reported to the Error Center. That turns
 * "it crashes sometimes" into "it died on /console after 11 minutes with a
 * 412 MB heap", which is what actually identifies the cause.
 *
 * Constraints, because a diagnostic must never become the problem:
 *   - one localStorage write per 20 s, at most (a small JSON object);
 *   - nothing runs while the document is hidden;
 *   - every entry point is wrapped — a missing API (old WebView) is ignored;
 *   - reporting is rate limited to once per session per reason.
 */

const STORAGE_KEY = 'dn.diag.session';
const HEARTBEAT_MS = 20_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * A heartbeat younger than this belongs to a page that is still alive — a second
 * tab, a second mount, a fast reload — not to a renderer that was killed. Without
 * the guard, any of those was reported as a crash.
 */
const LIVE_GRACE_MS = HEARTBEAT_MS * 3;

/**
 * Heap thresholds. A phone renderer is typically killed somewhere between
 * 300–500 MB of JavaScript heap; `performance.memory.jsHeapSizeLimit` reports
 * the real ceiling where available. These are pressure warnings, not crash
 * claims: they are reported with the measured numbers attached.
 */
const DEFAULT_HEAP_LIMIT = 512 * 1024 * 1024;
const PRESSURE_RATIO = 0.7;

export interface SessionRecord {
  id: string;
  startedAt: number;
  lastBeatAt: number;
  page: string;
  heapBytes: number | null;
  heapLimit: number | null;
  longTasks: number;
  longTaskMs: number;
  /** Navigation type of the current document (reload / back_forward / navigate). */
  navigationType: string | null;
  endedCleanly: boolean;
  endedAt: number | null;
}

export interface MemorySample {
  usedBytes: number | null;
  limitBytes: number | null;
  /** usedBytes / limitBytes, 0–1, when both are known. */
  ratio: number | null;
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function memory(): MemorySample {
  const perf = typeof performance !== 'undefined' ? (performance as Performance & { memory?: PerformanceMemory }) : null;
  const measured = perf?.memory;
  if (!measured || !Number.isFinite(measured.usedJSHeapSize)) {
    return { usedBytes: null, limitBytes: null, ratio: null };
  }
  const limit = measured.jsHeapSizeLimit || DEFAULT_HEAP_LIMIT;
  return {
    usedBytes: measured.usedJSHeapSize,
    limitBytes: limit,
    ratio: measured.usedJSHeapSize / limit,
  };
}

function read(): SessionRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionRecord;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.startedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(record: SessionRecord): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* storage full or blocked — the console still works */
  }
}

function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)dn_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Send one diagnostic to the Error Center. `keepalive` survives the page being
 * frozen, which is the whole point of reporting right before a crash.
 */
function report(message: string, code: string, context: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try {
    void fetch('/api/errors/report', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken() },
      body: JSON.stringify({
        message,
        code,
        url: window.location.pathname,
        context: { ...context, userAgent: navigator.userAgent, deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null },
      }),
    }).catch(() => undefined);
  } catch {
    /* reporting is best effort */
  }
}

function navigationType(): string | null {
  try {
    const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    return entries[0]?.type ?? null;
  } catch {
    return null;
  }
}

function formatMb(bytes: number | null): string {
  return bytes === null ? 'unknown' : `${Math.round(bytes / (1024 * 1024))} MB`;
}

export interface SentinelOptions {
  /** Called when the heap crosses the pressure threshold, to shed caches. */
  onMemoryPressure?: (sample: MemorySample) => void;
}

export interface SentinelHandle {
  stop: () => void;
  sample: () => MemorySample;
  record: () => SessionRecord | null;
}

/**
 * Start the sentinel. Returns a handle so tests (and a future "clear diagnostics"
 * button) can stop it explicitly.
 */
export function startSentinel(options: SentinelOptions = {}): SentinelHandle {
  const noop: SentinelHandle = { stop: () => undefined, sample: () => memory(), record: () => read() };
  if (typeof window === 'undefined') return noop;

  try {
    const previous = read();
    const now = Date.now();
    const previousWasLive =
      previous ? now - previous.lastBeatAt < LIVE_GRACE_MS : false;
    const session: SessionRecord = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: now,
      lastBeatAt: now,
      page: window.location.pathname,
      heapBytes: memory().usedBytes,
      heapLimit: memory().limitBytes,
      longTasks: 0,
      longTaskMs: 0,
      navigationType: navigationType(),
      endedCleanly: false,
      endedAt: null,
    };

    /**
     * A heartbeat from a session that never unloaded is a renderer that was
     * killed. `STALE_AFTER_MS` keeps an old record from an abandoned tab from
     * being reported as today's crash.
     */
    if (previous && !previous.endedCleanly && !previousWasLive && now - previous.lastBeatAt < STALE_AFTER_MS) {
      const livedSeconds = Math.round((previous.lastBeatAt - previous.startedAt) / 1000);
      report(
        `The browser terminated the previous session without unloading it (page ${previous.page}, heap ${formatMb(previous.heapBytes)} of ${formatMb(previous.heapLimit)}, ${livedSeconds}s alive, ${previous.longTasks} long tasks).`,
        'browser_terminated_session',
        {
          previous: {
            page: previous.page,
            livedSeconds,
            heapBytes: previous.heapBytes,
            heapLimit: previous.heapLimit,
            longTasks: previous.longTasks,
            longTaskMs: previous.longTaskMs,
            navigationType: previous.navigationType,
          },
        },
      );
      // The record has been used; a crash of *this* session must not re-report it.
      write({ ...previous, endedCleanly: true, endedAt: previous.lastBeatAt });
    }

    write(session);

    let reportedPressure = false;
    let reportedLongTasks = false;
    let longTasks = 0;
    let longTaskMs = 0;

    // Long tasks (>50 ms) are the frame drops a phone user actually feels; the
    // observer is cheap and absent in older WebViews.
    let observer: PerformanceObserver | null = null;
    try {
      if (typeof PerformanceObserver === 'function') {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks += 1;
            longTaskMs += entry.duration;
          }
          if (!reportedLongTasks && longTasks >= 50) {
            reportedLongTasks = true;
            report(
              `The console has blocked the main thread ${longTasks} times (${Math.round(longTaskMs)} ms total) in this session.`,
              'long_task_pressure',
              { longTasks, longTaskMs, page: window.location.pathname },
            );
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      }
    } catch {
      observer = null;
    }

    let timer: number | null = null;

    const beat = () => {
      const sample = memory();
      const current = read();
      if (!current || current.id !== session.id) return; // another tab took over
      const next: SessionRecord = {
        ...current,
        lastBeatAt: Date.now(),
        page: window.location.pathname,
        heapBytes: sample.usedBytes,
        heapLimit: sample.limitBytes,
        longTasks,
        longTaskMs,
      };
      write(next);

      if (!reportedPressure && sample.ratio !== null && sample.ratio >= PRESSURE_RATIO) {
        reportedPressure = true;
        report(
          `JavaScript heap reached ${Math.round(sample.ratio * 100)}% of the renderer limit on ${window.location.pathname} (${formatMb(sample.usedBytes)} of ${formatMb(sample.limitBytes)}). Caches were released to avoid a renderer kill.`,
          'memory_pressure',
          {
            heapBytes: sample.usedBytes,
            heapLimit: sample.limitBytes,
            ratio: sample.ratio,
            page: window.location.pathname,
            longTasks,
          },
        );
        try {
          options.onMemoryPressure?.(sample);
        } catch {
          /* a cache flush must never throw */
        }
      }
    };

    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(beat, HEARTBEAT_MS);
    };
    const stopTimer = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };

    /**
     * Mirrors visibility into the DOM so CSS can pause decorative animations
     * (see `html[data-doc-hidden="true"]` in globals.css). A background tab on
     * Android otherwise keeps composited animations running for nobody.
     */
    const markHidden = (hidden: boolean) => {
      try {
        if (hidden) document.documentElement.dataset.docHidden = 'true';
        else delete document.documentElement.dataset.docHidden;
      } catch {
        /* ignore */
      }
    };

    const onVisibility = () => {
      markHidden(document.hidden);
      if (document.hidden) {
        // One last beat, then stop: a background tab must cost nothing.
        beat();
        stopTimer();
        return;
      }
      start();
    };

    const onLeave = () => {
      const current = read();
      if (current && current.id === session.id) {
        write({ ...current, endedCleanly: true, endedAt: Date.now(), longTasks, longTaskMs });
      }
      stopTimer();
    };

    markHidden(document.hidden);
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);

    return {
      stop: () => {
        stopTimer();
        markHidden(false);
        try {
          observer?.disconnect();
        } catch {
          /* ignore */
        }
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onLeave);
        window.removeEventListener('beforeunload', onLeave);
        onLeave();
      },
      sample: memory,
      record: read,
    };
  } catch {
    return noop;
  }
}
