import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { cancelImport, runImportBatch } from '@/lib/projects/import-batch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  jobId: z.string().min(1),
  action: z.enum(['run', 'cancel']).default('run'),
});

/**
 * One step of a batched GitHub import.
 *
 * The client drives the loop, so progress survives a closed tab, a phone that
 * suspends the page and a platform request timeout. Each call writes at most
 * `IMPORT_BATCH_SIZE` files and returns the persisted counters — the progress
 * bar shows what was actually stored, not an animation.
 */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  rateLimit(`project-import-batch:${user.id}`, 120, 60_000);
  const input = await body(schema);

  const job = input.action === 'cancel' ? await cancelImport(input.jobId) : await runImportBatch(input.jobId);

  return ok({
    job,
    done: job.status !== 'running',
    percent: job.totalFiles > 0 ? Math.min(100, Math.round((job.fetchedFiles / job.totalFiles) * 100)) : 0,
  });
});
