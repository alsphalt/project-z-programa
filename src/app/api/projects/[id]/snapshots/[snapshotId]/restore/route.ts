import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { requireProject } from '@/lib/projects/repo';
import { restoreProjectSnapshot } from '@/lib/projects/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const schema = z.object({
  /** Restoring replaces the whole stored tree, so it must be asked for. */
  confirm: z.literal(true),
});

/**
 * Restores a project's files from a snapshot.
 *
 * The manifest is re-verified from storage before anything is deleted, the
 * restore itself runs in one transaction, and the tree is re-hashed inside that
 * transaction — a mismatch rolls the whole thing back.
 */
export const POST = route<{ id: string; snapshotId: string }>(
  { permission: 'file.write' },
  async ({ params, body, user }) => {
    rateLimit(`project-snapshot-restore:${user.id}`, 10, 60_000);
    await body(schema);
    const project = await requireProject(params.id);
    const report = await restoreProjectSnapshot({
      projectId: project.id,
      snapshotId: params.snapshotId,
      userId: user.id,
      user: { id: user.id, email: user.email },
    });
    return ok(report);
  },
);
