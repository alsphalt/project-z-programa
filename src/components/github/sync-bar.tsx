"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Github,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  Settings,
  UploadCloud,
} from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, errorMessage } from "@/lib/client";
import { useToast } from "@/components/providers";
import { Badge, Modal, Spinner } from "@/components/ui";
import { relative } from "@/lib/format";

/**
 * The one GitHub control surface used by FILE MANAGER and the CODE EDITOR.
 *
 * It never talks to GitHub directly: every action is a call to
 * `/api/github/files`, which records the change in the shared working copy and
 * lets the shared queue push it. The status shown here is the status of that
 * queue — a push is only ever reported as successful after GitHub confirmed the
 * commit.
 */

export type ServerSyncView = {
  serverId: string;
  bound: boolean;
  connection: {
    connected: boolean;
    accountLogin: string | null;
    repository: string | null;
    branch: string | null;
    autoSync: boolean;
    syncDelaySeconds: number;
    reason: string | null;
  };
  binding: { id: string; pathPrefix: string; autoSync: boolean; projectId: string } | null;
  project: {
    id: string;
    name: string;
    repo: string | null;
    branch: string | null;
    syncStatus: string;
    syncError: string | null;
    lastSyncAt: string | null;
    lastCommitSha: string | null;
    lastCommitUrl: string | null;
    lastCommitMessage: string | null;
    pendingFiles: number;
  } | null;
  pending: { count: number; dueAt: string | null; files: string[] } | null;
  events: Array<{ id: number; level: string; phase: string | null; message: string; at: string }>;
  limits: { maxPathsPerCall: number; maxImportFiles: number };
};

type Repo = { owner: string; name: string; fullName: string; defaultBranch: string; private: boolean };

function statusTone(status: string | null | undefined): "ok" | "warn" | "error" | "muted" {
  if (status === "synced") return "ok";
  if (status === "conflict" || status === "failed") return "error";
  if (status === "pending" || status === "syncing") return "warn";
  return "muted";
}

function statusLabel(view: ServerSyncView | null): string {
  if (!view) return "CHECKING";
  if (!view.connection.connected) return "GITHUB NOT CONNECTED";
  if (!view.bound) return "NOT BOUND";
  const status = view.project?.syncStatus;
  if (status === "synced") return "SYNCHRONIZED";
  if (status === "syncing") return "PUSHING";
  if (status === "pending") return "CHANGES PENDING";
  if (status === "conflict") return "CONFLICT";
  if (status === "failed") return "SYNC FAILED";
  if (status === "disabled") return "DISABLED";
  return "UP TO DATE";
}

export function GitHubSyncBar({
  serverId,
  selection,
  pulse = 0,
  onAfterChange,
  compact = false,
  label = "GITHUB",
}: {
  serverId: string | null;
  /** Files the user selected (folders are ignored). Empty means "everything pending". */
  selection: string[];
  /** Bump to refresh immediately after a local write. */
  pulse?: number;
  onAfterChange?: () => void | Promise<void>;
  compact?: boolean;
  label?: string;
}) {
  const { push } = useToast();
  const [view, setView] = useState<ServerSyncView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!compact);
  const [bindOpen, setBindOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [bind, setBind] = useState({ owner: "", repo: "", branch: "", pathPrefix: "", autoSync: true });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (tick = false) => {
      if (!serverId) return;
      try {
        const data = await apiGet<{ sync: ServerSyncView }>(
          `/api/github/files?serverId=${serverId}${tick ? "&tick=1" : ""}`,
        );
        if (!mounted.current) return;
        setView(data.sync);
        setError(null);
      } catch (err) {
        if (mounted.current) setError(errorMessage(err));
      }
    },
    [serverId],
  );

  useEffect(() => {
    void load(false);
  }, [load, pulse]);

  // Poll while something is queued, slowly otherwise: the pending state is the
  // only one that changes without a user action.
  //
  // The timer stops while the tab is hidden and one read runs on return. A
  // background tab on Android still gets its timers, so a dashboard left open
  // used to keep a request every 4 s alive for as long as the phone stayed
  // awake — the same reason `useApi` drops its interval on `hidden`.
  useEffect(() => {
    if (!serverId) return;
    const active = view?.project?.syncStatus === "pending" || view?.project?.syncStatus === "syncing";
    const every = active ? 4000 : 25000;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => void load(active), every);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) {
        stop();
        return;
      }
      start();
      void load(active);
    };

    if (typeof document === "undefined" || !document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, serverId, view?.project?.syncStatus]);

  const fileSelection = useMemo(
    () => selection.filter((path) => !path.endsWith("/")),
    [selection],
  );

  const act = useCallback(
    async (key: string, action: string, extra: Record<string, unknown> = {}, done?: string) => {
      if (!serverId) return;
      setBusy(key);
      try {
        const data = await apiPost<{ sync: ServerSyncView; result?: { reason?: string; message?: string } }>(
          "/api/github/files",
          { serverId, action, ...extra },
        );
        if (mounted.current) setView(data.sync);
        const detail = data.result?.message ?? data.result?.reason;
        push(done ?? detail ?? "Done", "ok");
        await load(false);
        await onAfterChange?.();
      } catch (err) {
        push(errorMessage(err), "error");
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [load, onAfterChange, push, serverId],
  );

  const submitBind = async () => {
    if (!serverId) return;
    const [owner, ...rest] = bind.owner.includes("/")
      ? [bind.owner.split("/")[0], bind.owner.split("/").slice(1).join("/")]
      : [bind.owner, bind.repo];
    const repo = bind.owner.includes("/") ? rest.join("/") : bind.repo;
    if (!owner?.trim() || !repo?.trim()) {
      push("Enter the repository as owner/name", "error");
      return;
    }
    setBusy("bind");
    try {
      const data = await apiPut<{ sync: ServerSyncView }>("/api/github/binding", {
        serverId,
        owner: owner.trim(),
        repo: repo.trim(),
        branch: bind.branch.trim() || undefined,
        pathPrefix: bind.pathPrefix.trim() || undefined,
        autoSync: bind.autoSync,
      });
      setView(data.sync);
      setBindOpen(false);
      push("Repository bound — pushes and pulls now use the shared GitHub connection", "ok");
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async () => {
    if (!serverId || !view?.binding) return;
    setBusy("auto");
    try {
      const next = !view.binding.autoSync;
      const data = await apiPatch<{ sync: ServerSyncView }>("/api/github/binding", { serverId, autoSync: next });
      if (mounted.current) setView(data.sync);
      push(next ? "Automatic synchronization on" : "Automatic synchronization off", "ok");
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const unbind = async () => {
    if (!serverId) return;
    setBusy("unbind");
    try {
      await apiDelete(`/api/github/binding?serverId=${serverId}`);
      await load(false);
      push("Binding removed — local files are untouched", "ok");
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  if (!serverId) return null;

  const tone = statusTone(view?.project?.syncStatus);
  const chip =
    tone === "ok"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
        : tone === "error"
          ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
          : "border-ink-700 bg-ink-900/70 text-slate-400";

  return (
    <div className="mb-3 rounded-lg border border-ink-700/70 bg-ink-900/40">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-300"
          onClick={() => setExpanded((value) => !value)}
        >
          <Github className="h-3.5 w-3.5 text-accent-soft" /> {label}
          <ChevronDown className={`h-3 w-3 transition ${expanded ? "" : "-rotate-90"}`} />
        </button>

        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${chip}`}>
          {statusLabel(view)}
        </span>

        {view?.project?.repo && (
          <span className="mono text-[10px] text-slate-500">
            {view.project.repo}
            {view.project.branch ? `@${view.project.branch}` : ""}
            {view.binding?.pathPrefix ? `:${view.binding.pathPrefix}` : ""}
          </span>
        )}

        {view?.project?.pendingFiles ? (
          <Badge tone="warn">{view.project.pendingFiles} pending</Badge>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {view?.connection.connected && view.bound && (
            <>
              <button
                className="btn-ghost !py-1 text-[11px]"
                disabled={busy !== null}
                onClick={() =>
                  fileSelection.length
                    ? void act("push", "push", { paths: fileSelection }, `Pushing ${fileSelection.length} file(s)…`)
                    : void act("push", "sync", {}, "Pushing everything pending")
                }
                title={fileSelection.length ? "Push the selected files" : "Push everything pending"}
              >
                {busy === "push" ? <Spinner /> : <ArrowUpFromLine className="h-3 w-3" />} Push
              </button>
              <button
                className="btn-ghost !py-1 text-[11px]"
                disabled={busy !== null || !fileSelection.length}
                onClick={() => void act("pull", "pull", { paths: fileSelection }, `Pulled ${fileSelection.length} file(s)`) }
                title={fileSelection.length ? "Replace the selected files with the remote version" : "Select files to pull"}
              >
                {busy === "pull" ? <Spinner /> : <ArrowDownToLine className="h-3 w-3" />} Pull
              </button>
              <button
                className="btn-ghost !py-1 text-[11px]"
                disabled={busy !== null}
                onClick={() => setCommitOpen(true)}
                title="Push with your own commit message"
              >
                <GitCommitHorizontal className="h-3 w-3" /> Commit
              </button>
              <button className="btn-ghost !py-1 text-[11px]" disabled={busy !== null} onClick={() => void load(true)}>
                {busy === "sync" ? <Spinner /> : <RefreshCw className="h-3 w-3" />} Sync now
              </button>
            </>
          )}
          {view?.connection.connected && !view.bound && (
            <button className="btn-primary !py-1 text-[11px]" onClick={() => setBindOpen(true)}>
              <Github className="h-3 w-3" /> Bind repository
            </button>
          )}
          {!view?.connection.connected && (
            <Link href="/settings?tab=github" className="btn-ghost !py-1 text-[11px]">
              <Settings className="h-3 w-3" /> Configure GitHub
            </Link>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-ink-750/60 px-3 py-2 text-[11px]">
          {error && <p className="mb-1 text-rose-300">{error}</p>}

          {view && !view.connection.connected && (
            <p className="text-slate-500">
              {view.connection.reason ?? "GitHub is not connected."} A repository can only be bound once a token or
              OAuth app is configured — the same connection is used by LIVE MONITORING and CRASH AND FIX.
            </p>
          )}

          {view?.connection.connected && !view.bound && (
            <p className="text-slate-500">
              Connected as <span className="mono text-slate-300">{view.connection.accountLogin ?? "unknown"}</span>.
              Bind this server to a repository to enable push, pull and status here. The default repository
              {view.connection.repository ? ` (${view.connection.repository})` : ""} is offered first.
            </p>
          )}

          {view?.bound && view.project && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-500">
                <span>
                  Automatic:{" "}
                  <span className={view.binding?.autoSync ? "text-emerald-300" : "text-amber-300"}>
                    {view.binding?.autoSync ? `on · ${view.connection.syncDelaySeconds}s debounce` : "off"}
                  </span>
                </span>
                <button className="text-accent-soft hover:underline" onClick={() => void toggleAuto()} disabled={busy !== null}>
                  {view.binding?.autoSync ? "Disable" : "Enable"}
                </button>
                {view.project.lastSyncAt && <span>last sync {relative(view.project.lastSyncAt)}</span>}
                {view.pending?.dueAt && <span>next push {relative(view.pending.dueAt)}</span>}
                {view.project.lastCommitUrl && (
                  <a
                    className="mono text-accent-soft hover:underline"
                    href={view.project.lastCommitUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {view.project.lastCommitSha?.slice(0, 7)}
                  </a>
                )}
                <button className="text-slate-500 hover:text-rose-300" onClick={() => void unbind()} disabled={busy !== null}>
                  Unbind
                </button>
              </div>

              {view.project.syncError && (
                <p className="flex items-start gap-1.5 rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1 text-rose-200">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{view.project.syncError}</span>
                </p>
              )}

              {view.project.syncStatus === "conflict" && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    className="btn-ghost !py-1 text-[11px]"
                    disabled={busy !== null}
                    onClick={() => void act("merge", "resolve", { mode: "merge-remote" }, "Rebased on the remote branch")}
                  >
                    Rebase &amp; push
                  </button>
                  <button
                    className="btn-ghost !py-1 text-[11px]"
                    disabled={busy !== null}
                    onClick={() => void act("discard", "resolve", { mode: "discard-local" }, "Local edits discarded")}
                  >
                    Discard local
                  </button>
                  <span className="text-slate-500">
                    Nothing was overwritten: the local copy is intact until you choose.
                  </span>
                </div>
              )}

              {view.pending?.files?.length ? (
                <p className="mono truncate text-slate-500">
                  queued: {view.pending.files.slice(0, 6).join(", ")}
                  {view.pending.files.length > 6 ? ` +${view.pending.files.length - 6}` : ""}
                </p>
              ) : null}

              {view.events.length > 0 && (
                <ul className="space-y-0.5">
                  {view.events.slice(0, 4).map((event) => (
                    <li
                      key={event.id}
                      className={`mono truncate ${
                        event.level === "success"
                          ? "text-emerald-300"
                          : event.level === "error"
                            ? "text-rose-300"
                            : event.level === "warn"
                              ? "text-amber-200"
                              : "text-slate-500"
                      }`}
                    >
                      {event.message}
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <button className="btn-ghost !py-1 text-[11px]" onClick={() => setImportOpen(true)}>
                  <UploadCloud className="h-3 w-3" /> Import from GitHub
                </button>
                <span className="text-slate-600">
                  Files are pulled into the current folder. Credentials and binaries are skipped.
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bind repository */}
      <Modal
        open={bindOpen}
        onClose={() => setBindOpen(false)}
        title="Bind this server to a repository"
        subtitle="One connection, one repository configuration. The same token and the same queue are used by CRASH AND FIX."
        footer={
          <>
            <button className="btn-ghost" onClick={() => setBindOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={busy !== null} onClick={() => void submitBind()}>
              {busy === "bind" ? <Spinner /> : <Check className="h-3.5 w-3.5" />} Bind
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Repository</label>
            <input
              className="field mono mt-1"
              placeholder={view?.connection.repository ?? "owner/repository"}
              value={bind.owner}
              onChange={(event) => {
                const value = event.target.value;
                if (value.includes("/")) {
                  const [owner, ...rest] = value.split("/");
                  setBind((current) => ({ ...current, owner: value, repo: rest.join("/") }));
                } else {
                  setBind((current) => ({ ...current, owner: value }));
                }
              }}
            />
            <p className="mt-1 text-[11px] text-slate-500">
              The repository is read through the connected token before it is stored, so “bound” always means GitHub
              answered.
            </p>
          </div>
          {!bind.owner.includes("/") && (
            <div>
              <label className="label">Repository name</label>
              <input
                className="field mono mt-1"
                value={bind.repo}
                onChange={(event) => setBind((current) => ({ ...current, repo: event.target.value }))}
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Branch</label>
              <input
                className="field mono mt-1"
                placeholder={view?.connection.branch ?? "default branch"}
                value={bind.branch}
                onChange={(event) => setBind((current) => ({ ...current, branch: event.target.value }))}
              />
            </div>
            <div>
              <label className="label">Repository folder (optional)</label>
              <input
                className="field mono mt-1"
                placeholder="e.g. bot"
                value={bind.pathPrefix}
                onChange={(event) => setBind((current) => ({ ...current, pathPrefix: event.target.value }))}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={bind.autoSync}
              onChange={(event) => setBind((current) => ({ ...current, autoSync: event.target.checked }))}
            />
            Push automatically ~{view?.connection.syncDelaySeconds ?? 5}s after the last save
          </label>
        </div>
      </Modal>

      {/* Commit changes */}
      <Modal
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        title="Commit changes"
        subtitle="Your first line becomes the commit subject. The file list is always appended."
        footer={
          <>
            <button className="btn-ghost" onClick={() => setCommitOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={busy !== null || !commitMessage.trim()}
              onClick={() => {
                setCommitOpen(false);
                void act(
                  "commit",
                  "push",
                  {
                    message: commitMessage.trim(),
                    paths: fileSelection.length ? fileSelection : undefined,
                  },
                  "Commit requested — GitHub must confirm before it counts",
                );
                setCommitMessage("");
              }}
            >
              {busy === "commit" ? <Spinner /> : <GitCommitHorizontal className="h-3.5 w-3.5" />} Commit &amp; push
            </button>
          </>
        }
      >
        <input
          className="field"
          placeholder="Fix the menu case handler"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          maxLength={120}
        />
        <p className="mt-2 text-[11px] text-slate-500">
          {fileSelection.length
            ? `${fileSelection.length} selected file(s) will be pushed.`
            : "Everything pending will be pushed."}
        </p>
      </Modal>

      <GitHubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        serverId={serverId}
        destination={selection.length === 1 && selection[0].endsWith("/") ? selection[0] : "/"}
        maxFiles={view?.limits.maxImportFiles ?? 120}
        defaultRepo={view?.project?.repo ?? view?.connection.repository ?? ""}
        defaultBranch={view?.project?.branch ?? view?.connection.branch ?? ""}
        onDone={async () => {
          await load(false);
          await onAfterChange?.();
        }}
      />
    </div>
  );
}

/**
 * Import files from a repository into the panel.
 *
 * Writes go through the normal backup + read-back path, so an import is
 * reversible file by file, and the counters shown are the counts the API
 * actually returned.
 */
export function GitHubImportDialog({
  open,
  onClose,
  serverId,
  destination,
  defaultRepo,
  defaultBranch,
  maxFiles,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  serverId: string;
  destination: string;
  defaultRepo: string;
  defaultBranch: string;
  maxFiles: number;
  onDone?: () => void | Promise<void>;
}) {
  const { push } = useToast();
  const [form, setForm] = useState({
    repo: defaultRepo,
    branch: defaultBranch,
    repoPrefix: "",
    destination,
    limit: 40,
  });
  const [repos, setRepos] = useState<Repo[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | null
    | {
        repo: string;
        branch: string;
        imported: Array<{ path: string; repoPath: string; bytes: number; hash: string }>;
        skipped: Array<{ path: string; reason: string }>;
        failed: Array<{ path: string; reason: string }>;
        truncated: boolean;
      }
  >(null);

  useEffect(() => {
    if (!open) return;
    setForm((current) => ({
      ...current,
      repo: current.repo || defaultRepo,
      branch: current.branch || defaultBranch,
      destination: current.destination || destination,
    }));
    apiGet<{ repos: Repo[] }>("/api/github/repos?perPage=60")
      .then((data) => setRepos(data.repos ?? []))
      .catch(() => setRepos([]));
  }, [defaultBranch, defaultRepo, destination, open]);

  const submit = async () => {
    const [owner, ...rest] = form.repo.split("/");
    const repo = rest.join("/");
    if (!owner || !repo) {
      push("Choose a repository as owner/name", "error");
      return;
    }
    setBusy(true);
    try {
      const data = await apiPost<{
        result: NonNullable<typeof result>;
      }>("/api/github/files", {
        serverId,
        action: "import",
        owner,
        repo,
        branch: form.branch || undefined,
        repoPrefix: form.repoPrefix || undefined,
        destination: form.destination || "/",
        limit: form.limit,
      });
      setResult(data.result);
      push(
        `Imported ${data.result.imported.length} file(s) — ${data.result.skipped.length} skipped, ${data.result.failed.length} failed`,
        data.result.failed.length ? "error" : "ok",
      );
      await onDone?.();
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Import from GitHub"
      subtitle="Reads the repository through the shared connection and writes real files into the panel, one backup at a time."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />} Import
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Repository</label>
          <input
            className="field mono mt-1"
            list="github-repo-list"
            placeholder="owner/repository"
            value={form.repo}
            onChange={(event) => setForm({ ...form, repo: event.target.value })}
          />
          <datalist id="github-repo-list">
            {repos.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>{`${repo.name}${repo.private ? " (private)" : ""}`}</option>
            ))}
          </datalist>
          <p className="mt-1 text-[11px] text-slate-500">
            {repos.length
              ? `${repos.length} repositories visible to the connected account.`
              : "Repository list unavailable — type owner/name (the token still decides what is readable)."}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Branch</label>
            <input
              className="field mono mt-1"
              value={form.branch}
              onChange={(event) => setForm({ ...form, branch: event.target.value })}
            />
          </div>
          <div>
            <label className="label">Repository folder</label>
            <input
              className="field mono mt-1"
              placeholder="(whole repository)"
              value={form.repoPrefix}
              onChange={(event) => setForm({ ...form, repoPrefix: event.target.value })}
            />
          </div>
          <div>
            <label className="label">Into panel folder</label>
            <input
              className="field mono mt-1"
              value={form.destination}
              onChange={(event) => setForm({ ...form, destination: event.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="label">Maximum files ({form.limit})</label>
          <input
            type="range"
            min={1}
            max={maxFiles}
            value={form.limit}
            onChange={(event) => setForm({ ...form, limit: Number(event.target.value) })}
            className="mt-1 w-full"
          />
          <p className="text-[11px] text-slate-500">
            A bounded import keeps the request short and the UI responsive — run it twice with a different folder for a
            bigger repository.
          </p>
        </div>

        {result && (
          <div className="space-y-2 rounded-lg border border-ink-700 bg-ink-950/50 p-2 text-[11px]">
            <p className="text-slate-300">
              {result.repo}@{result.branch}: {result.imported.length} imported, {result.skipped.length} skipped,
              {result.failed.length} failed{result.truncated ? " · stopped at the file limit" : ""}
            </p>
            {result.imported.slice(0, 8).map((file) => (
              <p key={file.path} className="mono truncate text-emerald-300">
                + {file.path}
              </p>
            ))}
            {result.failed.slice(0, 4).map((file) => (
              <p key={`f-${file.path}`} className="mono truncate text-rose-300">
                ! {file.path}: {file.reason}
              </p>
            ))}
            {result.skipped.slice(0, 4).map((file) => (
              <p key={`s-${file.path}`} className="mono truncate text-slate-500">
                – {file.path}: {file.reason}
              </p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
