"use client";

import Link from "next/link";
import { useState } from "react";
import { Archive, Database, Download, HardDrive, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner, Stat } from "@/components/ui";
import { apiPost, download, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { bytes, datetime, relative } from "@/lib/format";

type Payload = {
  storage: { driver: string; ready: boolean; detail: string; note: string };
  panelBackups: Array<{ uuid: string; name: string; bytes: number; createdAt: string | null; completedAt: string | null; isSuccessful: boolean; isLocked: boolean }>;
  panelError: string | null;
  versions: Array<{ id: string; path: string; version: number; sha256: string; size: number; source: string; message: string | null; createdAt: string; author: string | null }>;
  objects: Array<{ id: string; storage: string; key: string; size: number; sha256: string | null; createdAt: string }>;
  deployments: Array<{ publicId: string; status: string; startedAt: string; fileCount: number }>;
};

type VersionDetail = {
  version: { path: string; version: number; sha256: string; createdAt: string; source: string; message: string | null };
  content: string;
  current: { content: string; sha256: string } | null;
  identical: boolean;
};

export default function BackupsPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const data = useApi<Payload>(activeId ? `/api/backups?serverId=${activeId}` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("darknote-manual");
  const [restore, setRestore] = useState<Payload["versions"][number] | null>(null);
  const [detail, setDetail] = useState<VersionDetail | null>(null);

  const createBackup = async () => {
    setBusy("create");
    try {
      await apiPost("/api/backups", { serverId: activeId, action: "panel-backup", name });
      push("Panel backup requested — it builds in the background", "ok");
      await data.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const doRestore = async () => {
    if (!restore) return;
    setBusy("restore");
    try {
      const result = await apiPost<{ deployment: { publicId: string; status: string; error: string | null } }>("/api/versions", {
        serverId: activeId,
        versionId: restore.id,
        message: `Restore ${restore.path} to v${restore.version}`,
      });
      if (result.deployment.status === "SUCCEEDED") push(`Restored in ${result.deployment.publicId}`, "ok");
      else push(`${result.deployment.publicId}: ${result.deployment.error}`, "error");
      setRestore(null);
      await data.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const openVersion = async (id: string) => {
    try {
      const result = await fetch(`/api/versions?serverId=${activeId}&id=${id}`, { credentials: "same-origin" }).then((res) => res.json());
      if (result?.error) throw new Error(result.error.message);
      setDetail(result);
    } catch (error) {
      push(errorMessage(error), "error");
    }
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  return (
    <>
      <PageHeader
        title="Backups & Versions"
        description="Every deploy, delete and restore leaves a recoverable snapshot. Panel backups handle whole-server snapshots."
        actions={
          <>
            <input className="field !w-40 !py-1.5 text-xs" value={name} onChange={(event) => setName(event.target.value)} />
            <button className="btn-primary" onClick={createBackup} disabled={busy !== null}>
              {busy === "create" ? <Spinner /> : <Archive className="h-3.5 w-3.5" />} Create panel backup
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="File versions" value={data.data?.versions.length ?? 0} tone="accent" />
        <Stat label="Encrypted objects" value={data.data?.objects.length ?? 0} />
        <Stat label="Panel backups" value={data.data?.panelBackups.length ?? 0} hint={data.data?.panelError ?? "from the panel"} />
        <Stat label="Storage" value={data.data?.storage.driver ?? "—"} hint={data.data?.storage.ready ? "ready" : "not ready"} tone={data.data?.storage.ready ? "good" : "bad"} />
      </div>

      {data.data && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-ink-700/60 bg-ink-900/50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          <HardDrive className="mt-0.5 h-3 w-3 shrink-0" />
          {data.data.storage.note} · {data.data.storage.detail}
        </p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="File version history" subtitle="Content is recoverable; secrets are never stored in version history">
          {data.data?.versions.length ? (
            <ul className="divide-y divide-ink-750/60">
              {data.data.versions.map((version) => (
                <li key={version.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="mono truncate text-[11px] text-slate-200">{version.path}</p>
                    <p className="text-[10px] text-slate-500">
                      v{version.version} · {bytes(version.size)} · {version.source} · {relative(version.createdAt)}
                      {version.author ? ` · ${version.author}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void openVersion(version.id)}>Diff</button>
                    <button
                      className="btn-ghost !px-2 !py-1 text-[10px]"
                      onClick={() => void download(`/api/files/download?serverId=${activeId}&mode=version&versionId=${version.id}`).catch((error) => push(errorMessage(error), "error"))}
                    >
                      <Download className="h-3 w-3" />
                    </button>
                    <button className="btn-ghost !px-2 !py-1 text-[10px] text-amber-300" onClick={() => setRestore(version)}>
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No versions yet" hint="The first deploy or delete creates one." />
          )}
        </Panel>

        <Panel title="Panel backups" subtitle="Full-server snapshots created on Pterodactyl" >
          {data.data?.panelError && (
            <p className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
              {data.data.panelError}
            </p>
          )}
          {data.data?.panelBackups.length ? (
            <ul className="divide-y divide-ink-750/60">
              {data.data.panelBackups.map((backup) => (
                <li key={backup.uuid} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] text-slate-200">{backup.name}</p>
                    <p className="text-[10px] text-slate-500">
                      {bytes(backup.bytes)} · {relative(backup.completedAt ?? backup.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {backup.isSuccessful ? <Badge tone="good">ready</Badge> : <Badge tone="warn">building</Badge>}
                    <a className="btn-ghost !px-2 !py-1 text-[10px]" href={`/api/backups/download?serverId=${activeId}&uuid=${backup.uuid}`}>
                      <Download className="h-3 w-3" />
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            !data.data?.panelError && <Empty title="No panel backups" hint="Create one above. Pterodactyl builds it asynchronously." />
          )}
        </Panel>
      </div>

      <Panel className="mt-4" title="Recent deployments" subtitle="Each entry links to its own rollback">
        {data.data?.deployments.length ? (
          <ul className="divide-y divide-ink-750/60">
            {data.data.deployments.map((deployment) => (
              <li key={deployment.publicId} className="flex items-center justify-between gap-2 py-1.5 text-[11px]">
                <span className="mono text-slate-200">{deployment.publicId}</span>
                <span className="text-slate-500">{deployment.fileCount} files · {relative(deployment.startedAt)}</span>
                <span className="text-slate-400">{deployment.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No deployments recorded" />
        )}
      </Panel>

      <ConfirmDialog
        open={restore !== null}
        onClose={() => setRestore(null)}
        onConfirm={doRestore}
        busy={busy === "restore"}
        title={`Restore version ${restore?.version ?? ""}?`}
        description={
          <div className="space-y-2">
            <p className="mono text-[11px]">{restore?.path}</p>
            <p>Production is overwritten with this snapshot through the normal deployment pipeline: current content is backed up, the write is hash-verified and the bot restarts.</p>
          </div>
        }
        confirmLabel="Restore & restart"
        requireText="RESTORE"
      />

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        wide
        title={`Version diff · v${detail?.version.version ?? ""}`}
        subtitle={detail?.version.path}
        footer={<button className="btn-ghost" onClick={() => setDetail(null)}>Close</button>}
      >
        {detail && (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500">
              {detail.identical ? "This version matches production byte for byte." : "Difference between the archived version and what is running now."}
            </p>
            <pre className="code-scroll max-h-[50vh] overflow-auto rounded-lg border border-ink-700/70 bg-ink-950/80 px-3 py-2 text-[11px]">
              {detail.content}
            </pre>
            {detail.current && (
              <p className="text-[10px] text-slate-600">
                Current production sha {detail.current.sha256.slice(0, 12)} · version sha {detail.version.sha256.slice(0, 12)}
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
