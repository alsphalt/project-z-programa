import 'server-only';
import { ApiError } from '../api';
import { sha256 } from '../crypto';
import { extractCases } from '../cases';
import { getProject, listProjects, listScriptFiles } from '../projects/repo';
import type { ProjectRecord } from '../projects/repo';

/**
 * CRASH AND FIX — real case search.
 *
 * The search walks the imported project's JavaScript files, parses each one with
 * the same acorn-based extractor the Case Manager uses, and returns only the
 * `case '<name>':` blocks whose label matches the query. No file names, folders
 * or surrounding code are returned to the interface: the locator stays server
 * side and the client only ever sees the case itself.
 */

export interface CaseMatch {
  /** Opaque handle used for edit/save. It is not a path. */
  ref: string;
  projectId: string;
  projectName: string;
  fileId: string;
  caseName: string;
  code: string;
  startLine: number;
  endLine: number;
  caseStart: number;
  caseEnd: number;
  fileSha: string;
  caseSha: string;
  ordinal: number;
  language: 'javascript';
}

export interface CaseSearchStats {
  projects: number;
  filesScanned: number;
  filesMatched: number;
  casesExamined: number;
  skippedFiles: number;
  durationMs: number;
}

export interface CaseSearchResult {
  query: string;
  matches: CaseMatch[];
  stats: CaseSearchStats;
  truncated: boolean;
  note: string;
}

const MAX_MATCHES = 40;
const MAX_FILES_PER_SEARCH = 600;

export async function searchCases(query: string, options: { projectId?: string | null } = {}): Promise<CaseSearchResult> {
  const started = Date.now();
  const raw = query.trim();
  if (!raw) throw new ApiError('Type a command name to search for (for example “menu”).', 400, 'query_required');
  if (raw.length > 80) throw new ApiError('That query is too long — use a command name.', 400, 'query_too_long');
  const needle = raw.toLowerCase();

  let projectName = new Map<string, ProjectRecord>();
  if (options.projectId) {
    const project = await getProject(options.projectId);
    if (!project) throw new ApiError('That imported project no longer exists.', 404, 'project_not_found');
    projectName.set(project.id, project);
  } else {
    const projects = await listProjects();
    projectName = new Map(projects.filter((project) => project.status === 'ready').map((project) => [project.id, project]));
  }

  const files = (await listScriptFiles(options.projectId ?? null)).filter((file) => projectName.has(file.projectId));
  const scannable = files.slice(0, MAX_FILES_PER_SEARCH);

  const matches: CaseMatch[] = [];
  let filesScanned = 0;
  let filesMatched = 0;
  let casesExamined = 0;

  for (const file of scannable) {
    filesScanned += 1;
    if (!file.content) continue;
    const cases = extractCases(file.path, file.content);
    casesExamined += cases.length;

    const hits = cases.filter((block) => {
      const name = block.name.toLowerCase();
      return name === needle || name.startsWith(needle) || name.includes(needle);
    });
    if (!hits.length) continue;
    filesMatched += 1;

    const project = projectName.get(file.projectId)!;
    for (const block of hits) {
      const code = block.source.replace(/\s+$/, '');
      matches.push({
        ref: `${file.id}:${block.start}`,
        projectId: file.projectId,
        projectName: project.name,
        fileId: file.id,
        caseName: block.name,
        code,
        startLine: block.line,
        endLine: block.endLine,
        caseStart: block.start,
        caseEnd: block.end,
        fileSha: file.sha256 ?? sha256(file.content),
        caseSha: sha256(block.source),
        ordinal: block.index,
        language: 'javascript',
      });
    }
  }

  matches.sort((a, b) => {
    const exact = Number(b.caseName.toLowerCase() === needle) - Number(a.caseName.toLowerCase() === needle);
    if (exact !== 0) return exact;
    if (a.projectName !== b.projectName) return a.projectName.localeCompare(b.projectName);
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.caseName.localeCompare(b.caseName);
  });

  return {
    query: raw,
    matches: matches.slice(0, MAX_MATCHES),
    stats: {
      projects: projectName.size,
      filesScanned,
      filesMatched,
      casesExamined,
      skippedFiles: files.length - scannable.length,
      durationMs: Date.now() - started,
    },
    truncated: matches.length > MAX_MATCHES,
    note: files.length
      ? 'Extracted from the imported files with an AST walk — nested switches, block-scoped cases and commented-out labels are handled.'
      : 'No importable JavaScript files are available yet. Import a repository or upload a ZIP first.',
  };
}
