"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight, FileWarning, FolderTree, Radar, RefreshCw, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, Empty, Panel, Spinner, Stat, Status } from "@/components/ui";
import { apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { bytes, datetime, relative } from "@/lib/format";

type DiscoverInfo = {
  method: string;
  methodNote: string;
  lastScan: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    scanned: number;
    added: number;
    changed: number;
    deleted: number;
    failed: number;
    conflicts: number;
    message: string | null;
  } | null;
  counts: { files: number; folders: number };
  importantFiles: Array<{ path: string; name: string; size: number; sha256: string | null; mtime: string | null }>;
};

type ScanSummary = {
  scannedFiles: number;
  scannedFolders: number;
  indexed: number;
  added: string[];
  changed: string[];
  deleted: string[];
  failed: Array<{ path: string; message: string }>;
  skipped: Array<{ path: string; reason: string }>;
  conflicts: number;
  commands: number;
  truncated: boolean;
  rootPath: string;
  finishedAt: string;
};

export default function DiscoveryPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const info = useApi<DiscoverInfo>(activeId ? `/api/servers/${activeId}/discover` : null);
  const [scanning, setScanning] = useState(false);
  const [summary, setSummary] = useState<ScanSummary | null>(null);

  const scan = async () => {
    setScanning(true);
    try {
      const result = await apiPost<{ summary: ScanSummary }>(`/api/servers/${activeId}/discover`);
      setSummary(result.summary);
      push(
        `Scan finished: ${result.summary.indexed} indexed, ${result.summary.added.length} added, ${result.summary.changed.length} changed`,
        "ok",
      );
      await info.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setScanning(false);
    }
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  return (
    <>
      <PageHeader
        title="Live Server Discovery"
        description="Walks the real Pterodactyl directory tree, indexes every reachable text file and reports what changed since the last scan."
        actions={
          <button className="btn-primary" onClick={scan} disabled={scanning}>
            {scanning ? <Spinner /> : <Radar className="h-3.5 w-3.5" />}
            {scanning ? "Scanning production…" : "Scan server now"}
          </button>
        }
      />

      <div className="mb-4 rounded-lg border border-ink-700/60 bg-ink-900/50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
        <span className="font-medium text-slate-300">Method: {info.data?.method ?? "polling"}.</span>{" "}
        {info.data?.methodNote ??
          "Pterodactyl exposes no recursive listing and no file-change webhooks, so discovery is a real directory walk and change detection is polling."}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Indexed files" value={info.data?.counts.files ?? "—"} hint="non-deleted" tone="accent" />
        <Stat label="Indexed folders" value={info.data?.counts.folders ?? "—"} />
        <Stat label="Last scan" value={relative(info.data?.lastScan?.finishedAt ?? info.data?.lastScan?.startedAt)} hint={info.data?.lastScan ? `${info.data.lastScan.scanned} entries walked` : "never scanned"} />
        <Stat
          label="Last result"
          value={<Status status={info.data?.lastScan?.status ?? "UNKNOWN"} />}
          hint={info.data?.lastScan ? `${info.data.lastScan.failed} failed reads` : "run a scan"}
        />
      </div>

      {summary && (
        <Panel
          className="mt-4"
          title={`Scan result · ${datetime(summary.finishedAt)}`}
          subtitle={`root ${summary.rootPath} · ${summary.scannedFiles} files, ${summary.scannedFolders} folders · ${summary.commands} commands parsed`}
          actions={<Badge tone={summary.failed.length ? "warn" : "good"}>{summary.failed.length ? "partial" : "complete"}</Badge>}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Added" value={summary.added.length} tone={summary.added.length ? "good" : "default"} />
            <Stat label="Changed" value={summary.changed.length} tone={summary.changed.length ? "warn" : "default"} />
            <Stat label="Deleted" value={summary.deleted.length} tone={summary.deleted.length ? "bad" : "default"} />
            <Stat label="Conflicts" value={summary.conflicts} tone={summary.conflicts ? "bad" : "default"} />
          </div>

          {summary.added.length + summary.changed.length + summary.deleted.length > 0 && (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <ChangeList title="Added" tone="good" paths={summary.added} />
              <ChangeList title="Changed" tone="warn" paths={summary.changed} />
              <ChangeList title="Deleted" tone="bad" paths={summary.deleted} />
            </div>
          )}

          {summary.failed.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
                <FileWarning className="h-3.5 w-3.5" /> Files that could not be read ({summary.failed.length})
              </p>
              <ul className="mt-1 space-y-0.5">
                {summary.failed.slice(0, 8).map((failure) => (
                  <li key={failure.path} className="mono truncate text-[10px] text-amber-200/80">
                    {failure.path} — {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel
          title="Important project files detected"
          subtitle="Only files that actually exist on the server are listed"
          actions={<Link href="/files" className="text-[11px] text-accent-soft hover:underline">File manager →</Link>}
        >
          {info.data?.importantFiles.length ? (
            <ul className="divide-y divide-ink-750/60">
              {info.data.importantFiles.map((file) => (
                <li key={file.path} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-slate-200">{file.path}</p>
                    <p className="mono truncate text-[10px] text-slate-500">
                      {bytes(file.size)} · {file.sha256?.slice(0, 16) ?? "not hashed"} · {relative(file.mtime)}
                    </p>
                  </div>
                  <Link href={`/editor?path=${encodeURIComponent(file.path)}`} className="btn-ghost !px-2 !py-1 text-[10px]">
                    Open <ChevronRight className="h-3 w-3" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title="No known entry files indexed"
              hint="The bot's layout may differ from the common names. Run a scan, then browse the file manager to see the real tree."
              action={<Link href="/files" className="btn-ghost"><FolderTree className="h-3.5 w-3.5" /> Browse files</Link>}
            />
          )}
        </Panel>

        <Panel title="Scan behaviour" subtitle="What this scan can and cannot see">
          <ul className="space-y-2 text-[11px] leading-relaxed text-slate-400">
            <li className="flex gap-2"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" /> Ignored by policy: auth/session folders, .env files, keys, databases, node_modules and .git are never indexed or exposed.</li>
            <li className="flex gap-2"><RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyber" /> Change detection compares size, mtime and SHA-256. Hashes are computed from the bytes the panel returns.</li>
            <li className="flex gap-2"><Radar className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-soft" /> Scheduled scanning runs in-process when ENABLE_SCHEDULED_SCAN=true (interval SCAN_INTERVAL_SECONDS).</li>
            <li className="flex gap-2"><FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" /> Symlinks are skipped rather than followed, so a link cannot escape the project root.</li>
          </ul>
          {info.data?.lastScan?.message && (
            <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-200">
              {info.data.lastScan.message}
            </p>
          )}
        </Panel>
      </div>
    </>
  );
}

function ChangeList({ title, paths, tone }: { title: string; paths: string[]; tone: "good" | "warn" | "bad" }) {
  if (paths.length === 0) return null;
  return (
    <div className="rounded-lg border border-ink-700/60 bg-ink-950/40 px-2.5 py-2">
      <p className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
        {title} <Badge tone={tone}>{paths.length}</Badge>
      </p>
      <ul className="max-h-32 overflow-auto">
        {paths.slice(0, 40).map((path) => (
          <li key={path} className="mono truncate text-[10px] text-slate-400">{path}</li>
        ))}
      </ul>
    </div>
  );
}
