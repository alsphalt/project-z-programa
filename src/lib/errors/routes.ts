/**
 * Read the application's own route table from disk.
 *
 * This is what turns "Request failed (405)" into a specific finding: the route
 * exists, but it exports GET only, and the browser sent POST. It also powers the
 * navigation registry check, so BIGBROTHER never links to a page that does not
 * exist.
 */
import fs from 'node:fs';
import path from 'node:path';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiRouteInfo {
  /** Express-style pattern, e.g. /api/errors/:id/repair */
  pattern: string;
  file: string;
  methods: HttpMethod[];
  dynamic: boolean;
}

export interface PageInfo {
  /** URL path as the App Router resolves it, e.g. /monitor or /editor */
  href: string;
  file: string;
  dynamic: boolean;
}

interface Cache {
  api?: ApiRouteInfo[];
  pages?: PageInfo[];
  at: number;
}

const CACHE_TTL_MS = 15_000;
const cache: Cache = { at: 0 };

function appDir(override?: string): string {
  if (override) return override;
  const direct = path.join(process.cwd(), 'src', 'app');
  if (fs.existsSync(direct)) return direct;
  // When the process runs from the repository root of a workspace.
  const nested = path.join(process.cwd(), 'let-try', 'src', 'app');
  if (fs.existsSync(nested)) return nested;
  return direct;
}

function walk(dir: string, base: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
}

function segmentToPattern(segment: string): { value: string; dynamic: boolean } {
  if (segment.startsWith('((') || segment.startsWith('(')) return { value: '', dynamic: false }; // route group
  const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatchAll) return { value: `:${optionalCatchAll[1]}*?`, dynamic: true };
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return { value: `:${catchAll[1]}*`, dynamic: true };
  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic) return { value: `:${dynamic[1]}`, dynamic: true };
  return { value: segment, dynamic: false };
}

function exportedMethods(file: string): HttpMethod[] {
  let source = '';
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const found: HttpMethod[] = [];
  for (const method of HTTP_METHODS) {
    const re = new RegExp(
      `export\\s+(?:const|let|var|async\\s+function|function)\\s+${method}\\b|export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`,
    );
    if (re.test(source)) found.push(method);
  }
  return found;
}

export function apiRoutes(overrideAppDir?: string): ApiRouteInfo[] {
  const now = Date.now();
  if (!overrideAppDir && cache.api && now - cache.at < CACHE_TTL_MS) return cache.api;

  const root = path.join(appDir(overrideAppDir), 'api');
  const files: string[] = [];
  walk(root, root, files);

  const routes: ApiRouteInfo[] = [];
  for (const relative of files) {
    if (!/(^|\/)route\.tsx?$/.test(relative)) continue;
    const dir = relative.replace(/\/?route\.tsx?$/, '');
    const segments = dir.split('/').filter(Boolean);
    const mapped = segments.map(segmentToPattern).filter((segment) => segment.value !== '');
    routes.push({
      pattern: `/api${mapped.length ? `/${mapped.map((segment) => segment.value).join('/')}` : ''}`,
      file: `src/app/api/${relative}`,
      methods: exportedMethods(path.join(root, relative)),
      dynamic: mapped.some((segment) => segment.dynamic),
    });
  }
  routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
  if (!overrideAppDir) {
    cache.api = routes;
    cache.at = now;
  }
  return routes;
}

export function pages(overrideAppDir?: string): PageInfo[] {
  const now = Date.now();
  if (!overrideAppDir && cache.pages && now - cache.at < CACHE_TTL_MS) return cache.pages;

  const root = appDir(overrideAppDir);
  const files: string[] = [];
  walk(root, root, files);

  const out: PageInfo[] = [];
  for (const relative of files) {
    if (!/(^|\/)page\.tsx?$/.test(relative)) continue;
    const dir = relative.replace(/\/?page\.tsx?$/, '');
    const segments = dir.split('/').filter(Boolean);
    const mapped = segments
      .filter((segment) => !segment.startsWith('('))
      .map((segment) => (segment.startsWith('[') ? ':param' : segment));
    out.push({
      href: `/${mapped.join('/')}`.replace(/\/$/, '') || '/',
      file: `src/app/${relative}`,
      dynamic: segments.some((segment) => segment.startsWith('[')),
    });
  }
  if (!overrideAppDir) {
    cache.pages = out;
    cache.at = now;
  }
  return out;
}

function matchPattern(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  let i = 0;
  for (let p = 0; p < patternSegments.length; p += 1) {
    const segment = patternSegments[p];
    if (segment.endsWith('*?')) return true;
    if (segment.endsWith('*')) return true;
    if (i >= pathSegments.length) return false;
    if (!segment.startsWith(':')) {
      if (segment !== pathSegments[i]) return false;
    }
    i += 1;
  }
  return i === pathSegments.length;
}

export interface RouteLookup {
  pathname: string;
  /** True when an API route file serves this pathname. */
  exists: boolean;
  file: string | null;
  uploadedMethods: HttpMethod[];
  dynamic: boolean;
  /** Set when the route tree could not be read (e.g. a slim standalone build). */
  unavailable: boolean;
}

export function lookupApiRoute(pathname: string, overrideAppDir?: string): RouteLookup {
  const clean = pathname.split('?')[0];
  const routes = apiRoutes(overrideAppDir);
  if (!routes.length) {
    return {
      pathname: clean,
      exists: false,
      file: null,
      uploadedMethods: [],
      dynamic: false,
      unavailable: true,
    };
  }
  const exact = routes.find((route) => route.pattern === clean);
  const matched = exact ?? routes.find((route) => route.dynamic && matchPattern(route.pattern, clean));
  if (!matched) {
    return {
      pathname: clean,
      exists: false,
      file: null,
      uploadedMethods: [],
      dynamic: false,
      unavailable: false,
    };
  }
  return {
    pathname: clean,
    exists: true,
    file: matched.file,
    uploadedMethods: matched.methods,
    dynamic: matched.dynamic,
    unavailable: false,
  };
}

/** Used by tests and by the navigation check. */
export function pageExists(href: string, overrideAppDir?: string): boolean {
  const clean = href.split('?')[0].split('#')[0] || '/';
  const all = pages(overrideAppDir);
  if (!all.length) return false;
  const staticMatch = all.find((page) => !page.dynamic && page.href === clean);
  if (staticMatch) return true;
  return all.some((page) => page.dynamic && matchPattern(page.href, clean));
}
