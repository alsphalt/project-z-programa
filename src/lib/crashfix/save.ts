import 'server-only';
import { ApiError } from '../api';
import { sha256, uuid } from '../crypto';
import { query, queryOne } from '../db';
import { balanceCheck, extractCases, validateJavaScript, type CaseBlock, type ParseIssue } from '../cases';
import { getProjectFile, requireProject, writeProjectFile } from '../projects/repo';
import { afterLocalSave } from '../github/sync';
import type { CaseMatch } from './search';

/**
 * CRASH AND FIX — save and repair.
 *
 * Order of operations, all before a single byte is written:
 *   1. the file must still hash to what the browser loaded;
 *   2. the case must still exist at the same offset with the same content;
 *   3. the replacement must parse as exactly one case with the same label;
 *   4. the whole updated file must parse (or, when the file was already
 *      unparseable, its bracket balance must not get worse).
 * The write itself is a conditional UPDATE on the old hash, so a concurrent save
 * loses cleanly instead of overwriting.
 */

export interface SaveCaseInput {
  projectId: string;
  fileId: string;
  caseName: string;
  caseStart: number;
  expectedFileSha: string;
  expectedCaseSha?: string;
  expectedCaseCode?: string;
  nextCode: string;
  userId?: string | null;
}

export interface SaveCaseResult {
  match: CaseMatch;
  fileSha: string;
  previousFileSha: string;
  validation: { ok: boolean; errors: ParseIssue[]; warnings: string[] };
  sync: { applicable: boolean; scheduled: boolean; at: string | null; reason: string };
  historyId: string;
}

function identifyTarget(cases: CaseBlock[], input: SaveCaseInput): CaseBlock {
  const byOffset = cases.find((block) => block.start === input.caseStart && block.name === input.caseName);
  if (byOffset) return byOffset;
  const byHash = input.expectedCaseSha
    ? cases.find((block) => block.name === input.caseName && sha256(block.source) === input.expectedCaseSha)
    : undefined;
  if (byHash) return byHash;
  const candidates = cases.filter((block) => block.name === input.caseName);
  if (!candidates.length) {
    throw new ApiError(
      `No “${input.caseName}” case exists in that file any more. Run the search again — nothing was saved.`,
      409,
      'case_missing',
    );
  }
  throw new ApiError(
    `The “${input.caseName}” case moved since you loaded it. Run the search again before saving — nothing was saved.`,
    409,
    'case_moved',
  );
}

export async function saveCaseEdit(input: SaveCaseInput): Promise<SaveCaseResult> {
  if (!input.nextCode || !input.nextCode.trim()) {
    throw new ApiError('The replacement case is empty.', 400, 'replacement_required');
  }

  const project = await requireProject(input.projectId);
  const file = await getProjectFile(project.id, input.fileId);
  if (file.content === null || file.contentOmitted) {
    throw new ApiError('That file has no editable text copy (binary or above the inline limit).', 400, 'file_not_editable');
  }

  const content = file.content;
  const currentSha = sha256(content);
  if (input.expectedFileSha && input.expectedFileSha !== currentSha) {
    throw new ApiError(
      'This file changed after you loaded it. Re-run the search and apply your edit again — nothing was overwritten.',
      409,
      'file_changed',
    );
  }

  const cases = extractCases(file.path, content);
  const target = identifyTarget(cases, input);

  if (input.expectedCaseSha && sha256(target.source) !== input.expectedCaseSha) {
    throw new ApiError(
      'The case changed after you loaded it. Re-run the search before saving — nothing was saved.',
      409,
      'case_changed',
    );
  }
  if (input.expectedCaseCode && target.source.trim() !== input.expectedCaseCode.trim()) {
    throw new ApiError(
      'The case text no longer matches what you started from. Re-run the search before saving — nothing was saved.',
      409,
      'case_changed',
    );
  }

  const trimmedNew = input.nextCode.replace(/\s+$/, '');
  const probe = `switch (__darknote_probe__) {\n${trimmedNew}\n}`;
  const probeParse = validateJavaScript(probe);
  if (!probeParse.ok) {
    throw new ApiError(
      `The edited case does not parse: line ${probeParse.errors[0]?.line ?? 1} — ${probeParse.errors[0]?.message ?? 'syntax error'}`,
      422,
      'case_syntax_error',
    );
  }
  const probeCases = extractCases('probe.js', probe);
  // Only the outer case counts: a case body may legitimately contain its own
  // nested switch with its own case labels.
  const outer = probeCases.filter((block) => block.switchStart === 0 && block.name === input.caseName);
  if (!outer.length) {
    throw new ApiError(
      `The edited snippet must still declare case '${input.caseName}': — the case label was not found.`,
      422,
      'case_label_missing',
    );
  }
  if (outer.length > 1) {
    throw new ApiError(
      'The edited snippet declares the same case twice. Keep one case per save.',
      422,
      'case_ambiguous',
    );
  }

  const tail = target.source.match(/\s*$/)?.[0] ?? '';
  const replacement = `${trimmedNew}${tail}`;
  const updated = content.slice(0, target.start) + replacement + content.slice(target.end);

  const warnings: string[] = [];
  const before = validateJavaScript(content);
  const after = validateJavaScript(updated);
  if (before.ok && !after.ok) {
    throw new ApiError(
      `The updated file does not parse: line ${after.errors[0]?.line ?? 1} — ${after.errors[0]?.message ?? 'syntax error'}. Nothing was saved.`,
      422,
      'syntax_error',
    );
  }
  if (!before.ok) {
    const beforeBalance = balanceCheck(content).length;
    const afterBalance = balanceCheck(updated).length;
    if (afterBalance > beforeBalance) {
      throw new ApiError(
        'This file already had syntax problems, and the edit made the bracket balance worse. Nothing was saved.',
        422,
        'balance_regression',
      );
    }
    warnings.push(
      'This file did not parse before the edit either (it may contain TypeScript or JSX); only the case fragment and the bracket balance could be verified.',
    );
  }

  const written = await writeProjectFile({
    projectId: project.id,
    fileId: file.id,
    content: updated,
    expectedSha: currentSha,
    markDirty: true,
  });

  const newCases = extractCases(file.path, updated);
  const newBlock =
    newCases.find((block) => block.start === target.start && block.name === input.caseName) ??
    newCases.find((block) => block.name === input.caseName && block.start >= target.start - 1);
  if (!newBlock) {
    throw new ApiError(
      'The file was written but the case could not be re-read afterwards. Use Project Imports to inspect the file before continuing.',
      500,
      'case_reread_failed',
    );
  }

  const historyId = uuid();
  await query(
    `insert into crash_fix_history (id, project_id, file_id, file_path, case_name, before_code, after_code, file_sha_before, file_sha_after, action, status, user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'edit','saved',$10)`,
    [
      historyId,
      project.id,
      file.id,
      file.path,
      input.caseName,
      target.source,
      replacement,
      currentSha,
      written.file.sha256 ?? sha256(updated),
      input.userId ?? null,
    ],
  );

  const match: CaseMatch = {
    ref: `${file.id}:${newBlock.start}`,
    projectId: project.id,
    projectName: project.name,
    fileId: file.id,
    caseName: newBlock.name,
    code: newBlock.source.replace(/\s+$/, ''),
    startLine: newBlock.line,
    endLine: newBlock.endLine,
    caseStart: newBlock.start,
    caseEnd: newBlock.end,
    fileSha: written.file.sha256 ?? sha256(updated),
    caseSha: sha256(newBlock.source),
    ordinal: newBlock.index,
    language: 'javascript',
  };

  let sync: SaveCaseResult['sync'];
  try {
    const decision = await afterLocalSave(project.id, [file.path]);
    sync = { applicable: decision.applicable, scheduled: decision.scheduled, at: decision.at, reason: decision.reason };
  } catch (error) {
    sync = {
      applicable: true,
      scheduled: false,
      at: null,
      reason: `The change is saved locally, but scheduling the GitHub push failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    match,
    fileSha: match.fileSha,
    previousFileSha: currentSha,
    validation: { ok: true, errors: [], warnings },
    sync,
    historyId,
  };
}

export interface EditHistoryEntry {
  id: string;
  projectId: string;
  caseName: string;
  fileShaBefore: string | null;
  fileShaAfter: string | null;
  action: string;
  status: string;
  createdAt: string;
  beforeCode: string;
  afterCode: string;
}

export async function listEditHistory(projectId: string, limit = 25): Promise<EditHistoryEntry[]> {
  const rows = await query<Record<string, unknown>>(
    `select id, project_id, case_name, file_sha_before, file_sha_after, action, status, created_at, before_code, after_code
       from crash_fix_history where project_id = $1 order by created_at desc limit $2`,
    [projectId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    caseName: String(row.case_name),
    fileShaBefore: (row.file_sha_before as string) ?? null,
    fileShaAfter: (row.file_sha_after as string) ?? null,
    action: String(row.action),
    status: String(row.status),
    createdAt: String(row.created_at),
    beforeCode: String(row.before_code ?? ''),
    afterCode: String(row.after_code ?? ''),
  }));
}

/** Restores the previous text of one case through the same guarded path. */
export async function rollbackEdit(options: {
  historyId: string;
  userId?: string | null;
}): Promise<SaveCaseResult> {
  const row = await queryOne<Record<string, unknown>>(
    `select * from crash_fix_history where id = $1`,
    [options.historyId],
  );
  if (!row) throw new ApiError('That edit is not in the history.', 404, 'history_not_found');

  const projectId = String(row.project_id);
  const fileId = (row.file_id as string) ?? null;
  if (!fileId) throw new ApiError('That history entry has no file attached.', 400, 'history_no_file');

  const file = await getProjectFile(projectId, fileId);
  if (file.content === null) throw new ApiError('The file is no longer editable.', 400, 'file_not_editable');

  const caseName = String(row.case_name);
  const cases = extractCases(file.path, file.content);
  const current = cases.find((block) => block.name === caseName);
  if (!current) {
    throw new ApiError(
      `The “${caseName}” case no longer exists in the file, so the earlier version cannot be restored.`,
      409,
      'case_missing',
    );
  }

  const result = await saveCaseEdit({
    projectId,
    fileId,
    caseName,
    caseStart: current.start,
    expectedFileSha: sha256(file.content),
    expectedCaseCode: current.source,
    nextCode: String(row.before_code ?? ''),
    userId: options.userId ?? null,
  });

  await query(
    `update crash_fix_history set status = 'rolled_back' where id = $1`,
    [options.historyId],
  );
  await query(
    `insert into crash_fix_history (id, project_id, file_id, file_path, case_name, before_code, after_code, file_sha_before, file_sha_after, action, status, user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rollback','saved',$10)`,
    [
      uuid(),
      projectId,
      fileId,
      file.path,
      caseName,
      current.source,
      String(row.before_code ?? ''),
      sha256(file.content),
      result.fileSha,
      options.userId ?? null,
    ],
  );

  return result;
}
