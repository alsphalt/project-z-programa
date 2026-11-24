import { ApiError, ok, route } from '@/lib/api';
import { listEditHistory } from '@/lib/crashfix/save';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Edit history for one imported project: time, previous code, status. */
export const GET = route({ permission: 'file.read' }, async ({ req }) => {
  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) throw new ApiError('projectId is required.', 400, 'project_required');
  const history = await listEditHistory(projectId, 40);
  return ok({ history });
});
