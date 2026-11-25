"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown,
  ChevronRight,
  Copy,
  Download,
  FileArchive,
  FileCode2,
  FileText,
  Folder,
  FolderPlus,
  Github,
  Lock,
  MoveRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { GitHubImportDialog, GitHubSyncBar } from "@/components/github/sync-bar";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner } from "@/components/ui";
import { apiPost, download, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { bytes, relative } from "@/lib/format";

type Entry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: string | null;
  sha256: string | null;
  language: string | null;
  isSecret: boolean;
  secretKind: string | null;
  editable: boolean;
};

type Listing = {
  path: string;
  rootPath: string;
  parent: string | null;
  breadcrumbs: Array<{ name: string; path: string }>;
  entries: Entry[];
  counts: { files: number; folders: number; secrets: number };
  notice: string | null;
};

type Sort = "name" | "size" | "date" | "type";

/**
 * How many rows the table materialises at once.
 *
 * A Pterodactyl folder can hold thousands of entries (node_modules, a log dump,
 * an uploaded archive root). Every row is three icon buttons plus a checkbox and
 * a badge — around thirty DOM nodes — and the whole table was previously built
 * on the first render. On a phone that burst is what gets the renderer killed
 * ("Aw, Snap!"), because the tab has to lay out and paint all of it in one frame
 * while the previous page is still in memory.
 *
 * Rendering a page at a time keeps the node count flat: 150 rows is about 4,500
 * nodes, which every device can hold, and `Show more` adds the next page on an
 * interaction instead of during hydration.
 */
const ROW_PAGE = 150;

function FilesView() {
  const router = useRouter();
  const params = useSearchParams();
  const { activeId, activeServer } = useServers();
  const { push } = useToast();

  const path = params.get("path") ?? "";
  const listing = useApi<Listing>(activeId ? `/api/files?serverId=${activeId}&path=${encodeURIComponent(path || "/")}` : null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [busy, setBusy] = useState<string | null>(null);
  const [syncPulse, setSyncPulse] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  /** How many pages of `ROW_PAGE` rows are materialised. */
  const [rowPage, setRowPage] = useState(1);

  const [dialog, setDialog] = useState<
    | null
    | { kind: "mkdir" | "create" | "rename" | "move"; target?: Entry }
    | { kind: "delete"; paths: string[] }
    | { kind: "upload" }
    | {
        kind: "inspect";
        entries: Array<{ path: string; size: number; isDirectory?: boolean; unsafe?: string | null }>;
        file: File;
      }
  >(null);

  const [inputValue, setInputValue] = useState("");
  const [createContent, setCreateContent] = useState("");
  const [uploadTarget, setUploadTarget] = useState<string>("");

  const navigate = (target: string) => {
    setSelected(new Set());
    setFilter("");
    const query = target === "/" ? "" : `?path=${encodeURIComponent(target)}`;
    router.push(`/files${query}`);
  };

  const entries = useMemo(() => {
    const list = (listing.data?.entries ?? []).filter((entry) =>
      filter ? entry.name.toLowerCase().includes(filter.toLowerCase()) : true,
    );
    return [...list].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (sort === "size") return b.size - a.size;
      if (sort === "date") return new Date(b.mtime ?? 0).getTime() - new Date(a.mtime ?? 0).getTime();
      if (sort === "type") return (a.language ?? "").localeCompare(b.language ?? "");
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, [listing.data, filter, sort]);

  const visibleEntries = useMemo(() => entries.slice(0, rowPage * ROW_PAGE), [entries, rowPage]);
  const hiddenCount = Math.max(0, entries.length - visibleEntries.length);

  // A different folder, filter or sort order is a different list — start over
  // from the first page instead of keeping a window that no longer means anything.
  useEffect(() => {
    setRowPage(1);
  }, [listing.data?.path, filter, sort]);

  /**
   * Tell the shared GitHub engine what just changed on the panel.
   *
   * Fire-and-forget on purpose: a folder that is not bound to a repository (or a
   * deployment where GitHub is not connected) is a normal state, and it must not
   * turn a successful file operation into an error. The status bar below the
   * toolbar shows exactly what happened.
   */
  const notifyGitHub = async (changes: { paths?: string[]; deletes?: string[] }) => {
    if (!activeId) return;
    setSyncPulse((value) => value + 1);
    await apiPost("/api/github/files", { serverId: activeId, action: "detect", ...changes }).catch(() => undefined);
  };

  const run = async (
    key: string,
    fn: () => Promise<unknown>,
    message: string,
    changes?: { paths?: string[]; deletes?: string[] },
  ) => {
    setBusy(key);
    try {
      await fn();
      push(message, "ok");
      await listing.refresh();
      setDialog(null);
      if (changes) await notifyGitHub(changes);
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const currentDir = listing.data?.path ?? "/";
  const selectedPaths = Array.from(selected);

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  return (
    <>
      <PageHeader
        title="File Manager"
        description="Live remote filesystem. Every operation is executed on Pterodactyl, inside the configured project root."
        actions={
          <>
            <button className="btn-ghost" onClick={() => void listing.refresh()} disabled={listing.loading}>
              {listing.loading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </button>
            <button className="btn-ghost" onClick={() => { setDialog({ kind: "mkdir" }); setInputValue(""); }}>
              <FolderPlus className="h-3.5 w-3.5" /> New folder
            </button>
            <button className="btn-ghost" onClick={() => { setDialog({ kind: "create" }); setInputValue(""); setCreateContent(""); }}>
              <Plus className="h-3.5 w-3.5" /> New file
            </button>
            <button className="btn-ghost" onClick={() => setImportOpen(true)}>
              <Github className="h-3.5 w-3.5" /> Import from GitHub
            </button>
            <button className="btn-primary" onClick={() => { setDialog({ kind: "upload" }); setUploadTarget(currentDir); }}>
              <UploadCloud className="h-3.5 w-3.5" /> Upload
            </button>
          </>
        }
      />

      <GitHubSyncBar
        serverId={activeId}
        selection={selectedPaths}
        pulse={syncPulse}
        onAfterChange={() => void listing.refresh()}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-lg border border-ink-700/60 bg-ink-900/60 px-2 py-1.5 text-[11px]">
          {(listing.data?.breadcrumbs ?? []).map((crumb, index, all) => (
            <span key={crumb.path} className="flex shrink-0 items-center gap-1">
              <button className="rounded px-1 py-0.5 text-slate-300 hover:bg-ink-750 hover:text-white" onClick={() => navigate(crumb.path)}>
                {crumb.name}
              </button>
              {index < all.length - 1 && <ChevronRight className="h-3 w-3 text-slate-600" />}
            </span>
          ))}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input className="field !w-44 !py-1.5 pl-7 text-xs" placeholder="Filter this folder" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </div>

        <button className="btn-ghost !py-1.5 text-[11px]" onClick={() => setSort(sort === "name" ? "size" : sort === "size" ? "date" : sort === "date" ? "type" : "name")}>
          <ArrowUpDown className="h-3 w-3" /> {sort}
        </button>
      </div>

      {listing.data?.notice && (
        <p className="mb-3 rounded-lg border border-ink-700/60 bg-ink-900/40 px-3 py-1.5 text-[11px] text-slate-500">{listing.data.notice}</p>
      )}

      {selectedPaths.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
          <span className="text-slate-300">{selectedPaths.length} selected</span>
          <button className="btn-ghost !py-1 text-[11px]" onClick={() => void download(`/api/files/download?serverId=${activeId}&mode=zip&paths=${encodeURIComponent(selectedPaths.join(","))}`)}>
            <Download className="h-3 w-3" /> Download ZIP
          </button>
          <button className="btn-ghost !py-1 text-[11px]" onClick={() => { setDialog({ kind: "move" }); setInputValue(currentDir); }}>
            <MoveRight className="h-3 w-3" /> Move
          </button>
          <button className="btn-ghost !py-1 text-[11px]" onClick={() => run("zip", () => apiPost("/api/files/op", { action: "zip", serverId: activeId, paths: selectedPaths }), "Archive created on the server")}>
            <FileArchive className="h-3 w-3" /> Compress
          </button>
          <button className="btn-danger !py-1 text-[11px]" onClick={() => setDialog({ kind: "delete", paths: selectedPaths })}>
            <Trash2 className="h-3 w-3" /> Delete
          </button>
          <button className="ml-auto text-[11px] text-slate-500 hover:text-slate-300" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <Panel bodyClassName="!px-0 !py-0">
        {listing.error ? (
          <div className="px-4 py-6 text-xs text-rose-300">{listing.error}</div>
        ) : listing.loading && !listing.data ? (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-slate-500"><Spinner /> Reading remote directory…</div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6">
            <Empty title="This folder is empty" hint={filter ? "No entries match the filter." : "Create a file or upload something to get started."} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-ink-750/70 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.size > 0 && selected.size === entries.length}
                      onChange={(event) => setSelected(event.target.checked ? new Set(entries.map((entry) => entry.path)) : new Set())}
                    />
                  </th>
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Size</th>
                  <th className="px-2 py-2">Modified</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {listing.data?.parent && currentDir !== listing.data.rootPath && (
                  <tr className="table-row">
                    <td />
                    <td className="px-2 py-2" colSpan={5}>
                      <button className="text-slate-400 hover:text-slate-200" onClick={() => navigate(listing.data!.parent!)}>..</button>
                    </td>
                  </tr>
                )}
                {visibleEntries.map((entry) => (
                  <tr key={entry.path} className="table-row cv-auto">
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(entry.path)} onChange={() => toggle(entry.path)} />
                    </td>
                    <td className="max-w-[280px] px-2 py-2">
                      <button
                        className="flex w-full items-center gap-2 text-left"
                        onClick={() => (entry.isDirectory ? navigate(entry.path) : router.push(`/editor?path=${encodeURIComponent(entry.path)}`))}
                      >
                        {entry.isDirectory ? (
                          <Folder className="h-3.5 w-3.5 shrink-0 text-cyber" />
                        ) : entry.isSecret ? (
                          <Lock className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                        ) : entry.editable ? (
                          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-accent-soft" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        )}
                        <span className="truncate text-slate-200">{entry.name}</span>
                        {entry.isSecret && <Badge tone="warn">{entry.secretKind}</Badge>}
                      </button>
                    </td>
                    <td className="px-2 py-2 text-slate-400">{entry.isDirectory ? "—" : bytes(entry.size)}</td>
                    <td className="px-2 py-2 text-slate-500">{relative(entry.mtime)}</td>
                    <td className="px-2 py-2 text-slate-500">{entry.isDirectory ? "folder" : entry.language ?? "binary"}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {!entry.isDirectory && (
                          <>
                            <button className="rounded p-1 text-slate-500 hover:bg-ink-750 hover:text-slate-200" title="Download" onClick={() => void download(`/api/files/download?serverId=${activeId}&mode=file&path=${encodeURIComponent(entry.path)}`).catch((error) => push(errorMessage(error), "error"))}>
                              <Download className="h-3.5 w-3.5" />
                            </button>
                            <button className="rounded p-1 text-slate-500 hover:bg-ink-750 hover:text-slate-200" title="Copy path" onClick={() => { void navigator.clipboard.writeText(entry.path); push("Path copied", "ok"); }}>
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                        <button className="rounded p-1 text-slate-500 hover:bg-ink-750 hover:text-slate-200" title="Rename" onClick={() => { setDialog({ kind: "rename", target: entry }); setInputValue(entry.name); }}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300" title="Delete" onClick={() => setDialog({ kind: "delete", paths: [entry.path] })}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="mt-2 text-[11px] text-slate-600">
        {listing.data ? `${listing.data.counts.files} files · ${listing.data.counts.folders} folders · ${listing.data.counts.secrets} protected` : ""}
      </p>

      {hiddenCount > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-700/60 bg-ink-900/40 px-3 py-2 text-[11px] text-slate-400">
          <span>
            Showing {visibleEntries.length} of {entries.length} entries. The rest load a page at a time so a
            large folder cannot crash the browser on a phone.
          </span>
          <button className="btn-ghost !py-1 text-[11px]" onClick={() => setRowPage((value) => value + 1)}>
            Show next {Math.min(ROW_PAGE, hiddenCount)}
          </button>
        </div>
      )}

      {/* Create folder / file / rename / move */}
      <Modal
        open={dialog !== null && ["mkdir", "create", "rename", "move"].includes(dialog.kind)}
        onClose={() => setDialog(null)}
        title={
          dialog?.kind === "mkdir" ? "New folder" :
          dialog?.kind === "create" ? "New file" :
          dialog?.kind === "rename" ? "Rename" : "Move to folder"
        }
        subtitle={dialog?.kind === "rename" && "target" in dialog && dialog.target ? dialog.target.path : currentDir}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDialog(null)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={busy !== null || inputValue.trim().length === 0}
              onClick={() => {
                if (!dialog) return;
                if (dialog.kind === "mkdir") {
                  const target = `${currentDir === "/" ? "" : currentDir}/${inputValue.trim()}`;
                  void run("mkdir", () => apiPost("/api/files/op", { action: "mkdir", serverId: activeId, path: target }), "Folder created");
                }
                if (dialog.kind === "create") {
                  const target = `${currentDir === "/" ? "" : currentDir}/${inputValue.trim()}`;
                  void run(
                    "create",
                    () => apiPost("/api/files/op", { action: "create", serverId: activeId, path: target, content: createContent }),
                    "File created and indexed",
                    { paths: [target] },
                  );
                }
                if (dialog.kind === "rename" && dialog.target) {
                  const previousPath = dialog.target!.path;
                  const nextPath = `${currentDir === "/" ? "" : currentDir}/${inputValue.trim()}`;
                  void run(
                    "rename",
                    () => apiPost("/api/files/op", { action: "rename", serverId: activeId, path: previousPath, newName: inputValue.trim() }),
                    "Renamed on the server",
                    { paths: [nextPath], deletes: [previousPath] },
                  );
                }
                if (dialog.kind === "move") {
                  void run(
                    "move",
                    () => apiPost("/api/files/op", { action: "move", serverId: activeId, paths: selectedPaths, destination: inputValue.trim() }),
                    "Moved on the server",
                    {
                      paths: selectedPaths.map((path) => `${inputValue.trim().replace(/\/+$/, "")}/${path.split("/").pop()}`),
                      deletes: selectedPaths,
                    },
                  );
                }
              }}
            >
              {busy && <Spinner />} Apply
            </button>
          </>
        }
      >
        <label className="label">{dialog?.kind === "move" ? "Destination folder" : "Name"}</label>
        <input className="field mono mt-1" value={inputValue} onChange={(event) => setInputValue(event.target.value)} autoFocus />
        {dialog?.kind === "create" && (
          <>
            <label className="label mt-3 block">Initial content</label>
            <textarea className="field mono mt-1 h-40" value={createContent} onChange={(event) => setCreateContent(event.target.value)} spellCheck={false} />
          </>
        )}
        {dialog?.kind === "move" && <p className="mt-2 text-[11px] text-slate-500">Moves {selectedPaths.length} item(s) inside the project root.</p>}
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onClose={() => setDialog(null)}
        onConfirm={() =>
          dialog?.kind === "delete" &&
          run(
            "delete",
            () => apiPost("/api/files/op", { action: "delete", serverId: activeId, paths: dialog.paths }),
            "Deleted — previous contents were backed up",
            { deletes: dialog.paths },
          )
        }
        busy={busy === "delete"}
        danger
        title="Delete from production?"
        description={
          <div className="space-y-2">
            <p>The following will be removed from the live server:</p>
            <ul className="mono max-h-32 overflow-auto rounded border border-ink-700 bg-ink-950/60 px-2 py-1 text-[11px] text-rose-200">
              {dialog?.kind === "delete" && dialog.paths.map((path) => <li key={path} className="truncate">{path}</li>)}
            </ul>
            <p className="text-[11px] text-slate-500">Text files are backed up as a new version first. Folders and binaries cannot always be backed up this way.</p>
          </div>
        }
        confirmLabel="Delete"
        requireText="DELETE"
      />

      {/* Upload */}
      <Modal
        open={dialog?.kind === "upload"}
        onClose={() => setDialog(null)}
        title="Upload files"
        subtitle="Single files or a ZIP archive. ZIP contents are shown before anything is extracted."
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDialog(null)}>Close</button>
            <Link href={`/sync`} className="btn-ghost" onClick={() => setDialog(null)}>Re-scan later</Link>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Destination folder</label>
            <input className="field mono mt-1" value={uploadTarget} onChange={(event) => setUploadTarget(event.target.value)} />
          </div>
          <input
            type="file"
            multiple
            className="field !py-1.5 text-xs"
            onChange={async (event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length === 0) return;
              const form = new FormData();
              form.set("serverId", activeId ?? "");
              form.set("destination", uploadTarget);
              for (const file of files) form.append("files", file);
              const archive = files.find((file) => file.name.toLowerCase().endsWith(".zip"));

              if (archive) {
                setBusy("inspect");
                try {
                  const inspectForm = new FormData();
                  inspectForm.set("serverId", activeId ?? "");
                  inspectForm.set("destination", uploadTarget);
                  inspectForm.set("mode", "inspect");
                  inspectForm.append("files", archive);
                  const result = await fetch("/api/files/upload", {
                    method: "POST",
                    body: inspectForm,
                    headers: { "x-csrf-token": document.cookie.match(/(?:^|;\s*)dn_csrf=([^;]+)/)?.[1] ?? "" },
                  }).then((res) => res.json());
                  if (result?.error) throw new Error(result.error.message);
                  setDialog({ kind: "inspect", entries: result.archive.entries, file: archive });
                } catch (error) {
                  push(errorMessage(error), "error");
                } finally {
                  setBusy(null);
                }
                return;
              }

              setBusy("upload");
              try {
                const result = await fetch("/api/files/upload", {
                  method: "POST",
                  body: form,
                  headers: { "x-csrf-token": document.cookie.match(/(?:^|;\s*)dn_csrf=([^;]+)/)?.[1] ?? "" },
                }).then((res) => res.json());
                if (result?.error) throw new Error(result.error.message);
                push(`Uploaded ${result.summary.uploaded}, skipped ${result.summary.skipped}, failed ${result.summary.failed}`, result.summary.failed ? "error" : "ok");
                await listing.refresh();
                setDialog(null);
                const uploadedPaths = (result.files ?? []).map((entry: { path: string }) => entry.path);
                if (uploadedPaths.length) await notifyGitHub({ paths: uploadedPaths });
              } catch (error) {
                push(errorMessage(error), "error");
              } finally {
                setBusy(null);
              }
            }}
          />
          <p className="text-[11px] leading-relaxed text-slate-500">
            Existing files are never overwritten silently — set overwrite explicitly from the archive preview. Protected paths
            (.env, auth sessions, keys) are rejected.
          </p>
          {busy && <div className="flex items-center gap-2 text-xs text-slate-400"><Spinner /> Working…</div>}
        </div>
      </Modal>

      {/* Archive preview */}
      <Modal
        open={dialog?.kind === "inspect"}
        onClose={() => setDialog(null)}
        wide
        title="Archive contents"
        subtitle={dialog?.kind === "inspect" ? `${dialog.file.name} · ${dialog.entries.length} entries` : ""}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDialog(null)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={busy !== null}
              onClick={async () => {
                if (dialog?.kind !== "inspect") return;
                setBusy("extract");
                try {
                  const form = new FormData();
                  form.set("serverId", activeId ?? "");
                  form.set("destination", uploadTarget);
                  form.set("mode", "extract");
                  form.set("overwrite", "false");
                  form.append("files", dialog.file);
                  const result = await fetch("/api/files/upload", {
                    method: "POST",
                    body: form,
                    headers: { "x-csrf-token": document.cookie.match(/(?:^|;\s*)dn_csrf=([^;]+)/)?.[1] ?? "" },
                  }).then((res) => res.json());
                  if (result?.error) throw new Error(result.error.message);
                  push(`Extracted ${result.summary.extracted}, skipped ${result.summary.skipped}, failed ${result.summary.failed}`, "ok");
                  await listing.refresh();
                  setDialog(null);
                  // The archive entries are known, so the exact paths that were
                  // written are recorded — no guessing from the listing.
                  const extractedPaths = (dialog.entries ?? [])
                    .filter((entry) => !entry.isDirectory && !entry.unsafe)
                    .map((entry) => `${uploadTarget.replace(/\/+$/, "")}/${entry.path}`);
                  if (extractedPaths.length) await notifyGitHub({ paths: extractedPaths });
                } catch (error) {
                  push(errorMessage(error), "error");
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy ? <Spinner /> : <FileArchive className="h-3.5 w-3.5" />} Extract without overwriting
            </button>
          </>
        }
      >
        <ul className="divide-y divide-ink-750/60">
          {dialog?.kind === "inspect" && dialog.entries.map((entry) => (
            <li key={entry.path} className="flex items-center justify-between gap-3 py-1.5">
              <span className="mono truncate text-[11px] text-slate-300">{entry.path}</span>
              <span className="shrink-0 text-[10px] text-slate-500">{bytes(entry.size)}</span>
            </li>
          ))}
        </ul>
      </Modal>

      <GitHubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        serverId={activeId ?? ""}
        destination={currentDir}
        defaultRepo=""
        defaultBranch=""
        maxFiles={120}
        onDone={() => void listing.refresh()}
      />
    </>
  );
}

export default function FilesPage() {
  return (
    <Suspense fallback={<div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Loading…</div>}>
      <FilesView />
    </Suspense>
  );
}
