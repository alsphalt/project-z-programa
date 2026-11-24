"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Cloud,
  FileArchive,
  FileCode2,
  FolderOpen,
  Github,
  HardDrive,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner } from "@/components/ui";
import { ImportDialog } from "@/components/projects/import-dialog";
import { CodeEditor } from "@/components/code-editor";
import { useToast } from "@/components/providers";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { bytes, datetime, relative } from "@/lib/format";

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  source: "github" | "upload";
  sourceLabel: string | null;
  repository: { owner: string; name: string; branch: string | null; defaultBranch: string | null; private: boolean; url: string } | null;
  status: string;
  statusMessage: string | null;
  syncStatus: string;
  syncError: string | null;
  syncEnabled: boolean;
  lastSyncAt: string | null;
  lastCommitSha: string | null;
  lastCommitUrl: string | null;
  lastCommitMessage: string | null;
  fileCount: number;
  textFileCount: number;
  totalBytes: number;
  pendingChanges: number;
  pendingSince: string | null;
  createdAt: string;
};

type ProjectsResponse = {
  projects: ProjectRow[];
  github: { connected: boolean; account: string | null; autoSync: boolean; syncDelaySeconds: number };
  note: string;
};

type FileRow = {
  id: string;
  path: string;
  name: string;
  extension: string | null;
  sizeBytes: number;
  isText: boolean;
  editable: boolean;
  dirty: boolean;
  changedAt: string | null;
};

const SOURCE_LABEL: Record<string, string> = { github: "GitHub", upload: "File" };

export default function ProjectsPage() {
  const { push } = useToast();
  const projects = useApi<ProjectsResponse>("/api/projects", { refreshMs: 20_000 });
  const [importOpen, setImportOpen] = useState(false);

  const [browse, setBrowse] = useState<{ project: ProjectRow; files: FileRow[]; loading: boolean; search: string } | null>(null);
  const [editing, setEditing] = useState<{ project: ProjectRow; fileId: string; path: string; content: string; sha: string } | null>(null);
  const [savingFile, setSavingFile] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => projects.refresh();

  const openBrowse = async (project: ProjectRow) => {
    setBrowse({ project, files: [], loading: true, search: "" });
    try {
      const data = await apiGet<{ files: FileRow[] }>(`/api/projects/${project.id}/files`);
      setBrowse({ project, files: data.files, loading: false, search: "" });
    } catch (error) {
      push(errorMessage(error), "error");
      setBrowse({ project, files: [], loading: false, search: "" });
    }
  };

  const openFile = async (project: ProjectRow, file: FileRow) => {
    try {
      const data = await apiGet<{ file: { id: string; path: string; content: string; sha256: string } }>(
        `/api/projects/${project.id}/file?fileId=${file.id}`,
      );
      setEditing({ project, fileId: data.file.id, path: data.file.path, content: data.file.content, sha: data.file.sha256 });
    } catch (error) {
      push(errorMessage(error), "error");
    }
  };

  const saveFile = async () => {
    if (!editing) return;
    setSavingFile(true);
    try {
      const data = await apiPut<{ sync: { scheduled: boolean; reason: string } }>(`/api/projects/${editing.project.id}/file`, {
        fileId: editing.fileId,
        content: editing.content,
        expectedSha: editing.sha,
      });
      push(data.sync.scheduled ? "Saved — GitHub push queued" : "Saved to the project", "ok");
      setEditing(null);
      await refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setSavingFile(false);
    }
  };

  const syncNow = async (project: ProjectRow, action: "sync" | "retry" | "cancel" = "sync") => {
    setBusy(project.id);
    try {
      const data = await apiPost<{ sync: { syncStatus: string; lastCommitUrl: string | null } }>("/api/github/sync", {
        projectId: project.id,
        action,
      });
      push(
        data.sync.syncStatus === "synced"
          ? "GitHub confirmed the commit"
          : action === "cancel"
            ? "Scheduled push cancelled"
            : `Sync status: ${data.sync.syncStatus}`,
        data.sync.syncStatus === "synced" || action === "cancel" ? "ok" : "error",
      );
      await refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const toggleSync = async (project: ProjectRow) => {
    try {
      await apiPatch(`/api/projects/${project.id}`, { syncEnabled: !project.syncEnabled });
      push(project.syncEnabled ? "Automatic synchronization disabled for this project" : "Automatic synchronization enabled", "ok");
      await refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    }
  };

  const pendingAnywhere = Boolean(projects.data?.projects.some((project) => project.pendingChanges > 0));

  /**
   * Drain the debounced queue while something is waiting. On a long-running
   * `next start` the in-process worker already does this; on serverless hosts the
   * tick endpoint is what actually performs the push.
   */
  useEffect(() => {
    if (!pendingAnywhere) return;
    const timer = window.setInterval(() => {
      apiPost("/api/github/sync/tick")
        .catch(() => undefined)
        .finally(() => void projects.refresh());
    }, 4_000);
    return () => window.clearInterval(timer);
    // `refresh` is stable for a fixed URL; re-subscribing on every refresh would
    // restart the timer constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnywhere]);

  const data = projects.data;

  return (
    <>
      <PageHeader
        title="Projects & Imports"
        description="Everything imported into the panel — where it came from, what changed locally, and whether GitHub has accepted the push."
        actions={
          <>
            <button className="btn-ghost" onClick={() => void refresh()} disabled={projects.loading}>
              {projects.loading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </button>
            <button className="btn-primary" onClick={() => setImportOpen(true)}>
              <Upload className="h-3.5 w-3.5" /> Import a project
            </button>
          </>
        }
      />

      {data && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <Github className="h-3.5 w-3.5" />
            {data.github.connected ? `Connected as ${data.github.account}` : "GitHub not connected"}
          </span>
          <span>
            automatic sync {data.github.autoSync ? "on" : "off"} · {data.github.syncDelaySeconds}s debounce
          </span>
          <Link href="/settings?tab=github" className="text-accent-soft hover:underline">
            GitHub connection settings →
          </Link>
        </div>
      )}

      <Panel title="Import history" subtitle={data?.note}>
        {!data?.projects.length ? (
          <Empty
            title="Nothing imported yet"
            hint="Import a repository with the GitHub API, or upload a ZIP archive. Imported files become available to CRASH AND FIX immediately."
            action={
              <button className="btn-primary" onClick={() => setImportOpen(true)}>
                <FolderOpen className="h-3.5 w-3.5" /> Import a project
              </button>
            }
          />
        ) : (
          <ul className="divide-y divide-ink-750/60">
            {data.projects.map((project) => (
              <li key={project.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-xs font-semibold text-slate-100">{project.name}</p>
                      <Badge tone={project.source === "github" ? "cyber" : "accent"}>
                        {project.source === "github" ? <Github className="h-2.5 w-2.5" /> : <FileArchive className="h-2.5 w-2.5" />}
                        {SOURCE_LABEL[project.source]}
                      </Badge>
                      <Badge tone={project.status === "ready" ? "good" : project.status === "import_failed" ? "bad" : "warn"}>
                        {project.status}
                      </Badge>
                      {project.pendingChanges > 0 && <Badge tone="warn">{project.pendingChanges} pending</Badge>}
                      {project.syncStatus === "conflict" && <Badge tone="bad">conflict</Badge>}
                      {project.syncStatus === "synced" && <Badge tone="good">synchronized</Badge>}
                    </div>

                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-600">
                      <span>imported {datetime(project.createdAt)}</span>
                      <span>·</span>
                      <span>
                        {project.fileCount} files ({project.textFileCount} editable) · {bytes(project.totalBytes)}
                      </span>
                      {project.repository && (
                        <>
                          <span>·</span>
                          <a href={project.repository.url} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-300">
                            {project.repository.owner}/{project.repository.name}
                            {project.repository.branch ? `@${project.repository.branch}` : ""} <ArrowUpRight className="inline h-2.5 w-2.5" />
                          </a>
                        </>
                      )}
                    </p>

                    {project.repository && (
                      <p className="mt-1 text-[10px] text-slate-500">
                        {project.lastSyncAt ? (
                          <>
                            last sync {relative(project.lastSyncAt)}
                            {project.lastCommitSha ? ` · commit ${project.lastCommitSha.slice(0, 7)}` : ""}
                            {project.lastCommitUrl && (
                              <a href={project.lastCommitUrl} target="_blank" rel="noreferrer" className="ml-1 text-accent-soft hover:underline">
                                view
                              </a>
                            )}
                          </>
                        ) : (
                          "no successful push yet"
                        )}
                        {!project.syncEnabled && " · automatic sync off"}
                      </p>
                    )}

                    {project.syncError && <p className="mt-1 text-[10px] text-rose-300">{project.syncError}</p>}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void openBrowse(project)}>
                      <FileCode2 className="h-3 w-3" /> Browse
                    </button>
                    {project.repository && (
                      <>
                        <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void syncNow(project)} disabled={busy === project.id}>
                          {busy === project.id ? <Spinner className="h-2.5 w-2.5" /> : <Cloud className="h-3 w-3" />} Sync now
                        </button>
                        <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void toggleSync(project)}>
                          {project.syncEnabled ? "Disable auto" : "Enable auto"}
                        </button>
                      </>
                    )}
                    <button
                      className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                      onClick={() => setRemoveTarget(project)}
                      title="Remove the imported working copy"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="How synchronization behaves" subtitle="Debounced, verified, and never silently overwriting">
          <ul className="space-y-2 text-[11px] leading-relaxed text-slate-500">
            <li className="flex gap-2">
              <HardDrive className="mt-0.5 h-3 w-3 shrink-0 text-cyber" /> Saved files wait ~{data?.github.syncDelaySeconds ?? 5} seconds. Another save
              restarts the countdown, so a burst of edits becomes one commit.
            </li>
            <li className="flex gap-2">
              <HardDrive className="mt-0.5 h-3 w-3 shrink-0 text-cyber" /> Before pushing, the branch head and every touched blob sha are compared with
              what was imported. Anything unexpected becomes a conflict instead of an overwrite.
            </li>
            <li className="flex gap-2">
              <HardDrive className="mt-0.5 h-3 w-3 shrink-0 text-cyber" /> A push is only reported as successful after GitHub’s ref points at the new
              commit and the file content matches.
            </li>
          </ul>
        </Panel>

        <Panel title="Where the files live" subtitle="No serverless filesystem assumptions">
          <p className="text-[11px] leading-relaxed text-slate-500">
            Imported project contents are stored in the panel database and pushed through the GitHub Git Data API. Nothing is written to the deployment
            filesystem, nothing is executed, and removing a project never touches the repository.
          </p>
        </Panel>
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          void refresh();
        }}
      />

      <Modal
        open={browse !== null}
        onClose={() => setBrowse(null)}
        title={browse ? `${browse.project.name} — files` : "Files"}
        subtitle="Editable files open in the editor. Credential-shaped paths are never listed."
        wide
      >
        {browse && (
          <div className="space-y-2">
            <input
              className="field !py-1.5 text-xs"
              placeholder="Filter files…"
              value={browse.search}
              onChange={(event) => setBrowse({ ...browse, search: event.target.value })}
            />
            {browse.loading && (
              <p className="flex items-center gap-2 py-3 text-[11px] text-slate-400">
                <Spinner /> Reading the file list…
              </p>
            )}
            {!browse.loading && !browse.files.length && <Empty title="No files" hint="This project has no readable files." />}
            <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-ink-700/60">
              <table className="w-full text-left text-[11px]">
                <tbody>
                  {browse.files
                    .filter((file) => !browse.search || file.path.toLowerCase().includes(browse.search.toLowerCase()))
                    .slice(0, 600)
                    .map((file) => (
                      <tr key={file.id} className="table-row">
                        <td className="mono max-w-[52vw] truncate px-2.5 py-1.5 text-slate-300">{file.path}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-[10px] text-slate-600">{bytes(file.sizeBytes)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">{file.dirty && <Badge tone="warn">changed</Badge>}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right">
                          {file.editable ? (
                            <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void openFile(browse.project, file)}>
                              Open
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-600">{file.isText ? "too large" : "binary"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? editing.path : "File"}
        subtitle={editing ? `${editing.project.name} · ${editing.content.length} characters` : undefined}
        wide
        footer={
          <>
            <button className="btn-ghost" onClick={() => setEditing(null)}>
              Close
            </button>
            <button className="btn-primary" onClick={() => void saveFile()} disabled={savingFile}>
              {savingFile ? <Spinner /> : <Save className="h-3.5 w-3.5" />} Save
            </button>
          </>
        }
      >
        {editing && (
          <div className="h-[56vh] min-h-[320px] overflow-hidden rounded-lg border border-ink-700/70">
            <CodeEditor
              path={`project/${editing.project.id}/${editing.path}`}
              value={editing.content}
              language={editing.path.endsWith(".json") ? "json" : editing.path.endsWith(".css") ? "css" : editing.path.endsWith(".html") ? "html" : "javascript"}
              large={editing.content.length > 160_000}
              onChange={(value) => setEditing((current) => (current ? { ...current, content: value } : current))}
            />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (!removeTarget) return;
          try {
            await apiDelete(`/api/projects/${removeTarget.id}`);
            push("Imported project removed — the GitHub repository was not touched", "ok");
            setRemoveTarget(null);
            await refresh();
          } catch (error) {
            push(errorMessage(error), "error");
          }
        }}
        danger
        title="Remove this imported project?"
        description={
          removeTarget ? (
            <>
              The panel deletes its working copy of <span className="mono text-slate-200">{removeTarget.name}</span>, including unsaved pending changes.
              {removeTarget.repository && " The GitHub repository itself is never modified."}
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Remove project"
        requireText={removeTarget?.name}
      />
    </>
  );
}
