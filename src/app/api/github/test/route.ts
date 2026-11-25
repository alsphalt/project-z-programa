import { ok, route } from '@/lib/api';
import { noteConnectionTest } from '@/lib/github/credentials';
import { testConnection } from '@/lib/github/repos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * TEST CONNECTION — performs real calls against GitHub (token → account →
 * repository list → configured repository → branch) and records the outcome.
 */
export const POST = route({ permission: 'settings.manage' }, async () => {
  const result = await testConnection();
  await noteConnectionTest(result.ok, result.ok ? null : result.checks.find((check) => check.ok === false)?.detail ?? 'Connection test failed');
  return ok(result);
});
