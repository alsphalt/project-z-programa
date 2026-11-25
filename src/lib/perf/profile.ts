/**
 * Render profile — the reversible switch used to isolate what makes a device
 * slow, without changing code, environment or a single feature.
 *
 *   ?profile=safe     no polling, no ambient/snow animation, motion reduced.
 *                     Every page still loads its data, once, on demand.
 *   ?profile=reduced  no ambient/snow animation, polling stays on.
 *   ?profile=full     the default.
 *
 * The choice is remembered per device (`dn.profile.v1`), so a phone can be put
 * into safe mode once and left there while a problem is bisected, and cleared by
 * visiting `?profile=full`. Nothing here disables a feature — it only removes
 * optional, continuous cost, which is what an Android freeze is made of.
 *
 * The DARKNOTE introduction is part of the product and is never suppressed (see
 * `christmas/provider.tsx`); under `safe` it renders with its animation
 * neutralised, exactly like the operating system's own reduced-motion request.
 */

export type RenderProfile = 'full' | 'reduced' | 'safe';

export const PROFILE_STORAGE_KEY = 'dn.profile.v1';
export const PROFILE_PARAM = 'profile';

function normalize(value: unknown): RenderProfile | null {
  return value === 'full' || value === 'reduced' || value === 'safe' ? value : null;
}

/**
 * The profile for this device.
 *
 * Read order: `?profile=` (and it is stored) → the stored value → `full`. The
 * query parameter wins because it is the one a person types on the phone that is
 * misbehaving.
 */
export function readRenderProfile(): RenderProfile {
  if (typeof window === 'undefined') return 'full';
  try {
    const requested = normalize(new URLSearchParams(window.location.search).get(PROFILE_PARAM));
    if (requested) {
      window.localStorage.setItem(PROFILE_STORAGE_KEY, requested);
      return requested;
    }
    return normalize(window.localStorage.getItem(PROFILE_STORAGE_KEY)) ?? 'full';
  } catch {
    // Private mode / storage disabled: the defaults still work.
    return 'full';
  }
}

/** Mirrors the profile into the DOM so CSS can act on it. */
export function applyRenderProfile(profile: RenderProfile): void {
  if (typeof document === 'undefined') return;
  try {
    if (profile === 'full') delete document.documentElement.dataset.profile;
    else document.documentElement.dataset.profile = profile;
  } catch {
    /* ignore */
  }
}

/** Decorative motion (ambient word, orb mist, snow) is off in both non-default profiles. */
export function allowsDecorativeMotion(profile: RenderProfile): boolean {
  return profile === 'full';
}

/** Background polling is off in `safe` only: the page still reads on mount. */
export function allowsPolling(profile: RenderProfile): boolean {
  return profile !== 'safe';
}
