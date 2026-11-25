import 'server-only';
import { query } from '../db';
import { lookupApiRoute } from './routes';
import type { DiagnosisEvidence, ProjectEvidence } from './taxonomy';
import type { RawErrorInput } from './types';
import { extractEndpoint, extractModuleName } from './parse';

/**
 * Collect the real facts a diagnosis needs, from the database and the local
 * route tree. Everything returned here is measured; missing data stays null.
 */
export async function collectEvidence(
  serverId: string | null,
  input: RawErrorInput,
): Promise<DiagnosisEvidence> {
  const parsed = extractEndpoint(input.message ?? '');
  const endpoint = input.endpoint ?? parsed.endpoint ?? null;
  const method = input.httpMethod ?? parsed.method ?? null;
  const status = input.httpStatus ?? parsed.status ?? null;

  let route: DiagnosisEvidence['route'];
  if (endpoint?.startsWith('/api/') && (status === 405 || status === 404 || !status)) {
    try {
      route = lookupApiRoute(endpoint);
    } catch {
      route = undefined;
    }
  }

  let project: ProjectEvidence | undefined;
  if (serverId) {
    project = await projectEvidence(serverId, input.message ?? '');
  }

  return { route, project };
}

async function projectEvidence(serverId: string, message: string): Promise<ProjectEvidence> {
  const moduleName = extractModuleName(message);

  const [flags, paths, session] = await Promise.all([
    query<{ has_node_modules: boolean | null; has_package_json: boolean | null }>(
      `select
         exists(select 1 from file_indexes where server_id = $1 and deleted_at is null
                and (path like '%/node_modules' or path like '%/node_modules/%')) as has_node_modules,
         exists(select 1 from file_indexes where server_id = $1 and deleted_at is null
                and (name = 'package.json' or path = '/package.json')) as has_package_json`,
      [serverId],
    ),
    query<{ path: string }>(
      `select path from file_indexes where server_id = $1 and deleted_at is null
        and is_directory = false order by path asc limit 3000`,
      [serverId],
    ),
    query<{ path: string }>(
      `select path from file_indexes where server_id = $1 and deleted_at is null
        and (path like '/auth/%' or path like '%creds.json' or path like '%/session/%')
        and is_directory = false limit 20`,
      [serverId],
    ),
  ]);

  const allPaths = paths.map((row) => row.path);
  const candidates = moduleName
    ? allPaths
        .filter((path) => path.toLowerCase().includes(moduleName.replace(/^\.\//, '').toLowerCase().split('/').pop() ?? ''))
        .slice(0, 6)
    : [];

  return {
    hasNodeModules: flags[0] ? Boolean(flags[0].has_node_modules) : null,
    hasPackageJson: flags[0] ? Boolean(flags[0].has_package_json) : null,
    paths: allPaths,
    moduleCandidates: candidates,
    sessionArtifacts: session.map((row) => row.path),
  };
}
