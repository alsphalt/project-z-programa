/**
 * Test-only module resolution hook.
 *
 * 1. `server-only` throws when imported outside a React Server Components
 *    bundle. The pipeline tests import the server services directly, so the
 *    guard is mapped to an empty module here. This affects tests only — the real
 *    build keeps the guard, which is what stops a client component importing
 *    server code.
 * 2. The application source uses extensionless relative imports (the TypeScript
 *    convention). Node's type stripping needs a real filename, so `.ts` and
 *    `/index.ts` are tried for extensionless relative specifiers.
 * 3. The `@/` alias (`@/lib/db`) is resolved to `src/`, the same mapping as
 *    `tsconfig.json`, so a route handler can be imported and called directly in
 *    a test instead of only through a running server.
 */
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath, pathToFileURL } from 'node:url';

      const empty = ${JSON.stringify(new URL('./empty-module.mjs', import.meta.url).href)};
      const src = ${JSON.stringify(new URL('../src/', import.meta.url).href)};

      export async function resolve(specifier, context, next) {
        if (specifier === 'server-only') return { url: empty, shortCircuit: true };

        if (specifier.startsWith('@/')) {
          const path = fileURLToPath(new URL(specifier.slice(2), src));
          if (!/\\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('.json')) {
            for (const candidate of [path + '.ts', path + '.tsx', path + '/index.ts', path + '/index.tsx']) {
              if (existsSync(candidate)) {
                return { url: pathToFileURL(candidate).href, shortCircuit: true };
              }
            }
          }
          if (existsSync(path)) return { url: pathToFileURL(path).href, shortCircuit: true };
        }

        if (specifier.startsWith('.') || specifier.startsWith('/')) {
          const base = context.parentURL
            ? new URL(specifier, context.parentURL)
            : pathToFileURL(specifier);
          const path = fileURLToPath(base);
          if (!/\\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('.json')) {
            for (const candidate of [path + '.ts', path + '.tsx', path + '/index.ts', path + '/index.tsx']) {
              if (existsSync(candidate)) {
                return { url: pathToFileURL(candidate).href, shortCircuit: true };
              }
            }
          }
        }
        // Next.js subpath entry points are CJS files: 'next/server' -> 'next/server.js'
        if (specifier.startsWith('next/') && !specifier.endsWith('.js')) {
          try {
            return await next(specifier + '.js', context);
          } catch {
            /* fall through */
          }
        }
        return next(specifier, context);
      }
    `),
  import.meta.url,
);
