import { z } from 'zod';
import { ApiError, ok, route } from '@/lib/api';
import { getError, setErrorStatus } from '@/lib/errors/store';
import { assertServerAccess } from '@/lib/servers/repo';
import type { Permission, Principal } from '@/lib/auth/permissions';
import type { ErrorEvent } from '@/lib/errors/types';

async function loadGuarded(user: Principal, id: string, permission: Permission): Promise<ErrorEvent> {
  const error = await getError(id);
  if (!error) throw new ApiError('Error record not found.', 404, 'error_not_found');
  if (error.serverId && !['owner', 'admin'].includes(user.role)) {
    await assertServerAccess(user, error.serverId, permission);
  }
  return error;
}
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>({ permission: 'console.read' }, async ({ params, user }) => {
  const error = await loadGuarded(user, params.id, 'console.read');
  return ok({ error });
});

const patchSchema = z.object({
  status: z.enum(['active', 'resolved', 'ignored']),
  note: z.string().max(2000).optional(),
});

export const PATCH = route<Params>({ permission: 'console.read' }, async ({ params, body, user }) => {
  const input = await body(patchSchema);
  const before = await loadGuarded(user, params.id, 'console.read');

  const updated = await setErrorStatus(params.id, input.status, user, input.note);
  await logActivity({
    user,
    serverId: before.serverId,
    action: `error.${input.status}`,
    target: params.id,
    detail: { code: before.code, note: input.note ?? null },
  });
  return ok({ error: updated });
});

export const DELETE = route<Params>({ permission: 'console.read' }, async ({ params, user }) => {
  const existing = await loadGuarded(user, params.id, 'console.read');
  // Deleting diagnostics is an explicit owner action; operators mark them
  // resolved instead so the history stays auditable.
  if (user.role !== 'owner') {
    throw new ApiError('Only the owner can delete an error record. Mark it resolved instead.', 403, 'owner_only');
  }
  const { query } = await import('@/lib/db');
  await query('delete from error_intel_events where id = $1', [params.id]);
  await logActivity({
    user,
    serverId: existing.serverId,
    action: 'error.deleted',
    target: params.id,
    severity: 'warning',
    detail: { code: existing.code },
  });
  return ok({ deleted: params.id });
});
