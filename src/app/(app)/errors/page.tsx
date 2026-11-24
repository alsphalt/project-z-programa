"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Code2,
  FolderOpen,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  Wrench,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner, Stat } from "@/components/ui";
import { apiPatch, apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { datetime, relative } from "@/lib/format";
import type { RepairProposal } from "@/lib/errors/types";

type Severity = "critical" | "moderate" | "minor";
type Status = "active" | "resolved" | "ignored";

type ErrorEvent = {
  id: string;
  serverId: string | null;
  title: string;
  code: string;
  message: string;
  source: string;
  severity: Severity;
  status: Status;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  functionName: string | null;
  endpoint: string | null;
  httpMethod: string | null;
  httpStatus: number | null;
  rootCause: string;
  why: string;
  recommendation: string;
  evidence: string[];
  context: Record<string, unknown>;
  repair: { authority?: string; kind?: string; state?: string; proposal?: RepairProposal | null };
  repairAuthority?: string;
  repairKind?: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
};

type Stats = {
  active: number;
  resolved: number;
  criticalOpen: number;
  moderateOpen: number;
  minorOpen: number;
  last24h: number;
  total: number;
  bySource: Array<{ source: string; count: number }>;
};

type ScanSummary = {
  servers: number;
  summaries: Array<{
    serverName: string;
    consoleEvents: number;
    deploymentEvents: number;
    panelProblem: boolean;
    whatsappProblem: boolean;
    error?: string;
  }>;
};

const SOURCES = [
  "whatsapp",
  "panel",
  "console",
  "api",
  "frontend",
  "auth",
  "websocket",
  "files",
  "editor",
  "explorer",
  "deployment",
  "packages",
  "power",
  "storage",
  "database",
];

const SEVERITY_STYLE: Record<string, string> = {
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  moderate: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  minor: "border-sky-500/40 bg-sky-500/10 text-sky-200",
};

const STATUS_STYLE: Record<string, string> = {
  active: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  resolved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  ignored: "border-ink-600/70 bg-ink-800/70 text-slate-300",
};

function editorHref(path: string, line: number | null): string {
  const params = new URLSearchParams({ path });
  if (line) params.set("line", String(line));
  return `/editor?${params.toString()}`;
}

function explorerHref(path: string): string {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : "/";
  return `/files?${new URLSearchParams({ path: parent }).toString()}`;
}

function expectedConfirmation(kind: string | undefined): string {
  if (kind === "restart_bot") return "RESTART";
  if (kind === "file_patch") return "DEPLOY";
  return "CONFIRM";
}

export default function ErrorsPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();

  const [status, setStatus] = useState<"active" | "resolved" | "all">("active");
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const [source, setSource] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"server" | "all">("server");
  const [openId, setOpenId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTyped, setConfirmTyped] = useState("");
  const [patchOpen, setPatchOpen] = useState(false);
  const [patchPath, setPatchPath] = useState("");
  const [patchContent, setPatchContent] = useState("");
  const [pendingResolve, setPendingResolve] = useState<ErrorEvent | null>(null);

  const params = new URLSearchParams();
  if (scope === "server" && activeId) params.set("serverId", activeId);
  if (status !== "all") params.set("status", status);
  if (severity !== "all") params.set("severity", severity);
  if (source !== "all") params.set("source", source);
  if (query.trim()) params.set("q", query.trim());
  params.set("limit", "150");

  const feed = useApi<{ errors: ErrorEvent[]; total: number; stats: Stats }>(`/api/errors?${params.toString()}`, {
    refreshMs: 30_000,
  });

  const errors = feed.data?.errors ?? [];
  const stats = feed.data?.stats;
  const open = useMemo(() => errors.find((error) => error.id === openId) ?? null, [errors, openId]);

  const runScan = async () => {
    setScanning(true);
    try {
      const result = await apiPost<ScanSummary>("/api/errors/scan", activeId && scope === "server" ? { serverId: activeId } : {});
      setScan(result);
      push(`Scan finished over ${result.servers} server(s)`, "ok");
      await feed.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setScanning(false);
    }
  };

  const setErrorStatus = async (error: ErrorEvent, next: Status) => {
    setBusy(true);
    try {
      await apiPatch(`/api/errors/${error.id}`, {
        status: next,
        note: next === "resolved" ? "Marked resolved from the Error Center" : undefined,
      });
      push(next === "resolved" ? "Marked resolved" : `Marked ${next}`, "ok");
      await feed.refresh();
    } catch (error_) {
      push(errorMessage(error_), "error");
    } finally {
      setBusy(false);
      setPendingResolve(null);
    }
  };

  const prepareRepair = async (error: ErrorEvent, patch?: { path: string; content: string }) => {
    setBusy(true);
    try {
      await apiPost(`/api/errors/${error.id}/repair`, {
        action: "propose",
        path: patch?.path,
        content: patch?.content,
      });
      push("Repair proposal prepared — review it before authorising", "ok");
      setPatchOpen(false);
      await feed.refresh();
    } catch (error_) {
      push(errorMessage(error_), "error");
    } finally {
      setBusy(false);
    }
  };

  const applyRepair = async (error: ErrorEvent) => {
    const proposal = error.repair?.proposal;
    if (!proposal) return;
    setBusy(true);
    try {
      const result = await apiPost<{ result: string }>(`/api/errors/${error.id}/repair`, {
        action: "apply",
        confirm: confirmTyped,
      });
      push(result.result, "ok");
      setConfirmTyped("");
      await feed.refresh();
    } catch (error_) {
      push(errorMessage(error_), "error");
    } finally {
      setBusy(false);
    }
  };

  const discardRepair = async (error: ErrorEvent) => {
    setBusy(true);
    try {
      await apiPost(`/api/errors/${error.id}/repair`, { action: "discard" });
      setConfirmTyped("");
      await feed.refresh();
    } catch (error_) {
      push(errorMessage(error_), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Error Center"
        description="Every failure DARKNOTE has detected, with the component it came from, the affected file and line, the root cause it could establish, and a fix."
        actions={
          <>
            <button className="btn-ghost" onClick={() => void feed.refresh()} disabled={feed.loading}>
              {feed.loading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </button>
            <button className="btn-primary" onClick={() => void runScan()} disabled={scanning}>
              {scanning ? <Spinner /> : <ScanLine className="h-3.5 w-3.5" />} Run diagnostic scan
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Active" value={stats?.active ?? "—"} tone="warn" hint={`${stats?.last24h ?? 0} in 24h`} />
        <Stat label="Critical" value={stats?.criticalOpen ?? "—"} tone="bad" hint="open" />
        <Stat label="Moderate" value={stats?.moderateOpen ?? "—"} hint="open" />
        <Stat label="Minor" value={stats?.minorOpen ?? "—"} hint="open" />
        <Stat label="Resolved" value={stats?.resolved ?? "—"} tone="good" hint="kept in history" />
        <Stat label="Total records" value={stats?.total ?? "—"} hint="all time" />
      </div>

      {scan && (
        <Panel className="mt-4" title="Last diagnostic scan" subtitle={`${scan.servers} server(s) checked · console, deployments, bot status, panel reachability`}>
          <div className="space-y-1.5">
            {scan.summaries.length === 0 && (
              <p className="text-xs text-slate-400">No active server was available. Only API, auth and browser failures can be captured without one.</p>
            )}
            {scan.summaries.map((summary) => (
              <div key={summary.serverName} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-700/60 bg-ink-900/50 px-2.5 py-1.5 text-[11.5px]">
                <span className="font-medium text-slate-200">{summary.serverName}</span>
                <Badge tone={summary.consoleEvents ? "bad" : "default"}>{summary.consoleEvents} console</Badge>
                <Badge tone={summary.deploymentEvents ? "warn" : "default"}>{summary.deploymentEvents} deployment</Badge>
                <Badge tone={summary.panelProblem ? "bad" : "good"}>{summary.panelProblem ? "panel failing" : "panel reachable"}</Badge>
                <Badge tone={summary.whatsappProblem ? "bad" : "good"}>{summary.whatsappProblem ? "WhatsApp issue" : "WhatsApp OK"}</Badge>
                {summary.error && <span className="text-rose-300">{summary.error}</span>}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-ink-700/70 bg-ink-900/60 p-0.5 text-[11px]">
          {(["active", "resolved", "all"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setStatus(value)}
              className={`rounded-md px-2.5 py-1 capitalize transition ${status === value ? "bg-accent/15 text-white" : "text-slate-400 hover:text-slate-200"}`}
            >
              {value}
            </button>
          ))}
        </div>

        <input
          className="field !w-auto min-w-[180px] flex-1 !py-1.5 text-xs"
          placeholder="Search title, message, code, file or endpoint…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <select className="field !w-auto !py-1.5 text-xs" value={severity} onChange={(event) => setSeverity(event.target.value as never)}>
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="moderate">Moderate</option>
          <option value="minor">Minor</option>
        </select>

        <select className="field !w-auto !py-1.5 text-xs" value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="all">All sources</option>
          {SOURCES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        <button
          className="btn-ghost !py-1.5 text-[11px]"
          onClick={() => setScope((value) => (value === "server" ? "all" : "server"))}
          title={activeServer ? `Active server: ${activeServer.name}` : "No server selected"}
        >
          {scope === "server" ? `Scope: ${activeServer?.name ?? "no server"}` : "Scope: all servers"}
        </button>
      </div>

      <div className="mt-3 space-y-2">
        {feed.loading && !feed.data && (
          <p className="flex items-center gap-2 text-xs text-slate-400">
            <Spinner /> Loading errors…
          </p>
        )}

        {feed.error && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{feed.error}</p>
        )}

        {!feed.loading && errors.length === 0 && (
          <Empty
            title={status === "active" ? "No active problems recorded" : "Nothing in this filter"}
            hint={
              status === "active"
                ? "Errors are captured automatically from the console, API, panel, deployments and the browser. Run a diagnostic scan to check the current state; an empty list is not proof that everything is healthy."
                : "Try another severity, source or search term."
            }
            action={
              <button className="btn-primary" onClick={() => void runScan()} disabled={scanning}>
                <ScanLine className="h-3.5 w-3.5" /> Run diagnostic scan
              </button>
            }
          />
        )}

        {errors.map((error) => (
          <article
            key={error.id}
            className="panel cv-auto-tall cursor-pointer px-3.5 py-3 transition hover:border-ink-600/80"
            onClick={() => setOpenId(error.id)}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${SEVERITY_STYLE[error.severity]}`}>
                {error.severity}
              </span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${STATUS_STYLE[error.status]}`}>{error.status}</span>
              <span className="rounded-full border border-ink-600/70 bg-ink-800/60 px-2 py-0.5 text-[10px] text-slate-300">{error.code}</span>
              <span className="rounded-full border border-ink-700 px-2 py-0.5 text-[10px] text-slate-400">{error.source}</span>
              <span className="ml-auto text-[10px] text-slate-500">
                {error.occurrences}× · {relative(error.lastSeenAt)}
              </span>
            </div>

            <h3 className="mt-1.5 text-[13px] font-medium text-slate-100">{error.title}</h3>
            <p className="mono mt-1 line-clamp-2 break-words text-[11px] text-slate-400">{error.message}</p>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-slate-500">
              {error.filePath && (
                <span className="mono truncate">
                  {error.filePath}
                  {error.line ? `:${error.line}` : ""}
                </span>
              )}
              {error.endpoint && (
                <span className="mono truncate">
                  {error.httpMethod ? `${error.httpMethod} ` : ""}
                  {error.endpoint}
                  {error.httpStatus ? ` → ${error.httpStatus}` : ""}
                </span>
              )}
              {error.functionName && <span>fn {error.functionName}</span>}
              <span className="ml-auto flex items-center gap-1 text-accent-soft">
                Diagnose <ChevronRight className="h-3 w-3" />
              </span>
            </div>
          </article>
        ))}
      </div>

      <Modal
        open={Boolean(open)}
        onClose={() => {
          setOpenId(null);
          setConfirmTyped("");
          setPatchOpen(false);
        }}
        wide
        title={open?.title ?? "Error"}
        subtitle={open ? `${open.code} · ${open.severity} · ${open.source}` : undefined}
        footer={
          open ? (
            <>
              {open.filePath && (
                <Link className="btn-ghost" href={editorHref(open.filePath, open.line)}>
                  <Code2 className="h-3.5 w-3.5" /> Open in Code Editor
                </Link>
              )}
              {open.filePath && (
                <Link className="btn-ghost" href={explorerHref(open.filePath)}>
                  <FolderOpen className="h-3.5 w-3.5" /> Project Explorer
                </Link>
              )}
              {open.status === "active" ? (
                <button className="btn-primary" onClick={() => setPendingResolve(open)} disabled={busy}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> Mark resolved
                </button>
              ) : (
                <button className="btn-ghost" onClick={() => void setErrorStatus(open, "active")} disabled={busy}>
                  Reopen
                </button>
              )}
            </>
          ) : null
        }
      >
        {open && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${SEVERITY_STYLE[open.severity]}`}>{open.severity}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${STATUS_STYLE[open.status]}`}>{open.status}</span>
              <span className="rounded-full border border-ink-600/70 bg-ink-800/60 px-2 py-0.5 text-[10px] text-slate-300">{open.code}</span>
              <span className="rounded-full border border-ink-700 px-2 py-0.5 text-[10px] text-slate-400">{open.source}</span>
              {open.resolvedAt && <span className="rounded-full border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-200">resolved {relative(open.resolvedAt)}</span>}
            </div>

            <div>
              <p className="label">Exact message</p>
              <pre className="code-scroll mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-ink-700/60 bg-ink-950/80 px-3 py-2 text-[11.5px] text-slate-300">
                {open.message}
              </pre>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="First seen" value={datetime(open.firstSeenAt)} />
              <Field label="Last seen" value={`${datetime(open.lastSeenAt)} (${open.occurrences}×)`} />
              <Field label="Component" value={open.source} />
              <Field label="Affected file" value={open.filePath ? `${open.filePath}${open.line ? `:${open.line}${open.column ? `:${open.column}` : ""}` : ""}` : "not identified"} mono />
              <Field label="Function" value={open.functionName ?? "not identified"} mono />
              <Field
                label="Endpoint"
                value={open.endpoint ? `${open.httpMethod ?? "ANY"} ${open.endpoint}${open.httpStatus ? ` → ${open.httpStatus}` : ""}` : "not applicable"}
                mono
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-rose-200/80">Root cause</p>
                <p className="mt-1 text-[12px] leading-relaxed text-rose-100/90">{open.rootCause}</p>
              </div>
              <div className="rounded-lg border border-ink-700/60 bg-ink-900/50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Why it happened</p>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-300">{open.why}</p>
              </div>
            </div>

            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-200/80">Recommended solution</p>
              <p className="mt-1 text-[12px] leading-relaxed text-emerald-100/90">{open.recommendation}</p>
            </div>

            {open.evidence.length > 0 && (
              <div>
                <p className="label">Evidence captured</p>
                <ul className="mt-1 space-y-1">
                  {open.evidence.map((line, index) => (
                    <li key={index} className="mono break-words rounded border border-ink-700/60 bg-ink-950/60 px-2 py-1 text-[10.5px] text-slate-400">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-xl border border-ink-700/70 bg-ink-950/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <Wrench className="h-3 w-3" /> Repair assistance
                </p>
                {open.repair?.authority && (
                  <Badge tone={open.repair.authority === "safe" ? "good" : "warn"}>
                    {open.repair.authority === "safe" ? "safe · reversible" : "needs owner approval"}
                  </Badge>
                )}
              </div>

              {!open.repairKind ? (
                <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
                  No automated repair is offered for this problem class. DARKNOTE will not delete files, touch session data, expose credentials or rewrite working code on its own.
                </p>
              ) : open.repair?.proposal ? (
                <RepairView
                  proposal={open.repair.proposal}
                  busy={busy}
                  typed={confirmTyped}
                  onTyped={setConfirmTyped}
                  onApply={() => void applyRepair(open)}
                  onDiscard={() => void discardRepair(open)}
                />
              ) : (
                <div className="mt-2 space-y-2">
                  <p className="text-[12px] leading-relaxed text-slate-400">
                    DARKNOTE can prepare this repair ({open.repairKind}) for review. It creates a proposal and — where a file is involved — a backup and a validation result before anything is written.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary !py-1.5 text-xs" onClick={() => void prepareRepair(open)} disabled={busy}>
                      {busy ? <Spinner /> : <Wrench className="h-3.5 w-3.5" />} Prepare proposal
                    </button>
                    {open.repairKind === "file_patch" && (
                      <button className="btn-ghost !py-1.5 text-xs" onClick={() => setPatchOpen((value) => !value)}>
                        Attach a patch
                      </button>
                    )}
                  </div>
                  {patchOpen && (
                    <div className="space-y-2 rounded-lg border border-ink-700/60 bg-ink-900/40 p-2.5">
                      <input className="field mono text-xs" placeholder="/path/in/project.js" value={patchPath} onChange={(event) => setPatchPath(event.target.value)} />
                      <textarea
                        className="field mono min-h-[140px] text-xs"
                        placeholder="Proposed file content (validated before it can be deployed)"
                        value={patchContent}
                        onChange={(event) => setPatchContent(event.target.value)}
                      />
                      <button
                        className="btn-primary !py-1 text-xs"
                        disabled={!patchPath.trim() || !patchContent.trim() || busy}
                        onClick={() => void prepareRepair(open, { path: patchPath, content: patchContent })}
                      >
                        Validate & propose
                      </button>
                    </div>
                  )}
                </div>
              )}

              {open.repair?.state === "applied" && open.repair?.proposal?.appliedAt && (
                <p className="mt-2 text-[11px] text-emerald-300">
                  Applied {datetime(open.repair.proposal.appliedAt)} by {open.repair.proposal.appliedBy}.
                </p>
              )}
            </div>

            {open.context && Object.keys(open.context).length > 0 && (
              <details className="text-[11px] text-slate-500">
                <summary className="cursor-pointer select-none">Captured context</summary>
                <pre className="code-scroll mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded border border-ink-700/60 bg-ink-950/70 p-2 text-[10.5px]">
                  {JSON.stringify(open.context, null, 2)}
                </pre>
              </details>
            )}

            {open.status === "resolved" && (
              <p className="text-[11px] text-slate-500">
                Marked resolved {relative(open.resolvedAt)} by {open.resolvedBy ?? "unknown"}
                {open.resolutionNote ? ` — “${open.resolutionNote}”` : ""}. A recurrence reopens it automatically.
              </p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingResolve)}
        onClose={() => setPendingResolve(null)}
        onConfirm={() => pendingResolve && void setErrorStatus(pendingResolve, "resolved")}
        busy={busy}
        title="Mark this problem resolved?"
        description={
          <>
            Only mark it resolved if the cause is actually fixed. If it happens again, the next capture reopens the record and increments its occurrence count.
          </>
        }
        confirmLabel="Mark resolved"
      />
    </>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-ink-700/60 bg-ink-900/40 px-2.5 py-2">
      <p className="label">{label}</p>
      <p className={`mt-0.5 break-words text-[11.5px] text-slate-200 ${mono ? "mono" : ""}`}>{value}</p>
    </div>
  );
}

function RepairView({
  proposal,
  busy,
  typed,
  onTyped,
  onApply,
  onDiscard,
}: {
  proposal: RepairProposal;
  busy: boolean;
  typed: string;
  onTyped: (value: string) => void;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const expected = expectedConfirmation(proposal.kind);
  const blocked = proposal.state === "blocked";
  return (
    <div className="mt-2 space-y-2.5">
      <div className="rounded-lg border border-ink-700/60 bg-ink-900/40 p-2.5">
        <p className="text-[12px] font-medium text-slate-100">{proposal.summary}</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">{proposal.risk}</p>
        {proposal.path && <p className="mono mt-1 break-words text-[10.5px] text-slate-500">{proposal.path}</p>}
      </div>

      <ol className="space-y-1.5">
        {proposal.steps.map((step) => {
          const Icon = step.state === "done" ? CheckCircle2 : step.state === "blocked" ? XCircle : CircleDashed;
          const tone = step.state === "done" ? "text-emerald-300" : step.state === "blocked" ? "text-rose-300" : "text-slate-500";
          return (
            <li key={step.key} className="flex items-start gap-2 text-[11.5px]">
              <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
              <span>
                <span className="text-slate-200">{step.label}</span>
                <span className="text-slate-500"> — {step.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {proposal.diff && (
        <pre className="code-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-ink-700/60 bg-ink-950/80 p-2 text-[10.5px] text-slate-400">
          {proposal.diff}
        </pre>
      )}

      {proposal.validationErrors?.length ? (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-200">
          Validation: {proposal.validationErrors.join("; ")}
        </p>
      ) : null}

      {proposal.state === "applied" ? (
        <p className="flex items-center gap-1.5 text-[11.5px] text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5" /> Applied. The audit trail records who authorised it.
        </p>
      ) : blocked ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-100">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This proposal is blocked until the reason above is resolved. Nothing was written.
        </p>
      ) : (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
          <p className="flex items-center gap-1.5 text-[11px] text-amber-200">
            <ShieldAlert className="h-3.5 w-3.5" />
            {proposal.authority === "approval"
              ? "This changes production. Owner or admin authorisation is required."
              : "Safe, reversible operation — confirm to run it."}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              className="field mono max-w-[220px] !py-1 text-xs"
              placeholder={`Type ${expected}`}
              value={typed}
              onChange={(event) => onTyped(event.target.value)}
            />
            <button className="btn-primary !py-1.5 text-xs" onClick={onApply} disabled={busy || typed.trim().toUpperCase() !== expected}>
              {busy ? <Spinner /> : <Wrench className="h-3.5 w-3.5" />} Authorise & apply
            </button>
            <button className="btn-ghost !py-1.5 text-xs" onClick={onDiscard} disabled={busy}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
