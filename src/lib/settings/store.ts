import 'server-only';
import { cached, invalidate } from '../cache';
import { jsonb, parseJsonb, query } from '../db';
import {
  DEFAULT_PLATFORM_SETTINGS,
  mergePlatformSettings,
  resolvePlatformSettings,
  type PlatformSettings,
} from './platform';

/**
 * Database access for platform settings.
 *
 * Three rows in `platform_settings` (`appearance`, `security`, `registration`)
 * are read on nearly every request — the login screen needs the policy, the
 * shell needs the appearance defaults, the routes need the security switches.
 * They are cached for 20 seconds and invalidated on every write, which removes
 * three queries per page load without making a save feel stale.
 */

const CACHE_KEY = 'platform:settings';
const TTL_MS = 20_000;

interface Row {
  key: string;
  value: unknown;
  updated_at: string | null;
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  return cached(CACHE_KEY, TTL_MS, async () => {
    const rows = await query<Row>('select key, value, updated_at from platform_settings');
    const map: Record<string, unknown> = {};
    let updatedAt: string | null = null;
    for (const row of rows) {
      map[row.key] = parseJsonb<unknown>(row.value, {});
      if (row.updated_at && (!updatedAt || row.updated_at > updatedAt)) updatedAt = row.updated_at;
    }
    if (!rows.length) return DEFAULT_PLATFORM_SETTINGS;
    return resolvePlatformSettings(map, updatedAt);
  });
}

export interface PlatformSettingsUpdate {
  appearance?: Partial<PlatformSettings['appearance']> | null;
  security?: Partial<PlatformSettings['security']> | null;
  registration?: Partial<PlatformSettings['registration']> | null;
}

export async function savePlatformSettings(
  update: PlatformSettingsUpdate,
  userId: string | null,
): Promise<PlatformSettings> {
  const current = await getPlatformSettings();
  const next = mergePlatformSettings(current, update);

  const writes: Array<[string, unknown]> = [
    ['appearance', next.appearance],
    ['security', next.security],
    ['registration', next.registration],
  ];

  for (const [key, value] of writes) {
    await query(
      `insert into platform_settings (key, value, updated_by, updated_at)
       values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, jsonb(value), userId],
    );
  }

  invalidate(CACHE_KEY);
  return getPlatformSettings();
}
