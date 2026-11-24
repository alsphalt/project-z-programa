/*
 * DARKNOTE CONTROL CENTER — service worker.
 *
 * Scope of this worker is intentionally narrow, because the console is an
 * authenticated admin surface:
 *
 *   - Static build output (/_next/static), icons and the manifest are cached
 *     with stale-while-revalidate so the shell boots instantly and survives a
 *     flaky connection.
 *   - HTML navigations are network-first and never written to a cache, so an
 *     authenticated page can't be replayed to the next person using the device.
 *   - /api/* is never intercepted: every request keeps the browser's own
 *     credentials, cookies and cache headers.
 *   - When the network is gone, navigations fall back to /offline.
 *
 * Bump CACHE_VERSION whenever the cached surface changes; the previous caches
 * are removed on activate.
 */

/*
 * v3 — the worker is byte-for-byte the same strategy as v2; the version was
 * bumped because the build output changed (new chunk graph), and an old cache
 * holding stale hashed chunks is the classic "the fix did not arrive on my
 * phone" report. On activate the previous cache is deleted, so a device that
 * upgrades takes the new assets exactly once.
 */
const CACHE_VERSION = "v3";
const STATIC_CACHE = `darknote-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline";

const PRECACHE = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

// Paths that are safe to cache and safe to serve stale.
const CACHEABLE_PREFIXES = ["/_next/static/", "/icons/", "/assets/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Cache entries one by one so a single 404 can't fail the installation.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const response = await fetch(new Request(url, { cache: "reload" }));
            if (response.ok) await cache.put(url, response);
          } catch {
            /* offline during install: try again on the next activate */
          }
        }),
      );

      // The offline document points at hashed build chunks. Cache those too,
      // otherwise the fallback page arrives without its stylesheet the first
      // time a device goes offline.
      const offline = await cache.match(OFFLINE_URL);
      if (offline) {
        try {
          const html = await offline.clone().text();
          const assets = new Set(
            Array.from(html.matchAll(/(?:href|src)="(\/_next\/static\/[^"]+)"/g), (match) => match[1]),
          );
          await Promise.all(
            Array.from(assets).map(async (asset) => {
              try {
                const response = await fetch(new Request(asset, { cache: "reload" }));
                if (response.ok) await cache.put(asset, response);
              } catch {
                /* a missing chunk is not worth failing the install over */
              }
            }),
          );
        } catch {
          /* HTML not readable: keep the plain offline fallback */
        }
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE]);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("darknote-") && !keep.has(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "PING" && event.source) {
    event.source.postMessage({ type: "PONG", version: CACHE_VERSION });
  }
  if (data.type === "CLEAR_CACHES") {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("darknote-")).map((key) => caches.delete(key)));
        if (event.source) event.source.postMessage({ type: "CACHES_CLEARED" });
      })(),
    );
  }
});

function isCacheableAsset(url) {
  return CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === "basic") {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) return cached;
  const response = await network;
  return response || Response.error();
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(STATIC_CACHE);
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Offline</title><body style=\"background:#05060a;color:#e7eaf3;font:16px system-ui;padding:2rem\">You are offline.</body>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
