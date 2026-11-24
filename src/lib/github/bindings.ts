import 'server-only';
import { ApiError } from '../api';
import { query, queryOne } from '../db';
import { uuid } from '../crypto';
import { createProject, findProjectByRepo, getProject, requireProject, updateProject, type ProjectRecord } from '../projects/repo';
import { requireServer, type ServerRecord } from '../servers/repo';
import { getConnectionView, requireClient } from './credentials';
import { normalizeRepoPrefix } from './paths';

/**
 * One server ↔ one repository.
 *
 * FILE MANAGER and the CODE EDITOR do not own a GitHub connection: they use the
 * binding below, which points at an existing imported project. That is the whole
 * point of the design — the token, the repository configuration, the working copy
 * and the debounced queue are shared with CRASH AND FIX and LIVE MONITORING, so
 * there is exactly one place where a push can happen and exactly one history.
 */

export interface BindingRow {
  id: string;
  server_id: string;
  project_id: string;
  path_prefix: string;
  auto_sync: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerBinding {
  id: string;
  serverId: string;
  projectId: string;
  pathPrefix: string;
  autoSync: boolean;
  createdAt: string;
}

function mapBinding(row: BindingRow): ServerBinding {
  return {
    id: row.id,
    serverId: row.server_id,
    projectId: row.project_id,
    pathPrefix: row.path_prefix ?? '',
    autoSync: Boolean(row.auto_sync),
    createdAt: row.created_at,
  };
}

export async function getBinding(serverId: string): Promise<ServerBinding | null> {
  const row = await queryOne<BindingRow>('select * from server_github_bindings where server_id = $1', [serverId]);
  return row ? mapBinding(row) : null;
}

export interface BindingWithProject {
  binding: ServerBinding;
  project: ProjectRecord;
  server: ServerRecord;
}

export async function requireBinding(serverId: string): Promise<BindingWithProject> {
  const binding = await getBinding(serverId);
  if (!binding) {
    throw new ApiError(
      'This server is not bound to a GitHub repository yet. Connect one from the File Manager or the Code Editor.',
      424,
      'github_not_bound',
    );
  }
  const project = await getProject(binding.projectId);
  if (!project) {
    throw new ApiError(
      'The repository this server was bound to no longer exists in the panel. Bind it again.',
      409,
      'binding_project_missing',
    );
  }
  const server = await requireServer(serverId);
  return { binding, project, server };
}

/**
 * Bind a server to a repository.
 *
 * The repository and branch are read through the connected token before anything
 * is stored, so "bound" always means "GitHub answered". An existing working copy
 * for the same repository and branch is reused instead of created twice — the
 * database refuses a second active copy for good reason.
 */
export async function bindServerToRepository(options: {
  serverId: string;
  owner: string;
  repo: string;
  branch?: string | null;
  pathPrefix?: string | null;
  autoSync?: boolean;
  userId: string | null;
}): Promise<BindingWithProject> {
  const server = await requireServer(options.serverId);
  const connection = await getConnectionView();
  if (!connection.connected) {
    throw new ApiError(
      'GitHub is not connected. Add a token or authorize the OAuth app in Admin Settings → GitHub.',
      424,
      'github_not_connected',
    );
  }

  const pathPrefix = normalizeRepoPrefix(options.pathPrefix ?? '');
  const client = await requireClient();

  let repository;
  try {
    repository = await client.getRepository(options.owner, options.repo);
  } catch (error) {
    throw new ApiError(
      `That repository is not accessible with the connected token: ${error instanceof Error ? error.message : String(error)}`,
      400,
      'repository_unreachable',
    );
  }

  const branch = options.branch?.trim() || repository.default_branch;
  let head: { sha: string };
  try {
    head = await client.getBranchHead(repository.owner?.login ?? options.owner, repository.name, branch);
  } catch (error) {
    throw new ApiError(
      `The branch “${branch}” could not be read: ${error instanceof Error ? error.message : String(error)}`,
      400,
      'branch_unreachable',
    );
  }

  let project = await findProjectByRepo(repository.owner?.login ?? options.owner, repository.name, branch);
  if (!project) {
    project = await createProject({
      name: repository.name,
      description: repository.description ?? null,
      source: 'github',
      sourceLabel: `${repository.owner?.login ?? options.owner}/${repository.name}@${branch}`,
      github: {
        owner: repository.owner?.login ?? options.owner,
        repo: repository.name,
        branch,
        defaultBranch: repository.default_branch,
        private: Boolean(repository.private),
        commitSha: head.sha,
      },
      createdBy: options.userId,
    });
  } else if (!project.baseCommitSha) {
    project = await updateProject(project.id, { baseCommitSha: head.sha });
  }

  const autoSync = options.autoSync ?? true;
  const existing = await getBinding(options.serverId);
  const row = existing
    ? await queryOne<BindingRow>(
        `update server_github_bindings
            set project_id = $2, path_prefix = $3, auto_sync = $4, updated_at = now()
          where server_id = $1
          returning *`,
        [options.serverId, project.id, pathPrefix, autoSync],
      )
    : await queryOne<BindingRow>(
        `insert into server_github_bindings (id, server_id, project_id, path_prefix, auto_sync, created_by)
         values ($1,$2,$3,$4,$5,$6)
         returning *`,
        [uuid(), options.serverId, project.id, pathPrefix, autoSync, options.userId],
      );

  if (!row) throw new ApiError('The binding could not be stored.', 500, 'binding_failed');
  return { binding: mapBinding(row), project: await requireProject(project.id), server };
}

export async function unbindServer(serverId: string): Promise<void> {
  await query('delete from server_github_bindings where server_id = $1', [serverId]);
}

export async function setBindingAutoSync(serverId: string, autoSync: boolean): Promise<ServerBinding> {
  const row = await queryOne<BindingRow>(
    `update server_github_bindings set auto_sync = $2, updated_at = now() where server_id = $1 returning *`,
    [serverId, autoSync],
  );
  if (!row) throw new ApiError('This server is not bound to a repository.', 404, 'binding_missing');
  return mapBinding(row);
}

/** Every server bound to a repository — used by the settings screen. */
export async function listBindings(): Promise<Array<ServerBinding & { serverName: string; repo: string | null; branch: string | null }>> {
  const rows = await query<BindingRow & { server_name: string; github_owner: string | null; github_repo: string | null; github_branch: string | null }>(
    `select b.*, s.name as server_name, p.github_owner, p.github_repo, p.github_branch
       from server_github_bindings b
       join connected_servers s on s.id = b.server_id
       left join imported_projects p on p.id = b.project_id
      order by s.name asc`,
  );
  return rows.map((row) => ({
    ...mapBinding(row),
    serverName: row.server_name,
    repo: row.github_owner && row.github_repo ? `${row.github_owner}/${row.github_repo}` : null,
    branch: row.github_branch ?? null,
  }));
}
