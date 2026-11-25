"use client";

import { useMemo, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers } from "@/components/providers";
import { Badge, Empty, Panel, Spinner, Stat } from "@/components/ui";
import { useApi } from "@/lib/use-api";
import { datetime, relative } from "@/lib/format";

type Severity = "info" | "warning" | "critical";

type Event = {
  id: string;
  userEmail: string | null;
  serverId: string | null;
  serverName: string | null;
  action: string;
  target: string | null;
  severity: Severity;
  ip: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

type Payload = {
  events: Event[];
  total: number;
  limit: number;
  offset: number;
  summary: { last24h: number; warnings24h: number; critical24h: number; lastEventAt: string | null };
  facets: {
    actions: Array<{ action: string; count: number }>;
    severities: Array<{ severity: string; count: number }>;
    servers: Array<{ serverId: string; serverName: string | null; count: number }>;
  };
};

const PAGE = 50;

const RANGES = [
  { key: "24h", label: "24 hours", hours: 24 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
  { key: "30d", label: "30 days", hours: 24 * 30 },
  { key: "all", label: "All time", hours: 0 },
] as const;

const SEVERITY_STYLE: Record<Severity, string> = {
  info: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

/**
 * Activity Logs.
 *
 * Every row is a real `activity_logs` entry written by the action it describes.
 * Filtering, search and pagination run in SQL (`/api/activity`), so the page
 * stays responsive on a phone with a long history, and the counters come from
 * the same predicate as the list — they cannot disagree with what is shown.
 */
export default function ActivityPage() {
  const { servers, activeId } = useServers();
  const [scope, setScope] = useState<string>("all"); // "all" or a server id
  const [severity, setSeverity] = useState<string>("all");
  const [action, setAction] = useState<string>("");
  const [range, setRange] = useState<string>("7d");
  const [q, setQ] = useState("");
  const [pendingQ, setPendingQ] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (scope !== "all") params.set("serverId", scope);
    if (severity !== "all") params.set("severity", severity);
    if (action) params.set("action", action);
    if (q.trim()) params.set("q", q.trim());
    const hours = RANGES.find((entry) => entry.key === range)?.hours ?? 0;
    if (hours) params.set("since", new Date(Date.now() - hours * 3600_000).toISOString());
    params.set("limit", String(PAGE));
    params.set("offset", String(page * PAGE));
    return `/api/activity?${params.toString()}`;
  }, [scope, severity, action, range, q, page]);

  const data = useApi<Payload>(query);
  const events = data.data?.events ?? [];
  const total = data.data?.total ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE), 1);

  const reset = () => {
    setScope("all");
    setSeverity("all");
    setAction("");
    setRange("7d");
    setQ("");
    setPendingQ("");
    setPage(0);
  };

  const change = (apply: () => void) => {
    setPage(0);
    apply();
  };

  return (
    <div>
      <PageHeader
        title="Activity Logs"
        description="Every privileged action this platform performed, read from the append-only audit table. Server-scoped: you see the servers you hold a grant for, plus account-level events."
        actions={
          <>
            <button onClick={reset} className="btn-ghost !px-2.5 !py-1.5 text-[11px]">
              Reset filters
            </button>
            <button
              onClick={() => void data.refresh()}
              className="btn-primary !px-2.5 !py-1.5 text-[11px]"
              disabled={data.loading}
            >
              <RefreshCw className={`h-3 w-3 ${data.loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Events (24h)" value={data.data?.summary.last24h ?? 0} />
        <Stat label="Warnings (24h)" value={data.data?.summary.warnings24h ?? 0} />
        <Stat label="Critical (24h)" value={data.data?.summary.critical24h ?? 0} />
        <Stat
          label="Last event"
          value={data.data?.summary.lastEventAt ? relative(data.data.summary.lastEventAt) : "—"}
        />
      </div>

      <Panel className="mb-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Search</span>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                change(() => setQ(pendingQ));
              }}
              className="flex items-center gap-1 rounded-lg border border-ink-700/70 bg-ink-900/70 px-2"
            >
              <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <input
                value={pendingQ}
                onChange={(event) => setPendingQ(event.target.value)}
                placeholder="action, target, actor or detail"
                className="w-full bg-transparent py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"
              />
              <button type="submit" className="text-[10px] text-accent-soft">
                Go
              </button>
            </form>
          </label>

          <label>
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Server</span>
            <select
              value={scope}
              onChange={(event) => change(() => setScope(event.target.value))}
              className="rounded-lg border border-ink-700/70 bg-ink-900/70 px-2 py-1.5 text-xs text-slate-200"
            >
              <option value="all">All accessible servers</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                  {server.id === activeId ? " (active)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Severity</span>
            <select
              value={severity}
              onChange={(event) => change(() => setSeverity(event.target.value))}
              className="rounded-lg border border-ink-700/70 bg-ink-900/70 px-2 py-1.5 text-xs text-slate-200"
            >
              <option value="all">Any</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>

          <label>
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Action</span>
            <select
              value={action}
              onChange={(event) => change(() => setAction(event.target.value))}
              className="max-w-[190px] rounded-lg border border-ink-700/70 bg-ink-900/70 px-2 py-1.5 text-xs text-slate-200"
            >
              <option value="">All actions</option>
              {(data.data?.facets.actions ?? []).map((facet) => (
                <option key={facet.action} value={facet.action}>
                  {facet.action} ({facet.count})
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Range</span>
            <div className="flex overflow-hidden rounded-lg border border-ink-700/70">
              {RANGES.map((entry) => (
                <button
                  key={entry.key}
                  onClick={() => change(() => setRange(entry.key))}
                  className={`px-2 py-1.5 text-[11px] ${
                    range === entry.key ? "bg-accent/20 text-white" : "bg-ink-900/70 text-slate-400"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </label>
        </div>
      </Panel>

      {data.error && (
        <Panel className="mb-3 border-rose-500/40 bg-rose-500/5">
          <p className="text-xs text-rose-300">{data.error}</p>
        </Panel>
      )}

      <Panel>
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            {total.toLocaleString()} event{total === 1 ? "" : "s"}
            {q ? ` matching “${q}”` : ""}
          </span>
          <span>
            Page {page + 1} / {pages}
          </span>
        </div>

        {data.loading && !events.length && (
          <div className="flex items-center gap-2 py-6 text-xs text-slate-500">
            <Spinner /> Reading the audit table…
          </div>
        )}

        {!data.loading && !events.length && !data.error && (
          <Empty
            title="No activity in this range"
            hint="Actions such as sign-in, file writes, deploys, imports and GitHub synchronisation are recorded here as they happen. Widen the range or clear the filters."
          />
        )}

        {events.length > 0 && (
          <ul className="divide-y divide-ink-800/80">
            {events.map((event) => {
              const expanded = open === event.id;
              return (
                <li key={event.id}>
                  <button
                    onClick={() => setOpen(expanded ? null : event.id)}
                    className="flex w-full items-start gap-2 py-2 text-left hover:bg-ink-800/40"
                  >
                    <span
                      className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase ${SEVERITY_STYLE[event.severity]}`}
                    >
                      {event.severity}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mono block truncate text-xs text-slate-200">{event.action}</span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {event.serverName ?? "account"}
                        {event.target ? ` · ${event.target}` : ""}
                        {event.userEmail ? ` · ${event.userEmail}` : ""}
                        {event.ip ? ` · ${event.ip}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-[10px] text-slate-500">
                      <span className="block">{relative(event.createdAt)}</span>
                      <span className="hidden sm:block">{datetime(event.createdAt)}</span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="mb-2 rounded-lg border border-ink-800 bg-ink-950/60 p-2">
                      {event.detail && Object.keys(event.detail).length > 0 ? (
                        <pre className="mono max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] text-slate-400">
                          {JSON.stringify(event.detail, null, 2)}
                        </pre>
                      ) : (
                        <p className="text-[11px] text-slate-500">No structured detail was recorded for this action.</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            onClick={() => setPage((current) => Math.max(current - 1, 0))}
            disabled={page === 0 || data.loading}
            className="btn-ghost !px-2 !py-1 text-[11px] disabled:opacity-40"
          >
            <ChevronLeft className="h-3 w-3" /> Newer
          </button>
          <Badge>{offsetLabel(page, total)}</Badge>
          <button
            onClick={() => setPage((current) => (current + 1 < pages ? current + 1 : current))}
            disabled={page + 1 >= pages || data.loading}
            className="btn-ghost !px-2 !py-1 text-[11px] disabled:opacity-40"
          >
            Older <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </Panel>
    </div>
  );
}

function offsetLabel(page: number, total: number): string {
  if (!total) return "0 of 0";
  const from = page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);
  return `${from}–${to} of ${total}`;
}
