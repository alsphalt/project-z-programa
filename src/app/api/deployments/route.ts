import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { deployChanges, listDeployments } from '@/lib/services/deploy';
import { query, queryOne } from '@/lib/db';
import { publicId, toUiStatus, healthOk } from '@/lib/deploy-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface DeploymentListRow {
  id: string;
  status: string;
  trigger: string;
  file_count: number;
  restart_requested: boolean;
  restart_performed: boolean;
  error: string | null;
  created_by: string | null;
  started_at: string;
  finished_at: string | null;
  health: unknown;
  notes: string | null;
}

export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'file.read');

  const raw = await listDeployments(server.id, Number(url.searchParams.get('limit') ?? 40));
  const rows: DeploymentListRow[] = raw.map((row) => row as unknown as DeploymentListRow);
  const counts = await query<{ deployment_id: string; files: string | number; logs: string | number }>(
    `select d.id as deployment_id,
            coalesce(jsonb_array_length(d.files), 0) as files,
            (select count(*)::int from deployment_logs l where l.deployment_id = d.id) as logs
       from deployments d where d.server_id = $1`,
    [server.id],
  );
  const byId = new Map(counts.map((row) => [row.deployment_id, row]));

  const ids = rows.map((row) => row.id);
  const authors = await query<{ id: string; email: string }>(
    `select id, email from admin_users where id = any($1::text[])`,
    [ids.length ? ids : ['']],
  );
  const emailById = new Map(authors.map((row) => [row.id, row.email]));

  return ok({
    deployments: rows.map((row) => ({
      id: row.id,
      publicId: publicId(row.id),
      status: toUiStatus(row.status),
      message: row.notes,
      fileCount: Number(row.file_count ?? 0),
      restartRequired: Boolean(row.restart_requested),
      restartIssued: Boolean(row.restart_performed),
      healthOk: healthOk(row.health),
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      author: row.created_by ? (emailById.get(row.created_by) ?? null) : null,
      files: Number(byId.get(row.id)?.files ?? 0),
      logs: Number(byId.get(row.id)?.logs ?? 0),
    })),
  });
});

const deploySchema = z
  .object({
    serverId: z.string().min(1),
    /**
     * Preferred for large edits: deploy the server-side draft by id instead of
     * re-uploading a multi-megabyte string from the browser.
     */
    draftId: z.string().min(1).optional(),
    files: z
      .array(
        z.object({
          path: z.string().min(1),
          content: z.string(),
          expectedSha: z.string().nullable().optional(),
        }),
      )
      .min(1)
      .max(200)
      .optional(),
    message: z.string().max(500).optional(),
    restartMode: z.enum(['auto', 'always', 'never']).optional(),
  })
  .refine((value) => Boolean(value.draftId) !== Boolean(value.files?.length), {
    message: 'Provide either draftId or files (not both).',
  });

/**
 * The single write path to production: validate → backup → write → verify →
 * restart when required → observe startup. Never a silent local save.
 */
export const POST = route({ permission: 'deploy' }, async ({ user, body }) => {
  const input = await body(deploySchema);
  const server = await assertServerAccess(user, input.serverId, 'deploy');

  let changes: Array<{ path: string; content: string; expectedHash: string | null; note?: string }>;
  if (input.draftId) {
    const draft = await queryOne<{
      id: string;
      path: string;
      content: string;
      base_sha256: string | null;
      status: string;
      user_id: string | null;
    }>('select id, path, content, base_sha256, status, user_id from editor_drafts where id = $1 and server_id = $2', [
      input.draftId,
      server.id,
    ]);
    if (!draft) throw new ApiError('Draft not found for this server.', 404, 'draft_not_found');
    if (draft.status === 'uploading') {
      throw new ApiError('This draft is still uploading. Finish the chunked save first.', 409, 'draft_incomplete');
    }
    if (draft.status === 'deployed') {
      throw new ApiError('This draft was already deployed. Re-open the file to start a new edit.', 409, 'draft_deployed');
    }
    if (draft.user_id && draft.user_id !== user.id) {
      throw new ApiError('That draft belongs to another user.', 403, 'draft_forbidden');
    }
    changes = [
      {
        path: draft.path,
        content: draft.content,
        expectedHash: draft.base_sha256,
        note: input.message,
      },
    ];
  } else {
    changes = (input.files ?? []).map((file) => ({
      path: file.path,
      content: file.content,
      expectedHash: file.expectedSha ?? null,
      note: input.message,
    }));
  }

  const outcome = await deployChanges({
    server,
    user,
    changes,
    note: input.message,
    restartMode: input.restartMode ?? 'auto',
  });

  if (outcome.status === 'failed' && outcome.files.every((file) => file.status === 'failed')) {
    throw new ApiError(outcome.error ?? 'Deployment failed', 502, 'deployment_failed', outcome);
  }

  return ok({
    deployment: {
      id: outcome.id,
      publicId: publicId(outcome.id),
      status: toUiStatus(outcome.status),
      healthOk: outcome.health.verdict === 'healthy' ? true : outcome.health.verdict === 'unhealthy' ? false : null,
      health: outcome.health,
      restarted: outcome.restarted,
      error: outcome.error ?? null,
      warnings: outcome.warnings,
      files: outcome.files,
      logs: outcome.logs,
    },
  });
});
