"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CheckCircle2, Download, FolderDown, Package, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, Empty, Panel, Spinner, Stat } from "@/components/ui";
import { download, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { bytes, datetime, relative } from "@/lib/format";

type Payload = {
  method: string;
  candidates: Array<{ path: string; name: string; extension: string; size: number; sha256: string | null; modifiedAt: string | null; indexedAt: string }>;
  verified: Array<{ path: string; sha256: string | null; size: number; modifiedAt: string | null; status: string }>;
  exclusions: { secretFilesIndexed: number; note: string };
  history: Array<{ id: string; scope: string; paths: unknown; bytes: number; sha256: string | null; createdAt: string; user: string | null }>;
};

export default function DownloadsPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const [verify, setVerify] = useState(false);
  const data = useApi<Payload>(activeId ? `/api/downloads?serverId=${activeId}&verify=${verify ? "1" : "0"}` : null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const verifiedByPath = useMemo(() => {
    const map = new Map<string, Payload["verified"][number]>();
    for (const entry of data.data?.verified ?? []) map.set(entry.path, entry);
    return map;
  }, [data.data]);

  const grab = async (url: string, label: string) => {
    setBusy(true);
    try {
      const result = await download(url);
      push(`${label} — ${result.name}${result.sha256 ? ` · sha ${result.sha256.slice(0, 12)}` : ""}`, "ok");
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
        title="Download Center"
        description="Every download is read from Pterodactyl at request time and hashed. Cached drafts are never offered as production."
        actions={
          <>
            <button className="btn-ghost" onClick={() => setVerify((value) => !value)}>
              {verify ? "Hide verification" : "Verify against production"}
            </button>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => void grab(`/api/files/download?serverId=${activeId}&mode=project`, "Project archive")}
            >
              {busy ? <Spinner /> : <Package className="h-3.5 w-3.5" />} Download project ZIP
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Downloadable files" value={data.data?.candidates.length ?? 0} hint="secrets excluded" />
        <Stat label="Protected files" value={data.data?.exclusions.secretFilesIndexed ?? 0} hint="never downloadable" tone="warn" />
        <Stat label="Verified" value={data.data?.verified.length ?? 0} hint={verify ? "live hash check" : "not requested"} tone="good" />
        <Stat label="Downloads" value={data.data?.history.length ?? 0} hint="recent history" />
      </div>

      <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
        <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
        {data.data?.exclusions.note ??
          "Secrets are excluded by default. Owners can request a sensitive export explicitly, which is audited."}
      </p>

      {selected.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
          <span>{selected.size} selected</span>
          <button
            className="btn-ghost !py-1 text-[11px]"
            onClick={() => void grab(`/api/files/download?serverId=${activeId}&mode=zip&paths=${encodeURIComponent(Array.from(selected).join(","))}`, "Archive")}
          >
            <FolderDown className="h-3 w-3" /> Download ZIP
          </button>
          <button className="text-[11px] text-slate-500 hover:text-slate-300" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <Panel className="mt-4" bodyClassName="!px-0 !py-0" title="Production files" subtitle={`${data.data?.method ?? "live-read"} · newest hash shown after verification`}>
        {data.loading && !data.data ? (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-slate-500"><Spinner /> Reading index…</div>
        ) : (data.data?.candidates.length ?? 0) === 0 ? (
          <div className="px-4 py-6">
            <Empty title="Nothing indexed yet" hint="Run a discovery scan so the download center knows what exists." action={<Link href="/discovery" className="btn-primary">Run discovery</Link>} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-ink-750/70 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="w-8 px-3 py-2" />
                  <th className="px-2 py-2">File</th>
                  <th className="px-2 py-2">Size</th>
                  <th className="px-2 py-2">Modified</th>
                  <th className="px-2 py-2">SHA-256</th>
                  <th className="px-2 py-2 text-right">Download</th>
                </tr>
              </thead>
              <tbody>
                {data.data?.candidates.map((file) => {
                  const verified = verifiedByPath.get(file.path);
                  return (
                    <tr key={file.path} className="table-row">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(file.path)}
                          onChange={() =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (next.has(file.path)) next.delete(file.path);
                              else next.add(file.path);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="max-w-[280px] px-2 py-2">
                        <p className="mono truncate text-[11px] text-slate-200">{file.path}</p>
                        <p className="text-[10px] text-slate-600">indexed {relative(file.indexedAt)}</p>
                      </td>
                      <td className="px-2 py-2 text-slate-400">{bytes(verified?.size ?? file.size)}</td>
                      <td className="px-2 py-2 text-slate-500">{datetime(verified?.modifiedAt ?? file.modifiedAt)}</td>
                      <td className="px-2 py-2">
                        <span className="mono text-[10px] text-slate-500">{(verified?.sha256 ?? file.sha256)?.slice(0, 16) ?? "—"}</span>
                        {verified && (
                          <span className="ml-1 inline-flex align-middle">
                            <Badge tone={verified.status.includes("verified") ? "good" : "warn"}>
                              {verified.status.includes("verified") ? <CheckCircle2 className="h-2.5 w-2.5" /> : null}
                              {verified.status}
                            </Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          className="btn-ghost !px-2 !py-1 text-[10px]"
                          onClick={() => void grab(`/api/files/download?serverId=${activeId}&mode=file&path=${encodeURIComponent(file.path)}`, file.name)}
                        >
                          <Download className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel className="mt-4" title="Download history" subtitle="Who exported what, with the archive hash">
        {data.data?.history.length ? (
          <ul className="divide-y divide-ink-750/60">
            {data.data.history.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-2 py-1.5 text-[11px]">
                <span className="mono text-slate-300">{entry.scope}</span>
                <span className="text-slate-500">{bytes(entry.bytes)} · {relative(entry.createdAt)} · {entry.user ?? "system"}</span>
                <span className="mono text-[10px] text-slate-600">{entry.sha256?.slice(0, 10) ?? ""}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No downloads yet" />
        )}
      </Panel>
    </>
  );
}
