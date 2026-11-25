/**
 * Remote path safety. Every path that reaches the Pterodactyl API passes
 * through here so a request can never escape the configured project root.
 */

export class PathError extends Error {}

const FORBIDDEN_SEGMENTS = new Set(['..', '.']);

export function normalizeRemotePath(input: string): string {
  if (typeof input !== 'string') throw new PathError('Path must be a string');
  if (input.includes('\0')) throw new PathError('Path contains a null byte');
  let p = input.replace(/\\/g, '/').trim();
  if (p === '' || p === '.') p = '/';
  if (!p.startsWith('/')) p = `/${p}`;
  const segments: string[] = [];
  for (const raw of p.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (FORBIDDEN_SEGMENTS.has(raw)) {
      if (raw === '..') throw new PathError('Path traversal is not allowed');
      continue;
    }
    segments.push(raw);
  }
  return `/${segments.join('/')}`;
}

export function normalizeRoot(root: string): string {
  return normalizeRemotePath(root || '/');
}

/** Confine a request path to the project root. Returns an absolute remote path. */
export function confineToRoot(root: string, requested: string): string {
  const r = normalizeRoot(root);
  const p = normalizeRemotePath(requested);
  if (r === '/') return p;
  if (p === r) return p;
  if (!p.startsWith(`${r}/`)) {
    throw new PathError(`Path "${p}" is outside the configured project directory "${r}"`);
  }
  return p;
}

export function joinRemote(...parts: string[]): string {
  const joined = parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => part.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

export function parentOf(remotePath: string): string {
  const p = normalizeRemotePath(remotePath);
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

export function baseName(remotePath: string): string {
  const p = normalizeRemotePath(remotePath);
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

export function extensionOf(name: string): string {
  const base = name.toLowerCase();
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx + 1);
}

const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)auth(\/|$)/i,
  /(^|\/)sessions?(\/|$)/i,
  /(^|\/)baileys_store/i,
  /(^|\/)creds\.json$/i,
  /(^|\/)pre-key-\d+\.json$/i,
  /(^|\/)sender-key-.*\.json$/i,
  /(^|\/)session-.*\.json$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)secrets?\.(json|ya?ml|env)$/i,
];

/**
 * Templates are documentation, not credentials: `.env.example` lists the variable
 * names an operator must fill in. They stay readable (and editable, see
 * `isEditable`), while `.env` itself is still refused.
 */
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i;

/** Paths that may never be read into the browser, downloaded or versioned. */
export function isSecretPath(remotePath: string): boolean {
  const p = normalizeRemotePath(remotePath);
  if (ENV_TEMPLATE.test(p)) return false;
  return SECRET_PATTERNS.some((re) => re.test(p));
}

const EDITABLE_EXTENSIONS = new Set([
  'js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx', 'json', 'html', 'htm', 'css', 'scss',
  'md', 'markdown', 'txt', 'yml', 'yaml', 'xml', 'sql', 'sh', 'env.example', 'gitignore',
  'properties', 'ini', 'conf', 'toml', 'log', 'csv',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'mp3', 'mp4', 'wav', 'ogg',
  'webm', 'mov', 'avi', 'zip', 'gz', 'tar', 'rar', '7z', 'pdf', 'doc', 'docx', 'xls',
  'xlsx', 'ppt', 'pptx', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm', 'node', 'so',
  'dll', 'exe', 'db', 'sqlite', 'sqlite3', 'webp', 'psd', 'ai',
]);

export function isEditable(remotePath: string): boolean {
  const name = baseName(remotePath).toLowerCase();
  if (name === '.gitignore' || name === '.env.example') return true;
  return EDITABLE_EXTENSIONS.has(extensionOf(name));
}

export function isProbablyBinary(remotePath: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(baseName(remotePath)));
}

/** Never index or walk into these directories. */
export const DEFAULT_EXCLUDED_PATHS = [
  'node_modules',
  '.git',
  '.cache',
  'auth',
  'sessions',
  'session',
  'tmp',
  '.next',
  'dist',
  'build',
  'coverage',
  'logs',
];

export function isExcluded(remotePath: string, exclusions: string[]): boolean {
  const p = normalizeRemotePath(remotePath).toLowerCase();
  const segments = p.split('/').filter(Boolean);
  for (const raw of exclusions) {
    const ex = raw.trim().toLowerCase();
    if (!ex) continue;
    if (ex.includes('/')) {
      const needle = ex.startsWith('/') ? ex : `/${ex}`;
      if (p === needle || p.startsWith(`${needle}/`)) return true;
    } else if (segments.includes(ex)) {
      return true;
    }
  }
  return false;
}

/** Refuse paths used by system-level operations. */
export function assertNotProtectedOperation(paths: string[]): void {
  for (const p of paths) {
    const norm = normalizeRemotePath(p);
    if (norm === '/' || norm === '') {
      throw new PathError('Refusing to operate on the project root itself');
    }
  }
}

/** Human breadcrumb trail from the project root to a directory. */
export function breadcrumbsOf(root: string, target: string): Array<{ name: string; path: string }> {
  const normalizedRoot = normalizeRoot(root);
  const normalizedTarget = normalizeRemotePath(target);
  const trail = [{ name: normalizedRoot === '/' ? 'Server root' : baseName(normalizedRoot), path: normalizedRoot }];
  if (normalizedTarget === normalizedRoot) return trail;
  const relative =
    normalizedRoot === '/'
      ? normalizedTarget.slice(1)
      : normalizedTarget.slice(normalizedRoot.length + 1);
  let cursor = normalizedRoot;
  for (const segment of relative.split('/').filter(Boolean)) {
    cursor = joinRemote(cursor, segment);
    trail.push({ name: segment, path: cursor });
  }
  return trail;
}
