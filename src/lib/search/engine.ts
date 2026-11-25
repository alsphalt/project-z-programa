import 'server-only';
import { query } from '../db';
import { env } from '../env';
import { escapeRegExp, findTextMatches, summarizeJavaScript } from './ast';

export type SearchMode = 'text' | 'regex' | 'ast';

export interface SearchHit {
  path: string;
  fileName: string;
  line: number;
  column: number;
  lineText: string;
  before: string[];
  after: string[];
  kind: 'text' | 'case' | 'case_alias' | 'function';
  label?: string;
  charStart?: number;
  charEnd?: number;
  fileMatchCount: number;
}

export interface SearchResult {
  hits: SearchHit[];
  files: Array<{ path: string; matches: number; sha256: string | null }>;
  totalMatches: number;
  truncated: boolean;
  durationMs: number;
  snapshotAt: string | null;
  mode: SearchMode;
  notes: string[];
}

export function isLikelyUnsafeRegex(pattern: string): boolean {
  if (pattern.length > 400) return true;
  // Nested quantifiers such as (a+)+ or (.*)* are the classic ReDoS shape.
  return /(\([^)]*[+*][^)]*\)[+*])|(\.\*[+*])|(\.\+[+*])/.test(pattern);
}

function buildPattern(queryText: string, mode: SearchMode, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? '' : 'i';
  if (mode === 'regex') return new RegExp(queryText, flags);
  return new RegExp(escapeRegExp(queryText), flags);
}

export async function searchCode(options: {
  serverId: string;
  query: string;
  mode?: SearchMode;
  caseSensitive?: boolean;
  pathPrefix?: string;
  maxResults?: number;
}): Promise<SearchResult> {
  const started = Date.now();
  const mode = options.mode ?? 'text';
  const maxResults = Math.min(options.maxResults ?? env.maxSearchResults, 2000);
  const trimmed = options.query.trim();
  const notes: string[] = [];

  if (!trimmed) {
    return {
      hits: [],
      files: [],
      totalMatches: 0,
      truncated: false,
      durationMs: 0,
      snapshotAt: null,
      mode,
      notes: ['Type something to search.'],
    };
  }
  if (mode === 'regex' && isLikelyUnsafeRegex(trimmed)) {
    throw new Error('This regular expression looks expensive to evaluate and was rejected (ReDoS guard).');
  }

  const snapshotRow = await query<{ last: string | null }>(
    'select max(fetched_at) as last from file_contents where server_id = $1',
    [options.serverId],
  );
  const snapshotAt = snapshotRow[0]?.last ?? null;

  // ---- AST mode: search parsed case/function metadata first -----------------
  if (mode === 'ast') {
    const rows = await query<{
      path: string;
      kind: string;
      name: string;
      aliases: unknown;
      line_start: number;
      line_end: number;
      char_start: number;
      char_end: number;
    }>(
      `select path, kind, name, line_start, line_end, char_start, char_end from command_metadata
        where server_id = $1 and lower(name) like $2
        order by case when kind = 'case' then 0 else 1 end, name asc limit $3`,
      [options.serverId, `%${trimmed.toLowerCase()}%`, maxResults],
    );
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const cached = await query<{ content: string }>(
        'select content from file_contents where server_id = $1 and path = $2',
        [options.serverId, row.path],
      );
      const lines = (cached[0]?.content ?? '').split('\n');
      hits.push({
        path: row.path,
        fileName: row.path.split('/').pop() ?? row.path,
        line: Number(row.line_start),
        column: 1,
        lineText: lines[Number(row.line_start) - 1] ?? '',
        before: lines.slice(Math.max(0, Number(row.line_start) - 3), Number(row.line_start) - 1),
        after: lines.slice(Number(row.line_start), Number(row.line_start) + 2),
        kind: row.kind === 'function' ? 'function' : row.kind === 'case_alias' ? 'case_alias' : 'case',
        label: row.name,
        charStart: Number(row.char_start),
        charEnd: Number(row.char_end),
        fileMatchCount: 1,
      });
    }
    return {
      hits,
      files: [...new Set(hits.map((hit) => hit.path))].map((path) => ({ path, matches: 1, sha256: null })),
      totalMatches: hits.length,
      truncated: rows.length >= maxResults,
      durationMs: Date.now() - started,
      snapshotAt,
      mode,
      notes: notes.concat('AST results come from the last indexed snapshot; files are re-verified when opened.'),
    };
  }

  // ---- text / regex --------------------------------------------------------
  let pattern: RegExp;
  try {
    pattern = buildPattern(trimmed, mode, Boolean(options.caseSensitive));
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }

  const fileRows = await query<{ path: string; content: string; sha256: string }>(
    `select path, content, sha256 from file_contents
      where server_id = $1 and ($2 = '' or path like $2 || '%')
      order by path asc limit 3000`,
    [options.serverId, options.pathPrefix ?? ''],
  );

  const hits: SearchHit[] = [];
  const files: SearchResult['files'] = [];
  let totalMatches = 0;

  for (const file of fileRows) {
    if (hits.length >= maxResults) break;
    const matches = findTextMatches(file.content, pattern, 2, Math.min(200, maxResults - hits.length));
    if (!matches.length) continue;
    totalMatches += matches.length;
    files.push({ path: file.path, matches: matches.length, sha256: file.sha256 });
    const fileName = file.path.split('/').pop() ?? file.path;
    // Parse once per file so each hit can name its enclosing case.
    const cases = /\.(js|cjs|mjs|ts)$/i.test(file.path)
      ? summarizeJavaScript(file.content).cases
      : [];
    for (const match of matches) {
      let kind: SearchHit['kind'] = 'text';
      let label: string | undefined;
      const owner = cases.find((item) => match.line >= item.lineStart && match.line <= item.lineEnd);
      if (owner) {
        kind = 'case';
        label = owner.name;
      }
      hits.push({
        path: file.path,
        fileName,
        line: match.line,
        column: match.column,
        lineText: match.lineText,
        before: match.before,
        after: match.after,
        kind,
        label,
        fileMatchCount: matches.length,
      });
      if (hits.length >= maxResults) break;
    }
  }

  return {
    hits,
    files,
    totalMatches,
    truncated: hits.length >= maxResults,
    durationMs: Date.now() - started,
    snapshotAt,
    mode,
    notes: notes.concat(
      'Results come from the indexed snapshot of production files (refreshed by scan/sync). Opening a file re-verifies it against Pterodactyl.',
    ),
  };
}
