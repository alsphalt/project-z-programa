/**
 * Error Intelligence — shared types.
 *
 * A captured failure is always described with the same fields so the Error
 * Center, the API and BIGBROTHER never have to guess what a record means.
 */

export const ERROR_SOURCES = [
  'whatsapp',
  'panel',
  'console',
  'api',
  'frontend',
  'auth',
  'websocket',
  'files',
  'editor',
  'explorer',
  'deployment',
  'packages',
  'power',
  'storage',
  'database',
] as const;

export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const SEVERITIES = ['critical', 'moderate', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ERROR_STATUSES = ['active', 'resolved', 'ignored'] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

/** How much authority a repair needs before it may touch production. */
export type RepairAuthority = 'safe' | 'approval' | 'none';

export const SOURCE_LABELS: Record<ErrorSource, string> = {
  whatsapp: 'WhatsApp bot runtime',
  panel: 'Pterodactyl connection',
  console: 'Terminal / console output',
  api: 'Backend API request',
  frontend: 'Frontend',
  auth: 'Authentication',
  websocket: 'WebSocket connection',
  files: 'File manager',
  editor: 'Code editor',
  explorer: 'Project explorer',
  deployment: 'Deployment / rollback',
  packages: 'Packages & dependencies',
  power: 'Bot start / restart',
  storage: 'Backup storage',
  database: 'Database',
};

export interface RawErrorInput {
  message: string;
  source: ErrorSource;
  /** Stable upstream code (PterodactylError.code, ApiError.code, npm code…). */
  code?: string | null;
  serverId?: string | null;
  userId?: string | null;
  stack?: string | null;
  endpoint?: string | null;
  httpMethod?: string | null;
  httpStatus?: number | null;
  filePath?: string | null;
  line?: number | null;
  column?: number | null;
  functionName?: string | null;
  /** Structured facts collected by the caller (real evidence, not prose). */
  context?: Record<string, unknown>;
  evidence?: string[];
  at?: string;
}

export interface Diagnosis {
  title: string;
  code: string;
  severity: Severity;
  source: ErrorSource;
  rootCause: string;
  why: string;
  recommendation: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  functionName: string | null;
  endpoint: string | null;
  httpMethod: string | null;
  httpStatus: number | null;
  /** null = no automated repair is offered. */
  repairAuthority: RepairAuthority;
  /** Machine label used by the repair planner. */
  repairKind: string | null;
  evidence: string[];
}

export interface ErrorEvent extends Diagnosis {
  id: string;
  serverId: string | null;
  userId: string | null;
  message: string;
  status: ErrorStatus;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  context: Record<string, unknown>;
  repair: RepairRecord;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export interface RepairPlanStep {
  key: string;
  label: string;
  detail: string;
  /** done | pending | blocked */
  state: 'done' | 'pending' | 'blocked';
}

export interface RepairProposal {
  id: string;
  kind: string;
  authority: RepairAuthority;
  summary: string;
  risk: string;
  path: string | null;
  baseHash: string | null;
  proposedContent?: string | null;
  diff?: string | null;
  steps: RepairPlanStep[];
  backupId?: string | null;
  validated: boolean;
  validationErrors?: string[];
  createdAt: string;
  appliedAt?: string | null;
  appliedBy?: string | null;
  state: 'proposed' | 'applied' | 'discarded' | 'blocked';
  notes?: string[];
}

export interface RepairRecord {
  authority?: RepairAuthority;
  kind?: string | null;
  state?: 'none' | 'proposed' | 'applied' | 'discarded' | 'blocked';
  proposal?: RepairProposal | null;
  lastAction?: string | null;
  lastActionAt?: string | null;
}
