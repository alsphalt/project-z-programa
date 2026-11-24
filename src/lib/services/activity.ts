import 'server-only';
import { query, queryOne } from '../db';

/**
 * Activity log reads.
 *
 * The write side is `logActivity()` in `src/lib/audit.ts` — one append-only row
 * per privileged action. This module is the read side: the Activity Logs page
 * and the notification bell. Every value here comes from `activity_logs`; there
 * is no in-memory buffer, so a restart cannot invent or lose history.
 */

export const ACTIVITY_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type ActivitySeverity = (typeof ACTIVITY_SEVERITIES)[number];

export interface ActivityRow {
  id: string;
  userEmail: string | null;
  serverId: string | null;
  serverName: string | null;
  action: string;
  target: string | null;
  severity: ActivitySeverity;
  ip: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityFilters {
  serverId?: string | null;
  /** Visibility scope used when no explicit server was requested. */
  serverIds?: string[];
  /** Exact action (`file.write`) or a family (`file.`). */
  action?: string | null;
  severity?: ActivitySeverity | 'all' | null;
  q?: string | null;
  /** ISO timestamps, inclusive. */
  since?: string | null;
  until?: string | null;
  limit?: number;
  offset?: number;
}

export interface ActivityPage {
  events: ActivityRow[];
  total: number;
  limit: number;
  offset: number;
  facets: {
    actions: Array<{ action: string; count: number }>;
    severities: Array<{ severity: string; count: number }>;
    servers: Array<{ serverId: string; serverName: string | null; count: number }>;
  };
}

type SqlParam = string | number | string[];

const ACTIONS_LIMIT = 40;

/** `%` and `_` are LIKE wildcards; a user typing them means the character. */
function likeTerm(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function positiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.min(Math.max(Math.trunc(value as number), 1), max);
}

interface WhereParts {
  clause: string;
  params: SqlParam[];
}

/**
 * The single place a filter set becomes SQL. The list query and the count query
 * share it, which is what keeps `total` consistent with `events`.
 *
 * `alias` prefixes column names so the same builder can drive the joined query
 * (`a`) and the bare-table aggregates (no alias).
 */
function buildWhere(filters: ActivityFilters, alias = ''): WhereParts {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  const where: string[] = [];
  const params: SqlParam[] = [];
  const add = (sql: string, value: SqlParam) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.serverId) {
    add(`${col('server_id')} = ?`, filters.serverId);
  } else if (filters.serverIds) {
    if (!filters.serverIds.length) {
      // A user without server grants still sees account-level events.
      where.push(`${col('server_id')} is null`);
    } else {
      params.push(filters.serverIds);
      where.push(
        `(${col('server_id')} is null or ${col('server_id')} = any($${params.length}::text[]))`,
      );
    }
  }

  if (filters.severity && filters.severity !== 'all') {
    add(`${col('severity')} = ?`, filters.severity);
  }
  if (filters.action) {
    if (filters.action.endsWith('.')) add(`${col('action')} like ?`, `${filters.action}%`);
    else add(`${col('action')} = ?`, filters.action);
  }
  if (filters.q?.trim()) {
    params.push(likeTerm(filters.q));
    const p = `$${params.length}`;
    where.push(
      `(lower(${col('action')}) like ${p}
        or lower(coalesce(${col('target')},'')) like ${p}
        or lower(coalesce(${col('user_email')},'')) like ${p}
        or lower(coalesce(${col('detail')}::text,'')) like ${p})`,
    );
  }
  if (filters.since) {
    add(`${col('created_at')} >= ?::timestamptz`, filters.since);
  }
  if (filters.until) {
    add(`${col('created_at')} <= ?::timestamptz`, filters.until);
  }

  return { clause: where.length ? `where ${where.join(' and ')}` : '', params };
}

const SELECT = `
  select a.id::text       as id,
         a.user_email     as user_email,
         a.server_id      as server_id,
         s.name           as server_name,
         a.action         as action,
         a.target         as target,
         a.severity       as severity,
         a.ip             as ip,
         a.detail         as detail,
         a.created_at     as created_at
    from activity_logs a
    left join connected_servers s on s.id = a.server_id`;

function toRow(raw: Record<string, unknown>): ActivityRow {
  const detail = raw.detail;
  let parsed: Record<string, unknown> | null = null;
  if (detail && typeof detail === 'object') {
    parsed = detail as Record<string, unknown>;
  } else if (typeof detail === 'string' && detail.trim().startsWith('{')) {
    try {
      parsed = JSON.parse(detail) as Record<string, unknown>;
    } catch {
      parsed = null; // an unparsable detail column is not worth failing a read over
    }
  }
  return {
    id: String(raw.id),
    userEmail: (raw.user_email as string | null) ?? null,
    serverId: (raw.server_id as string | null) ?? null,
    serverName: (raw.server_name as string | null) ?? null,
    action: String(raw.action),
    target: (raw.target as string | null) ?? null,
    severity: (ACTIVITY_SEVERITIES as readonly string[]).includes(String(raw.severity))
      ? (raw.severity as ActivitySeverity)
      : 'info',
    ip: (raw.ip as string | null) ?? null,
    detail: parsed,
    createdAt: new Date(String(raw.created_at)).toISOString(),
  };
}

export async function listActivity(filters: ActivityFilters = {}): Promise<ActivityPage> {
  const limit = positiveInt(filters.limit, 50, 200);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);
  const { clause, params } = buildWhere(filters, 'a');

  const rows = await query<Record<string, unknown>>(
    `${SELECT} ${clause} order by a.created_at desc, a.id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );

  // Count over the same predicate; the join cannot change the row count because
  // activity_logs.server_id either matches one connected_servers row or is null.
  const countWhere = buildWhere(filters);
  const total = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from activity_logs ${countWhere.clause}`,
    countWhere.params,
  );

  return {
    events: rows.map(toRow),
    total: Number(total?.count ?? 0),
    limit,
    offset,
    facets: await activityFacets(filters),
  };
}

/**
 * Facet counts honour the same visibility, search and time scope as the list,
 * but not the action/severity selection — otherwise every dropdown would
 * collapse to the single value already chosen.
 */
export async function activityFacets(filters: ActivityFilters = {}): Promise<ActivityPage['facets']> {
  const scope: ActivityFilters = {
    serverId: filters.serverId,
    serverIds: filters.serverIds,
    since: filters.since,
    until: filters.until,
    q: filters.q,
  };
  const { clause, params } = buildWhere(scope);

  const [actions, severities, servers] = await Promise.all([
    query<{ action: string; count: string | number }>(
      `select action, count(*)::int as count from activity_logs ${clause}
        group by action order by count desc, action asc limit ${ACTIONS_LIMIT}`,
      params,
    ),
    query<{ severity: string; count: string | number }>(
      `select severity, count(*)::int as count from activity_logs ${clause} group by severity`,
      params,
    ),
    (() => {
      const scoped = buildWhere(scope, 'a');
      return query<{ server_id: string | null; name: string | null; count: string | number }>(
        `select a.server_id as server_id, s.name as name, count(*)::int as count
           from activity_logs a left join connected_servers s on s.id = a.server_id
           ${scoped.clause}
          group by a.server_id, s.name order by count desc limit 25`,
        scoped.params,
      );
    })(),
  ]);

  return {
    actions: actions.map((row) => ({ action: row.action, count: Number(row.count) })),
    severities: severities.map((row) => ({ severity: row.severity, count: Number(row.count) })),
    servers: servers
      .filter((row) => row.server_id)
      .map((row) => ({
        serverId: String(row.server_id),
        serverName: row.name ?? null,
        count: Number(row.count),
      })),
  };
}

/** Compact counters for the header bell. Aggregates only, no rows returned. */
export async function activitySummary(
  serverId?: string | null,
  serverIds?: string[],
): Promise<{ last24h: number; warnings24h: number; critical24h: number; lastEventAt: string | null }> {
  const { clause, params } = buildWhere({ serverId, serverIds });
  const scope = clause ? `${clause} and true` : 'where true';
  const row = await queryOne<{
    last24: string | number;
    warnings: string | number;
    critical: string | number;
    last_at: string | null;
  }>(
    `select count(*) filter (where created_at > now() - interval '24 hours')::int as last24,
            count(*) filter (where severity = 'warning'  and created_at > now() - interval '24 hours')::int as warnings,
            count(*) filter (where severity = 'critical' and created_at > now() - interval '24 hours')::int as critical,
            max(created_at) as last_at
       from activity_logs ${scope}`,
    params,
  );
  return {
    last24h: Number(row?.last24 ?? 0),
    warnings24h: Number(row?.warnings ?? 0),
    critical24h: Number(row?.critical ?? 0),
    lastEventAt: row?.last_at ? new Date(String(row.last_at)).toISOString() : null,
  };
}
