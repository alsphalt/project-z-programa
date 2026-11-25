"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitBranch,
  GitCommitHorizontal,
  Github,
  History,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { relative } from "@/lib/format";

/**
 * GITHUB ↔ DARKNOTE status.
 *
 * Every value here is read from the server (`/api/github/sync/status`), which in
 * turn reads persisted state: the last applied commit, the queued pushes, the
 * open conflicts and the webhook deliveries that actually arrived. Nothing in
 * this card is optimistic — "FULLY SYNCHRONIZED" only appears when the stored
 * base commit, the queue and the conflict table all agree.
 */

type SyncState = "disconnected" | "synced" | "pending" | "syncing" | "conflict" | "failed";

type StatusPayload = {
  state: SyncState;
  direction: "none" | "panel→github" | "github→panel" | "both";
  connection: {
    connected: boolean;
    login: string | null;
    repo: string | null;
    branch: string | null;
    autoSync: boolean;
    syncDelaySeconds: number;
    lastError: string | null;
  };
  project: {
    id: string;
    name: string;
    syncStatus: string;
    syncError: string | null;
    baseCommitSha: string | null;
    lastCommitSha: string | null;
    lastCommitMessage: string | null;
    lastCommitUrl: string | null;
    lastSyncAt: string | null;
  } | null;
  pending: { queuedPushes: number; dirtyFiles: number; openConflicts: number };
  webhook: {
    configured: boolean;
    lastDelivery: { id: string; event: string; status: string; message: string | null; at: string } | null;
    failedLastHour: number;
  };
  lastEvent: { at: string; message: string } | null;
  conflicts: Array<{ id: string; path: string; reason: string; created_at: string; head_commit: string | null }>;
  recentDeliveries: Array<{
    id: string;
    event: string;
    branch: string | null;
    commit: string | null;
    status: string;
    message: string | null;
    at: string;
  }>;
};

const TONE: Record<SyncState, { pill: string; dot: string; label: string }> = {
  disconnected: { pill: "border-slate-500/40 bg-slate-500/10 text-slate-300", dot: "bg-slate-400", label: "NOT CONNECTED" },
  synced: { pill: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400", label: "FULLY SYNCHRONIZED" },
  pending: { pill: "border-amber-500/40 bg-amber-500/10 text-amber-300", dot: "bg-amber-400", label: "CHANGES PENDING" },
  syncing: { pill: "border-blue-500/40 bg-blue-500/10 text-blue-300", dot: "bg-blue-400 animate-pulse", label: "SYNCHRONIZING" },
  conflict: { pill: "border-amber-500/40 bg-amber-500/10 text-amber-200", dot: "bg-amber-400", label: "CONFLICT — ACTION NEEDED" },
  failed: { pill: "border-rose-500/40 bg-rose-500/10 text-rose-300", dot: "bg-rose-400", label: "SYNC FAILED" },
};

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function GitHubSyncStatus({ compact = false }: { compact?: boolean }) {
  const status = useApi<StatusPayload>("/api/github/sync/status", { refreshMs: 10_000 });
  const [busy, setBusy] = useState<"" | "pull" | "hook" | "conflict">("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);

  const data = status.data;
  const tone = TONE[data?.state ?? "disconnected"];

  const pull = useCallback(async () => {
    setBusy("pull");
    setMessage(null);
    try {
      const result = await apiPost<{ applied: string[]; deleted: string[]; conflicts: unknown[]; detail: string }>(
        "/api/github/sync/pull",
        {},
      );
      setMessage({
        tone: result.conflicts.length ? "error" : "ok",
        text: result.detail,
      });
      await status.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy("");
    }
  }, [status]);

  const registerHook = useCallback(async () => {
    setBusy("hook");
    setMessage(null);
    try {
      const result = await apiPost<{ url: string; updated: boolean }>("/api/github/webhook/register", {});
      setMessage({
        tone: "ok",
        text: `${result.updated ? "Updated" : "Registered"} the push webhook at ${result.url}. GitHub will now notify DARKNOTE within seconds.`,
      });
      await status.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy("");
    }
  }, [status]);

  const resolve = useCallback(
    async (id: string, resolution: "local" | "remote") => {
      setBusy("conflict");
      setMessage(null);
      try {
        await apiPost(`/api/github/conflicts/${id}`, { resolution });
        setMessage({ tone: "ok", text: `Conflict resolved (${resolution === "local" ? "kept DARKNOTE" : "took GitHub"}).` });
        await status.refresh();
      } catch (error) {
        setMessage({ tone: "error", text: errorMessage(error) });
      } finally {
        setBusy("");
      }
    },
    [status],
  );

  if (status.loading && !data) {
    return (
      <section className="panel p-4">
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading synchronization state…
        </p>
      </section>
    );
  }

  if (status.error && !data) {
    return (
      <section className="panel p-4">
        <p className="text-xs text-rose-300">Synchronization status unavailable: {status.error}</p>
      </section>
    );
  }

  if (!data) return null;

  const pending = data.pending.queuedPushes + data.pending.dirtyFiles + data.pending.openConflicts;

  return (
    <section className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-ink-600/70 bg-ink-900/70 p-1.5 text-slate-300">
            <Github className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">GITHUB ↔ DARKNOTE</h2>
            <p className="text-[10px] uppercase tracking-[0.16em] text-slate-600">Bidirectional synchronization</p>
          </div>
        </div>
        <span className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wider ${tone.pill}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {tone.label}
        </span>
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 text-[11.5px] sm:grid-cols-2">
        <Row icon={<Github className="h-3 w-3" />} label="Repository" value={data.connection.repo ?? "Not connected"} />
        <Row icon={<GitBranch className="h-3 w-3" />} label="Branch" value={data.connection.branch ?? "—"} />
        <Row
          icon={<GitCommitHorizontal className="h-3 w-3" />}
          label="Latest commit"
          value={
            data.project?.lastCommitSha ? (
              <a
                href={data.project.lastCommitUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="text-accent-soft hover:underline"
                title={data.project.lastCommitMessage ?? undefined}
              >
                {short(data.project.lastCommitSha)} {data.project.lastCommitMessage ? `— ${data.project.lastCommitMessage}` : ""}
              </a>
            ) : (
              "—"
            )
          }
        />
        <Row
          icon={<Clock className="h-3 w-3" />}
          label="Last sync"
          value={data.project?.lastSyncAt ? relative(data.project.lastSyncAt) : "Never"}
        />
        <Row label="Pending changes" value={String(pending)} />
        <Row label="Direction" value={data.direction === "none" ? "Idle" : data.direction} />
        <Row
          label="Webhook"
          value={
            data.webhook.configured
              ? data.webhook.lastDelivery
                ? `Last delivery ${relative(data.webhook.lastDelivery.at)} (${data.webhook.lastDelivery.status})`
                : "Configured, no delivery yet"
              : "Not configured — polling only"
          }
        />
        <Row label="Base commit" value={short(data.project?.baseCommitSha)} />
      </dl>

      {data.project?.syncError && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {data.project.syncError}
        </p>
      )}
      {data.connection.lastError && (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] text-rose-200">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {data.connection.lastError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void pull()} disabled={busy === "pull"} className="btn-primary !py-1.5 text-[11px]">
          {busy === "pull" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Sync now
        </button>
        <button type="button" onClick={() => setShowHistory((value) => !value)} className="btn-ghost !py-1.5 text-[11px]">
          <History className="h-3 w-3" /> Sync history
        </button>
        <button
          type="button"
          onClick={() => setShowConflicts((value) => !value)}
          disabled={!data.conflicts.length}
          className="btn-ghost !py-1.5 text-[11px] disabled:opacity-50"
        >
          <AlertTriangle className="h-3 w-3" /> Resolve conflicts{data.conflicts.length ? ` (${data.conflicts.length})` : ""}
        </button>
        <button type="button" onClick={() => void registerHook()} disabled={busy === "hook"} className="btn-ghost !py-1.5 text-[11px]">
          {busy === "hook" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Github className="h-3 w-3" />}{" "}
          {data.webhook.configured ? "Repair webhook" : "Enable webhook"}
        </button>
      </div>

      {message && (
        <p
          className={`mt-2 rounded-lg border p-2 text-[11px] ${
            message.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          {message.tone === "ok" ? <CheckCircle2 className="mr-1 inline h-3 w-3" /> : null}
          {message.text}
        </p>
      )}

      {showConflicts && data.conflicts.length > 0 && (
        <ul className="mt-3 space-y-2">
          {data.conflicts.map((conflict) => (
            <li key={conflict.id} className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2">
              <p className="mono break-all text-[11px] text-amber-100">{conflict.path}</p>
              <p className="text-[10px] text-amber-200/80">
                {conflict.reason.replaceAll("_", " ")} · since {relative(conflict.created_at)}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={busy === "conflict"}
                  onClick={() => void resolve(conflict.id, "local")}
                  className="rounded border border-ink-600/70 px-2 py-1 text-[10px] text-slate-200 hover:border-accent/50"
                >
                  Keep DARKNOTE version
                </button>
                <button
                  type="button"
                  disabled={busy === "conflict"}
                  onClick={() => void resolve(conflict.id, "remote")}
                  className="rounded border border-ink-600/70 px-2 py-1 text-[10px] text-slate-200 hover:border-accent/50"
                >
                  Take GitHub version
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showHistory && (
        <div className="mt-3 space-y-2">
          {data.lastEvent && (
            <p className="rounded-lg border border-ink-700/70 bg-ink-900/60 p-2 text-[11px] text-slate-300">
              {relative(data.lastEvent.at)} — {data.lastEvent.message}
            </p>
          )}
          {data.recentDeliveries.length ? (
            <ul className="space-y-1">
              {data.recentDeliveries.map((delivery) => (
                <li key={delivery.id} className="flex items-start justify-between gap-2 text-[10.5px] text-slate-400">
                  <span className="min-w-0 truncate">
                    {delivery.event} {delivery.branch ? `· ${delivery.branch}` : ""}{" "}
                    {delivery.commit ? `· ${short(delivery.commit)}` : ""} — {delivery.message ?? delivery.status}
                  </span>
                  <span className="shrink-0 text-slate-600">{relative(delivery.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[10.5px] text-slate-500">
              No webhook deliveries recorded yet. Changes made on GitHub are still picked up by the 10-second poll.
            </p>
          )}
        </div>
      )}

      {compact ? null : (
        <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
          GitHub → DARKNOTE: webhook delivery plus a 10-second fallback poll. DARKNOTE → GitHub: {data.connection.syncDelaySeconds}s
          debounce after the last save, then a commit that is read back before it is reported as pushed.
        </p>
      )}
    </section>
  );
}

function Row({ icon, label, value }: { icon?: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-600">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0 truncate text-slate-200">{value}</dd>
    </>
  );
}
