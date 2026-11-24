import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { getPlatformSettings, savePlatformSettings } from '@/lib/settings/store';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Platform switches: appearance, security (passkeys) and registration policy. */
export const GET = route({ permission: null }, async () => {
  return ok({ settings: await getPlatformSettings() });
});

const schema = z.object({
  appearance: z
    .object({
      christmasEffects: z.enum(['on', 'off', 'reduced']).optional(),
      animatedIntro: z.boolean().optional(),
      snow: z.boolean().optional(),
    })
    .nullish(),
  security: z
    .object({
      passkeysEnabled: z.boolean().optional(),
      biometricLoginEnabled: z.boolean().optional(),
      requireUserVerification: z.boolean().optional(),
    })
    .nullish(),
  registration: z
    .object({
      enabled: z.boolean().optional(),
      defaultRole: z.enum(['viewer', 'operator', 'admin']).optional(),
    })
    .nullish(),
});

export const PUT = route({ permission: 'settings.manage' }, async ({ user, body }) => {
  const input = await body(schema);
  const settings = await savePlatformSettings(
    {
      appearance: input.appearance ?? null,
      security: input.security ?? null,
      registration: input.registration ?? null,
    },
    user.id,
  );

  await logActivity({
    user,
    action: 'settings.platform_updated',
    severity: 'warning',
    detail: {
      appearance: settings.appearance,
      security: settings.security,
      registration: settings.registration,
    },
  });

  return ok({ settings });
});
