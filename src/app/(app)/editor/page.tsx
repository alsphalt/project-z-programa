"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ClipboardPaste,
  CloudUpload,
  Copy,
  Download,
  Expand,
  FileCode2,
  Github,
  Keyboard,
  RotateCcw,
  Save,
  Scissors,
  TextSelect,
  Trash2,
  WrapText,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { GitHubSyncBar } from "@/components/github/sync-bar";
/**
 * Monaco is ~1 MB of JavaScript. Loading it lazily keeps the editor route's
 * first paint (header, tabs, status) instant on a phone, and the component is
 * only requested when a file is actually open.
 */
const CodeEditor = dynamic(() => import("@/components/code-editor").then((module) => module.CodeEditor), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-slate-500">
      <span className="h-3 w-3 animate-spin rounded-full border border-slate-600 border-t-transparent" /> Loading editor…
    </div>
  ),
});
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner, Status } from "@/components/ui";
import { apiDelete, apiGet, apiPost, apiPut, download, errorMessage } from "@/lib/client";
import { checkLoadedContent, checkWrite } from "@/lib/editor/guards";
import { relative } from "@/lib/format";

type Tab = {
  path: string;
  content: string;
  original: string;
  sha: string | null;
  indexedSha: string | null;
  language: string;
  modifiedAt: string | null;
  dirty: boolean;
  draftSaved: boolean;
  validation: { ok: boolean; errors: Array<{ line: number; message: string }>; pending?: boolean };
  /** Bytes of the production file as reported by the panel. */
  sizeBytes: number | null;
  /** Per-server editor limit, already clamped by the process ceiling. */
  limitBytes: number | null;
  /** True when the file was loaded through the chunked reader. */
  large: boolean;
  /** Server-side draft id, set once a large draft has been stored. */
  draftId: string | null;
};

type DraftRef = {
  id: string;
  content: string | null;
  bytes: number;
  truncated: boolean;
  baseSha: string | null;
  updatedAt: string;
};

type FilePayload = {
  path: string;
  content: string | null;
  sha256: string;
  language: string;
  modifiedAt: string | null;
  sizeBytes: number;
  totalChars: number;
  limitBytes: number;
  ceilingBytes: number;
  chunkBytes: number;
  largeFile: boolean;
  indexedSha: string | null;
  inSync: boolean;
  draft: DraftRef | null;
  validation?: { ok: boolean; errors: Array<{ line: number; message: string }> };
  secretKind: string | null;
};

/** Above this size the editor switches to the chunked reader/writer path. */
const LARGE_FILE_BYTES = 1_024 * 1_024;

function formatSize(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** UTF-8 byte length without allocating a copy of a multi-megabyte string. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

async function sha256Hex(text: string): Promise<string | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // Non-secure contexts have no subtle crypto; the server still verifies size
    // and the deploy step re-reads production and compares SHA-256.
    return null;
  }
}

type ChunkPayload = FilePayload & { offset: number; length: number; nextOffset: number | null; content: string | null };

/** Pull a production file one slice at a time and prove nothing was lost. */
async function readFileInChunks(
  serverId: string,
  meta: FilePayload,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  let received = 0;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const chunk = await apiGet<ChunkPayload>(
      `/api/files/content?serverId=${serverId}&path=${encodeURIComponent(meta.path)}&mode=chunk&offset=${offset}&length=${meta.chunkBytes}`,
    );
    const text = chunk.content ?? "";
    parts.push(text);
    received += text.length;
    onProgress?.(received, meta.totalChars);
    if (chunk.nextOffset === null) break;
    if (chunk.nextOffset <= offset) throw new Error("The chunked reader stalled — the file was not loaded.");
    offset = chunk.nextOffset;
  }
  const content = parts.join("");
  if (content.length !== meta.totalChars) {
    throw new Error(
      `Loaded ${content.length} of ${meta.totalChars} characters — the file was not opened to avoid showing truncated content.`,
    );
  }
  return content;
}

/** Pull a server-side draft one slice at a time. */
async function readDraftInChunks(
  serverId: string,
  path: string,
  draftId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  let received = 0;
  let totalChars = 0;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const chunk = await apiGet<ChunkPayload>(
      `/api/drafts/chunk?serverId=${serverId}&draftId=${encodeURIComponent(draftId)}&mode=chunk&offset=${offset}`,
    );
    totalChars = chunk.totalChars;
    const text = chunk.content ?? "";
    parts.push(text);
    received += text.length;
    onProgress?.(received, totalChars);
    if (chunk.nextOffset === null) break;
    if (chunk.nextOffset <= offset) throw new Error("The draft reader stalled — the draft was not restored.");
    offset = chunk.nextOffset;
  }
  void path;
  const content = parts.join("");
  if (content.length !== totalChars) {
    throw new Error(`Restored ${content.length} of ${totalChars} characters of the draft.`);
  }
  return content;
}

type ChunkCreateResponse = { draftId: string; chunkBytes: number; chunks: number; totalBytes: number };

/**
 * Store a draft through the chunked endpoint: create → PUT each slice →
 * finalize. The browser never posts the whole file in one request, which is what
 * used to kill the editor on mobile for anything past a couple of megabytes.
 */
async function uploadDraftInChunks(
  serverId: string,
  path: string,
  content: string,
  baseSha: string | null,
  onProgress?: (done: number, total: number) => void,
): Promise<{ draftId: string; bytes: number; sha256: string | null }> {
  const totalBytes = utf8Length(content);
  const created = await apiPost<ChunkCreateResponse>("/api/drafts/chunk", {
    action: "create",
    serverId,
    path,
    totalBytes,
    totalChars: content.length,
    baseSha,
  });
  const step = Math.max(64 * 1024, created.chunkBytes);
  const total = Math.ceil(content.length / step) || 1;
  for (let index = 0; index < total; index += 1) {
    const slice = content.slice(index * step, (index + 1) * step);
    await apiPut("/api/drafts/chunk", { serverId, draftId: created.draftId, index, content: slice });
    onProgress?.(index + 1, total);
  }
  const sha = await sha256Hex(content);
  const finalized = await apiPost<{ draftId: string; bytes: number; sha256: string }>("/api/drafts/chunk", {
    action: "finalize",
    serverId,
    draftId: created.draftId,
    sha256: sha ?? undefined,
  });
  return { draftId: finalized.draftId, bytes: finalized.bytes, sha256: finalized.sha256 ?? sha };
}

function EditorView() {
  const params = useSearchParams();
  const router = useRouter();
  const { activeId, activeServer } = useServers();
  const { push } = useToast();

  const initialPath = params.get("path") ?? "";
  const lineParam = Number.parseInt(params.get("line") ?? "0", 10);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployNote, setDeployNote] = useState("");
  // GitHub: bumped after every local write so the shared bar re-reads its status.
  const [syncPulse, setSyncPulse] = useState(0);
  const [pushAfterDeploy, setPushAfterDeploy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [openPath, setOpenPath] = useState("");
  const [draftBanner, setDraftBanner] = useState<{ path: string; content: string; baseSha: string | null; draftId: string | null } | null>(null);
  const [conflict, setConflict] = useState<{ message: string; details?: unknown } | null>(null);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<any>(null);
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = tabs.find((tab) => tab.path === active) ?? null;

  const openFile = useCallback(
    async (path: string, line = 0, options: { fresh?: boolean } = {}) => {
      if (!activeId || !path) return;
      if (!options.fresh && tabs.some((tab) => tab.path === path)) {
        setActive(path);
        if (line > 0) revealLine(line);
        return;
      }
      setLoading(true);
      setError(null);
      setProgress({ label: "Reading file…", done: 0, total: 0 });
      try {
        const query = `serverId=${activeId}&path=${encodeURIComponent(path)}`;
        // Metadata first: it tells us the real size and limit without shipping it.
        const meta = await apiGet<FilePayload>(`/api/files/content?${query}&mode=meta${options.fresh ? "&fresh=1" : ""}`);

        let content: string;
        let validation: { ok: boolean; errors: Array<{ line: number; message: string }>; pending?: boolean };
        if (meta.sizeBytes > LARGE_FILE_BYTES) {
          content = await readFileInChunks(activeId, meta, (done, total) =>
            setProgress({ label: "Loading large file", done, total }),
          );
          // Parsing several megabytes on load would block the main thread, so the
          // full check runs server-side at deploy time instead.
          validation = { ok: true, errors: [], pending: true };
        } else {
          const full = await apiGet<FilePayload>(`/api/files/content?${query}&mode=full`);
          content = full.content ?? "";
          validation = full.validation ?? { ok: true, errors: [] };
        }

        /**
         * Prove the buffer before it becomes a tab. An empty string used to be
         * indistinguishable from "the editor is broken" and could be saved over a
         * real file, so a short or empty body is now a hard error.
         */
        const loaded = checkLoadedContent({
          path: meta.path,
          content,
          totalChars: meta.totalChars,
          sizeBytes: meta.sizeBytes,
        });
        if (!loaded.ok) throw new Error(loaded.reason);

        const tab: Tab = {
          path: meta.path,
          content,
          original: content,
          sha: meta.sha256,
          indexedSha: meta.indexedSha,
          language: meta.language,
          modifiedAt: meta.modifiedAt,
          dirty: false,
          draftSaved: false,
          validation,
          sizeBytes: meta.sizeBytes,
          limitBytes: meta.limitBytes,
          large: meta.sizeBytes > LARGE_FILE_BYTES,
          draftId: meta.draft?.id ?? null,
        };
        setTabs((list) => (options.fresh ? list.map((item) => (item.path === meta.path ? tab : item)) : [...list, tab]));
        setActive(meta.path);

        if (meta.draft) {
          let draftContent = meta.draft.content;
          if (draftContent === null) {
            draftContent = await readDraftInChunks(activeId, meta.path, meta.draft.id, (done, total) =>
              setProgress({ label: "Loading stored draft", done, total }),
            );
          }
          setDraftBanner({
            path: meta.path,
            content: draftContent,
            baseSha: meta.draft.baseSha,
            draftId: meta.draft.id,
          });
        }
        if (line > 0) setTimeout(() => revealLine(line), 350);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
        setProgress(null);
      }
    },
    [activeId, tabs],
  );

  useEffect(() => {
    if (initialPath) void openFile(initialPath, lineParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, initialPath]);

  const revealLine = (line: number) => {
    const editor = editorRef.current;
    if (!editor || line <= 0) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    const monaco = monacoRef.current;
    if (monaco) {
      decorationsRef.current?.clear();
      decorationsRef.current = editor.createDecorationsCollection([
        {
          range: new monaco.Range(line, 1, line, 1),
          options: { isWholeLine: true, className: "bg-accent/10", linesDecorationsClassName: "bg-accent" },
        },
      ]);
    }
    editor.focus();
  };

  const update = (content: string) => {
    if (!active) return;
    const path = active;
    setTabs((list) =>
      list.map((tab) =>
        tab.path === path
          ? {
              ...tab,
              content,
              dirty: content !== tab.original,
              draftSaved: false,
              // A stored draft id is only valid for the bytes it was created from.
              draftId: content === tab.content ? tab.draftId : null,
            }
          : tab,
      ),
    );
    // The old code walked the whole string on every keystroke. On a 20 MB file
    // that locks up mobile browsers, so validation is debounced and skipped for
    // large files (deploy still parses them server-side).
    if (validateTimer.current) clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => {
      setTabs((list) =>
        list.map((tab) => {
          if (tab.path !== path) return tab;
          if (tab.large || content.length > 400_000) {
            return { ...tab, validation: { ok: true, errors: [], pending: true } };
          }
          if (tab.language !== "javascript" && tab.language !== "typescript") {
            return { ...tab, validation: { ok: true, errors: [] } };
          }
          return { ...tab, validation: quickValidate(content) };
        }),
      );
    }, 450);
  };

  const saveDraft = async () => {
    if (!current || !activeId) return;
    setSaving(true);
    try {
      // Never persist an empty buffer over a file that has bytes on production.
      const guard = checkWrite({ productionBytes: current.sizeBytes, content: current.content });
      if (!guard.ok) {
        push(guard.reason, "error");
        return;
      }
      const bytes = utf8Length(current.content);
      if (current.limitBytes && bytes > current.limitBytes) {
        throw new Error(
          `This file is ${formatSize(bytes)} — above the ${formatSize(current.limitBytes)} editor limit for this server. Raise “Editor file limit” in Settings or edit it over SFTP.`,
        );
      }
      if (bytes > LARGE_FILE_BYTES) {
        setProgress({ label: "Uploading large draft", done: 0, total: 0 });
        const stored = await uploadDraftInChunks(activeId, current.path, current.content, current.sha, (done, total) =>
          setProgress({ label: "Uploading large draft", done, total }),
        );
        setTabs((list) =>
          list.map((tab) =>
            tab.path === current.path
              ? { ...tab, draftSaved: true, draftId: stored.draftId, sizeBytes: stored.bytes }
              : tab,
          ),
        );
        push(`Draft stored server-side (${formatSize(stored.bytes)}) — production is untouched`, "ok");
      } else {
        await apiPut("/api/drafts", {
          serverId: activeId,
          path: current.path,
          content: current.content,
          baseSha: current.sha,
        });
        setTabs((list) => list.map((tab) => (tab.path === current.path ? { ...tab, draftSaved: true } : tab)));
        push("Draft saved — production is untouched", "ok");
      }
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  const deploy = async (pushAfter = false) => {
    if (!current || !activeId) return;
    setDeploying(true);
    try {
      // Same rule as the draft: an empty editor must never reach production.
      const guard = checkWrite({ productionBytes: current.sizeBytes, content: current.content });
      if (!guard.ok) {
        push(guard.reason, "error");
        setDeployOpen(false);
        return;
      }
      const bytes = utf8Length(current.content);
      // A large file is never posted as one body: it is stored as a server-side
      // draft first and the deployment then references that draft by id.
      let draftId = current.draftSaved ? current.draftId : null;
      if (!draftId && bytes > LARGE_FILE_BYTES) {
        setProgress({ label: "Storing draft before deploy", done: 0, total: 0 });
        const stored = await uploadDraftInChunks(activeId, current.path, current.content, current.sha, (done, total) =>
          setProgress({ label: "Storing draft before deploy", done, total }),
        );
        draftId = stored.draftId;
        setTabs((list) =>
          list.map((tab) =>
            tab.path === current.path ? { ...tab, draftSaved: true, draftId: stored.draftId } : tab,
          ),
        );
      }
      const body = draftId
        ? {
            serverId: activeId,
            draftId,
            message: deployNote || `Edit ${current.path} from the control center`,
          }
        : {
            serverId: activeId,
            files: [{ path: current.path, content: current.content, expectedSha: current.sha }],
            message: deployNote || `Edit ${current.path} from the control center`,
          };

      const result = await apiPost<{
        deployment: {
          publicId: string;
          status: string;
          healthOk: boolean | null;
          error: string | null;
          files: Array<{ path: string; postHash: string | null }>;
        };
      }>(
        "/api/deployments",
        body,
      );
      const deployment = result.deployment;
      if (deployment.status === "SUCCEEDED") {
        push(`Deployed ${deployment.publicId}${deployment.healthOk ? " — startup verified" : ""}`, "ok");
        await apiDelete(`/api/drafts?serverId=${activeId}&path=${encodeURIComponent(current.path)}`).catch(() => undefined);
        setTabs((list) =>
          list.map((tab) =>
            tab.path === current.path
              ? {
                  ...tab,
                  // The deployment reports the hash it re-read from production,
                  // so later conflict checks compare against real bytes.
                  sha: deployment.files.find((file) => file.path === tab.path)?.postHash ?? tab.sha,
                  original: tab.content,
                  dirty: false,
                  draftSaved: false,
                  draftId: null,
                  sizeBytes: utf8Length(tab.content),
                }
              : tab,
          ),
        );
        router.refresh();

        /**
         * The file on the panel just changed. Record it in the shared working
         * copy: if automatic synchronization is on, one commit follows ~5 s
         * after the last save; "Save and push" asks for it immediately.
         */
        try {
          await apiPost("/api/github/files", {
            serverId: activeId,
            action: pushAfter ? "push" : "detect",
            paths: [current.path],
            message: deployNote || null,
          });
          setSyncPulse((value) => value + 1);
          if (pushAfter) push("Push requested — GitHub must confirm the commit", "ok");
        } catch (syncError) {
          // No binding or no connection is a normal state, not a deploy failure.
          if (pushAfter) push(errorMessage(syncError), "error");
        }
      } else {
        push(`${deployment.publicId}: ${deployment.error ?? deployment.status}`, "error");
      }
      setDeployOpen(false);
      setDeployNote("");
    } catch (err) {
      const message = errorMessage(err);
      push(message, "error");
      setDeployOpen(false);
      if (message.toLowerCase().includes("conflict") || message.toLowerCase().includes("changed")) {
        setConflict({ message });
      }
    } finally {
      setDeploying(false);
      setProgress(null);
    }
  };

  const closeTab = (path: string) => {
    setTabs((list) => {
      const next = list.filter((tab) => tab.path !== path);
      if (active === path) setActive(next[next.length - 1]?.path ?? null);
      return next;
    });
  };

  const withEditor = (fn: (editor: any) => void) => {
    const editor = editorRef.current;
    if (editor) fn(editor);
  };

  const mobileActions = useMemo(
    () => [
      { label: "Select all", icon: TextSelect, run: () => withEditor((editor) => { const model = editor.getModel(); if (model) editor.setSelection(model.getFullModelRange()); editor.focus(); }) },
      {
        label: "Copy",
        icon: Copy,
        run: () => withEditor(async (editor) => {
          const selection = editor.getSelection();
          const text = editor.getModel()?.getValueInRange(selection) ?? "";
          if (text) { await navigator.clipboard.writeText(text).catch(() => undefined); push("Selection copied", "ok"); }
        }),
      },
      {
        label: "Cut",
        icon: Scissors,
        run: () => withEditor(async (editor) => {
          const selection = editor.getSelection();
          const model = editor.getModel();
          const text = model?.getValueInRange(selection) ?? "";
          if (!text) return;
          await navigator.clipboard.writeText(text).catch(() => undefined);
          editor.executeEdits("cut", [{ range: selection, text: "" }]);
        }),
      },
      {
        label: "Paste",
        icon: ClipboardPaste,
        run: () => withEditor(async (editor) => {
          try {
            const text = await navigator.clipboard.readText();
            if (!text) return;
            const selection = editor.getSelection();
            editor.executeEdits("paste", [{ range: selection, text }]);
          } catch {
            push("Clipboard read was blocked — use the native paste menu", "error");
          }
        }),
      },
      {
        label: "Delete",
        icon: Trash2,
        run: () => withEditor((editor) => {
          const selection = editor.getSelection();
          if (selection) editor.executeEdits("delete", [{ range: selection, text: "" }]);
        }),
      },
      {
        label: "Replace",
        icon: Keyboard,
        run: () => withEditor((editor) => { editor.getAction("editor.action.startFindReplaceAction")?.run(); editor.focus(); }),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  return (
    <div className={fullscreen ? "fixed inset-0 z-[80] flex flex-col bg-ink-950" : ""}>
      <PageHeader
        title="Code Editor"
        description="Edits are drafts until deployed. A deploy backs up the current production file, writes, verifies the hash and restarts the bot."
        actions={
          <>
            <button
              className={`btn-ghost ${wrap ? "border-accent/50 text-accent-soft" : ""}`}
              onClick={() => setWrap((value) => !value)}
              title="Toggle soft line wrapping (off keeps horizontal scrolling)"
            >
              <WrapText className="h-3.5 w-3.5" /> Wrap {wrap ? "on" : "off"}
            </button>
            <button className="btn-ghost" onClick={() => setFullscreen((value) => !value)}>
              <Expand className="h-3.5 w-3.5" /> {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <Link href="/files" className="btn-ghost"><FileCode2 className="h-3.5 w-3.5" /> Browse</Link>
          </>
        }
      />

      <GitHubSyncBar
        serverId={activeId}
        selection={current ? [current.path] : []}
        pulse={syncPulse}
        compact
        onAfterChange={() => {
          if (current) void openFile(current.path, 0, { fresh: true });
        }}
      />

      <div className="mb-2 flex items-center gap-2">
        <input
          className="field mono !py-1.5 text-xs"
          placeholder="/path/to/file.js — paste a path to open it"
          value={openPath}
          onChange={(event) => setOpenPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && openPath.trim()) void openFile(openPath.trim());
          }}
        />
        <button className="btn-ghost !py-1.5 text-[11px]" onClick={() => openPath.trim() && void openFile(openPath.trim())}>Open</button>
      </div>

      {tabs.length > 0 && (
        <div className="mb-2 flex gap-1 overflow-x-auto pb-1">
          {tabs.map((tab) => (
            <button
              key={tab.path}
              onClick={() => setActive(tab.path)}
              className={`group flex shrink-0 items-center gap-1.5 rounded-t-lg border-b-2 px-2.5 py-1.5 text-[11px] ${
                active === tab.path
                  ? "border-accent bg-ink-850 text-slate-100"
                  : "border-transparent bg-ink-900/60 text-slate-500 hover:text-slate-300"
              }`}
            >
              <span className="max-w-[160px] truncate">{tab.path.split("/").pop()}</span>
              {tab.dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
              <X
                className="h-3 w-3 text-slate-600 hover:text-rose-300"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.path);
                }}
              />
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>
      )}

      {progress && (
        <div className="mb-2 rounded-lg border border-cyber/30 bg-cyber/5 px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-[11px] text-cyber">
            <span className="flex items-center gap-1.5"><Spinner /> {progress.label}…</span>
            <span className="text-cyber/80">
              {progress.total > 0
                ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}% · ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
                : "starting"}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full bg-cyber transition-all"
              style={{ width: `${progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 8}%` }}
            />
          </div>
        </div>
      )}

      {draftBanner && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-[11px] text-violet-200">
          <span>A local draft exists for <span className="mono">{draftBanner.path}</span>.</span>
          <button
            className="btn-ghost !py-1 text-[10px]"
            onClick={() => {
              setTabs((list) =>
                list.map((tab) =>
                  tab.path === draftBanner.path
                    ? {
                        ...tab,
                        content: draftBanner.content,
                        dirty: draftBanner.content !== tab.original,
                        draftSaved: true,
                        draftId: draftBanner.draftId,
                        validation:
                          tab.language === "javascript" || tab.language === "typescript"
                            ? quickValidate(draftBanner.content)
                            : { ok: true, errors: [] },
                      }
                    : tab,
                ),
              );
              setDraftBanner(null);
            }}
          >
            Restore draft
          </button>
          <button
            className="btn-ghost !py-1 text-[10px]"
            onClick={async () => {
              await apiDelete(`/api/drafts?serverId=${activeId}&path=${encodeURIComponent(draftBanner.path)}`).catch(() => undefined);
              setDraftBanner(null);
              push("Draft discarded", "ok");
            }}
          >
            Discard
          </button>
        </div>
      )}

      <div className={`grid gap-3 ${fullscreen ? "min-h-0 flex-1 grid-rows-[1fr]" : "lg:grid-cols-[1fr_290px]"}`}>
        <Panel
          bodyClassName="!flex !flex-1 !min-h-0 !flex-col !p-0"
          className={`overflow-hidden ${fullscreen ? "flex min-h-0 flex-col" : ""}`}
        >
          {current ? (
            <>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-ink-750/70 px-3 py-2">
                <div className="min-w-0">
                  <p className="mono truncate text-[11px] text-slate-300">{current.path}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    <span>sha {current.sha?.slice(0, 10) ?? "—"}</span>
                    <span>·</span>
                    <span>{formatSize(current.sizeBytes)}</span>
                    <span>·</span>
                    {/* Proof that the buffer in the editor is the file, not an empty surface. */}
                    <span title="Characters currently held by the editor">{current.content.length.toLocaleString()} chars</span>
                    {current.limitBytes ? (
                      <>
                        <span>·</span>
                        <span>limit {formatSize(current.limitBytes)}</span>
                      </>
                    ) : null}
                    <span>·</span>
                    <span>{relative(current.modifiedAt)}</span>
                    {current.large ? <Badge tone="cyber">large file mode</Badge> : null}
                    {current.dirty ? <Badge tone="warn">unsaved</Badge> : current.draftSaved ? <Badge tone="accent">draft</Badge> : <Badge tone="good">production</Badge>}
                    {current.indexedSha && current.sha && current.indexedSha !== current.sha && <Badge tone="warn">index stale</Badge>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void saveDraft()} disabled={!current.dirty || saving}>
                    {saving ? <Spinner /> : <Save className="h-3 w-3" />} Draft
                  </button>
                  <button
                    className="btn-ghost !px-2 !py-1 text-[10px]"
                    onClick={() => current && void openFile(current.path, 0, { fresh: true })}
                    title="Re-read production from the panel"
                  >
                    <RotateCcw className="h-3 w-3" /> Reload
                  </button>
                  <button
                    className="btn-ghost !px-2 !py-1 text-[10px]"
                    onClick={() => void download(`/api/files/download?serverId=${activeId}&mode=file&path=${encodeURIComponent(current.path)}`).catch((error) => push(errorMessage(error), "error"))}
                  >
                    <Download className="h-3 w-3" /> Download
                  </button>
                  <button
                    className="btn-ghost !px-2 !py-1 text-[10px]"
                    onClick={() => {
                      if (!current || !activeId) return;
                      setPulling(true);
                      void apiPost<{ result: { restored: unknown[]; skipped: Array<{ reason: string }> } }>(
                        "/api/github/files",
                        {
                          serverId: activeId,
                          action: "pull",
                          paths: [current.path],
                          expectedHashes: current.sha ? { [current.path]: current.sha } : undefined,
                        },
                      )
                        .then(async (data) => {
                          if (data.result.restored.length) {
                            push("Pulled the latest version from GitHub", "ok");
                            setSyncPulse((value) => value + 1);
                            await openFile(current.path, 0, { fresh: true });
                          } else {
                            push(data.result.skipped[0]?.reason ?? "Nothing was pulled", "error");
                          }
                        })
                        .catch((error) => push(errorMessage(error), "error"))
                        .finally(() => setPulling(false));
                    }}
                    disabled={pulling}
                    title="Replace this file with the version on the connected branch"
                  >
                    {pulling ? <Spinner /> : <ArrowDownToLine className="h-3 w-3" />} Pull latest
                  </button>
                  <button
                    className="btn-ghost !px-2 !py-1 text-[10px]"
                    onClick={() => {
                      setPushAfterDeploy(true);
                      setDeployOpen(true);
                    }}
                    disabled={!current.dirty}
                    title="Deploy, then push the file to GitHub"
                  >
                    <Github className="h-3 w-3" /> Save &amp; push
                  </button>
                  <button className="btn-primary !px-2 !py-1 text-[10px]" onClick={() => { setPushAfterDeploy(false); setDeployOpen(true); }} disabled={!current.dirty}>
                    <CloudUpload className="h-3 w-3" /> Deploy
                  </button>
                </div>
              </div>

              {current.content.length === 0 && (current.sizeBytes ?? 0) === 0 && (
                <div className="shrink-0 border-b border-ink-750/70 bg-ink-900/60 px-3 py-1.5 text-[10px] text-slate-400">
                  This file is empty on production (0 B). Typing here is the only way it gets content.
                </div>
              )}

              {/**
               * The surface is measured in pixels by CodeEditor, so it always has a
               * real height on phones, tablets and desktop. The old wrapper relied on
               * `calc(100% - 52px)` inside an auto-height parent, which collapsed to
               * 0 px and produced a blank editor.
               */}
              <div
                className={
                  fullscreen
                    ? "relative min-h-0 w-full flex-1"
                    : "relative w-full h-[64dvh] min-h-[340px] lg:h-[calc(100dvh_-_19rem)] lg:min-h-[440px]"
                }
              >
                <CodeEditor
                  path={current.path}
                  language={current.language}
                  value={current.content}
                  large={current.large}
                  wrap={wrap}
                  onChange={update}
                  onMount={(editor, monaco) => {
                    editorRef.current = editor;
                    monacoRef.current = monaco;
                    if (lineParam > 0) setTimeout(() => revealLine(lineParam), 200);
                  }}
                />
              </div>
            </>
          ) : (
            <div className="flex h-[45dvh] items-center justify-center px-6">
              {loading ? (
                <div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Reading production file…</div>
              ) : (
                <Empty
                  title="No file open"
                  hint="Open a file from the file manager, or paste a path above. The editor always loads the current production bytes."
                  action={<Link href="/files" className="btn-ghost">Open file manager</Link>}
                />
              )}
            </div>
          )}
        </Panel>

        {!fullscreen && (
          <div className="space-y-3">
            <Panel title="Validation" bodyClassName="!py-3">
              {current?.validation.pending ? (
                <p className="flex items-center gap-2 text-xs text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> Parsed on deploy</p>
              ) : current?.validation.ok ? (
                <p className="flex items-center gap-2 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> Parses cleanly</p>
              ) : current ? (
                <ul className="space-y-1 text-[11px] text-rose-300">
                  {current.validation.errors.slice(0, 4).map((issue, index) => (
                    <li key={index} className="flex gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>line {issue.line}: {issue.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-slate-500">Open a file to validate it.</p>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                Syntax checking is a gate, not a guarantee. Deploys also verify the written hash and the bot's startup output.
              </p>
            </Panel>

            <Panel title="Production state" bodyClassName="!py-3">
              <dl className="space-y-1.5 text-[11px]">
                <div className="flex justify-between gap-2"><dt className="text-slate-500">In sync</dt><dd>{current?.indexedSha === current?.sha ? <Status status="CONNECTED" label="yes" /> : <Status status="UNKNOWN" label="unverified" />}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Dirty</dt><dd className="text-slate-200">{current?.dirty ? "yes" : "no"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Draft</dt><dd className="text-slate-200">{current?.draftSaved ? "saved" : "none"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Language</dt><dd className="text-slate-200">{current?.language ?? "—"}</dd></div>
              </dl>
            </Panel>

            <Panel title="Deploy checklist" bodyClassName="!py-3">
              <ol className="space-y-1.5 text-[11px] text-slate-400">
                <li>1. Draft compared against the production hash you loaded.</li>
                <li>2. Conflict check — a newer remote file blocks the write.</li>
                <li>3. Previous content backed up as a version.</li>
                <li>4. Write, then re-read and verify SHA-256.</li>
                <li>5. Restart and watch startup output for health.</li>
              </ol>
            </Panel>
          </div>
        )}
      </div>

      {/* Mobile editing toolbar */}
      {current && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-950/95 px-2 py-2 backdrop-blur lg:hidden">
          <div className="flex items-center gap-1 overflow-x-auto">
            {mobileActions.map((action) => (
              <button
                key={action.label}
                onClick={action.run}
                className="flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[9px] text-slate-400 hover:bg-ink-800 hover:text-slate-100"
              >
                <action.icon className="h-4 w-4" />
                {action.label}
              </button>
            ))}
            <button onClick={() => void saveDraft()} className="ml-auto flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[9px] text-accent-soft">
              <Save className="h-4 w-4" /> Draft
            </button>
            <button onClick={() => setDeployOpen(true)} className="flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[9px] text-emerald-300">
              <CloudUpload className="h-4 w-4" /> Deploy
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deployOpen}
        onClose={() => {
          setDeployOpen(false);
          setPushAfterDeploy(false);
        }}
        onConfirm={() => void deploy(pushAfterDeploy)}
        busy={deploying}
        title="Deploy to production?"
        description={
          <div className="space-y-2">
            <p className="mono text-[11px] text-slate-300">{current?.path}</p>
            <p>This writes the file on Pterodactyl, verifies the stored SHA-256, then restarts the bot and watches startup output.</p>
            {current && !current.validation.ok && !current.validation.pending && (
              <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                The file does not parse. Deployment will be rejected until the syntax error is fixed.
              </p>
            )}
          </div>
        }
        confirmLabel="Deploy & restart"
      />

      <Modal
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title="Production changed under you"
        subtitle="The deployment was blocked before writing anything"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setConflict(null)}>Keep my draft</button>
            <button
              className="btn-primary"
              onClick={async () => {
                setConflict(null);
                if (current) {
                  await openFile(current.path);
                  push("Reloaded the current production file", "ok");
                }
              }}
            >
              Reload production
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">{conflict?.message}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Nothing was written. The remote and local versions are both preserved in the conflict record under
          Synchronization, where you can compare them.
        </p>
      </Modal>

      {current && <div className="h-14 lg:hidden" />}
    </div>
  );
}

function quickValidate(content: string): { ok: boolean; errors: Array<{ line: number; message: string }> } {
  let depth = 0;
  let line = 1;
  const errors: Array<{ line: number; message: string }> = [];
  for (const char of content) {
    if (char === "\n") line += 1;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth < 0) {
        errors.push({ line, message: "Unexpected closing brace" });
        break;
      }
    }
  }
  if (depth > 0 && errors.length === 0) errors.push({ line, message: `${depth} unclosed brace(s)` });
  return { ok: errors.length === 0, errors };
}

export default function EditorPage() {
  return (
    <Suspense fallback={<div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Loading editor…</div>}>
      <EditorView />
    </Suspense>
  );
}
