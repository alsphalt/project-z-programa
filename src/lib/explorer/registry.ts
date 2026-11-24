/**
 * Optional dependency freshness check.
 *
 * Off by default: the explorer must work on a server with no outbound network and
 * must not phone the npm registry with a private package list unless the operator
 * asked for it. Set `DARKNOTE_NPM_REGISTRY_CHECK=1` to enable.
 *
 * When it is on, only the *latest published version* is fetched (one small request
 * per package, capped) and a declared range is reported as `outdated` when that
 * version does not satisfy it. Nothing is installed, upgraded or written.
 *
 * Version comparison is a deliberate subset of semver: `^`, `~`, `>=`, `>`, `=`,
 * bare versions, partial versions (`1`, `1.2`, `1.x`) and `||` alternatives. Any
 * range this parser does not understand returns `null` (= unknown) rather than a
 * guess, and `workspace:`/`file:`/`git+`/URL ranges are skipped.
 */

import { isOutdatedVersion, satisfiesRange } from './classify';

export interface VersionCheck {
  name: string;
  latest: string | null;
  error?: string;
}

export { isOutdatedVersion as isOutdated, satisfiesRange as satisfies };

/** Freshness checks are opt-in; without the flag nothing leaves the server. */
export function registryCheckEnabled(): boolean {
  return process.env.DARKNOTE_NPM_REGISTRY_CHECK === '1';
}

const cache = new Map<string, { at: number; value: VersionCheck }>();
const CACHE_TTL = 30 * 60_000;

async function latestOf(
  name: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<VersionCheck> {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let value: VersionCheck;
  try {
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      value = { name, latest: null, error: `registry responded ${response.status}` };
    } else {
      const body = (await response.json()) as { version?: unknown };
      value =
        typeof body.version === 'string'
          ? { name, latest: body.version }
          : { name, latest: null, error: 'registry returned no version' };
    }
  } catch (error) {
    value = {
      name,
      latest: null,
      error: controller.signal.aborted ? 'registry lookup timed out' : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
  if (!value.error) cache.set(name, { at: Date.now(), value });
  return value;
}

/**
 * Fetch the latest published version for each package, bounded and non-fatal.
 * Any failure is reported per package and never breaks the explorer.
 */
export async function fetchLatestVersions(
  names: string[],
  options: { fetcher?: typeof fetch; timeoutMs?: number; concurrency?: number } = {},
): Promise<Map<string, VersionCheck>> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const unique = [...new Set(names)].filter(Boolean).slice(0, 40);
  const results = new Map<string, VersionCheck>();

  for (let index = 0; index < unique.length; index += concurrency) {
    const batch = unique.slice(index, index + concurrency);
    const settled = await Promise.all(batch.map((name) => latestOf(name, fetcher, timeoutMs)));
    for (const entry of settled) results.set(entry.name, entry);
  }
  return results;
}

/** Test seam. */
export function resetRegistryCacheForTests(): void {
  cache.clear();
}
