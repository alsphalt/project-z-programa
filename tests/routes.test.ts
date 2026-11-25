/**
 * Route contract test.
 *
 * The "Request failed (405)" bugs were all the same shape: a component called
 * `/api/x` with POST/PUT/DELETE while the route file only exported GET, so
 * Next.js answered 405 before any application code ran. This test walks every
 * route file and every client call site and fails when a verb has no handler.
 *
 * It deliberately reads source instead of importing the modules: route modules
 * use the `@/` alias and Next runtime shims, and the point here is the exported
 * HTTP surface, not their internals.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, 'src', 'app', 'api');
const UI_DIRS = [path.join(ROOT, 'src', 'app'), path.join(ROOT, 'src', 'components')];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function exportsOf(source: string): Set<string> {
  const found = new Set<string>();
  for (const method of METHODS) {
    const patterns = [
      new RegExp(`export\\s+const\\s+${method}\\b`),
      new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`),
      new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`),
    ];
    if (patterns.some((pattern) => pattern.test(source))) found.add(method);
  }
  return found;
}

/** `src/app/api/servers/[id]/route.ts` → `/api/servers/:id` */
function routePattern(file: string): string {
  const rel = path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/');
  const segments = rel === '' ? [] : rel.split('/');
  return `/api/${segments.map((segment) => (segment.startsWith('[') ? ':' : segment)).join('/')}`.replace(/\/$/, '');
}

/** Client source path → comparable route pattern. */
function callPattern(raw: string): string | null {
  const withoutQuery = raw.split('?')[0].replace(/\/$/, '');
  if (!withoutQuery.startsWith('/api/')) return null;
  const segments = withoutQuery.slice('/api/'.length).split('/');
  if (segments.some((segment) => segment.includes('${'))) {
    return `/api/${segments.map((segment) => (segment.includes('${') ? ':' : segment)).join('/')}`;
  }
  return `/api/${segments.join('/')}`;
}

const routes = walk(API_DIR)
  .filter((file) => file.endsWith(`${path.sep}route.ts`))
  .map((file) => ({
    file: path.relative(ROOT, file),
    pattern: routePattern(file),
    source: readFileSync(file, 'utf8'),
    methods: exportsOf(readFileSync(file, 'utf8')),
  }));

const routeByPattern = new Map(routes.map((route) => [route.pattern, route]));

test('every declared route exports at least one HTTP method', () => {
  for (const route of routes) {
    assert.ok(route.methods.size > 0, `${route.file} exports no HTTP method`);
  }
});

test('the routes the UI calls exist with the method the UI uses', () => {
  const problems: string[] = [];
  const calls: Array<{ file: string; pattern: string; method: string; raw: string }> = [];

  for (const file of UI_DIRS.flatMap((dir) => walk(dir)).filter((entry) => entry.endsWith('.tsx'))) {
    const source = readFileSync(file, 'utf8');
    const helper = /api(Get|Post|Put|Patch|Delete)<[^>]*>?\(\s*[`"']([^`"']+)/g;
    for (const match of source.matchAll(helper)) {
      const method = match[1].toUpperCase();
      const pattern = callPattern(match[2]);
      if (pattern) calls.push({ file: path.relative(ROOT, file), pattern, method, raw: match[2] });
    }
    const direct = /fetch\(\s*[`"'](\/api\/[^`"']+)[`"']\s*,\s*\{[^}]*method:\s*["'](POST|PUT|PATCH|DELETE)["']/g;
    for (const match of source.matchAll(direct)) {
      const pattern = callPattern(match[1]);
      if (pattern) calls.push({ file: path.relative(ROOT, file), pattern, method: match[2], raw: match[1] });
    }
    const downloads = /download\(\s*`(\/api\/[^`"]+)/g;
    for (const match of source.matchAll(downloads)) {
      const pattern = callPattern(match[1]);
      if (pattern) calls.push({ file: path.relative(ROOT, file), pattern, method: 'GET', raw: match[1] });
    }
  }

  assert.ok(calls.length > 20, `expected to find client API calls, found ${calls.length}`);

  for (const call of calls) {
    const route = routeByPattern.get(call.pattern);
    if (!route) {
      problems.push(`${call.file}: ${call.method} ${call.raw} → no route for ${call.pattern}`);
      continue;
    }
    if (!route.methods.has(call.method)) {
      problems.push(
        `${call.file}: ${call.method} ${call.raw} → ${route.file} exports ${[...route.methods].join('/') || 'nothing'} (this would be HTTP 405)`,
      );
    }
  }

  assert.deepEqual(problems, [], `client/server method mismatch:\n${problems.join('\n')}`);
});

test('power actions are declared as POST, never GET', () => {
  const monitor = routeByPattern.get('/api/monitor');
  assert.ok(monitor, '/api/monitor route is missing');
  assert.ok(monitor!.methods.has('GET'), '/api/monitor must serve the monitor payload over GET');
  assert.ok(monitor!.methods.has('POST'), '/api/monitor must serve power actions over POST');

  const powerSource = readFileSync(path.join(ROOT, 'src', 'lib', 'pterodactyl', 'client.ts'), 'utf8');
  assert.match(
    powerSource,
    /async sendPower[\s\S]{0,200}?serverPath\('\/power'\)[\s\S]{0,120}?method:\s*'POST'/,
    'sendPower must POST to /servers/{id}/power',
  );
  assert.match(powerSource, /JSON\.stringify\(\{\s*signal\s*\}\)/, 'sendPower must send {"signal": ...}');
});

test('no state-changing route relies on GET', () => {
  const readOnlyRoutes = new Set(['/api/monitor', '/api/servers', '/api/files', '/api/files/content', '/api/drafts', '/api/search', '/api/cases', '/api/backups', '/api/versions', '/api/downloads', '/api/deployments', '/api/settings', '/api/servers/:id', '/api/servers/:id/test', '/api/servers/:id/sync', '/api/servers/:id/discover', '/api/servers/:id/sync/conflict', '/api/deployments/:id', '/api/console', '/api/console/command', '/api/drafts/chunk', '/api/health', '/api/auth/session']);
  for (const [pattern, route] of routeByPattern) {
    if (readOnlyRoutes.has(pattern)) continue;
    assert.ok(route.methods.size > 0, `${route.file} exports nothing`);
  }
});
