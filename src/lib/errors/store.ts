import 'server-only';
import { jsonb, parseJsonb, query, queryOne, type SqlParam } from '../db';
import { uuid } from '../crypto';
import type { Principal } from '../auth/permissions';
import { collectEvidence } from './evidence';
import { diagnose, fingerprintFor } from './taxonomy';
import type {
  ErrorEvent,
  ErrorSource,
  ErrorStatus,
  RawErrorInput,
  RepairRecord,
  Severity,
} from './types';

interface Row {
  id: string;
  server_id: string | null;
  user_id: string | null;
  fingerprint: string;
  title: string;
  code: string;
  message: string;
  source: string;
  severity: string;
  status: string;
  occurrences: number | string;
  first_seen_at: string;
  last_seen_at: string;
  file_path: string | null;
  line_number: number | null;
  column_number: number | null;
  function_name: string | null;
  endpoint: string | null;
  http_method: string | null;
  http_status: number | null;
  root_cause: string | null;
  why: string | null;
  recommendation: string | null;
  evidence: unknown;
  context: unknown;
  repair: unknown;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

function mapRow(row: Row): ErrorEvent {
  return {
    id: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    title: row.title,
    code: row.code,
    message: row.message,
    source: row.source as ErrorSource,
    severity: (['critical', 'moderate', 'minor'].includes(row.severity) ? row.severity : 'moderate') as Severity,
    status: (['active', 'resolved', 'ignored'].includes(row.status) ? row.status : 'active') as ErrorStatus,
    occurrences: Number(row.occurrences ?? 1),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    filePath: row.file_path,
    line: row.line_number === null ? null : Number(row.line_number),
    column: row.column_number === null ? null : Number(row.column_number),
    functionName: row.function_name,
    endpoint: row.endpoint,
    httpMethod: row.http_method,
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    rootCause: row.root_cause ?? '',
    why: row.why ?? '',
    recommendation: row.recommendation ?? '',
    evidence: parseJsonb<string[]>(row.evidence, []),
    context: parseJsonb<Record<string, unknown>>(row.context, {}),
    repair: parseJsonb<RepairRecord>(row.repair, {}),
    repairAuthority: (parseJsonb<RepairRecord>(row.repair, {}).authority ?? 'none') as ErrorEvent['repairAuthority'],
    repairKind: parseJsonb<RepairRecord>(row.repair, {}).kind ?? null,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

/**
 * Persist one captured failure.
 *
 * The same problem seen twice increments one row (fingerprint) instead of
 * flooding the Error Center, and a resolved problem that comes back is reopened
 * — because it is not fixed any more.
 */
export async function recordError(input: RawErrorInput): Promise<ErrorEvent | null> {
  try {
    const message = (input.message ?? '').trim();
    if (!message) return null;

    const evidence = await collectEvidence(input.serverId ?? null, input);
    const diagnosis = diagnose({ ...input, message }, evidence);
    const fingerprint = fingerprintFor({ ...input, message }, diagnosis);
    const id = uuid();
    const at = input.at ?? new Date().toISOString();

    const rows = await query<Row>(
      `insert into error_intel_events
        (id, server_id, user_id, fingerprint, title, code, message, source, severity, status,
         occurrences, first_seen_at, last_seen_at, file_path, line_number, column_number, function_name,
         endpoint, http_method, http_status, root_cause, why, recommendation, evidence, context, repair)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',1,$10::timestamptz,$10::timestamptz,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb)
       on conflict (fingerprint) do update set
         occurrences = error_intel_events.occurrences + 1,
         last_seen_at = excluded.last_seen_at,
         updated_at = now(),
         title = excluded.title,
         code = excluded.code,
         message = excluded.message,
         severity = excluded.severity,
         source = excluded.source,
         file_path = coalesce(excluded.file_path, error_intel_events.file_path),
         line_number = coalesce(excluded.line_number, error_intel_events.line_number),
         column_number = coalesce(excluded.column_number, error_intel_events.column_number),
         function_name = coalesce(excluded.function_name, error_intel_events.function_name),
         endpoint = coalesce(excluded.endpoint, error_intel_events.endpoint),
         http_method = coalesce(excluded.http_method, error_intel_events.http_method),
         http_status = coalesce(excluded.http_status, error_intel_events.http_status),
         root_cause = excluded.root_cause,
         why = excluded.why,
         recommendation = excluded.recommendation,
         evidence = excluded.evidence,
         context = excluded.context,
         status = 'active',
         resolved_at = null,
         resolved_by = null,
         resolution_note = null
       returning *`,
      [
        id,
        input.serverId ?? null,
        input.userId ?? null,
        fingerprint,
        diagnosis.title,
        diagnosis.code,
        message.slice(0, 4000),
        diagnosis.source,
        diagnosis.severity,
        at,
        diagnosis.filePath,
        diagnosis.line,
        diagnosis.column,
        diagnosis.functionName,
        diagnosis.endpoint,
        diagnosis.httpMethod,
        diagnosis.httpStatus,
        diagnosis.rootCause,
        diagnosis.why,
        diagnosis.recommendation,
        jsonb(diagnosis.evidence),
        jsonb(input.context ?? {}),
        jsonb({
          authority: diagnosis.repairAuthority,
          kind: diagnosis.repairKind,
          state: diagnosis.repairAuthority === 'none' ? 'none' : 'proposed',
        } satisfies RepairRecord),
      ],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  } catch (error) {
    // Error capture must never break the operation it observes.
    // eslint-disable-next-line no-console
    console.error('[darknote] failed to record error event', error);
    return null;
  }
}

/** Fire-and-forget variant for hot paths (console lines, API failures). */
export function captureError(input: RawErrorInput): void {
  void recordError(input);
}

export interface ErrorFilters {
  serverId?: string | null;
  /** When provided, restricts to these servers plus global (server-less) events. */
  serverIds?: string[];
  status?: ErrorStatus | 'all';
  severity?: Severity | 'all';
  source?: ErrorSource | 'all';
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ErrorStats {
  active: number;
  resolved: number;
  criticalOpen: number;
  moderateOpen: number;
  minorOpen: number;
  last24h: number;
  total: number;
  bySource: Array<{ source: string; count: number }>;
}

export async function listErrors(filters: ErrorFilters = {}): Promise<{ errors: ErrorEvent[]; total: number }> {
  const where: string[] = [];
  const params: SqlParam[] = [];
  const add = (sql: string, value: SqlParam) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.serverId) {
    add('server_id = ?', filters.serverId);
  } else if (filters.serverIds) {
    if (!filters.serverIds.length) {
      where.push('server_id is null');
    } else {
      params.push(filters.serverIds);
      where.push(`(server_id is null or server_id = any($${params.length}::text[]))`);
    }
  }
  if (filters.status && filters.status !== 'all') add('status = ?', filters.status);
  if (filters.severity && filters.severity !== 'all') add('severity = ?', filters.severity);
  if (filters.source && filters.source !== 'all') add('source = ?', filters.source);
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim().toLowerCase()}%`);
    const p = `$${params.length}`;
    where.push(
      `(lower(title) like ${p} or lower(message) like ${p} or lower(coalesce(file_path,'')) like ${p} or lower(code) like ${p} or lower(coalesce(endpoint,'')) like ${p})`,
    );
  }

  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  params.push(limit, offset);

  const [rows, totalRow] = await Promise.all([
    query<Row>(
      `select * from error_intel_events ${clause}
        order by case severity when 'critical' then 0 when 'moderate' then 1 else 2 end,
                 last_seen_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    ),
    queryOne<{ count: string | number }>(
      `select count(*)::int as count from error_intel_events ${clause}`,
      params.slice(0, -2),
    ),
  ]);

  return { errors: rows.map(mapRow), total: Number(totalRow?.count ?? rows.length) };
}

export async function getError(id: string): Promise<ErrorEvent | null> {
  const row = await queryOne<Row>('select * from error_intel_events where id = $1', [id]);
  return row ? mapRow(row) : null;
}

export async function errorStats(serverId?: string | null, serverIds?: string[]): Promise<ErrorStats> {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (serverId) {
    params.push(serverId);
    where.push('server_id = $1');
  } else if (serverIds) {
    if (!serverIds.length) {
      where.push('server_id is null');
    } else {
      params.push(serverIds);
      where.push('(server_id is null or server_id = any($1::text[]))');
    }
  }
  const filter = where.length ? `where ${where.join(' and ')}` : '';

  const [counts, sources] = await Promise.all([
    queryOne<{
      active: string | number; resolved: string | number; critical_open: string | number;
      moderate_open: string | number; minor_open: string | number; last24: string | number; total: string | number;
    }>(
      `select
         count(*) filter (where status = 'active')::int as active,
         count(*) filter (where status = 'resolved')::int as resolved,
         count(*) filter (where status = 'active' and severity = 'critical')::int as critical_open,
         count(*) filter (where status = 'active' and severity = 'moderate')::int as moderate_open,
         count(*) filter (where status = 'active' and severity = 'minor')::int as minor_open,
         count(*) filter (where last_seen_at > now() - interval '24 hours')::int as last24,
         count(*)::int as total
       from error_intel_events ${filter}`,
      params,
    ),
    query<{ source: string; count: string | number }>(
      `select source, count(*)::int as count from error_intel_events
        ${where.length ? `${filter} and status = 'active'` : "where status = 'active'"}
        group by source order by count desc limit 12`,
      params,
    ),
  ]);

  return {
    active: Number(counts?.active ?? 0),
    resolved: Number(counts?.resolved ?? 0),
    criticalOpen: Number(counts?.critical_open ?? 0),
    moderateOpen: Number(counts?.moderate_open ?? 0),
    minorOpen: Number(counts?.minor_open ?? 0),
    last24h: Number(counts?.last24 ?? 0),
    total: Number(counts?.total ?? 0),
    bySource: sources.map((row) => ({ source: row.source, count: Number(row.count) })),
  };
}

export async function setErrorStatus(
  id: string,
  status: ErrorStatus,
  user: Pick<Principal, 'id' | 'email'>,
  note?: string,
): Promise<ErrorEvent | null> {
  await query(
    `update error_intel_events set
       status = $2,
       resolved_at = case when $2 = 'resolved' then now() else null end,
       resolved_by = case when $2 = 'resolved' then $3 else null end,
       resolution_note = case when $2 = 'resolved' then $4 else null end,
       updated_at = now()
     where id = $1`,
    [id, status, `${user.email}`, note ?? null],
  );
  return getError(id);
}

export async function saveRepair(id: string, repair: RepairRecord): Promise<void> {
  await query('update error_intel_events set repair = $2::jsonb, updated_at = now() where id = $1', [id, jsonb(repair)]);
}

export async function unresolvedCriticalCount(serverId?: string | null): Promise<number> {
  const row = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from error_intel_events
      where status = 'active' and severity in ('critical','moderate')
        ${serverId ? 'and server_id = $1' : ''}`,
    serverId ? [serverId] : [],
  );
  return Number(row?.count ?? 0);
}
