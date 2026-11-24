/**
 * Mapping between a panel path and a repository path.
 *
 * FILE MANAGER and the CODE EDITOR see `/home/container/plugins/menu.js`; GitHub
 * sees `plugins/menu.js` (or `bot/plugins/menu.js` when the binding has a
 * prefix). Getting this wrong silently pushes the wrong file, so the mapping is
 * pure, total, and tested: every function either returns a clean path or throws.
 */

export class GitHubPathError extends Error {
  code: string;
  constructor(message: string, code = 'bad_path') {
    super(message);
    this.name = 'GitHubPathError';
    this.code = code;
  }
}

/** `'' | 'plugins' | 'plugins/menu'` — no leading slash, no `..`, no NUL. */
export function normalizeRepoPrefix(input: string | null | undefined): string {
  const raw = (input ?? '').replace(/\\/g, '/').trim();
  if (raw.includes('\u0000')) throw new GitHubPathError('A repository prefix cannot contain a NUL byte.', 'nul_byte');
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
  for (const segment of segments) {
    if (segment === '..') {
      throw new GitHubPathError('A repository prefix cannot contain "..".', 'traversal');
    }
  }
  return segments.join('/');
}

function normalizeServerRoot(projectRoot: string): string {
  const raw = (projectRoot || '/').replace(/\\/g, '/');
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new GitHubPathError('The project root cannot contain "..".', 'traversal');
  }
  return segments.join('/');
}

function normalizeServerPath(serverPath: string): string {
  const raw = (serverPath || '').replace(/\\/g, '/');
  if (raw.includes('\u0000')) throw new GitHubPathError('A file path cannot contain a NUL byte.', 'nul_byte');
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new GitHubPathError('A file path cannot contain "..".', 'traversal');
  }
  return segments.join('/');
}

/**
 * Panel path → repository path.
 *
 * `/home/container/plugins/menu.js` with root `/home/container` and prefix `bot`
 * becomes `bot/plugins/menu.js`. A path outside the root is refused rather than
 * mapped to something surprising.
 */
export function serverPathToRepoPath(options: {
  prefix: string;
  projectRoot: string;
  serverPath: string;
}): string {
  const prefix = normalizeRepoPrefix(options.prefix);
  const root = normalizeServerRoot(options.projectRoot);
  const full = normalizeServerPath(options.serverPath);

  let relative = full;
  if (root) {
    if (full === root) {
      throw new GitHubPathError('A directory cannot be pushed as a file.', 'not_a_file');
    }
    if (!full.startsWith(`${root}/`)) {
      throw new GitHubPathError(
        `“${options.serverPath}” is outside the server project root (${options.projectRoot}).`,
        'outside_root',
      );
    }
    relative = full.slice(root.length + 1);
  }
  if (!relative) throw new GitHubPathError('That path maps to an empty repository path.', 'empty_path');
  return prefix ? `${prefix}/${relative}` : relative;
}

/** Repository path → panel path (the inverse of the mapping above). */
export function repoPathToServerPath(options: {
  prefix: string;
  projectRoot: string;
  repoPath: string;
}): string {
  const prefix = normalizeRepoPrefix(options.prefix);
  const root = normalizeServerRoot(options.projectRoot);
  const repoPath = normalizeRepoPrefix(options.repoPath);
  if (!repoPath) throw new GitHubPathError('That repository path is empty.', 'empty_path');

  let relative = repoPath;
  if (prefix) {
    if (repoPath !== prefix && !repoPath.startsWith(`${prefix}/`)) {
      throw new GitHubPathError(
        `“${repoPath}” is not inside the bound repository folder “${prefix}”. Change the binding or pick another file.`,
        'outside_prefix',
      );
    }
    relative = repoPath.slice(prefix.length).replace(/^\//, '');
  }
  if (!relative) throw new GitHubPathError('That repository path maps to the repository root.', 'empty_path');

  return `/${[root, relative].filter(Boolean).join('/')}`;
}

/** True when the repository path lives inside the bound prefix. */
export function isInsidePrefix(prefix: string, repoPath: string): boolean {
  const normalizedPrefix = normalizeRepoPrefix(prefix);
  const normalizedPath = normalizeRepoPrefix(repoPath);
  if (!normalizedPrefix) return true;
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}
