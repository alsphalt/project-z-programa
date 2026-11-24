import { ok, route } from '@/lib/api';
import { listRepositories } from '@/lib/github/repos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Repositories the connected token can see. Never another account's list. */
export const GET = route({ permission: 'file.write' }, async ({ req }) => {
  const url = new URL(req.url);
  const result = await listRepositories({
    search: url.searchParams.get('q') ?? undefined,
    page: Number(url.searchParams.get('page') ?? 1),
    perPage: Number(url.searchParams.get('perPage') ?? 60),
    refresh: url.searchParams.get('refresh') === '1',
  });
  return ok(result);
});
