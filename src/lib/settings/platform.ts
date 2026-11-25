/**
 * Platform settings — types, defaults and normalisers.
 *
 * This module is intentionally free of server imports: the client components
 * read the same shape that the routes write, and the tests exercise the
 * normalisers directly. The database side lives in `./store.ts`.
 *
 * Everything here has a safe default, so a missing row (or a row written by an
 * older build) can never disable sign-up, break login or crash a page.
 */

export type AppearanceMode = 'on' | 'off' | 'reduced';

export interface AppearanceSettings {
  /** Christmas visuals across the console: on, off, or on with fewer animations. */
  christmasEffects: AppearanceMode;
  /** The animated DARKNOTE introduction on first open. */
  animatedIntro: boolean;
  /** Decorative snow layer. Independent from the intro, off in reduced mode. */
  snow: boolean;
}

export interface SecuritySettings {
  /** Allow WebAuthn/passkey enrolment and sign-in. */
  passkeysEnabled: boolean;
  /** Allow the dedicated biometric sign-in path (platform authenticators). */
  biometricLoginEnabled: boolean;
  /** Require the authenticator to verify the user (biometric or device PIN). */
  requireUserVerification: boolean;
}

export type RegistrationRole = 'viewer' | 'operator' | 'admin';

export interface RegistrationSettings {
  /**
   * Self-service sign-up. Deliberately defaults to `true` and is never expired,
   * auto-disabled or deleted by the application — only an administrator changes
   * it here.
   */
  enabled: boolean;
  /** Role granted to a fresh account. Viewer by default: least privilege. */
  defaultRole: RegistrationRole;
}

export interface PlatformSettings {
  appearance: AppearanceSettings;
  security: SecuritySettings;
  registration: RegistrationSettings;
  /** ISO timestamp of the last write, for the settings screen. */
  updatedAt: string | null;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  christmasEffects: 'on',
  animatedIntro: true,
  snow: true,
};

export const DEFAULT_SECURITY: SecuritySettings = {
  passkeysEnabled: true,
  biometricLoginEnabled: true,
  requireUserVerification: true,
};

export const DEFAULT_REGISTRATION: RegistrationSettings = {
  enabled: true,
  defaultRole: 'viewer',
};

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  appearance: DEFAULT_APPEARANCE,
  security: DEFAULT_SECURITY,
  registration: DEFAULT_REGISTRATION,
  updatedAt: null,
};

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function resolveAppearance(value: unknown): AppearanceSettings {
  const input = record(value);
  const mode = input.christmasEffects;
  const christmasEffects: AppearanceMode =
    mode === 'off' || mode === 'reduced' || mode === 'on' ? mode : DEFAULT_APPEARANCE.christmasEffects;
  return {
    christmasEffects,
    animatedIntro: bool(input.animatedIntro, DEFAULT_APPEARANCE.animatedIntro),
    // Reduced motion implies no snow layer even if `snow` was stored as true.
    snow: christmasEffects === 'reduced' ? false : bool(input.snow, DEFAULT_APPEARANCE.snow),
  };
}

export function resolveSecurity(value: unknown): SecuritySettings {
  const input = record(value);
  const passkeysEnabled = bool(input.passkeysEnabled, DEFAULT_SECURITY.passkeysEnabled);
  return {
    passkeysEnabled,
    // Biometric sign-in cannot stay on when passkeys are switched off: they are
    // the same credential, and reporting "enabled" for something that can never
    // work would be a lie in the settings screen.
    biometricLoginEnabled: passkeysEnabled
      ? bool(input.biometricLoginEnabled, DEFAULT_SECURITY.biometricLoginEnabled)
      : false,
    requireUserVerification: bool(input.requireUserVerification, DEFAULT_SECURITY.requireUserVerification),
  };
}

export function resolveRegistration(value: unknown): RegistrationSettings {
  const input = record(value);
  const role = input.defaultRole;
  const defaultRole: RegistrationRole =
    role === 'admin' || role === 'operator' || role === 'viewer' ? role : DEFAULT_REGISTRATION.defaultRole;
  return {
    enabled: bool(input.enabled, DEFAULT_REGISTRATION.enabled),
    defaultRole,
  };
}

export function resolvePlatformSettings(
  rows: Record<string, unknown>,
  updatedAt: string | null = null,
): PlatformSettings {
  return {
    appearance: resolveAppearance(rows.appearance),
    security: resolveSecurity(rows.security),
    registration: resolveRegistration(rows.registration),
    updatedAt,
  };
}

/**
 * The subset of the settings that a visitor who is not signed in may see.
 * Nothing here is sensitive: it only tells the login screen which buttons to
 * render and the effects layer which defaults to use.
 */
export interface PublicPolicy {
  registrationEnabled: boolean;
  passkeysEnabled: boolean;
  biometricLoginEnabled: boolean;
  requireUserVerification: boolean;
  appearance: AppearanceSettings;
  branding: { product: string; credit: string };
}

export const BRANDING = {
  product: 'DARKNOTE',
  credit: 'POWERED BY JIMMY M, TECH',
} as const;

export function publicPolicy(settings: PlatformSettings): PublicPolicy {
  return {
    registrationEnabled: settings.registration.enabled,
    passkeysEnabled: settings.security.passkeysEnabled,
    biometricLoginEnabled: settings.security.biometricLoginEnabled,
    requireUserVerification: settings.security.requireUserVerification,
    appearance: settings.appearance,
    branding: { ...BRANDING },
  };
}

/**
 * Merge a partial update onto the stored settings. Unknown keys are ignored and
 * every field is re-normalised, so a hostile payload cannot store arbitrary JSON
 * in these documents.
 */
export function mergePlatformSettings(
  current: PlatformSettings,
  patch: {
    appearance?: Partial<AppearanceSettings> | null;
    security?: Partial<SecuritySettings> | null;
    registration?: Partial<RegistrationSettings> | null;
  },
): { appearance: AppearanceSettings; security: SecuritySettings; registration: RegistrationSettings } {
  return {
    appearance: resolveAppearance({ ...current.appearance, ...(patch.appearance ?? {}) }),
    security: resolveSecurity({ ...current.security, ...(patch.security ?? {}) }),
    registration: resolveRegistration({ ...current.registration, ...(patch.registration ?? {}) }),
  };
}
