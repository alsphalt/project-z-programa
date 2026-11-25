import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Compress responses at the edge of Node (the console is mostly JSON + text).
  compress: true,
  productionBrowserSourceMaps: false,
  experimental: {
    /**
     * Rewrite barrel imports into per-icon imports. `lucide-react` is imported by
     * almost every page, and without this the bundler has to touch the whole
     * icon set on each of them.
     */
    optimizePackageImports: ["lucide-react"],
  },
  // This repository can live inside another project that has its own lockfile.
  // Pin the tracing root so Next writes and reads the same .next directory.
  outputFileTracingRoot: __dirname,
  /**
   * `db/schema.sql` and `db/migrations/*.sql` are read with fs at boot, not
   * imported, so the bundler cannot discover them on its own. Without this a
   * serverless deployment or `output: "standalone"` build ships without the
   * folder and the first database call fails with "db/schema.sql not found".
   *
   * This is the App Router equivalent of the Vercel `functions.includeFiles`
   * setting — that one only applies to files under `api/`, which this app does
   * not use.
   */
  outputFileTracingIncludes: {
    "/**": ["./db/schema.sql", "./db/migrations/**/*.sql"],
    "/*": ["./db/schema.sql", "./db/migrations/**/*.sql"],
  },
  poweredByHeader: false,
  serverExternalPackages: [
    "ws",
    "pg",
    "@neondatabase/serverless",
    "@prisma/client",
    "@aws-sdk/client-s3",
    "@electric-sql/pglite",
  ],
  async headers() {
    return [
      {
        // The worker must be revalidated on every load, otherwise a deploy can
        // leave clients pinned to an old cache until the HTTP cache expires.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Content-Type", value: "application/manifest+json" },
          { key: "Cache-Control", value: "public, max-age=3600" },
        ],
      },
      {
        source: "/icons/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // Monaco is served from the deployment (no CDN dependency). A day of
        // caching keeps the editor instant on repeat visits without pinning an
        // old build for long after an upgrade.
        source: "/monaco/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
