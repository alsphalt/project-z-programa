import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { isLikelyUnsafeRegex, searchCode } from '@/lib/search/engine';
import { escapeRegExp } from '@/lib/search/ast';
import { previewReplace } from '@/lib/services/replace';
import { fetchRemoteFile } from '@/lib/files/service';
import { sha256 } from '@/lib/crypto';
import { baseName } from '@/lib/security/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type UiMode = 'text' | 'regex' | 'case' | 'function';

function engineMode(mode: UiMode): 'text' | 'regex' | 'ast' {
  if (mode === 'regex') return 'regex';
  if (mode === 'case' || mode === 'function') return 'ast';
  return 'text';
}

function matcher(query: string, mode: UiMode, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? 'g' : 'gi';
  const source = mode === 'regex' ? query : escapeRegExp(query);
  return new RegExp(source, flags);
}

/** Code search across the indexed production files, optionally re-verified live. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const queryText = (url.searchParams.get('q') ?? '').trim();
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!queryText) throw new ApiError('Enter something to search for.', 400, 'query_required');
  const server = await assertServerAccess(user, serverId, 'file.read');

  const mode = (url.searchParams.get('mode') ?? 'text') as UiMode;
  const caseSensitive = url.searchParams.get('caseSensitive') === '1';
  const live = url.searchParams.get('live') === '1';
  const folder = url.searchParams.get('folder') ?? '';
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 400), 800);

  if (mode === 'regex' && isLikelyUnsafeRegex(queryText)) {
    throw new ApiError('That regular expression looks unsafe (nested quantifiers). Simplify it.', 400, 'unsafe_regex');
  }

  const started = Date.now();
  const result = await searchCode({
    serverId: server.id,
    query: queryText,
    mode: engineMode(mode),
    caseSensitive,
    pathPrefix: folder || undefined,
    maxResults: limit,
  });

  const warnings = [...result.notes];
  let liveRefreshed = 0;
  let hits = result.hits;

  if (live) {
    // Re-read the matching files from production and keep only matches that are
    // still present. This is how a stale index is caught before you act on it.
    const paths = Array.from(new Set(hits.map((hit) => hit.path))).slice(0, 25);
    const fresh = new Map<string, string>();
    for (const path of paths) {
      try {
        const snapshot = await fetchRemoteFile(server, path, { withStat: false });
        fresh.set(path, snapshot.content);
        liveRefreshed += 1;
      } catch (error) {
        warnings.push(`${path} could not be re-read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (fresh.size) {
      const re = matcher(queryText, mode, caseSensitive);
      const verified = [];
      for (const hit of hits) {
        const content = fresh.get(hit.path);
        if (content === undefined) {
          verified.push(hit);
          continue;
        }
        const lineText = content.split('\n')[hit.line - 1] ?? '';
        re.lastIndex = 0;
        if (mode === 'case' || mode === 'function' ? Boolean(hit.label) : re.test(lineText)) verified.push(hit);
      }
      if (verified.length !== hits.length) {
        warnings.push(
          `${hits.length - verified.length} indexed match(es) no longer exist in production and were dropped.`,
        );
      }
      hits = verified;
    }
  }

  const seen = new Map<string, number>();
  return ok({
    query: queryText,
    mode,
    hits: hits.map((hit) => {
      const occurrence = (seen.get(hit.path) ?? 0) + 1;
      seen.set(hit.path, occurrence);
      return {
        path: hit.path,
        name: baseName(hit.path),
        line: hit.line,
        column: hit.column,
        match: hit.label ?? (hit.lineText.trim().slice(0, 160) || queryText),
        lineText: hit.lineText,
        before: hit.before,
        after: hit.after,
        occurrence,
        kind: hit.kind,
        fileMatchCount: hit.fileMatchCount,
      };
    }),
    filesScanned: result.files.length,
    filesWithMatches: result.files.length,
    liveRefreshed,
    truncated: result.truncated,
    tookMs: Date.now() - started,
    source: live && liveRefreshed > 0 ? 'production + index' : 'indexed content cache',
    warnings,
  });
});

const replaceSchema = z.object({
  serverId: z.string().min(1),
  query: z.string().min(1),
  replacement: z.string(),
  mode: z.enum(['text', 'regex', 'case', 'function']).default('text'),
  caseSensitive: z.boolean().default(false),
  folder: z.string().optional(),
});

/** Preview a global replacement. Nothing is written until /api/deployments runs. */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(replaceSchema);
  const server = await assertServerAccess(user, input.serverId, 'file.write');
  if (input.mode === 'regex' && isLikelyUnsafeRegex(input.query)) {
    throw new ApiError('That regular expression looks unsafe (nested quantifiers). Simplify it.', 400, 'unsafe_regex');
  }

  const plan = await previewReplace({
    server,
    query: input.query,
    replacement: input.replacement,
    mode: input.mode === 'regex' ? 'regex' : 'literal',
    caseSensitive: input.caseSensitive,
    pathPrefix: input.folder || undefined,
  });

  return ok({
    token: plan.token,
    previews: plan.files.map((file) => ({
      path: file.path,
      name: baseName(file.path),
      occurrences: file.matches,
      beforeHash: file.beforeHash,
      changes: file.samples,
      newContent: file.afterContent,
      newSha: sha256(file.afterContent),
      oldSha: file.beforeHash,
      validation: file.validation,
    })),
    matchedFiles: plan.files.length,
    totalOccurrences: plan.totalMatches,
    skipped: plan.skipped,
    warnings: plan.notes,
    note:
      'Review every file before deploying. Replacing is applied through the deployment pipeline, which backs up each file first.',
  });
});
