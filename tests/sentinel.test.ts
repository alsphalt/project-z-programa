/**
 * Crash sentinel behaviour.
 *
 * The sentinel exists because a killed renderer cannot report anything: the next
 * launch has to notice that the previous heartbeat was never closed. These tests
 * drive the module against a minimal fake browser and assert what it writes and
 * what it would send, so a regression cannot quietly turn the diagnostic into
 * noise ("reported the previous session as a crash on every page load").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const STORAGE_KEY = 'dn.diag.session';

interface FakeStorage {
  data: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function installFakeBrowser(initial: Record<string, string> = {}): {
  storage: FakeStorage;
  reports: Array<Record<string, unknown>>;
  fireVisibility: (hidden: boolean) => void;
  timers: number[];
  runBeat: () => void;
} {
  const data = new Map<string, string>(Object.entries(initial));
  const storage: FakeStorage = {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
  const reports: Array<Record<string, unknown>> = [];
  const listeners: Record<string, Array<() => void>> = {};
  const timers: number[] = [];
  const intervals: Array<() => void> = [];
  let hidden = false;

  const documentStub = {
    get hidden() {
      return hidden;
    },
    cookie: 'dn_csrf=test-token',
    documentElement: { dataset: {} as Record<string, string> },
    addEventListener: (event: string, handler: () => void) => {
      (listeners[event] ??= []).push(handler);
    },
    removeEventListener: (event: string, handler: () => void) => {
      listeners[event] = (listeners[event] ?? []).filter((entry) => entry !== handler);
    },
  };

  const windowStub = {
    location: { pathname: '/console' },
    localStorage: storage,
    setInterval: (fn: () => void) => {
      const id = timers.length + 1;
      timers.push(id);
      intervals.push(fn);
      return id;
    },
    clearInterval: () => undefined,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: (event: string, handler: () => void) => {
      (listeners[`w:${event}`] ??= []).push(handler);
    },
    removeEventListener: () => undefined,
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  // `navigator` and `performance` are getter-only on newer Node releases.
  const define = (name: string, value: unknown) => {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  define('window', windowStub);
  define('document', documentStub);
  define('navigator', { userAgent: 'test-agent', onLine: true });
  define('performance', {
    memory: { usedJSHeapSize: 120 * 1024 * 1024, totalJSHeapSize: 150 * 1024 * 1024, jsHeapSizeLimit: 512 * 1024 * 1024 },
    getEntriesByType: () => [{ type: 'navigate' }],
  });
  define('fetch', (url: string, init: { body?: string }) => {
    reports.push({ url, ...JSON.parse(init.body ?? '{}') });
    return Promise.resolve({ ok: true });
  });

  return {
    storage,
    reports,
    timers,
    /** Runs one heartbeat tick, exactly as the 20 s interval would. */
    runBeat: () => {
      for (const fn of intervals) fn();
    },
    fireVisibility: (nextHidden: boolean) => {
      hidden = nextHidden;
      for (const handler of listeners.visibilitychange ?? []) handler();
    },
  };
}

function clearFakeBrowser(): void {
  for (const name of ['window', 'document', 'navigator', 'performance', 'fetch']) {
    delete (globalThis as unknown as Record<string, unknown>)[name];
  }
}

test('a clean session writes a heartbeat and reports nothing', async () => {
  const browser = installFakeBrowser();
  try {
    const { startSentinel } = await import('../src/lib/perf/sentinel.ts');
    const handle = startSentinel();
    const record = JSON.parse(browser.storage.getItem(STORAGE_KEY) ?? '{}') as {
      page: string;
      endedCleanly: boolean;
      heapBytes: number;
    };
    assert.equal(record.page, '/console');
    assert.equal(record.endedCleanly, false, 'an open session is marked as not ended');
    assert.equal(record.heapBytes, 120 * 1024 * 1024, 'the measured heap is recorded');
    assert.equal(browser.reports.length, 0, 'a first load must not report a crash');
    handle.stop();
    const closed = JSON.parse(browser.storage.getItem(STORAGE_KEY) ?? '{}') as { endedCleanly: boolean };
    assert.equal(closed.endedCleanly, true, 'stop() marks the session closed');
  } finally {
    clearFakeBrowser();
  }
});

test('an unclosed heartbeat from a previous session is reported once', async () => {
  const startedAt = Date.now() - 11 * 60 * 1000;
  const previous = {
    id: 'previous',
    startedAt,
    // Six minutes before "now": clearly not a heartbeat from a live tab.
    lastBeatAt: startedAt + 300_000,
    page: '/console',
    heapBytes: 412 * 1024 * 1024,
    heapLimit: 512 * 1024 * 1024,
    longTasks: 63,
    longTaskMs: 12_400,
    navigationType: 'navigate',
    endedCleanly: false,
    endedAt: null,
  };
  const browser = installFakeBrowser({ [STORAGE_KEY]: JSON.stringify(previous) });
  try {
    const { startSentinel } = await import('../src/lib/perf/sentinel.ts');
    const handle = startSentinel();

    assert.equal(browser.reports.length, 1, 'exactly one report for the terminated session');
    const report = browser.reports[0] as { code: string; message: string; context: { previous: { page: string; heapBytes: number; longTasks: number } } };
    assert.equal(report.code, 'browser_terminated_session');
    assert.equal(report.context.previous.page, '/console');
    assert.equal(report.context.previous.heapBytes, 412 * 1024 * 1024);
    assert.equal(report.context.previous.longTasks, 63);
    assert.match(report.message, /mid|MB/i);

    // Launching again must not report the same death a second time.
    const second = installFakeBrowser({ [STORAGE_KEY]: JSON.stringify(previous) });
    const stale = JSON.parse(second.storage.getItem(STORAGE_KEY) ?? '{}');
    handle.stop();
    assert.equal(stale.endedCleanly, false, 'the previous record was already marked reported');
  } finally {
    clearFakeBrowser();
  }
});

test('a heartbeat from a live page (second tab, second mount) is not a crash', async () => {
  const now = Date.now();
  const browser = installFakeBrowser({
    [STORAGE_KEY]: JSON.stringify({
      id: 'other-tab',
      startedAt: now - 120_000,
      lastBeatAt: now - 5_000,
      page: '/console',
      heapBytes: 80 * 1024 * 1024,
      heapLimit: 512 * 1024 * 1024,
      longTasks: 1,
      longTaskMs: 60,
      navigationType: 'navigate',
      endedCleanly: false,
      endedAt: null,
    }),
  });
  try {
    const { startSentinel } = await import('../src/lib/perf/sentinel.ts');
    const handle = startSentinel();
    assert.equal(
      browser.reports.length,
      0,
      'a heartbeat five seconds old belongs to a page that is still alive — reporting it was a false crash on every navigation',
    );
    handle.stop();
  } finally {
    clearFakeBrowser();
  }
});

test('a heartbeat older than a day is not reported as a crash', async () => {
  const startedAt = Date.now() - 48 * 60 * 60 * 1000;
  const browser = installFakeBrowser({
    [STORAGE_KEY]: JSON.stringify({
      id: 'ancient',
      startedAt,
      lastBeatAt: startedAt,
      page: '/files',
      heapBytes: 10,
      heapLimit: 512 * 1024 * 1024,
      longTasks: 0,
      longTaskMs: 0,
      navigationType: 'navigate',
      endedCleanly: false,
      endedAt: null,
    }),
  });
  try {
    const { startSentinel } = await import('../src/lib/perf/sentinel.ts');
    const handle = startSentinel();
    assert.equal(browser.reports.length, 0, 'a two-day-old record is an abandoned tab, not a crash');
    handle.stop();
  } finally {
    clearFakeBrowser();
  }
});

test('memory pressure is reported with the measured numbers and releases caches', async () => {
  const browser = installFakeBrowser();
  try {
    const globals = globalThis as unknown as Record<string, unknown>;
    (globals.performance as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize = 460 * 1024 * 1024;

    const { startSentinel } = await import('../src/lib/perf/sentinel.ts');
    let released = 0;
    const handle = startSentinel({ onMemoryPressure: () => void (released += 1) });
    assert.equal(released, 0, 'mounting does not sample pressure');

    browser.runBeat();

    const record = JSON.parse(browser.storage.getItem(STORAGE_KEY) ?? '{}') as { heapBytes: number };
    assert.equal(record.heapBytes, 460 * 1024 * 1024, 'the heartbeat records the current heap');

    const pressure = browser.reports.find((entry) => (entry as { code?: string }).code === 'memory_pressure');
    assert.ok(pressure, 'crossing 70% of the limit must be reported');
    assert.equal((pressure as { context: { ratio: number } }).context.ratio > 0.7, true);
    assert.equal(released, 1, 'caches are released at the same moment');

    browser.runBeat();
    const again = browser.reports.filter((entry) => (entry as { code?: string }).code === 'memory_pressure');
    assert.equal(again.length, 1, 'pressure is reported once per session, not every beat');
    handle.stop();
  } finally {
    clearFakeBrowser();
  }
});
