import { ok, route } from '@/lib/api';
import { getImportOptions } from '@/lib/github/repos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Drives the GitHub Import tab:
 *  - repository configured → show that one repository with IMPORT;
 *  - account connected   → searchable list of authorised repositories;
 *  - nothing configured  → "GITHUB NOT CONNECTED" with a link to Admin Settings.
 */
export const GET = route({ permission: 'file.read' }, async () => {
  const options = await getImportOptions();
  return ok(options);
});
