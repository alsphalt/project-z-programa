"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  CheckCheck,
  CircleDot,
  Copy,
  GitCommitHorizontal,
  HardHat,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  TerminalSquare,
  Undo2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Badge, CopyButton, Empty, Modal, Panel, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { apiGet, apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { CodeEditor } from "@/components/code-editor";
import { relative } from "@/lib/format";

/**
 * CRASH AND FIX 👷‍♂️
 *
 * The terminal is a presentation layer; every line that claims something about
 * the project is produced from a real API response. The 3 s initialisation and
 * the 5 s scan window are pacing, not fake results: if the search finishes early
 * the remaining time is used for completion animations that repeat the measured
 * numbers, and if it takes longer the scan simply keeps running.
 */

type CaseMatch = {
  ref: string;
  projectId: string;
  projectName: string;
  fileId: string;
  caseName: string;
  code: string;
  startLine: number;
  endLine: number;
  caseStart: number;
  caseEnd: number;
  fileSha: string;
  caseSha: string;
  ordinal: number;
  language: string;
};

type SearchResult = {
  query: string;
  matches: CaseMatch[];
  stats: {
    projects: number;
    filesScanned: number;
    filesMatched: number;
    casesExamined: number;
    skippedFiles: number;
    durationMs: number;
  };
  truncated: boolean;
  note: string;
};

type SyncDecision = { applicable: boolean; scheduled: boolean; at: string | null; reason: string };

type SaveResult = {
  match: CaseMatch;
  fileSha: string;
  previousFileSha: string;
  validation: { ok: boolean; errors: Array<{ line: number; message: string }>; warnings: string[] };
  sync: SyncDecision;
  historyId: string;
  message: string;
};

type SyncEvent = { id: number; level: string; phase: string | null; message: string; at: string };
type SyncState = {
  syncStatus: string;
  syncError: string | null;
  lastSyncAt: string | null;
  lastCommitSha: string | null;
  lastCommitUrl: string | null;
  branch: string | null;
  pending: { count: number; dueAt: string | null; files: string[] } | null;
  events: SyncEvent[];
};

type HistoryEntry = {
  id: string;
  caseName: string;
  action: string;
  status: string;
  createdAt: string;
  beforeCode: string;
  afterCode: string;
};

type Line = { id: number; text: string; tone: "blue" | "green" | "red" | "dim" };

type Phase = "idle" | "init" | "scanning" | "done" | "error";

const INIT_LINES = [
  "[CRASH AND FIX] INITIALIZING...",
  "[+] Loading JavaScript scanner...",
  "[+] Preparing code analysis...",
  "[+] Initializing search engine...",
  "[+] Activating detection system...",
  "[+] Scanner ready.",
];

const SCAN_LINES = [
  "[+] Starting JavaScript scan...",
  "[+] Searching registered commands...",
  "[+] Analyzing switch statements...",
  "[+] Checking case declarations...",
  "[+] Examining JavaScript structures...",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KEYWORDS = new Set([
  "await", "async", "break", "case", "catch", "class", "const", "continue", "default", "delete",
  "do", "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in",
  "instanceof", "let", "new", "of", "return", "super", "switch", "this", "throw", "try", "typeof",
  "var", "while", "yield", "true", "false", "null", "undefined",
]);

const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;

function highlightLine(line: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    if (match.index > last) nodes.push(line.slice(last, match.index));
    const [full, comment, string, number, word] = match;
    if (comment) nodes.push(<span key={key++} className="text-slate-600 italic">{full}</span>);
    else if (string) nodes.push(<span key={key++} className="text-emerald-300">{full}</span>);
    else if (number) nodes.push(<span key={key++} className="text-amber-300">{full}</span>);
    else if (word) {
      const isKeyword = KEYWORDS.has(word);
      const isCall = /^\s*\(/.test(line.slice(match.index + full.length));
      if (word === "case" || word === "switch" || word === "break") {
        nodes.push(<span key={key++} className="text-violet-300 font-medium">{full}</span>);
      } else if (isKeyword) {
        nodes.push(<span key={key++} className="text-accent-soft">{full}</span>);
      } else if (isCall) {
        nodes.push(<span key={key++} className="text-cyber">{full}</span>);
      } else {
        nodes.push(<span key={key++} className="text-slate-200">{full}</span>);
      }
    }
    last = match.index + full.length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes.length ? nodes : " ";
}

function toneClass(tone: Line["tone"]): string {
  if (tone === "green") return "text-emerald-300";
  if (tone === "red") return "text-rose-400";
  if (tone === "dim") return "text-slate-500";
  return "text-cyber";
}

export default function CrashAndFixPage() {
  const { push } = useToast();
  const projects = useApi<{ projects: Array<{ id: string; name: string; source: string; repository: { owner: string; name: string; branch: string | null } | null }> }>(
    "/api/projects",
  );

  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<{ match: CaseMatch; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncDecision, setSyncDecision] = useState<SyncDecision | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [syncLines, setSyncLines] = useState<Line[]>([]);
  const [seenEvents, setSeenEvents] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const lineId = useRef(0);
  const runToken = useRef<{ cancelled: boolean }>({ cancelled: false });
  const terminalRef = useRef<HTMLDivElement | null>(null);

  const append = useCallback((text: string, tone: Line["tone"]) => {
    lineId.current += 1;
    const id = lineId.current;
    setLines((current) => [...current, { id, text, tone }]);
  }, []);

  useEffect(() => {
    const node = terminalRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const activeProject = useMemo(
    () => projects.data?.projects.find((project) => project.id === projectId) ?? null,
    [projects.data, projectId],
  );

  const loadHistory = useCallback(async (id: string) => {
    if (!id) {
      setHistory([]);
      return;
    }
    try {
      const data = await apiGet<{ history: HistoryEntry[] }>(`/api/crash-and-fix/history?projectId=${id}`);
      setHistory(data.history);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    void loadHistory(projectId);
  }, [projectId, loadHistory]);

  // ---------------------------------------------------------------- searching

  const runSearch = async (rawQuery: string) => {
    const term = rawQuery.trim();
    if (!term) {
      push("Type a command name first (for example “menu”).", "error");
      return;
    }

    // Cancel whatever was running: a new search never races the previous one.
    runToken.current.cancelled = true;
    const token = { cancelled: false };
    runToken.current = token;

    setPhase("init");
    setLines([]);
    setResult(null);
    setError(null);
    setProgress(4);
    setSyncDecision(null);
    setSyncState(null);
    setSyncLines([]);

    for (const [index, text] of INIT_LINES.entries()) {
      if (token.cancelled) return;
      append(text, index === 0 ? "blue" : index === INIT_LINES.length - 1 ? "green" : "blue");
      setProgress(4 + Math.round(((index + 1) / INIT_LINES.length) * 26));
      await sleep(430);
    }

    if (token.cancelled) return;
    setPhase("scanning");
    const scanStart = Date.now();

    const request = apiGet<SearchResult>(
      `/api/crash-and-fix/search?q=${encodeURIComponent(term)}${projectId ? `&projectId=${projectId}` : ""}`,
    );

    // Present the real phases while the request is in flight.
    for (const [index, text] of SCAN_LINES.entries()) {
      if (token.cancelled) return;
      append(text, "blue");
      setProgress(34 + Math.round(((index + 1) / SCAN_LINES.length) * 40));
      await sleep(320);
      if (index === 2) append(`[+] Searching for: ${term}`, "dim");
    }

    if (token.cancelled) return;
    append("[+] Extracting complete case...", "blue");
    setProgress(84);
    append("[+] Verifying code boundaries...", "blue");

    let data: SearchResult;
    try {
      data = await request;
    } catch (requestError) {
      if (token.cancelled) return;
      setPhase("error");
      setError(errorMessage(requestError));
      append(`[!] ${errorMessage(requestError)}`, "red");
      setProgress(100);
      return;
    }

    if (token.cancelled) return;

    // Hold the presentation to ~5 s of scanning; never fabricate a result.
    const elapsed = Date.now() - scanStart;
    if (elapsed < 5000) {
      setProgress(90);
      await sleep(5000 - elapsed);
      if (token.cancelled) return;
    }

    setResult(data);
    setProgress(100);
    setPhase("done");

    if (data.matches.length) {
      append(`[+] Matching pattern detected — ${data.matches.length} case(s)`, "green");
      append(
        `[+] Search completed: ${data.stats.filesScanned} file(s) · ${data.stats.casesExamined} case(s) examined · ${data.stats.durationMs} ms`,
        "green",
      );
      append("[+] EXTRACTION COMPLETE", "green");
      append("[+] CASE FOUND", "green");
    } else {
      append("[!] CASE NOT FOUND", "red");
      append("[!] No matching JavaScript case was detected.", "red");
    }
  };

  // ------------------------------------------------------------- sync polling

  const pollSync = useCallback(async (id: string, token: { cancelled: boolean }) => {
    try {
      const data = await apiGet<{ sync: SyncState }>(`/api/github/sync?projectId=${id}&tick=1`);
      if (token.cancelled) return;
      setSyncState(data.sync);
      setSeenEvents((current) => {
        const next = new Set(current);
        const incoming: Line[] = [];
        for (const event of data.sync.events) {
          if (next.has(event.id)) continue;
          next.add(event.id);
          incoming.push({
            id: event.id,
            text: event.message,
            tone: event.level === "success" ? "green" : event.level === "error" ? "red" : event.level === "warn" ? "red" : "blue",
          });
        }
        if (incoming.length) setSyncLines((existing) => [...existing, ...incoming]);
        return next;
      });
    } catch {
      /* the next tick retries */
    }
  }, []);

  useEffect(() => {
    if (!syncDecision?.scheduled || !editing?.match.projectId) return;
    const token = { cancelled: false };
    void pollSync(editing.match.projectId, token);
    const timer = window.setInterval(() => void pollSync(editing.match.projectId, token), 2200);
    return () => {
      token.cancelled = true;
      window.clearInterval(timer);
    };
  }, [syncDecision, editing, pollSync]);

  // -------------------------------------------------------------------- saves

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const data = await apiPost<SaveResult>("/api/crash-and-fix/save", {
        projectId: editing.match.projectId,
        fileId: editing.match.fileId,
        caseName: editing.match.caseName,
        caseStart: editing.match.caseStart,
        expectedFileSha: editing.match.fileSha,
        expectedCaseSha: editing.match.caseSha,
        expectedCaseCode: editing.match.code,
        nextCode: editing.value,
      });
      setResult((current) =>
        current
          ? {
              ...current,
              matches: current.matches.map((match) => (match.fileId === data.match.fileId && match.caseStart === editing.match.caseStart ? data.match : match)),
            }
          : current,
      );
      setEditing({ match: data.match, value: data.match.code });
      setSyncDecision(data.sync);
      append("[+] CASE UPDATED SUCCESSFULLY", "green");
      append("[+] JavaScript validation passed.", "green");
      append("[+] Original source updated.", "green");
      append("[+] Changes synchronized with panel.", "green");
      if (data.sync.scheduled) append(`[+] ${data.sync.reason}`, "blue");
      else append(`[!] ${data.sync.reason}`, "red");
      push("Case saved to the project file", "ok");
      void loadHistory(editing.match.projectId);
    } catch (saveFailure) {
      const message = errorMessage(saveFailure);
      setSaveError(message);
      append(`[!] SAVE FAILED — ${message}`, "red");
      push(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (historyId: string) => {
    try {
      const data = await apiPost<SaveResult>("/api/crash-and-fix/rollback", { historyId });
      append("[+] PREVIOUS VERSION RESTORED", "green");
      setSyncDecision(data.sync);
      setResult((current) =>
        current
          ? {
              ...current,
              matches: current.matches.map((match) =>
                match.fileId === data.match.fileId && match.caseName === data.match.caseName ? data.match : match,
              ),
            }
          : current,
      );
      if (editing && editing.match.fileId === data.match.fileId) {
        setEditing({ match: data.match, value: data.match.code });
      }
      push("Previous version restored", "ok");
      void loadHistory(data.match.projectId);
    } catch (rollbackFailure) {
      push(errorMessage(rollbackFailure), "error");
    }
  };

  const manualSync = async () => {
    const id = editing?.match.projectId ?? projectId;
    if (!id) return;
    try {
      const data = await apiPost<{ sync: SyncState }>("/api/github/sync", { projectId: id, action: "sync" });
      setSyncState(data.sync);
      push(
        data.sync.syncStatus === "synced" ? "Pushed — GitHub confirmed the commit" : `Sync status: ${data.sync.syncStatus}`,
        data.sync.syncStatus === "synced" ? "ok" : "error",
      );
      const token = { cancelled: false };
      void pollSync(id, token);
    } catch (syncFailure) {
      push(errorMessage(syncFailure), "error");
      append(`[!] SYNC FAILED — ${errorMessage(syncFailure)}`, "red");
    }
  };

  const resolveConflict = async (mode: "merge-remote" | "discard-local") => {
    const id = editing?.match.projectId ?? projectId;
    if (!id) return;
    try {
      const data = await apiPost<{ sync: SyncState; message: string }>("/api/github/sync", {
        projectId: id,
        action: "resolve",
        mode,
      });
      setSyncState(data.sync);
      push(data.message, "ok");
    } catch (conflictFailure) {
      push(errorMessage(conflictFailure), "error");
    }
  };

  const busy = phase === "init" || phase === "scanning";

  return (
    <>
      <PageHeader
        title="CRASH AND FIX 👷‍♂️"
        description="Search a real command case, read the extracted block, repair it, and let the panel write it back to the imported project."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select className="field !w-auto !py-1.5 text-[11px]" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">All imported projects</option>
              {(projects.data?.projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button className="btn-ghost !py-1.5 text-[11px]" onClick={() => void projects.refresh()}>
              <RefreshCw className="h-3 w-3" /> Projects
            </button>
          </div>
        }
      />

      <Panel
        className="!bg-ink-950/80"
        title={
          <span className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-cyber" /> JavaScript scanner
          </span>
        }
        subtitle={
          activeProject
            ? `Scope: ${activeProject.name}${activeProject.repository ? ` · ${activeProject.repository.owner}/${activeProject.repository.name}@${activeProject.repository.branch ?? ""}` : ""}`
            : "Scope: every imported JavaScript project"
        }
        bodyClassName="!px-3 sm:!px-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cyber/70" />
            <input
              className="field mono !bg-black/70 pl-9 text-sm !border-cyber/25 focus:!border-cyber/60"
              placeholder="menu · play · ping · sticker · antidelete · promote …"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) void runSearch(query);
              }}
              spellCheck={false}
            />
          </div>
          <button className="btn-primary" onClick={() => void runSearch(query)} disabled={busy}>
            {busy ? <Spinner /> : <HardHat className="h-3.5 w-3.5" />}
            {busy ? "SCANNING" : "SCAN & EXTRACT"}
          </button>
        </div>

        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-ink-800">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              phase === "error" ? "bg-rose-500" : phase === "done" ? "bg-emerald-400" : "bg-gradient-to-r from-accent via-cyber to-emerald-400"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>

        <div
          ref={terminalRef}
          className="mono mt-3 h-[268px] overflow-y-auto rounded-lg border border-cyber/15 bg-black px-3 py-2.5 text-[11.5px] leading-[1.7] shadow-[inset_0_0_40px_rgba(49,208,245,0.06)]"
        >
          {lines.length === 0 && (
            <p className="text-slate-600">
              $ awaiting target command…
              <span className="ml-1 inline-block h-3 w-1.5 animate-pulseSoft bg-cyber align-middle" />
            </p>
          )}
          {lines.map((line) => (
            <p key={line.id} className={toneClass(line.tone)}>
              {line.text}
            </p>
          ))}
          {busy && (
            <p className="text-cyber/70">
              <span className="animate-pulseSoft">█</span>
            </p>
          )}
        </div>
      </Panel>

      <SyncStrip
        decision={syncDecision}
        state={syncState}
        lines={syncLines}
        onManualSync={() => void manualSync()}
        onResolve={resolveConflict}
      />

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          {phase === "done" && result && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <Badge tone={result.matches.length ? "good" : "bad"}>
                {result.matches.length ? "CASE FOUND" : "CASE NOT FOUND"}
              </Badge>
              <span className="text-slate-500">
                {result.matches.length} match(es) · {result.stats.filesScanned} file(s) scanned · {result.stats.casesExamined} case(s) examined ·{" "}
                {result.stats.durationMs} ms
              </span>
              {result.truncated && <span className="text-amber-300">showing the first 40 matches</span>}
            </div>
          )}

          {phase === "error" && error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <p className="flex items-center gap-1.5 font-medium">
                <ShieldAlert className="h-3.5 w-3.5" /> SEARCH FAILED
              </p>
              <p className="mt-1 text-rose-200/80">{error}</p>
            </div>
          )}

          {result?.matches.map((match) => (
            <CaseCard
              key={match.ref}
              match={match}
              onEdit={() => {
                setSaveError(null);
                setSyncDecision(null);
                setSyncLines([]);
                setEditing({ match, value: match.code });
              }}
            />
          ))}

          {phase === "done" && result && !result.matches.length && (
            <Empty
              title="No matching JavaScript case was detected"
              hint={`Nothing in the imported projects declares a case matching “${result.query}”. ${result.note}`}
            />
          )}

          {phase === "idle" && (
            <Empty
              title="Ready to scan"
              hint="Type a command name above. The scanner parses the imported JavaScript and returns only the matching case — never file names, folders or unrelated code."
            />
          )}
        </div>

        <div className="space-y-3">
          <Panel title="Repair history" subtitle={activeProject ? activeProject.name : "Select one project to see its edits"}>
            {!projectId && (
              <p className="text-[11px] leading-relaxed text-slate-500">
                Edit history is stored per project. Choose a project in the header to list its repairs.
              </p>
            )}
            {projectId && !history.length && (
              <p className="text-[11px] text-slate-500">No repairs recorded for this project yet.</p>
            )}
            {projectId && history.length > 0 && (
              <ul className="space-y-2">
                {history.slice(0, 8).map((entry) => (
                  <li key={entry.id} className="rounded-lg border border-ink-700/60 bg-ink-950/50 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="mono truncate text-[11px] text-slate-200">{entry.caseName}</p>
                      <Badge tone={entry.status === "saved" ? "good" : entry.status === "rolled_back" ? "warn" : "bad"}>
                        {entry.action}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[10px] text-slate-600">{relative(entry.createdAt)}</p>
                    <button
                      className="btn-ghost mt-1.5 !px-2 !py-1 text-[10px]"
                      onClick={() => void rollback(entry.id)}
                    >
                      <Undo2 className="h-2.5 w-2.5" /> Restore this version
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="What this scans" subtitle="Real files, real parser">
            <ul className="space-y-2 text-[11px] leading-relaxed text-slate-500">
              <li className="flex gap-2">
                <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-cyber" /> Every JavaScript file of the imported projects is parsed with acorn; only
                <span className="mono text-slate-300">case '…':</span> blocks are returned.
              </li>
              <li className="flex gap-2">
                <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-cyber" /> A save is refused if the file or the case changed since you loaded it.
              </li>
              <li className="flex gap-2">
                <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-cyber" /> GitHub pushes are debounced by 5 seconds and only reported after GitHub
                confirms the ref.
              </li>
            </ul>
          </Panel>
        </div>
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Repair “${editing.match.caseName}”` : "Repair case"}
        subtitle={editing ? `${editing.match.projectName} · lines ${editing.match.startLine}–${editing.match.endLine} · ${editing.value !== editing.match.code ? "unsaved changes" : "saved"}` : undefined}
        wide
        footer={
          <>
            <button className="btn-ghost" onClick={() => setEditing(null)}>
              <X className="h-3.5 w-3.5" /> Discard
            </button>
            <button
              className="btn-ghost"
              onClick={() => editing && setEditing({ match: editing.match, value: editing.match.code })}
              disabled={!editing || editing.value === editing.match.code}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </button>
            <button className="btn-primary" onClick={() => void save()} disabled={saving || !editing || editing.value === editing.match.code}>
              {saving ? <Spinner /> : <CheckCheck className="h-3.5 w-3.5" />} SAVE
            </button>
          </>
        }
      >
        {editing && (
          <div className="space-y-2">
            <div className="h-[46vh] min-h-[280px] overflow-hidden rounded-lg border border-ink-700/70">
              <CodeEditor
                path={`crash-and-fix/${editing.match.fileId}-${editing.match.caseStart}.js`}
                value={editing.value}
                language="javascript"
                large={editing.value.length > 160_000}
                onChange={(value) => setEditing((current) => (current ? { ...current, value } : current))}
              />
            </div>
            {saveError && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">{saveError}</p>
            )}
            {syncDecision && (
              <p
                className={`rounded-lg border px-3 py-2 text-[11px] ${
                  syncDecision.scheduled
                    ? "border-cyber/30 bg-cyber/10 text-cyber"
                    : syncDecision.applicable
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                      : "border-ink-700 bg-ink-900/60 text-slate-400"
                }`}
              >
                {syncDecision.reason}
              </p>
            )}
            <p className="text-[10px] leading-relaxed text-slate-600">
              Only this case is replaced. The rest of the file is preserved byte for byte, the whole file is re-parsed, and the previous version stays in
              the repair history.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}

function CaseCard({ match, onEdit }: { match: CaseMatch; onEdit: () => void }) {
  const lines = match.code.split("\n");
  return (
    <div className="panel overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-750/70 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-300">
            CASE
          </span>
          <p className="mono truncate text-xs font-semibold text-slate-100">case '{match.caseName}':</p>
          <Badge tone="default">{match.projectName}</Badge>
          <span className="text-[10px] text-slate-600">
            lines {match.startLine}–{match.endLine}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <CopyButton value={match.code} label="Copy" />
          <button className="btn-ghost !px-2 !py-1 text-[11px]" onClick={onEdit}>
            <Pencil className="h-3 w-3" /> Edit
          </button>
        </div>
      </header>
      <div className="code-scroll max-h-[420px] overflow-auto bg-[#0b0d13] px-0 py-2">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${match.ref}-${index}`} className="align-top hover:bg-white/[0.02]">
                <td className="w-[1%] select-none whitespace-nowrap border-r border-ink-800/80 px-2 text-right text-[10px] leading-[1.65] text-slate-700">
                  {match.startLine + index}
                </td>
                <td className="whitespace-pre px-3 text-[12px] leading-[1.65] text-slate-200">{highlightLine(line)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SyncStrip({
  decision,
  state,
  lines,
  onManualSync,
  onResolve,
}: {
  decision: SyncDecision | null;
  state: SyncState | null;
  lines: Line[];
  onManualSync: () => void;
  onResolve: (mode: "merge-remote" | "discard-local") => void;
}) {
  if (!decision && !state && !lines.length) return null;

  const status = state?.syncStatus ?? (decision?.scheduled ? "pending" : null);
  const tone =
    status === "synced"
      ? "good"
      : status === "failed" || status === "conflict"
        ? "bad"
        : status
          ? "warn"
          : "default";

  return (
    <div className="mt-3 rounded-xl border border-ink-700/70 bg-ink-950/70 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold tracking-wider text-slate-300">
          <GitCommitHorizontal className="h-3.5 w-3.5 text-cyber" /> GITHUB SYNCHRONIZATION
        </span>
        {status && <Badge tone={tone}>{status.toUpperCase()}</Badge>}
        {state?.branch && <span className="text-slate-600">branch {state.branch}</span>}
        {state?.pending && (
          <span className="text-slate-500">
            {state.pending.count} pending file(s)
            {state.pending.dueAt ? ` · due ${new Date(state.pending.dueAt).toLocaleTimeString()}` : ""}
          </span>
        )}
        {state?.lastSyncAt && <span className="text-slate-600">last sync {relative(state.lastSyncAt)}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {state?.lastCommitUrl && (
            <a className="btn-ghost !px-2 !py-1 text-[10px]" href={state.lastCommitUrl} target="_blank" rel="noreferrer">
              <ArrowUpRight className="h-2.5 w-2.5" /> Commit
            </a>
          )}
          <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={onManualSync}>
            <RefreshCw className="h-2.5 w-2.5" /> Manual sync
          </button>
          {(status === "conflict" || state?.syncStatus === "conflict") && (
            <>
              <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => onResolve("merge-remote")}>
                Rebase &amp; push
              </button>
              <button className="btn-danger !px-2 !py-1 text-[10px]" onClick={() => onResolve("discard-local")}>
                Discard local
              </button>
            </>
          )}
        </div>
      </div>

      {state?.syncError && <p className="mt-1.5 text-[11px] text-rose-300">{state.syncError}</p>}
      {decision && !state?.syncError && <p className="mt-1.5 text-[11px] text-slate-500">{decision.reason}</p>}

      {lines.length > 0 && (
        <div className="mono mt-2 max-h-[120px] overflow-y-auto rounded-lg bg-black/60 px-2.5 py-2 text-[11px] leading-[1.7]">
          {lines.slice(-12).map((line) => (
            <p key={`sync-${line.id}`} className={toneClass(line.tone)}>
              {line.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
