import { ok, route } from '@/lib/api';
import { query, queryOne } from '@/lib/db';
import { getConnectionView } from '@/lib/github/credentials';
import { findProjectByRepo } from '@/lib/projects/repo';
import { recentDeliveries, readWebhookSecret } from '@/lib/github/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type SyncState = 'disconnected' | 'synced' | 'pending' | 'syncing' | 'conflict' | 'failed';

/**
 * One read for the whole synchronization status card.
 *
 * Everything here is stored state — no GitHub call is made, so the panel can
 * poll it cheaply. The freshness of "latest commit" comes from the webhook or
 * the 10 s poller, and `lastCheckedAt` says when that last happened.
 */
export const GET = route({ permission: 'file.read' }, async () => {
  const connection = await getConnectionView();
  const owner = connection.repository?.owner ?? null;
  const repo = connection.repository?.name ?? null;
  const branch = connection.repository?.branch ?? null;

  const project = owner && repo ? await findProjectByRepo(owner, repo, branch) : null;

  const counts = await queryOne<{
    pending_jobs: string | number;
    dirty_files: string | number;
    open_conflicts: string | number;
    failed_deliveries: string | number;
  }>(
    `select
       (select count(*)::int from github_sync_jobs where status = 'pending' and ($1::text is null or project_id = $1)) as pending_jobs,
       (select count(*)::int from imported_project_files where dirty = true and pending_delete = false and ($1::text is null or project_id = $1)) as dirty_files,
       (select count(*)::int from github_sync_conflicts where status = 'open' and ($1::text is null or project_id = $1)) as open_conflicts,
       (select count(*)::int from github_webhook_deliveries where status = 'failed' and received_at > now() - interval '1 hour') as failed_deliveries`,
    [project?.id ?? null],
  );

  const pendingJobs = Number(counts?.pending_jobs ?? 0);
  const dirtyFiles = Number(counts?.dirty_files ?? 0);
  const openConflicts = Number(counts?.open_conflicts ?? 0);
  const failedDeliveries = Number(counts?.failed_deliveries ?? 0);

  const conflicts = project
    ? await query<{
        id: string;
        path: string;
        reason: string;
        status: string;
        created_at: string;
        head_commit: string | null;
      }>(
        `select id, path, reason, status, created_at, head_commit
           from github_sync_conflicts
          where project_id = $1 and status = 'open'
          order by created_at desc
          limit 25`,
        [project.id],
      )
    : [];

  const deliveries = await recentDeliveries(6).catch(() => []);
  const lastDelivery = deliveries[0] ?? null;
  const webhookConfigured = Boolean(await readWebhookSecret().catch(() => null));

  const lastEvent = project
    ? await queryOne<{ created_at: string; message: string }>(
        `select created_at, message from github_sync_events where project_id = $1 order by id desc limit 1`,
        [project.id],
      )
    : null;

  let state: SyncState = 'disconnected';
  if (connection.connected && project) {
    if (openConflicts > 0 || project.syncStatus === 'conflict') state = 'conflict';
    else if (project.syncStatus === 'failed' || failedDeliveries > 0) state = 'failed';
    else if (project.syncStatus === 'syncing') state = 'syncing';
    else if (pendingJobs > 0 || dirtyFiles > 0 || project.syncStatus === 'pending') state = 'pending';
    else if (project.syncStatus === 'synced' || project.baseCommitSha) state = 'synced';
    else state = 'pending';
  }

  const direction =
    openConflicts > 0
      ? 'both'
      : pendingJobs > 0 || dirtyFiles > 0
        ? 'panel→github'
        : lastEvent
          ? 'github→panel'
          : 'none';

  return ok({
    state,
    direction,
    connection: {
      connected: connection.connected,
      login: connection.account?.login ?? null,
      repo: owner && repo ? `${owner}/${repo}` : null,
      branch,
      autoSync: connection.autoSync,
      syncDelaySeconds: connection.syncDelaySeconds,
      lastError: connection.lastError ?? null,
    },
    project: project
      ? {
          id: project.id,
          name: project.name,
          syncStatus: project.syncStatus,
          syncError: project.syncError,
          baseCommitSha: project.baseCommitSha,
          lastCommitSha: project.lastCommitSha,
          lastCommitMessage: project.lastCommitMessage,
          lastCommitUrl: project.lastCommitUrl,
          lastSyncAt: project.lastSyncAt,
        }
      : null,
    pending: { queuedPushes: pendingJobs, dirtyFiles, openConflicts },
    webhook: {
      configured: webhookConfigured,
      lastDelivery: lastDelivery
        ? {
            id: lastDelivery.id,
            event: lastDelivery.event,
            status: lastDelivery.status,
            message: lastDelivery.message,
            at: lastDelivery.received_at,
          }
        : null,
      failedLastHour: failedDeliveries,
    },
    lastEvent: lastEvent ? { at: lastEvent.created_at, message: lastEvent.message } : null,
    conflicts,
    recentDeliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      event: delivery.event,
      branch: delivery.branch,
      commit: delivery.commit_sha,
      status: delivery.status,
      message: delivery.message,
      at: delivery.received_at,
    })),
  });
});
