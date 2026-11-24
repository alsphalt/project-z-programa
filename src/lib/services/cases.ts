import 'server-only';
import { query } from '../db';
import { ApiError } from '../api';
import type { ServerRecord } from '../servers/repo';
import { fetchRemoteFile, validateContent } from '../files/service';
import { summarizeJavaScript, offsetToLine } from '../search/ast';

export interface CaseRow {
  id: string;
  path: string;
  name: string;
  aliases: string[];
  lineStart: number;
  lineEnd: number;
  charStart: number;
  charEnd: number;
  signature: string | null;
  sha256: string | null;
  sizeBytes: number;
  modifiedAt: string | null;
}

export async function listCases(
  serverId: string,
  filter: { search?: string; path?: string; limit?: number } = {},
): Promise<CaseRow[]> {
  const rows = await query<{
    id: string;
    path: string;
    name: string;
    aliases: unknown;
    line_start: number;
    line_end: number;
    char_start: number;
    char_end: number;
    signature: string | null;
    sha256: string | null;
    size_bytes: string | number;
    modified_at: string | null;
  }>(
    `select m.id, m.path, m.name, m.aliases, m.line_start, m.line_end, m.char_start, m.char_end,
            m.signature, m.sha256, i.size_bytes, i.remote_modified_at as modified_at
       from command_metadata m
       left join file_indexes i on i.server_id = m.server_id and i.path = m.path
      where m.server_id = $1 and m.kind = 'case'
        and ($2 = '' or lower(m.name) like $2)
        and ($3 = '' or m.path = $3)
      order by m.path asc, m.line_start asc limit $4`,
    [serverId, filter.search ? `%${filter.search.toLowerCase()}%` : '', filter.path ?? '', filter.limit ?? 400],
  );
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    name: row.name,
    aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
    lineStart: Number(row.line_start),
    lineEnd: Number(row.line_end),
    charStart: Number(row.char_start),
    charEnd: Number(row.char_end),
    signature: row.signature,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes ?? 0),
    modifiedAt: row.modified_at,
  }));
}

export async function getCaseCode(server: ServerRecord, filePath: string, charStart: number, charEnd: number) {
  const snapshot = await fetchRemoteFile(server, filePath, { withStat: false });
  const code = snapshot.content.slice(charStart, charEnd);
  return { code, sha256: snapshot.sha256, content: snapshot.content };
}

function expandToLines(source: string, start: number, end: number): { start: number; end: number } {
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let lineEnd = source.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = source.length;
  else lineEnd += 1;
  return { start: lineStart, end: lineEnd };
}

export type CaseAction = 'replace' | 'delete' | 'duplicate' | 'move' | 'aliases';

export interface CaseEditPreview {
  path: string;
  action: CaseAction;
  beforeContent: string;
  afterContent: string;
  beforeHash: string;
  range: { start: number; end: number };
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  structure: {
    beforeCases: number;
    afterCases: number;
    removedCases: string[];
    addedCases: string[];
    otherCasesIntact: boolean;
  };
  lines: { removed: number; added: number };
  warnings: string[];
}

export async function previewCaseEdit(options: {
  server: ServerRecord;
  path: string;
  name: string;
  action: CaseAction;
  replacement?: string;
  newName?: string;
  aliases?: string[];
  targetName?: string;
  position?: 'before' | 'after';
}): Promise<CaseEditPreview> {
  const snapshot = await fetchRemoteFile(options.server, options.path, { withStat: false });
  const source = snapshot.content;
  const summary = summarizeJavaScript(source);
  if (!summary.ok) {
    throw new ApiError(`Cannot edit cases: the file does not parse (${summary.error})`, 422, 'parse_failed');
  }
  const target = summary.cases.find((item) => item.name === options.name);
  if (!target) {
    throw new ApiError(`Case '${options.name}' was not found in ${options.path}. Re-scan the server.`, 404, 'case_missing');
  }

  let after = source;
  let range = { start: target.charStart, end: target.charEnd };
  const warnings: string[] = [];

  if (options.action === 'replace') {
    if (!options.replacement?.trim()) throw new ApiError('Replacement code is empty', 400, 'empty_replacement');
    if (!/^\s*case\s+['"`]/.test(options.replacement) && target.name !== 'default') {
      warnings.push('Replacement does not start with a case label — check that you included it.');
    }
    after = source.slice(0, target.charStart) + options.replacement + source.slice(target.charEnd);
  } else if (options.action === 'delete') {
    const expanded = expandToLines(source, target.charStart, target.charEnd);
    range = expanded;
    after = source.slice(0, expanded.start) + source.slice(expanded.end);
  } else if (options.action === 'duplicate') {
    if (!options.newName) throw new ApiError('A new case name is required for duplication', 400, 'name_required');
    const block = source.slice(target.charStart, target.charEnd);
    const labelRe = new RegExp(`^([\\s\\S]*?case\\s+['"\`])${escapeForRegExp(target.name)}(['"\`])`);
    const renamed = block.replace(labelRe, `$1${options.newName}$2`);
    if (renamed === block) {
      throw new ApiError('Could not rewrite the case label for duplication', 422, 'label_rewrite_failed');
    }
    const insertion = expandToLines(source, target.charStart, target.charEnd);
    const text = `\n${renamed}`;
    after = source.slice(0, insertion.end) + text + source.slice(insertion.end);
    range = { start: insertion.end, end: insertion.end + text.length };
  } else if (options.action === 'aliases') {
    const aliases = (options.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
    const labels = [target.name, ...aliases];
    const block = source.slice(target.charStart, target.charEnd);
    const firstBrace = block.indexOf(':');
    if (firstBrace === -1) throw new ApiError('Case block has no label separator', 422, 'unexpected_shape');
    const bodyStart = target.charStart + firstBrace + 1;
    const labelText = `\n${labels.map((label) => `      case '${label}':`).join('\n')}`;
    after = source.slice(0, target.charStart) + labelText + source.slice(bodyStart);
    range = { start: target.charStart, end: bodyStart };
  } else if (options.action === 'move') {
    if (!options.targetName) throw new ApiError('A target case is required to move a case', 400, 'target_required');
    const sibling = summary.cases.find((item) => item.name === options.targetName);
    if (!sibling) throw new ApiError(`Target case '${options.targetName}' not found`, 404, 'case_missing');
    if (sibling.switchIndex !== target.switchIndex) {
      throw new ApiError('Cases can only be moved inside the same switch block', 422, 'different_switch');
    }
    const block = expandToLines(source, target.charStart, target.charEnd);
    const blockText = source.slice(block.start, block.end);
    const withoutBlock = source.slice(0, block.start) + source.slice(block.end);
    const siblingShifted = {
      start: sibling.charStart > block.start ? sibling.charStart - blockText.length : sibling.charStart,
      end: sibling.charEnd > block.start ? sibling.charEnd - blockText.length : sibling.charEnd,
    };
    const targetLines = expandToLines(withoutBlock, siblingShifted.start, siblingShifted.end);
    const insertAt = options.position === 'after' ? targetLines.end : targetLines.start;
    after = withoutBlock.slice(0, insertAt) + blockText + withoutBlock.slice(insertAt);
    range = { start: insertAt, end: insertAt + blockText.length };
  }

  const afterSummary = summarizeJavaScript(after);
  const validation = await validateContent(options.path, after);
  if (!afterSummary.ok) {
    validation.ok = false;
    validation.errors.push(`Edited file no longer parses: ${afterSummary.error}`);
  }

  const beforeNames = summary.cases.map((item) => item.name);
  const afterNames = afterSummary.cases.map((item) => item.name);
  const removed = beforeNames.filter((name) => !afterNames.includes(name));
  const added = afterNames.filter((name) => !beforeNames.includes(name));
  const expectedRemoved = options.action === 'delete' ? [target.name] : [];
  const otherIntact =
    options.action === 'delete'
      ? removed.length === 1 && removed[0] === target.name
      : beforeNames.every((name) => {
          if (options.action === 'replace' && name === target.name) return true;
          return afterNames.includes(name);
        });

  if (!otherIntact) {
    validation.ok = false;
    validation.errors.push(
      `Structural check failed: neighbouring cases changed (removed: ${removed.join(', ') || 'none'}; added: ${added.join(', ') || 'none'}).`,
    );
  }
  void expectedRemoved;

  const beforeLines = source.split('\n').length;
  const afterLines = after.split('\n').length;

  return {
    path: options.path,
    action: options.action,
    beforeContent: source,
    afterContent: after,
    beforeHash: snapshot.sha256,
    range,
    validation,
    structure: {
      beforeCases: beforeNames.length,
      afterCases: afterNames.length,
      removedCases: removed,
      addedCases: added,
      otherCasesIntact: otherIntact,
    },
    lines: { removed: Math.max(0, beforeLines - afterLines), added: Math.max(0, afterLines - beforeLines) },
    warnings,
  };
}

function escapeForRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function caseSummary(serverId: string) {
  const row = await query<{ total: string | number; files: string | number }>(
    `select count(*)::int as total, count(distinct path)::int as files from command_metadata
      where server_id = $1 and kind = 'case'`,
    [serverId],
  );
  return { total: Number(row[0]?.total ?? 0), files: Number(row[0]?.files ?? 0) };
}

export { offsetToLine };
