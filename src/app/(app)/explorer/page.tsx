"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Braces,
  ChevronRight,
  Database,
  Download,
  ExternalLink,
  FilePlus2,
  FolderPlus,
  FolderTree,
  Info,
  Layers,
  Package,
  Pencil,
  PlayCircle,
  Puzzle,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner } from "@/components/ui";
import { api, apiDelete, apiGet, apiPost, download, errorMessage } from "@/lib/client";
import { relative } from "@/lib/format";
import { EXPLORER_CATEGORIES, type ExplorerCategoryId } from "@/lib/explorer/classify";
import type {
  ExplorerCategoryView,
  ExplorerFileInfo,
  ExplorerItem,
  ExplorerOverview,
  ExplorerScanResult,
  ExplorerSearchResult,
} from "@/lib/explorer/types";

const CATEGORY_ICONS: Record<ExplorerCategoryId, typeof Puzzle> = {
  plugins: Puzzle,
  package: Package,
  entry: PlayCircle,
  cases: Layers,
  functions: Braces,
  config: Settings2,
  database: Database,
};

function formatSize(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function editorHref(path: string, line?: number): string {
  const suffix = line && line > 0 ? `&line=${line}` : "";
  return `/editor?path=${encodeURIComponent(path)}${suffix}`;
}

export default function ExplorerPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();

  const [overview, setOverview] = useState<ExplorerOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ExplorerScanResult | null>(null);

  const [category, setCategory] = useState<ExplorerCategoryId | null>(null);
  const [categoryView, setCategoryView] = useState<ExplorerCategoryView | null>(null);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [paging, setPaging] = useState(false);

  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ExplorerSearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  const [navOpen, setNavOpen] = useState(false);
  const [detail, setDetail] = useState<ExplorerFileInfo | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<{ path: string; isDirectory: boolean; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ path: string; destination: string } | null>(null);
  const [createTarget, setCreateTarget] = useState<{ kind: "file" | "folder"; path: string } | null>(null);
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const [replacePath, setReplacePath] = useState<string | null>(null);
  const searchSequence = useRef(0);

  const loadOverview = useCallback(async () => {
    if (!activeId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<ExplorerOverview>(`/api/explorer?serverId=${activeId}`);
      setOverview(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    void loadOverview();
    setCategory(null);
    setCategoryView(null);
    setQuery("");
    setSearchResult(null);
    setDetail(null);
    setScanResult(null);
  }, [loadOverview]);

  const openCategory = useCallback(
    async (id: ExplorerCategoryId) => {
      if (!activeId) return;
      setCategory(id);
      setNavOpen(false);
      setSearchResult(null);
      setCategoryLoading(true);
      try {
        const data = await apiGet<ExplorerCategoryView>(`/api/explorer/category?serverId=${activeId}&id=${id}&limit=200&offset=0`);
        setCategoryView(data);
      } catch (err) {
        push(errorMessage(err), "error");
        setCategoryView(null);
      } finally {
        setCategoryLoading(false);
      }
    },
    [activeId, push],
  );

  /** Append the next page instead of replacing the list. */
  const loadMore = useCallback(async () => {
    if (!activeId || !category || !categoryView) return;
    setPaging(true);
    try {
      const data = await apiGet<ExplorerCategoryView>(
        `/api/explorer/category?serverId=${activeId}&id=${category}&limit=200&offset=${categoryView.items.length}`,
      );
      setCategoryView((previous) =>
        previous
          ? { ...data, items: [...previous.items, ...data.items] }
          : data,
      );
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setPaging(false);
    }
  }, [activeId, category, categoryView, push]);

  useEffect(() => {
    if (!activeId || query.trim().length < 2) {
      setSearchResult(null);
      setSearching(false);
      return;
    }
    const sequence = ++searchSequence.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await apiGet<ExplorerSearchResult>(
          `/api/explorer/search?serverId=${activeId}&q=${encodeURIComponent(query.trim())}`,
        );
        if (searchSequence.current === sequence) setSearchResult(data);
      } catch (err) {
        if (searchSequence.current === sequence) push(errorMessage(err), "error");
      } finally {
        if (searchSequence.current === sequence) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [activeId, query, push]);

  const rescan = async () => {
    if (!activeId) return;
    setScanning(true);
    setScanResult(null);
    try {
      const result = await apiPost<ExplorerScanResult>("/api/explorer/scan", { serverId: activeId, deep: true });
      setScanResult(result);
      push(
        `Scan finished: ${result.indexed} indexed, ${result.added.length} added, ${result.changed.length} changed, ${result.deleted.length} deleted`,
        "ok",
      );
      await loadOverview();
      if (category) await openCategory(category);
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setScanning(false);
    }
  };

  const showDetail = async (path: string) => {
    if (!activeId) return;
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const data = await apiGet<ExplorerFileInfo>(
        `/api/explorer/file?serverId=${activeId}&path=${encodeURIComponent(path)}`,
      );
      setDetail(data);
    } catch (err) {
      push(errorMessage(err), "error");
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const requestDelete = (path: string, isDirectory = false) => {
    setConfirmDelete({ path, isDirectory, name: path.split("/").filter(Boolean).pop() ?? path });
  };

  const deleteFile = async (target: { path: string; isDirectory: boolean; name: string }) => {
    if (!activeId) return;
    setBusy(true);
    try {
      // Folders require their own name as the token; files require DELETE.
      const token = target.isDirectory ? target.name : "DELETE";
      await apiDelete(
        `/api/explorer/file?serverId=${activeId}&path=${encodeURIComponent(target.path)}&confirm=${encodeURIComponent(token)}`,
      );
      push(`Deleted ${target.path} — a backup was kept`, "ok");
      setConfirmDelete(null);
      setDetailOpen(false);
      await loadOverview();
      if (category) await openCategory(category);
    } catch (err) {
      push(errorMessage(err), "error");
      setConfirmDelete(null);
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async () => {
    if (!activeId || !renameTarget || !renameTarget.name.trim()) return;
    setBusy(true);
    try {
      await apiPost("/api/files/op", {
        action: "rename",
        serverId: activeId,
        path: renameTarget.path,
        newName: renameTarget.name.trim(),
      });
      push("Renamed", "ok");
      setRenameTarget(null);
      await loadOverview();
      if (category) await openCategory(category);
      if (detailOpen && detail) await showDetail(detail.path);
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const submitMove = async () => {
    if (!activeId || !moveTarget || !moveTarget.destination.trim()) return;
    setBusy(true);
    try {
      await apiPost("/api/files/op", {
        action: "move",
        serverId: activeId,
        paths: [moveTarget.path],
        destination: moveTarget.destination.trim(),
      });
      push("Moved", "ok");
      setMoveTarget(null);
      await loadOverview();
      if (category) await openCategory(category);
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async () => {
    if (!activeId || !createTarget || !createTarget.path.trim()) return;
    setBusy(true);
    try {
      await apiPost("/api/files/op", {
        action: createTarget.kind === "folder" ? "mkdir" : "create",
        serverId: activeId,
        path: createTarget.path.trim(),
        ...(createTarget.kind === "file" ? { content: "" } : {}),
      });
      push(`${createTarget.kind === "folder" ? "Folder" : "File"} created`, "ok");
      setCreateTarget(null);
      await loadOverview();
      if (category) await openCategory(category);
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const pickReplacement = (path: string) => {
    setReplacePath(path);
    replaceInput.current?.click();
  };

  const uploadReplacement = async (file: File) => {
    if (!activeId || !replacePath) return;
    setBusy(true);
    try {
      const destination = replacePath.split("/").slice(0, -1).join("/") || "/";
      const form = new FormData();
      form.append("serverId", activeId);
      form.append("destination", destination);
      form.append("mode", "upload");
      form.append("files", file, replacePath.split("/").pop() ?? file.name);
      await api("/api/files/upload?serverId=" + encodeURIComponent(activeId), { method: "POST", body: form });
      push(`Replaced ${replacePath} — previous content backed up`, "ok");
      await loadOverview();
      if (category) await openCategory(category);
      if (detailOpen) await showDetail(replacePath);
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(false);
      setReplacePath(null);
      if (replaceInput.current) replaceInput.current.value = "";
    }
  };

  const navItems = useMemo(
    () =>
      (overview?.categories ?? EXPLORER_CATEGORIES.map((definition) => ({
        ...definition,
        count: 0,
        samples: [],
        available: false,
      }))).map((entry) => ({ ...entry, Icon: CATEGORY_ICONS[entry.id] })),
    [overview],
  );

  if (!activeServer) {
    return (
      <Empty
        title="No server selected"
        hint="Connect a Pterodactyl server to explore its real project files."
        action={<Link href="/settings" className="btn-primary">Connect server</Link>}
      />
    );
  }

  const showSearch = query.trim().length >= 2;

  return (
    <div className="pb-6">
      <PageHeader
        title="Project Explorer"
        description="Discovers the real project structure through the panel API: plugins, cases, functions, configuration, dependencies and the actual entry point."
        actions={
          <>
            <button className="btn-ghost !px-3 !py-2 text-[11px]" onClick={() => setNavOpen(true)}>
              <FolderTree className="h-3.5 w-3.5" /> Folders
            </button>
            <button className="btn-primary !px-3 !py-2 text-[11px]" onClick={() => void rescan()} disabled={scanning}>
              {scanning ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} {scanning ? "Scanning…" : "Rescan"}
            </button>
          </>
        }
      />

      {/* Folder navigation: a sheet on phones, an inline rail on desktop */}
      <div className="mb-3 flex items-stretch gap-2">
        <button
          onClick={() => setNavOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-ink-700/70 bg-ink-850/70 px-3 py-2.5 text-left transition hover:border-accent/40"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10">
            <FolderTree className="h-4 w-4 text-accent-soft" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-slate-100">
              {category ? navItems.find((item) => item.id === category)?.label : "Project navigation"}
            </span>
            <span className="mono block truncate text-[10px] text-slate-500">
              {overview ? `${overview.index.files} files · ${overview.index.folders} folders` : "Loading index…"}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
        </button>
        <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <button className="btn-ghost !px-2 !py-1.5 text-[11px]" onClick={() => setCreateTarget({ kind: "file", path: "/" })}>
            <FilePlus2 className="h-3.5 w-3.5" /> File
          </button>
          <button className="btn-ghost !px-2 !py-1.5 text-[11px]" onClick={() => setCreateTarget({ kind: "folder", path: "/" })}>
            <FolderPlus className="h-3.5 w-3.5" /> Folder
          </button>
        </div>
      </div>

      {/* Global search */}
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          className="field mono !py-2.5 !pl-9 text-xs"
          placeholder="Search plugins, commands, cases, functions, files or code…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {query && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-200"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>
      )}

      {scanResult && (
        <div className="mb-3 rounded-lg border border-cyber/30 bg-cyber/5 px-3 py-2 text-[11px] text-cyber">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">Scan finished</span>
            <span>{scanResult.indexed} indexed</span>
            <span>{scanResult.added.length} added</span>
            <span>{scanResult.changed.length} changed</span>
            <span>{scanResult.deleted.length} deleted</span>
            {scanResult.renamed.length > 0 && <span>{scanResult.renamed.length} renamed</span>}
            <span>{scanResult.cases} cases · {scanResult.functions} functions</span>
            <span>{(scanResult.durationMs / 1000).toFixed(1)}s</span>
          </div>
          {(scanResult.added.length > 0 || scanResult.deleted.length > 0 || scanResult.renamed.length > 0) && (
            <div className="mt-1 space-y-0.5 text-[10px] text-cyber/80">
              {scanResult.renamed.slice(0, 5).map((entry) => (
                <p key={`${entry.from}-${entry.to}`} className="mono truncate">renamed {entry.from} → {entry.to}</p>
              ))}
              {scanResult.added.slice(0, 5).map((path) => (
                <p key={`add-${path}`} className="mono truncate">added {path}</p>
              ))}
              {scanResult.deleted.slice(0, 5).map((path) => (
                <p key={`del-${path}`} className="mono truncate">deleted {path}</p>
              ))}
            </div>
          )}
          {scanResult.failed.length > 0 && (
            <p className="mt-1 text-[10px] text-amber-300">
              {scanResult.failed.length} paths could not be read: {scanResult.failed[0].path}
            </p>
          )}
        </div>
      )}

      {loading && !overview ? (
        <div className="flex items-center gap-2 px-1 py-8 text-xs text-slate-500">
          <Spinner /> Reading the project index…
        </div>
      ) : null}

      {overview && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-3">
            {showSearch ? (
              <SearchResults
                result={searchResult}
                searching={searching}
                onOpen={(path, line) => void showDetail(path)}
                onExpand={(path) => void showDetail(path)}
                lineHref={editorHref}
              />
            ) : category ? (
              <Panel
                title={
                  <span className="flex items-center gap-2">
                    {(() => {
                      const Icon = CATEGORY_ICONS[category];
                      return <Icon className="h-4 w-4 text-accent-soft" />;
                    })()}
                    {categoryView?.label ?? navItems.find((item) => item.id === category)?.label}
                  </span>
                }
                subtitle={categoryView?.description}
                bodyClassName="!py-3"
                actions={
                  <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => setCategory(null)}>
                    <X className="h-3 w-3" /> Close
                  </button>
                }
              >
                {categoryLoading ? (
                  <div className="flex items-center gap-2 py-6 text-xs text-slate-500"><Spinner /> Discovering…</div>
                ) : !categoryView ? null : categoryView.items.length === 0 ? (
                  <p className="py-4 text-xs leading-relaxed text-slate-500">{categoryView.hint}</p>
                ) : (
                  <>
                    <p className="mb-2 text-[10px] text-slate-500">
                      {categoryView.total} result{categoryView.total === 1 ? "" : "s"}
                      {categoryView.items.length < categoryView.total
                        ? ` · showing ${categoryView.items.length}`
                        : ""}
                    </p>
                    <div className="divide-y divide-ink-750/60">
                      {categoryView.items.map((item) => (
                        <ItemRow
                          key={item.id}
                          item={item}
                          expanded={Boolean(expanded[item.id])}
                          onToggle={() => setExpanded((state) => ({ ...state, [item.id]: !state[item.id] }))}
                          onInfo={(path) => void showDetail(path)}
                          onRename={(path) => setRenameTarget({ path, name: path.split("/").pop() ?? "" })}
                          onMove={(path) => setMoveTarget({ path, destination: path.split("/").slice(0, -1).join("/") || "/" })}
                          onReplace={pickReplacement}
                          onDelete={(path) => requestDelete(path)}
                        />
                      ))}
                    </div>
                    {categoryView.items.length < categoryView.total && (
                      <button
                        className="btn-ghost mt-3 w-full !py-2 text-[11px]"
                        onClick={() => void loadMore()}
                        disabled={paging}
                      >
                        {paging ? <Spinner /> : <ChevronRight className="h-3.5 w-3.5" />} Load more
                        <span className="text-slate-500">
                          ({categoryView.total - categoryView.items.length} left)
                        </span>
                      </button>
                    )}
                  </>
                )}
                {categoryView?.notes.filter(Boolean).length ? (
                  <div className="mt-3 space-y-1 border-t border-ink-750/60 pt-2">
                    {categoryView.notes.filter(Boolean).map((note, index) => (
                      <p key={index} className="text-[10px] leading-relaxed text-slate-500">{note}</p>
                    ))}
                  </div>
                ) : null}
              </Panel>
            ) : (
              <>
                <Warnings warnings={overview.warnings} />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {navItems.map((item) => {
                    const Icon = item.Icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => void openCategory(item.id)}
                        className="panel group flex items-start gap-3 px-3 py-3 text-left transition hover:border-accent/40"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-600/70 bg-ink-900/70">
                          <Icon className="h-4 w-4 text-accent-soft" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-semibold text-slate-100">{item.label}</span>
                            <span className={`mono shrink-0 text-[10px] ${item.available ? "text-cyber" : "text-slate-600"}`}>
                              {item.count}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">{item.description}</span>
                          {item.samples.length > 0 && (
                            <span className="mono mt-1 block truncate text-[10px] text-slate-600">{item.samples[0]}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <EntryCard overview={overview} />
              </>
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <Panel title="Project snapshot" bodyClassName="!py-3">
              <dl className="space-y-1.5 text-[11px]">
                <Row label="Files" value={overview.index.files.toLocaleString()} />
                <Row label="Folders" value={overview.index.folders.toLocaleString()} />
                <Row label="With cached text" value={overview.index.withContent.toLocaleString()} />
                <Row label="Cases" value={overview.index.caseCount.toLocaleString()} />
                <Row label="Functions" value={overview.index.functionCount.toLocaleString()} />
                <Row label="Last scan" value={overview.lastScan?.at ? relative(overview.lastScan.at) : "never"} />
                <Row
                  label="Scan result"
                  value={
                    overview.lastScan
                      ? `${overview.lastScan.status} · +${overview.lastScan.added} ~${overview.lastScan.changed} −${overview.lastScan.deleted}`
                      : "—"
                  }
                />
                <Row label="Root" value={overview.server.root} mono />
              </dl>
              {overview.lastScan?.message && (
                <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{overview.lastScan.message}</p>
              )}
              <button className="btn-ghost mt-3 w-full !py-1.5 text-[11px]" onClick={() => void rescan()} disabled={scanning}>
                {scanning ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Scan project again
              </button>
            </Panel>

            <Panel title="package.json" bodyClassName="!py-3">
              {overview.package.path ? (
                <>
                  <p className="mono truncate text-[11px] text-slate-300">{overview.package.path}</p>
                  <p className="mt-1 text-[10px] text-slate-500">
                    {overview.package.name ?? "(no name)"} {overview.package.version ? `v${overview.package.version}` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge tone="accent">{overview.package.dependencies.length} deps</Badge>
                    <Badge tone="default">{overview.package.scripts.length} scripts</Badge>
                    {overview.package.problems.length > 0 && (
                      <Badge tone="warn">{overview.package.problems.length} problems</Badge>
                    )}
                  </div>
                  <button
                    className="btn-ghost mt-2 w-full !py-1.5 text-[11px]"
                    onClick={() => void openCategory("package")}
                  >
                    <Package className="h-3.5 w-3.5" /> Open dependencies
                  </button>
                </>
              ) : (
                <p className="text-[11px] text-slate-500">No package.json was found in the indexed project.</p>
              )}
            </Panel>
          </div>
        </div>
      )}

      {/* Folder navigation sheet */}
      <Modal
        open={navOpen}
        onClose={() => setNavOpen(false)}
        title="Project navigation"
        subtitle="Categories are discovered from the real files, not from fixed folder names"
        footer={
          <button className="btn-ghost" onClick={() => setNavOpen(false)}>
            Close
          </button>
        }
      >
        <div className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.Icon;
            return (
              <button
                key={item.id}
                onClick={() => void openCategory(item.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition ${
                  category === item.id ? "bg-accent/13 text-white" : "text-slate-300 hover:bg-ink-800"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0 text-accent-soft" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{item.label}</span>
                  <span className="block truncate text-[10px] text-slate-500">{item.samples[0] ?? item.description}</span>
                </span>
                <span className="mono shrink-0 text-[10px] text-slate-500">{item.count}</span>
              </button>
            );
          })}
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-ink-750 pt-2">
            <button className="btn-ghost !py-2 text-[11px]" onClick={() => { setNavOpen(false); setCreateTarget({ kind: "file", path: "/" }); }}>
              <FilePlus2 className="h-3.5 w-3.5" /> New file
            </button>
            <button className="btn-ghost !py-2 text-[11px]" onClick={() => { setNavOpen(false); setCreateTarget({ kind: "folder", path: "/" }); }}>
              <FolderPlus className="h-3.5 w-3.5" /> New folder
            </button>
          </div>
        </div>
      </Modal>

      {/* File information + actions */}
      <Modal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={detail ? detail.name : "File"}
        subtitle={detail?.path}
        footer={
          detail ? (
            <div className="flex w-full flex-wrap items-center gap-1.5">
              {detail.editable && (
                <Link className="btn-primary !px-2 !py-1.5 text-[11px]" href={editorHref(detail.path)}>
                  <Pencil className="h-3 w-3" /> Open in editor
                </Link>
              )}
              <button
                className="btn-ghost !px-2 !py-1.5 text-[11px]"
                onClick={() => void download(`/api/files/download?serverId=${activeId}&mode=file&path=${encodeURIComponent(detail.path)}`).catch((err) => push(errorMessage(err), "error"))}
              >
                <Download className="h-3 w-3" /> Download
              </button>
              {(detail.editable || detail.isDirectory) && (
                <>
                  <button className="btn-ghost !px-2 !py-1.5 text-[11px]" onClick={() => setRenameTarget({ path: detail.path, name: detail.name })}>
                    <Pencil className="h-3 w-3" /> Rename
                  </button>
                  <button
                    className="btn-ghost !px-2 !py-1.5 text-[11px]"
                    onClick={() => setMoveTarget({ path: detail.path, destination: detail.path.split("/").slice(0, -1).join("/") || "/" })}
                  >
                    Move
                  </button>
                  {detail.editable && (
                    <button className="btn-ghost !px-2 !py-1.5 text-[11px]" onClick={() => pickReplacement(detail.path)}>
                      <Upload className="h-3 w-3" /> Replace
                    </button>
                  )}
                </>
              )}
              {detail.deletable && (
                <button
                  className="btn-danger !px-2 !py-1.5 text-[11px]"
                  onClick={() => requestDelete(detail.path, detail.isDirectory)}
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </button>
              )}
            </div>
          ) : null
        }
      >
        {detailLoading || !detail ? (
          <div className="flex items-center gap-2 py-6 text-xs text-slate-500"><Spinner /> Reading file…</div>
        ) : (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
              <Row label="Name" value={detail.name} />
              <Row label="Type" value={detail.language ?? detail.extension ?? "—"} />
              <Row label="Size" value={formatSize(detail.sizeBytes)} />
              <Row label="Modified" value={detail.modifiedAt ? relative(detail.modifiedAt) : "—"} />
              <Row label="SHA-256" value={detail.sha256 ? `${detail.sha256.slice(0, 16)}…` : "—"} mono />
              <Row label="Draft" value={detail.draft ? `${formatSize(detail.draft.bytes)} · ${detail.draft.status}` : "none"} />
              <Row label="Versions" value={`${detail.versions.count}${detail.versions.latest ? ` · latest v${detail.versions.latest.version}` : ""}`} />
              <Row label="Categories" value={detail.categories.map((entry) => entry.id).join(", ") || "—"} />
            </dl>
            <p className="mono break-all rounded-lg border border-ink-700/60 bg-ink-900/60 px-2 py-1.5 text-[10px] text-slate-400">
              {detail.path}
            </p>

            {detail.protectedData && (
              <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200">
                Production records: download only. Editing and deletion are refused.
              </p>
            )}
            {detail.secret && (
              <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[10px] text-rose-200">
                Credential file ({detail.secretKind ?? "protected"}): content is never read or shown.
              </p>
            )}

            {detail.symbols.cases.length > 0 && (
              <div>
                <p className="label mb-1">Commands / cases ({detail.symbols.cases.length})</p>
                <div className="flex flex-wrap gap-1">
                  {detail.symbols.cases.slice(0, 24).map((entry) => (
                    <Link
                      key={`${entry.name}-${entry.line}`}
                      href={editorHref(detail.path, entry.line)}
                      className="chip mono !text-[10px] hover:border-accent/50"
                      title={`line ${entry.line}${entry.aliases.length ? ` · aliases: ${entry.aliases.join(", ")}` : ""}`}
                    >
                      {entry.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {detail.symbols.functions.length > 0 && (
              <div>
                <p className="label mb-1">Functions ({detail.symbols.functions.length})</p>
                <div className="flex flex-wrap gap-1">
                  {detail.symbols.functions.slice(0, 20).map((entry) => (
                    <Link
                      key={`${entry.name}-${entry.line}`}
                      href={editorHref(detail.path, entry.line)}
                      className="chip mono !text-[10px] hover:border-accent/50"
                      title={`line ${entry.line}`}
                    >
                      {entry.name}()
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {detail.imports.length > 0 && (
              <div>
                <p className="label mb-1">Imports ({detail.imports.length})</p>
                <ul className="space-y-0.5 text-[10px]">
                  {detail.imports.slice(0, 12).map((entry, index) => (
                    <li key={`${entry.specifier}-${index}`} className="flex items-baseline gap-1.5">
                      <span className="mono shrink-0 text-slate-600">L{entry.line}</span>
                      {entry.resolvedPath ? (
                        <button className="mono truncate text-cyber hover:underline" onClick={() => void showDetail(entry.resolvedPath!)}>
                          {entry.specifier}
                        </button>
                      ) : (
                        <span className={`mono truncate ${entry.external ? "text-slate-400" : "text-rose-300"}`}>
                          {entry.specifier}
                          {entry.external ? " (package)" : " (missing)"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.importedBy.length > 0 && (
              <div>
                <p className="label mb-1">Imported by ({detail.importedBy.length})</p>
                <ul className="space-y-0.5 text-[10px]">
                  {detail.importedBy.slice(0, 12).map((entry, index) => (
                    <li key={`${entry.path}-${index}`}>
                      <button className="mono truncate text-left text-cyber hover:underline" onClick={() => void showDetail(entry.path)}>
                        {entry.path}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.notes.map((note, index) => (
              <p key={index} className="text-[10px] leading-relaxed text-slate-500">{note}</p>
            ))}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => (confirmDelete ? void deleteFile(confirmDelete) : undefined)}
        busy={busy}
        title={confirmDelete?.isDirectory ? "Delete this folder?" : "Delete this production file?"}
        requireText={confirmDelete?.isDirectory ? confirmDelete.name : undefined}
        description={
          <div className="space-y-2">
            <p className="mono break-all text-[11px] text-slate-300">{confirmDelete?.path}</p>
            {confirmDelete?.isDirectory ? (
              <p className="text-[11px] leading-relaxed text-amber-200">
                Everything inside this folder is removed with it. Files are backed up as versions first; folders that
                contain credentials or production records are refused.
              </p>
            ) : (
              <p>The file is backed up as a version first, then removed from the panel. You can restore it from Backups &amp; Versions.</p>
            )}
          </div>
        }
        confirmLabel="Back up & delete"
      />

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Rename"
        subtitle={renameTarget?.path}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setRenameTarget(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => void submitRename()} disabled={busy}>
              {busy ? <Spinner /> : null} Rename
            </button>
          </>
        }
      >
        <input
          className="field mono text-xs"
          value={renameTarget?.name ?? ""}
          onChange={(event) => setRenameTarget((state) => (state ? { ...state, name: event.target.value } : state))}
          autoCapitalize="off"
          spellCheck={false}
        />
      </Modal>

      <Modal
        open={moveTarget !== null}
        onClose={() => setMoveTarget(null)}
        title="Move"
        subtitle={moveTarget?.path}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setMoveTarget(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => void submitMove()} disabled={busy}>
              {busy ? <Spinner /> : null} Move
            </button>
          </>
        }
      >
        <label className="label">Destination folder</label>
        <input
          className="field mono mt-1 text-xs"
          placeholder="/plugins"
          value={moveTarget?.destination ?? ""}
          onChange={(event) => setMoveTarget((state) => (state ? { ...state, destination: event.target.value } : state))}
          autoCapitalize="off"
          spellCheck={false}
        />
      </Modal>

      <Modal
        open={createTarget !== null}
        onClose={() => setCreateTarget(null)}
        title={createTarget?.kind === "folder" ? "New folder" : "New file"}
        subtitle="A full path inside the project root"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setCreateTarget(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => void submitCreate()} disabled={busy}>
              {busy ? <Spinner /> : null} Create
            </button>
          </>
        }
      >
        <input
          className="field mono text-xs"
          placeholder={createTarget?.kind === "folder" ? "/plugins/new-plugin" : "/plugins/new-plugin/index.js"}
          value={createTarget?.path ?? ""}
          onChange={(event) => setCreateTarget((state) => (state ? { ...state, path: event.target.value } : state))}
          autoCapitalize="off"
          spellCheck={false}
        />
      </Modal>

      <input
        ref={replaceInput}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadReplacement(file);
        }}
      />
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-slate-200 ${mono ? "mono text-[10px]" : ""}`}>{value}</dd>
    </div>
  );
}

function Warnings({ warnings }: { warnings: ExplorerOverview["warnings"] }) {
  if (!warnings.length) return null;
  return (
    <div className="space-y-1.5">
      {warnings.map((warning) => (
        <div
          key={warning.code + (warning.path ?? "")}
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 leading-relaxed">{warning.message}</span>
        </div>
      ))}
    </div>
  );
}

function EntryCard({ overview }: { overview: ExplorerOverview }) {
  const entry = overview.entry;
  return (
    <Panel title="Entry point" subtitle="Resolved from the panel startup command, package.json and the import graph" bodyClassName="!py-3">
      {entry.path ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={editorHref(entry.path)} className="mono min-w-0 truncate text-xs text-accent-soft hover:underline">
              {entry.path}
            </Link>
            <Badge tone="good">verified</Badge>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{entry.evidence}</p>
        </>
      ) : (
        <p className="text-[11px] text-amber-300">No entry point could be verified. {entry.note}</p>
      )}
      {entry.startupCommand && (
        <p className="mono mt-2 break-all rounded border border-ink-700/60 bg-ink-900/60 px-2 py-1 text-[10px] text-slate-400">
          {entry.startupCommand}
        </p>
      )}
      {entry.note && entry.path && <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{entry.note}</p>}
      {entry.candidates.length > 1 && (
        <div className="mt-2 border-t border-ink-750/60 pt-2">
          <p className="label mb-1">Candidates</p>
          <ul className="space-y-1 text-[10px]">
            {entry.candidates.slice(1, 5).map((candidate) => (
              <li key={candidate.path} className="flex items-baseline justify-between gap-2">
                <Link href={editorHref(candidate.path)} className="mono min-w-0 truncate text-slate-400 hover:text-slate-200">
                  {candidate.path}
                </Link>
                <span className="mono shrink-0 text-slate-600">{candidate.score}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function SearchResults({
  result,
  searching,
  onOpen,
  onExpand,
  lineHref,
}: {
  result: ExplorerSearchResult | null;
  searching: boolean;
  onOpen: (path: string, line?: number) => void;
  onExpand: (path: string) => void;
  lineHref: (path: string, line?: number) => string;
}) {
  if (searching && !result) {
    return (
      <Panel bodyClassName="!py-4">
        <div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Searching the project…</div>
      </Panel>
    );
  }
  if (!result) return null;
  return (
    <Panel
      title={`Search: ${result.query}`}
      subtitle={`${result.totalMatches} matches${result.snapshotAt ? ` · index ${relative(result.snapshotAt)}` : ""}`}
      bodyClassName="!py-3"
    >
      {result.symbols.length > 0 && (
        <div className="mb-3">
          <p className="label mb-1">Commands &amp; functions</p>
          <div className="divide-y divide-ink-750/60">
            {result.symbols.map((symbol) => (
              <div key={`${symbol.kind}-${symbol.path}-${symbol.name}-${symbol.line}`} className="flex items-center gap-2 py-1.5">
                <Badge tone={symbol.kind === "case" ? "accent" : "cyber"}>{symbol.kind}</Badge>
                <Link href={lineHref(symbol.path, symbol.line)} className="mono min-w-0 flex-1 truncate text-[11px] text-slate-200 hover:text-white">
                  {symbol.name}
                </Link>
                <button className="mono max-w-[45%] shrink-0 truncate text-[10px] text-slate-500 hover:text-cyber" onClick={() => onExpand(symbol.path)}>
                  {symbol.path.split("/").pop()} · L{symbol.line}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.names.length > 0 && (
        <div className="mb-3">
          <p className="label mb-1">Files &amp; folders</p>
          <div className="flex flex-wrap gap-1">
            {result.names.slice(0, 16).map((entry) => (
              <button
                key={entry.path}
                className="chip mono max-w-full !text-[10px] hover:border-accent/50"
                onClick={() => (entry.isDirectory ? onExpand(entry.path) : onOpen(entry.path))}
              >
                <span className="truncate">{entry.path}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {result.files.length > 0 && (
        <div>
          <p className="label mb-1">Code matches</p>
          <div className="space-y-2">
            {result.files.slice(0, 30).map((file) => (
              <div key={file.path} className="rounded-lg border border-ink-700/60 bg-ink-900/40 p-2">
                <div className="flex items-center gap-2">
                  <button className="mono min-w-0 flex-1 truncate text-left text-[11px] text-slate-200 hover:text-white" onClick={() => onExpand(file.path)}>
                    {file.path}
                  </button>
                  <span className="shrink-0 text-[10px] text-slate-500">{file.matches}</span>
                  <Link className="shrink-0 text-[10px] text-accent-soft hover:underline" href={lineHref(file.path, file.hits[0]?.line)}>
                    open
                  </Link>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {file.hits.slice(0, 3).map((hit) => (
                    <li key={`${file.path}-${hit.line}-${hit.column}`} className="flex items-baseline gap-1.5">
                      <Link href={lineHref(file.path, hit.line)} className="mono shrink-0 text-[10px] text-slate-600 hover:text-cyber">
                        L{hit.line}
                      </Link>
                      <span className="mono min-w-0 truncate text-[10px] text-slate-400">{hit.text.trim()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.notes.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-ink-750/60 pt-2">
          {result.notes.map((note, index) => (
            <p key={index} className="text-[10px] leading-relaxed text-slate-500">{note}</p>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ItemRow({
  item,
  expanded,
  onToggle,
  onInfo,
  onRename,
  onMove,
  onReplace,
  onDelete,
}: {
  item: ExplorerItem;
  expanded: boolean;
  onToggle: () => void;
  onInfo: (path: string) => void;
  onRename: (path: string) => void;
  onMove: (path: string) => void;
  onReplace: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const hasChildren = Boolean(item.children?.length);
  return (
    <div className="py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {item.path ? (
              <button className="mono min-w-0 max-w-full truncate text-left text-[12px] font-medium text-slate-100 hover:text-white" onClick={() => onInfo(item.path!)}>
                {item.name}
              </button>
            ) : (
              <span className="mono min-w-0 max-w-full truncate text-[12px] font-medium text-slate-100">{item.name}</span>
            )}
            {(item.badges ?? []).map((badge) => (
              <Badge
                key={badge}
                tone={
                  badge === "entry point"
                    ? "good"
                    : ["protected", "unreferenced", "outdated", "missing", "unpinned"].includes(badge)
                      ? "warn"
                      : "default"
                }
              >
                {badge}
              </Badge>
            ))}
            {item.count !== undefined && <span className="mono text-[10px] text-slate-500">{item.count}</span>}
          </div>
          {item.subtitle && <p className="mono mt-0.5 truncate text-[10px] text-slate-600">{item.subtitle}</p>}
          {item.detail && <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-slate-500">{item.detail}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {item.path && item.editable && (
            <Link href={editorHref(item.path)} className="rounded p-2 text-slate-400 hover:bg-ink-800 hover:text-white" title="Open in editor">
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
          {item.path && (
            <button className="rounded p-2 text-slate-400 hover:bg-ink-800 hover:text-white" onClick={() => onInfo(item.path!)} title="File information">
              <Info className="h-3.5 w-3.5" />
            </button>
          )}
          {item.path && item.editable && (
            <>
              <button className="rounded p-2 text-slate-400 hover:bg-ink-800 hover:text-white" onClick={() => onReplace(item.path!)} title="Replace file">
                <Upload className="h-3.5 w-3.5" />
              </button>
              <button className="rounded p-2 text-slate-400 hover:bg-ink-800 hover:text-white" onClick={() => onRename(item.path!)} title="Rename">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button className="rounded p-2 text-slate-400 hover:bg-ink-800 hover:text-rose-300" onClick={() => onDelete(item.path!)} title="Delete">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {hasChildren && (
            <button className="rounded p-2 text-slate-400 hover:bg-ink-800 hover:text-white" onClick={onToggle} title="Show items">
              <ChevronRight className={`h-3.5 w-3.5 transition ${expanded ? "rotate-90" : ""}`} />
            </button>
          )}
        </div>
      </div>
      {expanded && hasChildren && (
        <ul className="mt-1 space-y-0.5 border-l border-ink-700/70 pl-3">
          {item.children!.map((child) => (
            <li key={`${child.path}-${child.name}-${child.line ?? 0}`} className="flex items-baseline gap-2">
              {child.line ? (
                <Link href={editorHref(child.path, child.line)} className="mono min-w-0 truncate text-[10px] text-slate-300 hover:text-cyber">
                  {child.name}
                  <span className="text-slate-600"> L{child.line}</span>
                </Link>
              ) : (
                <Link href={editorHref(child.path)} className="mono min-w-0 truncate text-[10px] text-slate-300 hover:text-cyber">
                  {child.name}
                </Link>
              )}
              {child.detail && <span className="min-w-0 truncate text-[10px] text-slate-600">{child.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
