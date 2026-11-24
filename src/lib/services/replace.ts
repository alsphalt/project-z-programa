import 'server-only';
import { query } from '../db';
import { sha256 } from '../crypto';
import { ApiError } from '../api';
import { env } from '../env';
import type { ServerRecord } from '../servers/repo';
import { fetchRemoteFile, validateContent, writeProductionFile } from '../files/service';
import { deployChanges, planHash, type ChangeRequest } from './deploy';
import { escapeRegExp, findTextMatches } from '../search/ast';
import { isLikelyUnsafeRegex } from '../search/engine';
import { isSecretPath } from '../security/paths';
import type { Principal } from '../auth/permissions';

export interface ReplaceFilePreview {
  path: string;
  matches: number;
  beforeHash: string;
  beforeContent: string;
  afterContent: string;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  samples: Array<{ line: number; before: string; after: string }>;
}

export interface ReplacePlan {
  token: string;
  query: string;
  replacement: string;
  mode: 'literal' | 'regex';
  caseSensitive: boolean;
  files: ReplaceFilePreview[];
  totalMatches: number;
  skipped: Array<{ path: string; reason: string }>;
  notes: string[];
}

function buildReplacementRegex(query: string, replacement: string, mode: 'literal' | 'regex', caseSensitive: boolean) {
  const flags = `g${caseSensitive ? '' : 'i'}`;
  if (mode === 'regex') {
    if (isLikelyUnsafeRegex(query)) {
      throw new ApiError('Regular expression rejected by the ReDoS guard.', 400, 'unsafe_regex');
    }
    return new RegExp(query, flags);
  }
  return new RegExp(escapeRegExp(query), flags);
}

export async function previewReplace(options: {
  server: ServerRecord;
  query: string;
  replacement: string;
  mode?: 'literal' | 'regex';
  caseSensitive?: boolean;
  pathPrefix?: string;
  maxFiles?: number;
}): Promise<ReplacePlan> {
  const { server } = options;
  const mode = options.mode ?? 'literal';
  if (!options.query) throw new ApiError('Search text is required', 400, 'query_required');
  const regex = buildReplacementRegex(options.query, options.replacement, mode, Boolean(options.caseSensitive));

  const candidates = await query<{ path: string; content: string; sha256: string }>(
    `select path, content, sha256 from file_contents
      where server_id = $1 and ($2 = '' or path like $2 || '%')
      order by path asc limit 2000`,
    [server.id, options.pathPrefix ?? ''],
  );

  const files: ReplaceFilePreview[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let totalMatches = 0;
  const maxFiles = options.maxFiles ?? 60;

  for (const candidate of candidates) {
    if (files.length >= maxFiles) break;
    const matches = findTextMatches(candidate.content, regex, 0, 5);
    if (!matches.length) continue;
    if (isSecretPath(candidate.path)) {
      skipped.push({ path: candidate.path, reason: 'classified as secret' });
      continue;
    }
    const count = [...candidate.content.matchAll(new RegExp(regex.source, regex.flags))].length;
    const after = candidate.content.replace(regex, options.replacement);
    if (after === candidate.content) continue;
    const validation = await validateContent(candidate.path, after);
    files.push({
      path: candidate.path,
      matches: count,
      beforeHash: candidate.sha256,
      beforeContent: candidate.content,
      afterContent: after,
      validation,
      samples: matches.map((match) => ({
        line: match.line,
        before: match.lineText,
        after: match.lineText.replace(new RegExp(regex.source, regex.flags.replace('g', '')), options.replacement),
      })),
    });
    totalMatches += count;
  }

  const token = planHash({
    server: server.id,
    replacement: options.replacement,
    files: files.map((file) => ({
      path: file.path,
      beforeHash: file.beforeHash,
      afterHash: sha256(file.afterContent),
    })),
  });

  return {
    token,
    query: options.query,
    replacement: options.replacement,
    mode,
    caseSensitive: Boolean(options.caseSensitive),
    files,
    totalMatches,
    skipped,
    notes: [
      'Preview only — nothing has been written to production yet.',
      `Preview reads the indexed snapshot; hashes are re-verified against Pterodactyl before writing.`,
      ...(files.length >= maxFiles ? [`Limited to ${maxFiles} files. Narrow the path prefix to cover more.`] : []),
    ],
  };
}

export async function applyReplace(options: {
  server: ServerRecord;
  user: Pick<Principal, 'id' | 'email'>;
  token: string;
  replacement?: string;
  files: Array<{ path: string; beforeHash: string; afterContent: string }>;
  note?: string;
  restartMode?: 'auto' | 'always' | 'never';
}) {
  const { server, user } = options;
  if (!options.files.length) throw new ApiError('No files selected for replacement', 400, 'empty_selection');
  // The token binds the exact selection (paths, pre-hashes, post-content hashes).
  // A mismatch means the payload changed after the preview and must be re-previewed.
  const expected = planHash({
    server: server.id,
    replacement: options.replacement ?? '',
    files: options.files.map((file) => ({
      path: file.path,
      beforeHash: file.beforeHash,
      afterHash: sha256(file.afterContent),
    })),
  });
  if (options.token && options.token !== expected) {
    throw new ApiError(
      'The replacement preview is stale or was modified. Re-run the preview before applying.',
      409,
      'stale_plan',
    );
  }

  const changes: ChangeRequest[] = [];
  for (const file of options.files) {
    const snapshot = await fetchRemoteFile(server, file.path, { withStat: false });
    if (snapshot.sha256 !== file.beforeHash) {
      throw new ApiError(
        `${file.path} changed in production since the preview was generated. Re-run the preview.`,
        409,
        'stale_file',
      );
    }
    changes.push({ path: file.path, content: file.afterContent, expectedHash: file.beforeHash });
  }

  return deployChanges({
    server,
    user,
    changes,
    note: options.note ?? `Global replace across ${changes.length} file(s)`,
    restartMode: options.restartMode ?? 'auto',
  });
}

/** Single-file whole-content replacement, backed up and verified like any deploy. */
export async function replaceWholeFile(options: {
  server: ServerRecord;
  user: Pick<Principal, 'id' | 'email'>;
  path: string;
  content: string;
  expectedHash: string | null;
  note?: string;
}) {
  return deployChanges({
    server: options.server,
    user: options.user,
    changes: [{ path: options.path, content: options.content, expectedHash: options.expectedHash }],
    note: options.note ?? 'Whole-file replacement',
    restartMode: 'auto',
  });
}

export { writeProductionFile };
