"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, errorMessage } from "./client";
import { allowsPolling, readRenderProfile } from '@/lib/perf/profile';

/**
 * Cached, de-duplicated GET hook.
 *
 * Every page used to fire its own request on mount, so navigating back and forth
 * re-fetched identical payloads and made the console feel slower than it is.
 * This keeps a small in-memory cache:
 *
 *  - a fresh entry (default 4 s) is served immediately with no network call;
 *  - a stale entry renders immediately and revalidates in the background, so a
 *    page never shows a spinner for data it already has;
 *  - concurrent callers of the same URL share one request;
 *  - the returned identity is stable, so a parent re-render does not restart it.
 *
 * `refresh()` always bypasses the cache — that is what the explicit Refresh
 * buttons call.
 */

interface Entry {
  data: unknown;
  at: number;
  /** Approximate retained bytes, used to bound the whole cache. */
  bytes: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Keep the cache small: this is a convenience layer, not a data store.
 *
 * Counting entries is not enough. A single `/api/monitor` payload carries the
 * console tail, so sixty "small" entries could pin several megabytes of JS
 * objects for the lifetime of the tab — on a low-RAM Android device that is
 * how a page that worked for ten minutes dies on the eleventh. The cache is now
 * bounded by retained bytes as well as by count, and the oldest entry is
 * dropped first.
 */
const MAX_ENTRIES = 30;
const MAX_BYTES = 3 * 1024 * 1024;

function estimateBytes(data: unknown): number {
  if (data === null || data === undefined) return 0;
  try {
    const json = JSON.stringify(data);
    // Two bytes per UTF-16 code unit plus object overhead.
    return json ? json.length * 2 + 128 : 0;
  } catch {
    return 256 * 1024;
  }
}

function totalBytes(): number {
  let sum = 0;
  for (const entry of cache.values()) sum += entry.bytes;
  return sum;
}

function remember(url: string, data: unknown): void {
  cache.set(url, { data, at: Date.now(), bytes: estimateBytes(data) });
  if (cache.size <= MAX_ENTRIES && totalBytes() <= MAX_BYTES) return;
  // Evict least-recently-fetched entries until both budgets are satisfied.
  const ordered = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of ordered) {
    if (cache.size <= MAX_ENTRIES && totalBytes() <= MAX_BYTES) break;
    if (key === url) continue;
    cache.delete(key);
  }
}

/** Drop cached responses (used after a write that is known to change them). */
export function invalidateApi(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function useApi<T>(
  url: string | null,
  options: { refreshMs?: number; staleMs?: number; skipCache?: boolean } = {},
) {
  const { refreshMs, skipCache = false } = options;
  const staleMs = options.staleMs ?? 4000;

  const cachedValue = url && !skipCache ? (cache.get(url)?.data as T | undefined) : undefined;
  const [data, setData] = useState<T | null>(cachedValue ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url) && cachedValue === undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      if (!url) return;
      if (!force && !skipCache) {
        const entry = cache.get(url);
        if (entry && Date.now() - entry.at < staleMs) {
          if (mounted.current) {
            setData(entry.data as T);
            setLoading(false);
            setError(null);
          }
          return;
        }
      }

      try {
        let request = inFlight.get(url);
        if (!request) {
          request = apiGet<T>(url).finally(() => inFlight.delete(url));
          inFlight.set(url, request);
        }
        const result = (await request) as T;
        remember(url, result);
        if (mounted.current) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (mounted.current) setError(errorMessage(err));
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [skipCache, staleMs, url],
  );

  const refresh = useCallback(async () => {
    await load(true);
  }, [load]);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    // Serve what we have, then revalidate — one render, no spinner flash.
    const entry = skipCache ? undefined : cache.get(url);
    if (entry) {
      setData(entry.data as T);
      setLoading(false);
    } else {
      setLoading(true);
    }
    void load(false);
  }, [load, skipCache, url]);

  /**
   * Polling stops while the page is hidden.
   *
   * Android keeps background tabs alive long enough for their timers to fire,
   * so a dashboard left open in another tab kept hitting the panel and the
   * database — and kept its JSON in this cache — for no benefit. The timer is
   * dropped on `hidden` and one fresh read runs when the page comes back.
   */
  useEffect(() => {
    /**
     * `?profile=safe` turns every background poll off for this device. The page
     * already has its data from the mount read; this only stops the repeat.
     */
    const every = allowsPolling(readRenderProfile()) ? options.refreshMs : 0;
    if (!every || !url) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void load(true), every);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) {
        stop();
        return;
      }
      start();
      void load(true);
    };

    if (typeof document === "undefined" || !document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, options.refreshMs, url]);

  return { data, error, loading, refresh, setData };
}
