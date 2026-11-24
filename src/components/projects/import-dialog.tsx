"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  FileArchive,
  FolderGit2,
  Github,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { Badge, Empty, Modal, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { apiGet, apiPost, errorMessage } from "@/lib/client";
import { bytes, relative } from "@/lib/format";

/**
 * Compact import chooser used by LIVE MONITORING → UPLOAD A FILE.
 *
 * Everything shown here is produced by the backend: the repository list comes
 * from the connected token, the progress bars come from real import jobs, and a
 * project is only reported as imported after its files are stored.
 */

type RepoOption = {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  language: string | null;
  updatedAt: string;
  defaultBranch: string;
  canPush: boolean;
};

type ImportOptions = {
  mode: "repository" | "account" | "none";
  connected: boolean;
  status: string;
  account: { login: string; avatar: string | null } | null;
  repository: RepoOption | null;
  configured: { owner: string; name: string; branch: string | null } | null;
  error: string | null;
  message: string;
};

type ImportJob = {
  id: string;
  status: "running" | "succeeded" | "failed";
  phase: string | null;
  totalFiles: number;
  fetchedFiles: number;
  totalBytes: number;
  skippedFiles: number;
  message: string | null;
  error: string | null;
};

type Summary = { files: number; textFiles: number; skipped: number; bytes: number; branch?: string; commitSha?: string; note?: string };

type FilePhase = "idle" | "uploading" | "extracting" | "done" | "error";

function csrf(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)dn_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}) {
  const { push } = useToast();
  const [step, setStep] = useState<"choose" | "file" | "github">("choose");

  // ---- device upload
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);
  const [filePhase, setFilePhase] = useState<FilePhase>("idle");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [uploadNames, setUploadNames] = useState<string[]>([]);

  // ---- github
  const [options, setOptions] = useState<ImportOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [branches, setBranches] = useState<Array<{ name: string; sha: string | null }>>([]);
  const [branch, setBranch] = useState<string>("");
  const [importing, setImporting] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setStep("choose");
    setFilePhase("idle");
    setUploadPercent(0);
    setJob(null);
    setFileError(null);
    setSummary(null);
    setUploadNames([]);
    setImporting(null);
    setBranches([]);
    setBranch("");
    setSearch("");
    setPage(1);
  }, [stopPolling]);

  const close = () => {
    stopPolling();
    onClose();
  };

  const pollJob = useCallback(
    (jobId: string) => {
      stopPolling();
      pollRef.current = window.setInterval(async () => {
        try {
          const data = await apiGet<{ job: ImportJob }>(`/api/projects/import/status?id=${jobId}`);
          setJob(data.job);
          if (data.job.status !== "running") stopPolling();
        } catch {
          stopPolling();
        }
      }, 700);
    },
    [stopPolling],
  );

  const loadRepos = useCallback(
    async (nextPage: number, query: string) => {
      setRepoLoading(true);
      setRepoError(null);
      try {
        const data = await apiGet<{ repos: RepoOption[]; hasMore: boolean }>(
          `/api/github/repos?page=${nextPage}&perPage=60&q=${encodeURIComponent(query)}`,
        );
        setRepos((current) => (nextPage === 1 ? data.repos : [...current, ...data.repos]));
        setHasMore(data.hasMore);
        setPage(nextPage);
      } catch (error) {
        setRepoError(errorMessage(error));
      } finally {
        setRepoLoading(false);
      }
    },
    [],
  );

  const openGithub = async () => {
    setStep("github");
    setOptionsLoading(true);
    setRepoError(null);
    try {
      const data = await apiGet<ImportOptions>("/api/github/import-options");
      setOptions(data);
      if (data.mode === "account") await loadRepos(1, "");
      if (data.mode === "repository" && data.repository) {
        setBranch(data.configured?.branch ?? data.repository.defaultBranch);
        const owner = data.repository.owner;
        const repo = data.repository.name;
        apiGet<{ branches: Array<{ name: string; sha: string | null }> }>(
          `/api/github/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
        )
          .then((result) => setBranches(result.branches))
          .catch(() => setBranches([]));
      }
    } catch (error) {
      setRepoError(errorMessage(error));
      setOptions(null);
    } finally {
      setOptionsLoading(false);
    }
  };

  /**
   * GitHub import, driven in batches.
   *
   * The server prepares the job (one tree read) and returns immediately; each
   * `batch` call stores the next few files. Nothing here downloads repository
   * content into the browser, and closing the tab only pauses the import — the
   * job resumes from its cursor when the same repository is imported again.
   */
  const startImport = async (repo: RepoOption, targetBranch?: string) => {
    setImporting(repo.fullName);
    setJob(null);
    setSummary(null);
    setRepoError(null);
    cancelRef.current = false;
    try {
      const started = await apiPost<{ jobId: string; job: ImportJob; reused: boolean; totalFiles: number }>(
        "/api/projects/import/github",
        { owner: repo.owner, repo: repo.name, branch: targetBranch || undefined },
      );

      let current = started.job;
      setJob(current);

      let guard = 0;
      while (current.status === "running" && !cancelRef.current && guard < 4000) {
        guard += 1;
        try {
          const step = await apiPost<{ job: ImportJob; done: boolean }>("/api/projects/import/batch", {
            jobId: started.jobId,
          });
          current = step.job;
          setJob(step.job);
          if (step.done) break;
        } catch (error) {
          // Keep whatever was stored and surface the real error.
          setRepoError(errorMessage(error));
          break;
        }
        // Yield between batches so the progress bar paints and the phone stays
        // responsive during a large import.
        await new Promise((resolve) => setTimeout(resolve, 60));
      }

      if (cancelRef.current) {
        await apiPost("/api/projects/import/batch", { jobId: started.jobId, action: "cancel" }).catch(() => undefined);
        setRepoError("Import cancelled. Files already stored remain available.");
        return;
      }

      if (current.status === "succeeded") {
        setSummary({
          files: current.fetchedFiles,
          textFiles: current.fetchedFiles,
          skipped: current.skippedFiles,
          bytes: current.totalBytes,
          branch: targetBranch || undefined,
        });
        push(`${repo.fullName} imported — ${current.fetchedFiles} files`, "ok");
        onImported?.();
      } else if (current.status === "failed") {
        setRepoError(current.error ?? "Import failed.");
      }
    } catch (error) {
      setRepoError(errorMessage(error));
      push(errorMessage(error), "error");
    } finally {
      setImporting(null);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const list = Array.from(files);
    setUploadNames(list.map((file) => file.name));
    setFilePhase("uploading");
    setUploadPercent(0);
    setFileError(null);
    setSummary(null);
    setJob(null);

    let jobId: string | null = null;
    try {
      const created = await apiPost<{ jobId: string }>("/api/projects/import/job", {
        source: "upload",
        message: "Receiving upload",
      });
      jobId = created.jobId;
      pollJob(jobId);
    } catch {
      jobId = null;
    }

    const form = new FormData();
    for (const file of list) form.append("files", file);
    if (jobId) form.append("jobId", jobId);

    const payload = await new Promise<{ ok: boolean; status: number; body: unknown }>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/projects/import/upload");
      xhr.setRequestHeader("x-csrf-token", csrf());
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setUploadPercent(Math.round((event.loaded / event.total) * 100));
          if (event.loaded >= event.total) setFilePhase("extracting");
        }
      };
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
      };
      xhr.onerror = () => resolve({ ok: false, status: 0, body: null });
      xhr.send(form);
    });

    stopPolling();

    if (!payload.ok) {
      const envelope = payload.body as { error?: string; code?: string } | null;
      setFilePhase("error");
      setFileError(envelope?.error ?? `Upload failed (${payload.status})`);
      return;
    }

    const envelope = payload.body as { data?: { summary?: Summary; project?: { name?: string } } } | null;
    setSummary(envelope?.data?.summary ?? null);
    setFilePhase("done");
    setUploadPercent(100);
    push(
      envelope?.data?.project?.name
        ? `${envelope.data.project.name} imported`
        : "Upload imported",
      "ok",
    );
    onImported?.();
  };

  const accountName = options?.account?.login ?? "GitHub";

  return (
    <Modal
      open={open}
      onClose={close}
      title={step === "choose" ? "Import a project" : step === "file" ? "Upload from this device" : "GitHub repositories"}
      subtitle={
        step === "choose"
          ? "Choose where the project comes from. Files are stored in the panel, never executed."
          : step === "file"
            ? "ZIP archives are extracted and registered as a project; single files are stored as-is."
            : options?.mode === "repository"
              ? "A repository is configured in Admin Settings."
              : accountName
      }
      footer={
        step === "choose" ? (
          <button className="btn-ghost" onClick={close}>
            Cancel
          </button>
        ) : (
          <>
            <button className="btn-ghost" onClick={() => reset()}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <button className="btn-primary" onClick={close}>
              Done
            </button>
          </>
        )
      }
    >
      {step === "choose" && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <button
            onClick={() => setStep("file")}
            className="group flex flex-col items-start gap-2 rounded-xl border border-ink-700/70 bg-ink-950/60 p-3.5 text-left transition hover:border-accent/50 hover:bg-accent/5"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-ink-600/70 bg-ink-900 text-accent-soft">
              <Upload className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold text-slate-100">📂 File Upload</span>
            <span className="text-[11px] leading-relaxed text-slate-500">
              ZIP archive, or individual .js / .json / .html / .css files from this device.
            </span>
          </button>

          <button
            onClick={() => void openGithub()}
            className="group flex flex-col items-start gap-2 rounded-xl border border-ink-700/70 bg-ink-950/60 p-3.5 text-left transition hover:border-cyber/50 hover:bg-cyber/5"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-ink-600/70 bg-ink-900 text-cyber">
              <Github className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold text-slate-100">🐙 GitHub Import</span>
            <span className="text-[11px] leading-relaxed text-slate-500">
              Import a repository through the GitHub API — no manual download, and later edits sync back.
            </span>
          </button>
        </div>
      )}

      {step === "file" && (
        <div className="space-y-3">
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".zip,.js,.mjs,.cjs,.jsx,.ts,.json,.html,.htm,.css,.md,.txt,.yml,.yaml"
            className="hidden"
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-600 px-4 py-8 text-slate-400 transition hover:border-accent/60 hover:text-slate-200"
            onClick={() => inputRef.current?.click()}
            disabled={filePhase === "uploading" || filePhase === "extracting"}
          >
            <FileArchive className="h-6 w-6 text-accent-soft" />
            <span className="text-xs font-medium">Choose a ZIP archive or project files</span>
            <span className="text-[10px] text-slate-600">Up to 64 MB per file · ZIP up to 800 files</span>
          </button>

          {uploadNames.length > 0 && (
            <p className="mono truncate text-[10px] text-slate-500">{uploadNames.join(" · ")}</p>
          )}

          {(filePhase === "uploading" || filePhase === "extracting") && (
            <div className="space-y-2 rounded-lg border border-ink-700/70 bg-ink-950/60 px-3 py-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 text-cyber">
                  <Spinner className="h-3 w-3" />
                  {filePhase === "uploading" ? "Uploading…" : job?.message ?? "Extracting archive…"}
                </span>
                <span className="mono text-slate-400">{uploadPercent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent to-cyber transition-all"
                  style={{ width: `${filePhase === "extracting" ? Math.max(uploadPercent, 92) : uploadPercent}%` }}
                />
              </div>
              {job && job.totalFiles > 0 && (
                <p className="mono text-[10px] text-slate-500">
                  {job.fetchedFiles}/{job.totalFiles} files · {bytes(job.totalBytes)}
                </p>
              )}
            </div>
          )}

          {filePhase === "error" && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              {fileError ?? "The upload failed."}
            </p>
          )}

          {filePhase === "done" && summary && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[11px] text-emerald-200">
              <p className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" /> PROJECT IMPORTED
              </p>
              <p className="mt-1 text-emerald-200/80">
                {summary.files} files ({summary.textFiles} editable) · {bytes(summary.bytes)}
                {summary.skipped ? ` · ${summary.skipped} skipped` : ""}
                {summary.note ? ` · ${summary.note}` : ""}
              </p>
              <Link href="/projects" className="mt-1.5 inline-block text-emerald-300 underline">
                Open imported projects →
              </Link>
            </div>
          )}
        </div>
      )}

      {step === "github" && (
        <div className="space-y-3">
          {optionsLoading && (
            <div className="flex items-center gap-2 px-1 py-6 text-xs text-slate-400">
              <Spinner /> Reading the GitHub connection…
            </div>
          )}

          {!optionsLoading && options?.mode === "none" && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-3">
              <p className="text-sm font-semibold tracking-wide text-rose-200">GITHUB NOT CONNECTED</p>
              <p className="mt-1 text-[11px] leading-relaxed text-rose-200/80">
                {options.error ?? "Connect your GitHub account in Admin Settings before importing repositories."}
              </p>
              <Link href="/settings?tab=github" className="btn-primary mt-2.5 !py-1.5 text-[11px]">
                Open GitHub configuration
              </Link>
            </div>
          )}

          {!optionsLoading && options?.mode === "repository" && options.repository && (
            <div className="space-y-2.5">
              <RepoCard
                repo={options.repository}
                onImport={() => void startImport(options.repository!, branch)}
                busy={importing === options.repository.fullName}
                disabled={importing !== null}
                actionLabel="IMPORT"
              />
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-700/70 bg-ink-950/50 px-3 py-2">
                <label className="label !text-slate-500">Branch</label>
                {branches.length ? (
                  <select className="field !w-auto !py-1 text-[11px]" value={branch} onChange={(event) => setBranch(event.target.value)}>
                    {branches.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                        {item.name === options.repository?.defaultBranch ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="mono text-[11px] text-slate-300">{branch || options.repository.defaultBranch}</span>
                )}
                <span className="ml-auto text-[10px] text-slate-600">
                  Imports go to the branch selected here, and pushes return to the same branch.
                </span>
              </div>
              {options.configured && (
                <p className="text-[10px] text-slate-600">
                  Configured repository: {options.configured.owner}/{options.configured.name}
                  {options.configured.branch ? ` · ${options.configured.branch}` : ""}
                </p>
              )}
            </div>
          )}

          {!optionsLoading && options?.mode === "account" && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    className="field !py-1.5 pl-8 text-xs"
                    placeholder="Search repositories…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void loadRepos(1, search);
                    }}
                  />
                </div>
                <button className="btn-ghost !px-2 !py-1.5 text-[11px]" onClick={() => void loadRepos(1, search)} disabled={repoLoading}>
                  {repoLoading ? <Spinner /> : <RefreshCw className="h-3 w-3" />}
                </button>
              </div>

              {repoError && (
                <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">{repoError}</p>
              )}

              <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
                {repos.map((repo) => (
                  <RepoCard
                    key={repo.fullName}
                    repo={repo}
                    onImport={() => void startImport(repo, repo.defaultBranch)}
                    busy={importing === repo.fullName}
                    disabled={importing !== null}
                    actionLabel="IMPORT"
                  />
                ))}
                {!repos.length && !repoLoading && (
                  <Empty
                    title={search ? "No repository matches that search" : "No repositories visible"}
                    hint={
                      search
                        ? "The filter runs over the repositories this token can access."
                        : "The token cannot see any repository. Check its scopes in Admin Settings."
                    }
                  />
                )}
              </div>

              {hasMore && (
                <button
                  className="btn-ghost w-full !py-1.5 text-[11px]"
                  onClick={() => void loadRepos(page + 1, search)}
                  disabled={repoLoading}
                >
                  {repoLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Load more repositories
                </button>
              )}
            </div>
          )}

          {(importing || job) && (
            <div className="space-y-1.5 rounded-lg border border-cyber/30 bg-cyber/5 px-3 py-2.5">
              <div className="flex items-center justify-between text-[11px] text-cyber">
                <span className="flex items-center gap-1.5">
                  <Spinner className="h-3 w-3" />
                  {job?.message ?? `Connecting to ${importing}…`}
                </span>
                <span className="flex items-center gap-2">
                  {job && job.totalFiles > 0 && (
                    <span className="mono">{Math.round((job.fetchedFiles / job.totalFiles) * 100)}%</span>
                  )}
                  {importing ? (
                    <button
                      type="button"
                      onClick={() => {
                        cancelRef.current = true;
                      }}
                      className="rounded border border-ink-600/70 px-2 py-0.5 text-[10px] text-slate-300 hover:border-rose-500/50"
                    >
                      Cancel
                    </button>
                  ) : null}
                </span>
              </div>
              {job && job.totalFiles > 0 && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyber to-accent transition-all"
                    style={{ width: `${Math.min(100, Math.round((job.fetchedFiles / job.totalFiles) * 100))}%` }}
                  />
                </div>
              )}
              {job && (
                <p className="mono text-[10px] text-slate-500">
                  {job.fetchedFiles}/{job.totalFiles} files · {bytes(job.totalBytes)}
                  {job.skippedFiles ? ` · ${job.skippedFiles} skipped` : ""}
                </p>
              )}
            </div>
          )}

          {summary && !importing && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[11px] text-emerald-200">
              <p className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" /> REPOSITORY IMPORTED
              </p>
              <p className="mt-1 text-emerald-200/80">
                {summary.files} files ({summary.textFiles} editable) · {bytes(summary.bytes)}
                {summary.branch ? ` · ${summary.branch}` : ""}
                {summary.commitSha ? ` @ ${summary.commitSha.slice(0, 7)}` : ""}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-3">
                <Link href="/projects" className="text-emerald-300 underline">
                  Manage imported projects →
                </Link>
                <Link href="/crash-and-fix" className="text-emerald-300 underline">
                  Open CRASH AND FIX →
                </Link>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function RepoCard({
  repo,
  onImport,
  busy,
  disabled,
  actionLabel,
}: {
  repo: RepoOption;
  onImport: () => void;
  busy: boolean;
  disabled: boolean;
  actionLabel: string;
}) {
  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-950/60 px-3 py-2.5 transition hover:border-ink-600">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <p className="truncate text-xs font-semibold text-slate-100">{repo.name}</p>
            <Badge tone={repo.private ? "warn" : "good"}>
              {repo.private ? <Lock className="h-2.5 w-2.5" /> : <Globe className="h-2.5 w-2.5" />}
              {repo.private ? "PRIVATE" : "PUBLIC"}
            </Badge>
          </div>
          {repo.description && (
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{repo.description}</p>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-600">
            <span>{repo.language ?? "unknown language"}</span>
            <span>·</span>
            <span>{repo.owner}/{repo.name}</span>
            <span>·</span>
            <span>updated {relative(repo.updatedAt)}</span>
          </p>
        </div>
        <button
          className="btn-primary shrink-0 !px-2.5 !py-1 text-[10px] tracking-wider"
          onClick={onImport}
          disabled={disabled}
        >
          {busy ? <Spinner className="h-3 w-3" /> : null}
          {busy ? "IMPORTING" : actionLabel}
        </button>
      </div>
    </div>
  );
}
