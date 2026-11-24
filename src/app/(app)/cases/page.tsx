"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Copy, Pencil, Plus, Search, Trash2, Workflow } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner } from "@/components/ui";
import { apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";

type CaseRow = {
  id: string;
  name: string;
  filePath: string;
  line: number;
  endLine: number | null;
  aliases: string[];
  fileSha: string | null;
};

type CasesPayload = {
  cases: CaseRow[];
  files: Array<{ path: string; sha256: string | null; size: number; indexedAt: string }>;
  aliasesSource: string | null;
  note: string;
};

type Preview = {
  content: string;
  newSha: string;
  originalSha: string;
  validation: { ok: boolean; errors: Array<{ line: number; message: string }> };
  balance: Array<{ line: number; message: string }>;
  warning?: string;
};

export default function CasesPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const data = useApi<CasesPayload>(activeId ? `/api/cases?serverId=${activeId}` : null);
  const [query, setQuery] = useState("");
  const [fileFilter, setFileFilter] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [preview, setPreview] = useState<null | {
    row: CaseRow;
    content: string;
    sha: string;
    original: string;
    note: string;
    validation: { ok: boolean; errors: Array<{ line: number; message: string }> };
    balance: Array<{ line: number; message: string }>;
  }>(null);
  const [busy, setBusy] = useState(false);

  const [duplicate, setDuplicate] = useState<CaseRow | null>(null);
  const [newName, setNewName] = useState("");
  const [replaceCase, setReplaceCase] = useState<CaseRow | null>(null);
  const [replacement, setReplacement] = useState("");
  const [deleteTargets, setDeleteTargets] = useState<CaseRow[] | null>(null);

  const rows = useMemo(() => {
    return (data.data?.cases ?? []).filter((row) => {
      if (fileFilter && row.filePath !== fileFilter) return false;
      if (!query) return true;
      const needle = query.toLowerCase();
      return row.name.toLowerCase().includes(needle) || row.aliases.some((alias) => alias.toLowerCase().includes(needle));
    });
  }, [data.data, query, fileFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, CaseRow[]>();
    for (const row of rows) {
      if (!map.has(row.filePath)) map.set(row.filePath, []);
      map.get(row.filePath)!.push(row);
    }
    return Array.from(map.entries());
  }, [rows]);

  const buildPreview = async (row: CaseRow, action: "delete-block" | "duplicate-block" | "replace-block", payload: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const result = await apiPost<Preview>(`/api/cases`, {
        serverId: activeId,
        path: row.filePath,
        name: row.name,
        action,
        ...payload,
      });
      setPreview({
        row,
        content: result.content,
        sha: result.newSha,
        original: result.originalSha,
        validation: result.validation,
        balance: result.balance ?? [],
        note:
          action === "delete-block"
            ? `Remove case "${row.name}" — ${row.endLine ? row.endLine - row.line + 1 : "?"} lines`
            : action === "duplicate-block"
              ? `Duplicate "${row.name}" as "${payload.newName}"`
              : `Replace the body of "${row.name}"`,
      });
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
      setDuplicate(null);
      setReplaceCase(null);
      setDeleteTargets(null);
    }
  };

  const deployPreview = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await apiPost<{ deployment: { publicId: string; status: string; healthOk: boolean | null; error: string | null } }>(
        "/api/deployments",
        {
          serverId: activeId,
          files: [{ path: preview.row.filePath, content: preview.content, expectedSha: preview.original }],
          message: preview.note,
        },
      );
      const deployment = result.deployment;
      if (deployment.status === "SUCCEEDED") push(`Deployed ${deployment.publicId}`, "ok");
      else push(`${deployment.publicId}: ${deployment.error ?? deployment.status}`, "error");
      setPreview(null);
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
        title="Case Manager"
        description="Switch cases parsed from the real dispatcher with an AST, plus the aliases the bot's config maps to them."
        actions={
          <button className="btn-ghost" onClick={() => void data.refresh()} disabled={data.loading}>
            {data.loading ? <Spinner /> : <Workflow className="h-3.5 w-3.5" />} Refresh
          </button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input className="field !w-56 !py-1.5 pl-7 text-xs" placeholder="Search cases or aliases" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <select className="field !w-auto !py-1.5 text-xs" value={fileFilter} onChange={(event) => setFileFilter(event.target.value)}>
          <option value="">All files</option>
          {data.data?.files.map((file) => (
            <option key={file.path} value={file.path}>{file.path}</option>
          ))}
        </select>
        <span className="text-[11px] text-slate-500">{rows.length} cases</span>
        {data.data?.aliasesSource && <Badge tone="accent">aliases: {data.data.aliasesSource}</Badge>}
        {selected.size > 0 && (
          <button
            className="btn-danger !py-1 text-[11px]"
            onClick={() => {
              const targets = rows.filter((row) => selected.has(row.id));
              if (targets.length > 0) setDeleteTargets(targets);
            }}
          >
            <Trash2 className="h-3 w-3" /> Delete {selected.size} selected
          </button>
        )}
      </div>

      {data.data?.note && <p className="mb-3 rounded-lg border border-ink-700/60 bg-ink-900/40 px-3 py-1.5 text-[11px] text-slate-500">{data.data.note}</p>}

      {grouped.length === 0 ? (
        <Panel>
          <Empty
            title="No cases indexed"
            hint="Run LIVE SERVER DISCOVERY so the dispatcher file is parsed and its switch cases become editable blocks."
            action={<Link href="/discovery" className="btn-primary">Open discovery</Link>}
          />
        </Panel>
      ) : (
        <div className="space-y-4">
          {grouped.map(([filePath, list]) => (
            <Panel
              key={filePath}
              title={filePath}
              subtitle={`${list.length} cases · ${data.data?.files.find((file) => file.path === filePath)?.sha256?.slice(0, 12) ?? "unhashed"}`}
              bodyClassName="!px-0 !py-0"
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-ink-750/70 text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="w-8 px-3 py-2" />
                      <th className="px-2 py-2">Case</th>
                      <th className="px-2 py-2">Line</th>
                      <th className="px-2 py-2">Aliases</th>
                      <th className="px-2 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((row) => (
                      <tr key={row.id} className="table-row">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selected.has(row.id)}
                            onChange={() =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-2">
                          <span className="mono text-slate-200">{row.name}</span>
                        </td>
                        <td className="px-2 py-2 text-slate-500">{row.line}</td>
                        <td className="px-2 py-2">
                          {row.aliases.length ? (
                            <div className="flex flex-wrap gap-1">
                              {row.aliases.slice(0, 4).map((alias) => <Badge key={alias} tone="cyber">{alias}</Badge>)}
                            </div>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <Link
                              href={`/editor?path=${encodeURIComponent(row.filePath)}&line=${row.line}`}
                              className="rounded p-1 text-slate-500 hover:bg-ink-750 hover:text-slate-200"
                              title="Open in editor"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Link>
                            <button
                              className="rounded p-1 text-slate-500 hover:bg-ink-750 hover:text-slate-200"
                              title="Replace body"
                              onClick={() => { setReplaceCase(row); setReplacement(""); }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            <button
                              className="rounded p-1 text-slate-500 hover:bg-ink-750 hover:text-slate-200"
                              title="Duplicate"
                              onClick={() => { setDuplicate(row); setNewName(`${row.name}_copy`); }}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                            <button
                              className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                              title="Delete"
                              onClick={() => setDeleteTargets([row])}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <Modal
        open={duplicate !== null}
        onClose={() => setDuplicate(null)}
        title="Duplicate case"
        subtitle={duplicate?.filePath}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDuplicate(null)}>Cancel</button>
            <button className="btn-primary" disabled={busy || !newName.trim()} onClick={() => duplicate && buildPreview(duplicate, "duplicate-block", { newName: newName.trim() })}>
              {busy && <Spinner />} Preview duplicate
            </button>
          </>
        }
      >
        <label className="label">New case name</label>
        <input className="field mono mt-1" value={newName} onChange={(event) => setNewName(event.target.value)} autoFocus />
        <p className="mt-2 text-[11px] text-slate-500">The block is copied verbatim and only the case label changes, so brackets and scope stay intact.</p>
      </Modal>

      <Modal
        open={replaceCase !== null}
        onClose={() => setReplaceCase(null)}
        wide
        title={`Replace body of "${replaceCase?.name ?? ""}"`}
        subtitle={replaceCase?.filePath}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setReplaceCase(null)}>Cancel</button>
            <button className="btn-primary" disabled={busy || !replacement.trim()} onClick={() => replaceCase && buildPreview(replaceCase, "replace-block", { code: replacement })}>
              {busy && <Spinner />} Preview replacement
            </button>
          </>
        }
      >
        <p className="mb-2 text-[11px] text-slate-500">
          Paste the statements that should run for this case. The surrounding <span className="mono">case …:</span> label and the
          neighbouring cases are preserved.
        </p>
        <textarea className="field mono h-56" value={replacement} onChange={(event) => setReplacement(event.target.value)} spellCheck={false} />
      </Modal>

      <ConfirmDialog
        open={deleteTargets !== null}
        onClose={() => setDeleteTargets(null)}
        onConfirm={() => deleteTargets && deleteTargets[0] && buildPreview(deleteTargets[0], "delete-block")}
        title={`Delete ${deleteTargets?.length ?? 0} case block(s)?`}
        description={
          <div className="space-y-2">
            <p>These blocks are removed from the file:</p>
            <ul className="mono max-h-32 overflow-auto rounded border border-ink-700 bg-ink-950/60 px-2 py-1 text-[11px] text-rose-200">
              {deleteTargets?.map((row) => <li key={row.id}>{row.name}</li>)}
            </ul>
            <p className="text-[11px] text-slate-500">A preview with validation is shown next — nothing is written until you deploy.</p>
          </div>
        }
        confirmLabel="Preview removal"
        danger
      />

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        wide
        title={preview?.note ?? "Preview"}
        subtitle={`${preview?.row.filePath} · new sha ${preview?.sha.slice(0, 12)}`}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPreview(null)}>Cancel</button>
            <button className="btn-primary" disabled={busy || !preview?.validation.ok} onClick={() => void deployPreview()}>
              {busy && <Spinner />} Deploy this change
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {preview && !preview.validation.ok && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              <p className="font-medium">This edit does not parse — deployment is blocked.</p>
              <ul className="mt-1 space-y-0.5">
                {preview.validation.errors.map((error, index) => (
                  <li key={index}>line {error.line}: {error.message}</li>
                ))}
                {preview.balance.map((error, index) => (
                  <li key={`b-${index}`}>line {error.line}: {error.message}</li>
                ))}
              </ul>
            </div>
          )}
          {preview?.validation.ok && (
            <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-300">
              Parses cleanly. Deploying will back up the current file, write this content and verify the stored hash before restarting.
            </p>
          )}
          <pre className="code-scroll max-h-[45vh] overflow-auto rounded-lg border border-ink-700/70 bg-ink-950/80 px-3 py-2 text-slate-300">
            {preview?.content.split("\n").slice(Math.max(0, (preview?.row.line ?? 1) - 12), (preview?.row.endLine ?? preview?.row.line ?? 1) + 12).join("\n")}
          </pre>
        </div>
      </Modal>
    </>
  );
}
