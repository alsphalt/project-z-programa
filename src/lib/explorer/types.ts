/** Shared Project Explorer shapes (client + server). No runtime imports. */
import type { ExplorerCategoryId } from './classify';

export type { ExplorerCategoryId };

export interface ExplorerItem {
  /** Stable key for React lists. */
  id: string;
  /** How the row should be rendered. */
  type: 'file' | 'plugin' | 'entry' | 'case-group' | 'function-group' | 'config' | 'data';
  name: string;
  path?: string;
  subtitle?: string;
  detail?: string;
  sizeBytes?: number;
  modifiedAt?: string | null;
  count?: number;
  line?: number;
  badges?: string[];
  protected?: boolean;
  editable?: boolean;
  /** Nested rows: files of a plugin, cases of a file, functions of a file. */
  children?: Array<{ path: string; name: string; line?: number; detail?: string; protected?: boolean }>;
}

export interface ExplorerCategoryView {
  id: ExplorerCategoryId;
  label: string;
  description: string;
  hint: string;
  items: ExplorerItem[];
  notes: string[];
  total: number;
  truncated: boolean;
  /** Items skipped by this page. */
  offset: number;
}

export interface ExplorerCategorySummary {
  id: ExplorerCategoryId;
  label: string;
  description: string;
  hint: string;
  count: number;
  samples: string[];
  /** False when the category could not be resolved from real project files. */
  available: boolean;
}

export interface ExplorerEntryView {
  path: string | null;
  evidence: string;
  startupCommand: string | null;
  runtime: string | null;
  note: string | null;
  candidates: Array<{ path: string; score: number; evidence: string }>;
  verified: boolean;
}

export interface ExplorerDependency {
  name: string;
  range: string;
  kind: 'dependency' | 'devDependency';
  imported: boolean;
  installed: 'present' | 'missing' | 'unverified';
  latest: string | null;
  status: 'ok' | 'missing' | 'unused' | 'unpinned' | 'outdated';
}

export interface ExplorerPackageView {
  path: string | null;
  name: string | null;
  version: string | null;
  main: string | null;
  scripts: Array<{ name: string; command: string }>;
  dependencies: ExplorerDependency[];
  problems: Array<{ code: string; message: string; path?: string }>;
  installedCheck: 'checked' | 'unavailable';
  note: string | null;
}

export interface ExplorerWarning {
  code: string;
  message: string;
  path?: string;
}

export interface ExplorerOverview {
  server: { id: string; name: string; root: string };
  index: {
    files: number;
    folders: number;
    withContent: number;
    caseCount: number;
    functionCount: number;
    indexedAt: string | null;
  };
  lastScan: {
    at: string | null;
    status: string;
    added: number;
    changed: number;
    deleted: number;
    failed: number;
    message: string | null;
    durationMs: number | null;
  } | null;
  categories: ExplorerCategorySummary[];
  entry: ExplorerEntryView;
  package: ExplorerPackageView;
  warnings: ExplorerWarning[];
  capabilities: { canWrite: boolean; canDelete: boolean; canDeploy: boolean };
}

export interface ExplorerSearchHit {
  line: number;
  column: number;
  text: string;
  before: string[];
  after: string[];
}

export interface ExplorerSearchResult {
  query: string;
  symbols: Array<{ path: string; name: string; kind: string; line: number; detail?: string }>;
  files: Array<{ path: string; name: string; matches: number; hits: ExplorerSearchHit[] }>;
  names: Array<{ path: string; name: string; isDirectory: boolean }>;
  totalMatches: number;
  truncated: boolean;
  notes: string[];
  snapshotAt: string | null;
}

export interface ExplorerFileInfo {
  path: string;
  name: string;
  extension: string;
  language: string | null;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
  sha256: string | null;
  indexedSha: string | null;
  contentCached: boolean;
  secret: boolean;
  secretKind: string | null;
  editable: boolean;
  /** False for credentials, records and protected folders. */
  deletable: boolean;
  protectedData: boolean;
  categories: Array<{ id: ExplorerCategoryId; reason: string }>;
  draft: { id: string; bytes: number; updatedAt: string; status: string } | null;
  versions: { count: number; latest: { version: number; createdAt: string; note: string | null } | null };
  symbols: {
    cases: Array<{ name: string; line: number; aliases: string[] }>;
    functions: Array<{ name: string; line: number; signature: string | null }>;
  };
  imports: Array<{ specifier: string; line: number; resolvedPath: string | null; external: boolean; bare: string | null }>;
  importedBy: Array<{ path: string; line: number; specifier: string }>;
  brokenReferences: string[];
  siblings: Array<{ path: string; name: string; isDirectory: boolean; sizeBytes: number }>;
  notes: string[];
}

export interface ExplorerScanResult {
  status: 'succeeded' | 'partial' | 'failed';
  scannedFiles: number;
  scannedFolders: number;
  indexed: number;
  added: string[];
  changed: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  failed: Array<{ path: string; message: string }>;
  cases: number;
  functions: number;
  durationMs: number;
  message: string;
  truncated: boolean;
  finishedAt: string;
}
