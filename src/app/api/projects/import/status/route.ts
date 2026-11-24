import { ApiError, ok, route } from '@/lib/api';
import { getImportJob } from '@/lib/projects/import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'file.read' }, async ({ req }) => {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) throw new ApiError('id is required.', 400, 'job_required');
  const job = await getImportJob(id);
  return ok({
    job,
    percent:
      job.totalFiles > 0 ? Math.min(100, Math.round((job.fetchedFiles / job.totalFiles) * 100)) : job.status === 'succeeded' ? 100 : 0,
  });
});
