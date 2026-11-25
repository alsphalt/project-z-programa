import { ApiError, ok, rateLimit, route } from '@/lib/api';
import { searchCases } from '@/lib/crashfix/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Searches the real JavaScript of every imported project (or one project) for
 * `case '<name>':` blocks and returns only those cases. File names, folders and
 * surrounding code never leave the server.
 */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  rateLimit(`crashfix-search:${user.id}`, 90, 60_000);
  const url = new URL(req.url);
  const query = url.searchParams.get('q') ?? '';
  if (!query.trim()) throw new ApiError('Type a command name to search for.', 400, 'query_required');
  const projectId = url.searchParams.get('projectId') || null;
  const result = await searchCases(query, { projectId });
  return ok(result);
});
