"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, FileSearch, Replace, Search as SearchIcon, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, Empty, Modal, Panel, Spinner, Stat } from "@/components/ui";
import { apiGet, apiPost, errorMessage } from "@/lib/client";

type Hit = {
  path: string;
  name: string;
  line: number;
  column: number;
  match: string;
  lineText: string;
  before: string[];
  after: string[];
  occurrence: number;
};

type SearchResult = {
  query: string;
  mode: string;
  hits: Hit[];
  filesScanned: number;
  filesWithMatches: number;
  liveRefreshed: number;
  truncated: boolean;
  tookMs: number;
  source: string;
  warnings: string[];
};

type Preview = {
  path: string;
  name: string;
  occurrences: number;
  changes: Array<{ line: number; before: string; after: string }>;
  newContent: string;
  newSha: string;
  oldSha: string | null;
};

export default function SearchPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("auto");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [live, setLive] = useState(true);
  const [folder, setFolder] = useState("");

  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [deploying, setDeploying] = useState(false);

  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!activeId || !query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        serverId: activeId,
        q: query.trim(),
        mode,
        caseSensitive: caseSensitive ? "1" : "0",
        live: live ? "1" : "0",
        limit: "400",
      });
      if (folder.trim()) params.set("folder", folder.trim());
      const data = await apiGet<SearchResult>(`/api/search?${params.toString()}`);
      setResult(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const previewReplace = async () => {
    setBusy(true);
    try {
      const data = await apiPost<{ previews: Preview[]; matchedFiles: number; totalOccurrences: number; warnings: string[]; note: string }>(
        "/api/search",
        {
          serverId: activeId,
          query: query.trim(),
          replacement,
          mode,
          caseSensitive,
          ...(folder.trim() ? { folder: folder.trim() } : {}),
        },
      );
      setPreviews(data.previews);
      setSelectedFiles(new Set(data.previews.map((preview) => preview.path)));
      if (data.previews.length === 0) push("No file contains that search text", "info");
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const deploySelected = async () => {
    if (!previews) return;
    const files = previews
      .filter((preview) => selectedFiles.has(preview.path))
      .map((preview) => ({ path: preview.path, content: preview.newContent, expectedSha: preview.oldSha }));
    if (files.length === 0) return;

    setDeploying(true);
    try {
      const result = await apiPost<{ deployment: { publicId: string; status: string; error: string | null } }>("/api/deployments", {
        serverId: activeId,
        files,
        message: `Global replace: ${query} → ${replacement} (${files.length} files)`,
      });
      if (result.deployment.status === "SUCCEEDED") push(`Replaced across ${files.length} files in ${result.deployment.publicId}`, "ok");
      else push(`${result.deployment.publicId}: ${result.deployment.error}`, "error");
      setReplaceOpen(false);
      setPreviews(null);
      await runSearch();
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setDeploying(false);
    }
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  const grouped = new Map<string, Hit[]>();
  for (const hit of result?.hits ?? []) {
    if (!grouped.has(hit.path)) grouped.set(hit.path, []);
    grouped.get(hit.path)!.push(hit);
  }

  return (
    <>
      <PageHeader
        title="Global Search"
        description="Searches the actual production bytes, not a stale cache. Live mode re-reads candidate files before matching."
        actions={
          <button className="btn-ghost" onClick={() => setReplaceOpen(true)}>
            <Replace className="h-3.5 w-3.5" /> Search &amp; replace
          </button>
        }
      />

      <Panel bodyClassName="!py-3">
        <form onSubmit={runSearch} className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              className="field !py-2 pl-8 text-sm"
              placeholder={`case 'menu' · isOwner · function · /regex/i`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <select className="field !w-auto !py-2 text-xs" value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="auto">Auto</option>
            <option value="literal">Exact text</option>
            <option value="case">Switch case</option>
            <option value="function">Function</option>
            <option value="regex">Regex</option>
            <option value="fuzzy">Similar</option>
          </select>
          <input className="field !w-32 !py-2 text-xs" placeholder="folder (opt)" value={folder} onChange={(event) => setFolder(event.target.value)} />
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /> Aa
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} /> live
          </label>
          <button className="btn-primary !py-2" disabled={busy || !query.trim()}>
            {busy ? <Spinner /> : <SearchIcon className="h-3.5 w-3.5" />} Search
          </button>
        </form>
      </Panel>

      {error && <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

      {result && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Matches" value={result.hits.length} hint={result.truncated ? "truncated" : "all shown"} tone="accent" />
            <Stat label="Files" value={result.filesWithMatches} hint={`of ${result.filesScanned} scanned`} />
            <Stat label="Source" value={result.source} hint={`${result.liveRefreshed} files re-read from production`} />
            <Stat label="Duration" value={`${result.tookMs} ms`} hint={`mode: ${result.mode}`} />
          </div>

          {result.warnings.map((warning, index) => (
            <p key={index} className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-200">
              <Sparkles className="mt-0.5 h-3 w-3 shrink-0" /> {warning}
            </p>
          ))}

          <div className="mt-3 space-y-3">
            {Array.from(grouped.entries()).map(([path, hits]) => (
              <Panel
                key={path}
                title={path}
                subtitle={`${hits.length} match${hits.length === 1 ? "" : "es"}`}
                actions={<Link href={`/editor?path=${encodeURIComponent(path)}&line=${hits[0].line}`} className="text-[11px] text-accent-soft hover:underline">Open <ArrowRight className="inline h-3 w-3" /></Link>}
                bodyClassName="!py-2"
              >
                <ul className="divide-y divide-ink-750/50">
                  {hits.slice(0, 25).map((hit, index) => (
                    <li key={`${hit.line}-${index}`} className="py-1.5">
                      <Link
                        href={`/editor?path=${encodeURIComponent(path)}&line=${hit.line}`}
                        className="block rounded px-1 hover:bg-ink-800/50"
                      >
                        <div className="flex items-center gap-2 text-[10px] text-slate-500">
                          <Badge tone="default">L{hit.line}</Badge>
                          <span className="mono truncate">{hit.match}</span>
                        </div>
                        <pre className="code-scroll mt-0.5 overflow-hidden text-[11px] text-slate-400">
{hit.before.map((line, i) => `  ${hit.line - hit.before.length + i} │ ${line}`).join("\n")}
{`> ${hit.line} │ ${hit.lineText}`}
{hit.after.map((line, i) => `  ${hit.line + 1 + i} │ ${line}`).join("\n")}
                        </pre>
                      </Link>
                    </li>
                  ))}
                </ul>
                {hits.length > 25 && <p className="mt-1 text-[10px] text-slate-600">+{hits.length - 25} more matches in this file</p>}
              </Panel>
            ))}
          </div>

          {result.hits.length === 0 && (
            <Panel className="mt-3">
              <Empty title="No matches in production" hint="Try live mode, a looser mode (Similar), or confirm the file was indexed by a discovery scan." action={<Link href="/discovery" className="btn-ghost"><FileSearch className="h-3.5 w-3.5" /> Run discovery</Link>} />
            </Panel>
          )}
        </>
      )}

      {!result && !busy && (
        <Panel className="mt-3">
          <Empty
            title="Search the live dispatcher"
            hint="Examples: case 'menu' · isOwner · config.ownerNumber · function · database/ · /case\s+'(\w+)'/gi"
          />
        </Panel>
      )}

      <Modal
        open={replaceOpen}
        onClose={() => { setReplaceOpen(false); setPreviews(null); }}
        wide
        title="Global search & replace"
        subtitle="Preview every affected line before anything is written"
        footer={
          <>
            <button className="btn-ghost" onClick={() => { setReplaceOpen(false); setPreviews(null); }}>Close</button>
            <button className="btn-ghost" onClick={() => void previewReplace()} disabled={busy || !query.trim()}>
              {busy ? <Spinner /> : <SearchIcon className="h-3.5 w-3.5" />} Build preview
            </button>
            <button className="btn-primary" onClick={() => void deploySelected()} disabled={deploying || !previews || selectedFiles.size === 0}>
              {deploying ? <Spinner /> : <Replace className="h-3.5 w-3.5" />} Deploy {selectedFiles.size} file(s)
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Find</label>
            <input className="field mono mt-1" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div>
            <label className="label">Replace with</label>
            <input className="field mono mt-1" value={replacement} onChange={(event) => setReplacement(event.target.value)} />
          </div>
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Uses the current mode ({mode}). Each file is deployed through the normal pipeline: backup → write → hash verify → restart.
          Files are never edited in place without a backup.
        </p>

        {previews && (
          <div className="mt-3 space-y-2">
            {previews.length === 0 && <Empty title="No occurrences found" hint="Adjust the query or mode and build the preview again." />}
            {previews.map((preview) => (
              <div key={preview.path} className="rounded-lg border border-ink-700/70 bg-ink-900/50">
                <label className="flex cursor-pointer items-center gap-2 border-b border-ink-750/70 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(preview.path)}
                    onChange={() =>
                      setSelectedFiles((current) => {
                        const next = new Set(current);
                        if (next.has(preview.path)) next.delete(preview.path);
                        else next.add(preview.path);
                        return next;
                      })
                    }
                  />
                  <span className="mono min-w-0 flex-1 truncate text-[11px] text-slate-200">{preview.path}</span>
                  <Badge tone="warn">{preview.occurrences}</Badge>
                </label>
                <ul className="max-h-40 overflow-auto px-3 py-1.5">
                  {preview.changes.slice(0, 12).map((change) => (
                    <li key={change.line} className="py-1">
                      <p className="text-[10px] text-slate-500">line {change.line}</p>
                      <p className="mono truncate text-[10px] text-rose-300">- {change.before}</p>
                      <p className="mono truncate text-[10px] text-emerald-300">+ {change.after}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
