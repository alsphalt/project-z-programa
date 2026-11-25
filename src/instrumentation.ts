/**
 * Next instrumentation hook.
 *
 * It deliberately imports nothing.
 *
 * Next compiles this file in a dedicated bundle that does **not** apply
 * `serverExternalPackages`. A single import of `src/lib/db.ts` here (directly or
 * three modules deep, via the GitHub pull poller) dragged `pg` into that graph,
 * `pg` requires `fs`, and the whole compilation failed with
 * `Module not found: Can't resolve 'fs'`. The dev server then answered every
 * request with a blank page, and the same graph would have failed a production
 * build in exactly the same way once instrumentation was compiled.
 *
 * The background workers now live in `src/lib/worker/boot.ts` and are started
 * from the normal server graph (`src/app/layout.tsx`, `/api/health`), where `pg`
 * is external and the bundle compiles.
 */
export async function register(): Promise<void> {
  // Intentionally empty. Do not import application modules from this file.
}
