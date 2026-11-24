import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { createImportJob } from '@/lib/projects/import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  source: z.enum(['github', 'upload']),
  message: z.string().max(200).optional(),
});

/**
 * Opens an import job before the (potentially long) import starts, so the
 * browser has something real to poll while files are being fetched and stored.
 */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  rateLimit(`import-job:${user.id}`, 40, 60_000);
  const input = await body(schema);
  const jobId = await createImportJob({ source: input.source, userId: user.id, message: input.message });
  return ok({ jobId });
});
