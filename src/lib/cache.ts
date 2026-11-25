/**
 * Process-local TTL cache.
 *
 * The console is one Node process talking to one database and one panel. A few
 * values are read on nearly every request and change rarely (platform settings,
 * the GitHub connection row, a server row). Re-reading them per request is the
 * single largest source of avoidable database round-trips, so they go through
 * this map instead.
 *
 * Rules that keep it honest:
 *  - every entry has an explicit TTL, so a write from another process is picked
 *    up within seconds at worst;
 *  - every writer in this codebase calls `invalidate()` with its key prefix, so
 *    our own writes are visible immediately;
 *  - a failed load is never cached — the next caller retries.
 */
interface Entry {
  value: unknown;
  expiresAt: number;
}

const globalStore = globalThis as unknown as {
  __darknoteCache?: Map<string, Entry>;
  __darknoteInflight?: Map<string, Promise<unknown>>;
};

const store = (globalStore.__darknoteCache ??= new Map<string, Entry>());
const inflight = (globalStore.__darknoteInflight ??= new Map<string, Promise<unknown>>());

/** Longest TTL allowed, so a typo cannot pin a value for a day. */
const MAX_TTL_MS = 5 * 60_000;

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    try {
      const value = await load();
      store.set(key, { value, expiresAt: Date.now() + Math.min(Math.max(ttlMs, 0), MAX_TTL_MS) });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/** Drops every entry whose key starts with `prefix` (all entries when omitted). */
export function invalidate(prefix?: string): number {
  if (!prefix) {
    const size = store.size;
    store.clear();
    return size;
  }
  let removed = 0;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** Drops stale entries. Called opportunistically, never on a timer. */
export function pruneCache(limit = 200): void {
  if (store.size <= limit) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}
