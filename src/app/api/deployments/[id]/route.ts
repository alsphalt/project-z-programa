import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess, getServer } from '@/lib/servers/repo';
import { rollbackDeployment } from '@/lib/services/deploy';
import { parseJsonb, query, queryOne } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/session';
import { healthOk, publicId, toUiStatus } from '@/lib/deploy-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface Params extends Record<string, string> {
  id: string;
}

interface DeploymentRow {
  id: string;
  server_id: string;
  status: string;
  trigger: string;
  file_count: number;
  files: unknown;
  pre_hashes: unknown;
  post_hashes: unknown;
  validation: unknown;
  restart_requested: boolean;
  restart_performed: boolean;
  health: unknown;
  error: string | null;
  notes: string | null;
  created_by: string | null;
  started_at: string;
  finished_at: string | null;
}

async function load(id: string, user: SessionUser) {
  const row = await queryOne<DeploymentRow>('select * from deployments where id = $1', [id]);
  if (!row) throw new ApiError('Deployment not found', 404, 'deployment_not_found');
  const server = await assertServerAccess(user, row.server_id, 'file.read');
  return { row, server };
}

export const GET = route<Params>({ permission: 'file.read' }, async ({ user, params }) => {
  const { row, server } = await load(params.id, user);

  const paths = parseJsonb<Array<{ path?: string } | string>>(row.files, []).map((item) =>
    typeof item === 'string' ? item : (item.path ?? ''),
  );
  const pre = parseJsonb<Record<string, string | null>>(row.pre_hashes, {});
  const post = parseJsonb<Record<string, string | null>>(row.post_hashes, {});
  const sizes = await query<{ path: string; size_bytes: string | number }>(
    `select path, size_bytes from file_indexes where server_id = $1 and path = any($2::text[])`,
    [server.id, paths.length ? paths : ['']],
  );
  const sizeByPath = new Map(sizes.map((item) => [item.path, Number(item.size_bytes ?? 0)]));

  const logs = await query<{ level: string; message: string; created_at: string; step: string | null }>(
    `select level, message, created_at, step from deployment_logs where deployment_id = $1 order by id asc limit 500`,
    [row.id],
  );

  return ok({
    deployment: {
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
      author: null,
      changedPaths: paths,
      server: { id: server.id, name: server.name },
      files: paths.map((path) => ({
        path,
        action: 'write',
        beforeSha: pre[path] ?? null,
        afterSha: post[path] ?? null,
        size: sizeByPath.get(path) ?? 0,
      })),
      logs: logs.map((line) => ({
        level: line.level,
        message: line.step ? `[${line.step}] ${line.message}` : line.message,
        at: line.created_at,
      })),
      validation: parseJsonb<Record<string, unknown>>(row.validation, {}),
    },
  });
});

const actionSchema = z.object({ action: z.literal('rollback') });

export const POST = route<Params>({ permission: 'rollback' }, async ({ user, params, body }) => {
  await body(actionSchema);
  const row = await queryOne<{ server_id: string }>('select server_id from deployments where id = $1', [params.id]);
  if (!row) throw new ApiError('Deployment not found', 404, 'deployment_not_found');
  const server = await getServer(row.server_id);
  if (!server) throw new ApiError('The server for this deployment no longer exists', 409, 'server_gone');
  await assertServerAccess(user, server.id, 'rollback');

  const result = await rollbackDeployment({ server, user, deploymentId: params.id });
  return ok({
    rolledBack: true,
    publicId: publicId(params.id),
    restored: result.restored,
    failed: result.failed,
    restarted: result.restarted,
    detail: result.detail,
  });
});
