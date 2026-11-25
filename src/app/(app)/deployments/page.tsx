"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight, History, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner, Stat, Status } from "@/components/ui";
import { apiGet, apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { datetime, relative } from "@/lib/format";

type Row = {
  id: string;
  publicId: string;
  status: string;
  message: string | null;
  fileCount: number;
  restartRequired: boolean;
  restartIssued: boolean;
  healthOk: boolean | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  author: string | null;
  files: number;
  logs: number;
};

type Detail = {
  deployment: Row & {
    changedPaths?: unknown;
    server: { id: string; name: string };
    files: Array<{ path: string; action: string; beforeSha: string | null; afterSha: string | null; size: number }>;
    logs: Array<{ level: string; message: string; at: string }>;
  };
};

export default function DeploymentsPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const list = useApi<{ deployments: Row[]; policy: string | null }>(
    activeId ? `/api/deployments?serverId=${activeId}` : null,
    { refreshMs: 20_000 },
  );
  const [detail, setDetail] = useState<Detail["deployment"] | null>(null);
  const [rollback, setRollback] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (id: string) => {
    try {
      const data = await apiGet<Detail>(`/api/deployments/${id}`);
      setDetail(data.deployment);
    } catch (error) {
      push(errorMessage(error), "error");
    }
  };

  const doRollback = async () => {
    if (!rollback) return;
    setBusy(true);
    try {
      await apiPost(`/api/deployments/${rollback.id}`, { action: "rollback" });
      push(`Rolled back ${rollback.publicId}`, "ok");
      setRollback(null);
      setDetail(null);
      await list.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  const deployments = list.data?.deployments ?? [];
  const succeeded = deployments.filter((row) => row.status === "SUCCEEDED").length;
  const failed = deployments.filter((row) => row.status === "FAILED").length;

  return (
    <>
      <PageHeader
        title="Deployments"
        description="Every approved write: backup, hash verification, restart and startup health — with rollback per deployment."
        actions={<Link href="/editor" className="btn-primary">Open editor</Link>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Deployments" value={deployments.length} />
        <Stat label="Succeeded" value={succeeded} tone="good" />
        <Stat label="Failed" value={failed} tone={failed ? "bad" : "default"} />
        <Stat label="Restart policy" value={list.data?.policy ? "auto" : "—"} hint={list.data?.policy ?? "per server policy"} />
      </div>

      <Panel className="mt-4" bodyClassName="!px-0 !py-0">
        {deployments.length === 0 ? (
          <div className="px-4 py-6">
            <Empty title="No deployments yet" hint="Save a draft in the editor and deploy it to see the pipeline run." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-ink-750/70 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2">Deployment</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Files</th>
                  <th className="px-2 py-2">Restart</th>
                  <th className="px-2 py-2">Author</th>
                  <th className="px-2 py-2">When</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {deployments.map((row) => (
                  <tr key={row.id} className="table-row cursor-pointer" onClick={() => void open(row.id)}>
                    <td className="px-4 py-2">
                      <p className="mono text-slate-200">{row.publicId}</p>
                      <p className="max-w-[280px] truncate text-[10px] text-slate-500">{row.message ?? "no description"}</p>
                    </td>
                    <td className="px-2 py-2"><Status status={row.status} /></td>
                    <td className="px-2 py-2 text-slate-400">{row.files}</td>
                    <td className="px-2 py-2">
                      {row.restartIssued ? <Badge tone="cyber">restarted</Badge> : row.restartRequired ? <Badge tone="warn">pending</Badge> : <Badge>skipped</Badge>}
                    </td>
                    <td className="px-2 py-2 text-slate-400">{row.author ?? "—"}</td>
                    <td className="px-2 py-2 text-slate-500">{relative(row.startedAt)}</td>
                    <td className="px-2 py-2 text-right"><ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-600" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        wide
        title={detail?.publicId ?? "Deployment"}
        subtitle={detail ? `${datetime(detail.startedAt)} · ${detail.author ?? "unknown"}` : ""}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDetail(null)}>Close</button>
            {detail && detail.status !== "ROLLED_BACK" && (
              <button className="btn-danger" onClick={() => setRollback(detail as unknown as Row)}>
                <RotateCcw className="h-3.5 w-3.5" /> Rollback this deployment
              </button>
            )}
          </>
        }
      >
        {detail && (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Status status={detail.status} />
              {detail.healthOk === true && <Badge tone="good">startup healthy</Badge>}
              {detail.healthOk === false && <Badge tone="bad">startup unhealthy</Badge>}
              {detail.restartIssued && <Badge tone="cyber">restart issued</Badge>}
            </div>
            {detail.error && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">{detail.error}</p>
            )}

            <div>
              <p className="label mb-1">Files</p>
              <ul className="divide-y divide-ink-750/60 rounded-lg border border-ink-700/60">
                {detail.files.map((file) => (
                  <li key={file.path} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="mono min-w-0 flex-1 truncate text-[11px] text-slate-300">{file.path}</span>
                    <Badge>{file.action}</Badge>
                    <span className="mono text-[10px] text-slate-500">{file.afterSha?.slice(0, 8) ?? "deleted"}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="label mb-1">Pipeline log</p>
              <pre className="code-scroll max-h-64 overflow-auto rounded-lg border border-ink-700/70 bg-ink-950/80 px-3 py-2 text-[11px]">
                {detail.logs.map((log) => `${log.at.slice(11, 19)} [${log.level}] ${log.message}`).join("\n") || "no log lines"}
              </pre>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={rollback !== null}
        onClose={() => setRollback(null)}
        onConfirm={doRollback}
        busy={busy}
        danger
        title="Roll back this deployment?"
        description={
          <div className="space-y-2">
            <p>Only the files changed by <span className="mono">{rollback?.publicId}</span> are restored to their pre-deployment content.</p>
            <p className="text-[11px] text-slate-500">
              WhatsApp sessions, databases and unrelated files are untouched. The current content is backed up first, so the
              rollback can itself be undone.
            </p>
          </div>
        }
        confirmLabel="Rollback"
        requireText="ROLLBACK"
      />

      {list.loading && <p className="mt-2 flex items-center gap-2 text-[11px] text-slate-500"><Spinner /> Loading deployment history…</p>}
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-600">
        <History className="h-3 w-3" /> Health is judged from live console output after the restart, not from file writes.
      </p>
    </>
  );
}
