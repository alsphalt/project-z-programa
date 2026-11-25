/**
 * Christmas appearance preferences.
 *
 * Two layers, deliberately:
 *  - the administrator's defaults (`appearance` in platform settings), which every
 *    visitor starts from;
 *  - the per-device choice in localStorage, which always wins once it exists.
 *
 * `introSeen` lives on the device too: the introduction is a first-run moment,
 * not a toll gate on every page load.
 */

export type ChristmasMode = 'on' | 'off' | 'reduced';

export interface ServerAppearance {
  christmasEffects: ChristmasMode;
  animatedIntro: boolean;
  snow: boolean;
}

export interface ChristmasPrefs {
  mode: ChristmasMode;
  intro: boolean;
  snow: boolean;
  introSeen: boolean;
}

export const CHRISTMAS_STORAGE_KEY = 'dn.christmas.v1';

export const DEFAULT_APPEARANCE: ServerAppearance = {
  christmasEffects: 'on',
  animatedIntro: true,
  snow: true,
};

export function normalizeMode(value: unknown, fallback: ChristmasMode = 'on'): ChristmasMode {
  return value === 'on' || value === 'off' || value === 'reduced' ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** localStorage may contain anything (old builds, manual edits, garbage). */
export function parseStored(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mergePrefs(server: ServerAppearance, stored: Record<string, unknown> | null): ChristmasPrefs {
  const local = stored ?? {};
  const mode = normalizeMode(local.mode, normalizeMode(server.christmasEffects));
  return {
    mode,
    intro: booleanOr(local.intro, Boolean(server.animatedIntro)),
    // Reduced motion never shows moving snow, whatever the stored value says.
    snow: mode === 'reduced' ? false : booleanOr(local.snow, Boolean(server.snow)),
    introSeen: local.introSeen === true,
  };
}

export function serializePrefs(prefs: ChristmasPrefs): string {
  return JSON.stringify({
    mode: prefs.mode,
    intro: prefs.intro,
    snow: prefs.snow,
    introSeen: prefs.introSeen,
  });
}

/**
 * True when the console is running as an installed app (home screen, dock or
 * standalone window) rather than in a browser tab.
 *
 * The introduction is a launch moment for the installed app: closing it and
 * opening it again must show the intro again. A browser tab keeps the
 * first-run-only behaviour.
 */
export function isStandaloneLaunch(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (window.matchMedia?.('(display-mode: window-controls-overlay)').matches) return true;
    if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true;
  } catch {
    /* matchMedia can be blocked; fall through to the iOS flag */
  }
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** The appearance mode already chosen on this device, before any network call. */
export function storedMode(stored: Record<string, unknown> | null, server: ServerAppearance): ChristmasMode {
  return normalizeMode((stored ?? {}).mode, normalizeMode(server.christmasEffects));
}

/** True when the operating system asks for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
