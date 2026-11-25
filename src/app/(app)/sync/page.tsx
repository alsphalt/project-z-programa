"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, ArrowLeftRight, FileDiff, RefreshCw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { GitHubSyncStatus } from "@/components/github/sync-status";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner, Stat, Status } from "@/components/ui";
import { apiDelete, apiGet, apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { datetime, relative } from "@/lib/format";

type SyncPayload = {
  state: string;
  method: string;
  methodNote: string;
  lastScan: {
    id: string;
    status: string;
    trigger: string;
    method: string;
    startedAt: string;
    finishedAt: string | null;
    added: number;
    changed: number;
    deleted: number;
    scanned: number;
    failed: number;
    conflicts: number;
    message: string | null;
  } | null;
  pending: { drafts: number; conflicts: number; events: number; versions: number };
  drafts: Array<{ path: string; updatedAt: string; baseSha: string | null }>;
  conflicts: Array<{ id: string; path: string; createdAt: string; baseSha: string | null; remoteSha: string | null }>;
  lastDeployment: { publicId: string; status: string; startedAt: string } | null;
};

type ConflictDetail = {
  conflict: { path: string; remoteSha: string | null; baseSha: string | null; note: string | null };
  remote: string | null;
  local: string | null;
};

export default function SyncPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const data = useApi<SyncPayload>(activeId ? `/api/servers/${activeId}/sync` : null, { refreshMs: 25_000 });
  const [syncing, setSyncing] = useState(false);
  const [compare, setCompare] = useState<ConflictDetail | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const result = await apiPost<{ summary: { added: string[]; changed: string[]; deleted: string[]; failed: unknown[] } }>(
        `/api/servers/${activeId}/sync`,
      );
      push(
        `Sync complete — ${result.summary.added.length} added, ${result.summary.changed.length} changed, ${result.summary.deleted.length} deleted`,
        "ok",
      );
      await data.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setSyncing(false);
    }
  };

  const openConflict = async (conflict: SyncPayload["conflicts"][number]) => {
    try {
      const detail = await apiGet<ConflictDetail>(
        `/api/servers/${activeId}/sync/conflict?path=${encodeURIComponent(conflict.path)}`,
      );
      setCompare(detail);
    } catch (error) {
      push(errorMessage(error), "error");
    }
  };

  const resolveKeepRemote = async (path: string) => {
    setBusy(true);
    try {
      await apiDelete(`/api/drafts?serverId=${activeId}&path=${encodeURIComponent(path)}`);
      push("Local draft discarded — production version kept", "ok");
      setCompare(null);
      await data.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const resolveKeepMine = async (path: string) => {
    setBusy(true);
    try {
      const draft = await apiGet<{ draft: { content: string; baseSha: string | null } | null }>(
        `/api/drafts?serverId=${activeId}&path=${encodeURIComponent(path)}`,
      );
      if (!draft.draft) throw new Error("No local draft found for this file");
      const result = await apiPost<{ deployment: { publicId: string; status: string; error: string | null } }>("/api/deployments", {
        serverId: activeId,
        files: [{ path, content: draft.draft.content, expectedSha: null }],
        message: `Conflict resolution: keep local draft for ${path}`,
      });
      if (result.deployment.status === "SUCCEEDED") push(`Kept local version in ${result.deployment.publicId}`, "ok");
      else push(`${result.deployment.publicId}: ${result.deployment.error}`, "error");
      await apiDelete(`/api/drafts?serverId=${activeId}&path=${encodeURIComponent(path)}`).catch(() => undefined);
      setCompare(null);
      await data.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  return (
    <>
      <PageHeader
        title="Synchronization"
        description="Reconciles the index, drafts and production. Nothing here overwrites remote changes without your explicit choice."
        actions={
          <button className="btn-primary" onClick={syncNow} disabled={syncing}>
            {syncing ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Sync now
          </button>
        }
      />

      {/* GitHub ↔ DARKNOTE. Reads persisted state from the sync engine only. */}
      <div className="mb-4">
        <GitHubSyncStatus />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-ink-700/60 bg-ink-900/50 px-3 py-2 text-[11px]">
        <Status status={data.data?.state ?? "UNKNOWN"} />
        <span className="text-slate-500">method:</span>
        <span className="text-slate-300">{data.data?.method ?? "polling"}</span>
        <span className="ml-auto text-slate-600">{data.data?.pending.events ?? 0} unhandled remote events</span>
      </div>

      {data.data?.methodNote && (
        <p className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
          {data.data.methodNote}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Last scan" value={relative(data.data?.lastScan?.finishedAt ?? data.data?.lastScan?.startedAt)} hint={data.data?.lastScan ? datetime(data.data.lastScan.startedAt) : "never"} />
        <Stat label="Pending drafts" value={data.data?.pending.drafts ?? 0} tone={data.data?.pending.drafts ? "warn" : "good"} />
        <Stat label="Open conflicts" value={data.data?.pending.conflicts ?? 0} tone={data.data?.pending.conflicts ? "bad" : "good"} />
        <Stat label="Tracked versions" value={data.data?.pending.versions ?? 0} hint="recoverable snapshots" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel
          title="Remote changes detected"
          subtitle="Conflicts appear when production moved while a draft pointed at an older hash"
        >
          {data.data?.conflicts.length ? (
            <ul className="space-y-2">
              {data.data.conflicts.map((conflict) => (
                <li key={conflict.id} className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="mono min-w-0 flex-1 truncate text-[11px] text-slate-200">{conflict.path}</p>
                    <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void openConflict(conflict)}>
                      <FileDiff className="h-3 w-3" /> Compare
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">
                    base {conflict.baseSha?.slice(0, 10) ?? "—"} → remote {conflict.remoteSha?.slice(0, 10) ?? "—"} · {relative(conflict.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No conflicts" hint="Production and your drafts agree on every tracked hash." />
          )}
        </Panel>

        <Panel title="Local drafts" subtitle="Drafts never touch production until deployed">
          {data.data?.drafts.length ? (
            <ul className="divide-y divide-ink-750/60">
              {data.data.drafts.map((draft) => (
                <li key={draft.path} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="mono truncate text-[11px] text-slate-200">{draft.path}</p>
                    <p className="text-[10px] text-slate-500">base {draft.baseSha?.slice(0, 10) ?? "none"} · {relative(draft.updatedAt)}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Link href={`/editor?path=${encodeURIComponent(draft.path)}`} className="btn-ghost !px-2 !py-1 text-[10px]">Open</Link>
                    <button className="btn-ghost !px-2 !py-1 text-[10px] text-rose-300" onClick={() => setConfirmDiscard(draft.path)}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No drafts" hint="Edits you save without deploying land here." />
          )}
        </Panel>
      </div>

      <Panel className="mt-4" title="Sync history" subtitle="Every reconciliation is recorded with counts">
        {data.data?.lastScan ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <dl className="space-y-1.5 text-[11px]">
              <Row label="Status" value={<Status status={data.data.lastScan.status} />} />
              <Row label="Trigger" value={data.data.lastScan.trigger} />
              <Row label="Entries walked" value={String(data.data.lastScan.scanned)} />
              <Row label="Added" value={String(data.data.lastScan.added)} />
              <Row label="Changed" value={String(data.data.lastScan.changed)} />
              <Row label="Deleted" value={String(data.data.lastScan.deleted)} />
              <Row label="Failed reads" value={String(data.data.lastScan.failed)} />
            </dl>
            <div className="rounded-lg border border-ink-700/60 bg-ink-950/50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
              <p className="flex items-center gap-1.5 text-slate-300"><ArrowLeftRight className="h-3 w-3" /> {data.data.lastScan.method}</p>
              <p className="mt-1">Started {datetime(data.data.lastScan.startedAt)}</p>
              <p>Finished {datetime(data.data.lastScan.finishedAt)}</p>
              {data.data.lastScan.message && <p className="mt-1 text-amber-200">{data.data.lastScan.message}</p>}
              {data.data.lastDeployment && (
                <p className="mt-2 flex items-center gap-1.5">
                  Last deploy <span className="mono text-slate-300">{data.data.lastDeployment.publicId}</span>
                  <Status status={data.data.lastDeployment.status} />
                </p>
              )}
            </div>
          </div>
        ) : (
          <Empty title="No sync has run yet" hint="Press SYNC NOW to reconcile the index with production." action={<button className="btn-primary" onClick={syncNow}><RefreshCw className="h-3.5 w-3.5" /> Sync now</button>} />
        )}
      </Panel>

      <ConfirmDialog
        open={confirmDiscard !== null}
        onClose={() => setConfirmDiscard(null)}
        onConfirm={async () => {
          if (!confirmDiscard) return;
          setBusy(true);
          try {
            await apiDelete(`/api/drafts?serverId=${activeId}&path=${encodeURIComponent(confirmDiscard)}`);
            push("Draft discarded", "ok");
            setConfirmDiscard(null);
            await data.refresh();
          } catch (error) {
            push(errorMessage(error), "error");
          } finally {
            setBusy(false);
          }
        }}
        busy={busy}
        danger
        title="Discard this draft?"
        description={<span className="mono text-[11px]">{confirmDiscard}</span>}
        confirmLabel="Discard draft"
      />

      <Modal
        open={compare !== null}
        onClose={() => setCompare(null)}
        wide
        title="Conflict comparison"
        subtitle={compare?.conflict.path}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setCompare(null)}>Close</button>
            <button className="btn-ghost" disabled={busy} onClick={() => compare && void resolveKeepRemote(compare.conflict.path)}>
              Keep remote (discard draft)
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => compare && void resolveKeepMine(compare.conflict.path)}>
              {busy && <Spinner />} Keep my version
            </button>
          </>
        }
      >
        <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          Production changed after your draft was created. Both versions are preserved here; choosing either is a deliberate
          deployment with a backup.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="label mb-1">Production (remote) · {compare?.conflict.remoteSha?.slice(0, 10)}</p>
            <pre className="code-scroll max-h-[40vh] overflow-auto rounded-lg border border-ink-700/70 bg-ink-950/80 px-3 py-2 text-slate-300">
              {compare?.remote ?? "— production content was not captured —"}
            </pre>
          </div>
          <div>
            <p className="label mb-1">Your draft · base {compare?.conflict.baseSha?.slice(0, 10)}</p>
            <pre className="code-scroll max-h-[40vh] overflow-auto rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-slate-300">
              {compare?.local ?? "— no local copy stored —"}
            </pre>
          </div>
        </div>
      </Modal>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-200">{value}</dd>
    </div>
  );
}
