import { ok, route } from '@/lib/api';
import { listProjectSummaries } from '@/lib/projects/repo';
import { getConnectionView } from '@/lib/github/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Import history: every imported project, its source, state and sync status. */
export const GET = route({ permission: 'file.read' }, async () => {
  const [projects, connection] = await Promise.all([listProjectSummaries(), getConnectionView()]);
  return ok({
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      source: project.source,
      sourceLabel: project.sourceLabel,
      repository:
        project.githubOwner && project.githubRepo
          ? {
              owner: project.githubOwner,
              name: project.githubRepo,
              branch: project.githubBranch,
              defaultBranch: project.githubDefaultBranch,
              private: project.githubPrivate,
              url: `https://github.com/${project.githubOwner}/${project.githubRepo}`,
            }
          : null,
      status: project.status,
      statusMessage: project.statusMessage,
      syncStatus: project.syncStatus,
      syncError: project.syncError,
      syncEnabled: project.syncEnabled,
      lastSyncAt: project.lastSyncAt,
      lastCommitSha: project.lastCommitSha,
      lastCommitUrl: project.lastCommitUrl,
      lastCommitMessage: project.lastCommitMessage,
      fileCount: project.fileCount,
      textFileCount: project.textFileCount,
      totalBytes: project.totalBytes,
      pendingChanges: project.pendingChanges,
      pendingSince: project.pendingSince,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    github: {
      connected: connection.connected,
      account: connection.account?.login ?? null,
      autoSync: connection.autoSync,
      syncDelaySeconds: connection.syncDelaySeconds,
    },
    note: 'Removing a project deletes only the panel’s working copy — the GitHub repository is never touched.',
  });
});
