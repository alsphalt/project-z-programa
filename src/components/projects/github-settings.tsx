"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Cloud,
  Github,
  KeyRound,
  Link2,
  Plug,
  RefreshCw,
  Save,
  ShieldAlert,
  Unplug,
  XCircle,
} from "lucide-react";
import { Badge, Empty, Panel, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { apiDelete, apiGet, apiPost, apiPut, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { relative } from "@/lib/format";

type Connection = {
  connected: boolean;
  status: "connected" | "disconnected" | "failed";
  authMode: "token" | "oauth" | null;
  tokenConfigured: boolean;
  tokenHint: string | null;
  scopes: string[];
  account: { login: string; name: string | null; avatar: string | null; id: string | null } | null;
  repository: { owner: string; name: string; branch: string | null } | null;
  repositoryConfigured: boolean;
  oauthAppConfigured: boolean;
  oauthClientId: string | null;
  autoSync: boolean;
  syncDelaySeconds: number;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
};

type Capability = { key: string; label: string; ok: boolean | null; detail: string };

/**
 * GITHUB CONNECTION — Admin Settings.
 *
 * Two ways in: a personal access token (verified against /user before it is
 * stored) or a real OAuth App authorization. The token never leaves the server,
 * and the panel only ever shows its last four characters.
 */
export function GitHubSettings() {
  const { push } = useToast();
  const connection = useApi<{ connection: Connection }>("/api/github/settings");
  const projects = useApi<{ projects: Array<{ id: string; name: string; pendingChanges: number; repository: unknown; syncStatus: string }> }>("/api/projects");

  const [owner, setOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [delay, setDelay] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Capability[] | null>(null);

  const data = connection.data?.connection;

  const run = async (key: string, fn: () => Promise<unknown>, message?: string) => {
    setBusy(key);
    try {
      await fn();
      if (message) push(message, "ok");
      await connection.refresh();
      await projects.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const saveToken = () =>
    run("token", () => apiPut("/api/github/settings", { token }), "GitHub token verified and stored").then(() => setToken(""));

  const saveRepository = () =>
    run(
      "repository",
      () =>
        apiPut("/api/github/settings", {
          repository: { owner: owner || data?.repository?.owner || "", name: repoName || data?.repository?.name || "", branch: branch || undefined },
        }),
      "Repository configured",
    ).then(() => {
      setOwner("");
      setRepoName("");
      setBranch("");
    });

  const saveOAuthApp = () =>
    run(
      "oauth",
      () => apiPut("/api/github/settings", { oauthApp: { clientId, clientSecret: clientSecret || undefined } }),
      "OAuth App saved",
    ).then(() => setClientSecret(""));

  const test = async () => {
    setBusy("test");
    try {
      const result = await apiPost<{ ok: boolean; checks: Capability[] }>("/api/github/test");
      setChecks(result.checks);
      push(result.ok ? "GitHub connection verified" : "GitHub connection has problems", result.ok ? "ok" : "error");
      await connection.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const saveSync = () =>
    run("sync", () => apiPut("/api/github/settings", { autoSync: data?.autoSync, syncDelaySeconds: delay ?? data?.syncDelaySeconds }), "Synchronization settings saved");

  const pendingProjects = (projects.data?.projects ?? []).filter((project) => project.repository && project.pendingChanges > 0);

  return (
    <div className="space-y-4" id="github">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Github className="h-4 w-4" /> GitHub connection
          </span>
        }
        subtitle="Used by GitHub Import and by automatic synchronization of imported projects."
        actions={
          <>
            <button className="btn-ghost !py-1.5 text-[11px]" onClick={() => void test()} disabled={busy !== null}>
              {busy === "test" ? <Spinner /> : <Plug className="h-3 w-3" />} TEST CONNECTION
            </button>
            {data?.connected && (
              <button
                className="btn-danger !py-1.5 text-[11px]"
                onClick={() => void run("disconnect", () => apiDelete("/api/github/settings?target=token"), "GitHub disconnected")}
                disabled={busy !== null}
              >
                <Unplug className="h-3 w-3" /> Disconnect
              </button>
            )}
          </>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StatusCell
            label="GitHub"
            value={data?.connected ? "GitHub Connected" : "GitHub Disconnected"}
            tone={data?.connected ? "good" : "bad"}
            hint={data?.account ? `@${data.account.login}` : "no account authorised"}
          />
          <StatusCell
            label="Repository"
            value={data?.repositoryConfigured ? "Repository Configured" : "No Repository"}
            tone={data?.repositoryConfigured ? "good" : "default"}
            hint={data?.repository ? `${data.repository.owner}/${data.repository.name}${data.repository.branch ? `@${data.repository.branch}` : ""}` : "account-wide list is used"}
          />
          <StatusCell
            label="Access token"
            value={data?.tokenConfigured ? "Token Configured" : "No Token"}
            tone={data?.tokenConfigured ? "good" : "default"}
            hint={data?.tokenHint ?? "stored encrypted, never returned"}
          />
          <StatusCell
            label="Last test"
            value={data?.lastTestOk === null || data?.lastTestOk === undefined ? "Not tested" : data.lastTestOk ? "Connection OK" : "Connection Failed"}
            tone={data?.lastTestOk === false ? "bad" : data?.lastTestOk ? "good" : "default"}
            hint={data?.lastTestAt ? relative(data.lastTestAt) : "run TEST CONNECTION"}
          />
        </div>

        {data?.lastError && (
          <p className="mt-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {data.lastError}
          </p>
        )}

        {checks && (
          <ul className="mt-3 divide-y divide-ink-750/60">
            {checks.map((check) => (
              <li key={check.key} className="flex items-start justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-200">{check.label}</p>
                  <p className="mono break-words text-[10px] text-slate-500">{check.detail}</p>
                </div>
                {check.ok === null ? <Badge tone="default">n/a</Badge> : check.ok ? <Badge tone="good">pass</Badge> : <Badge tone="bad">fail</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="A. GitHub repository"
          subtitle="Optional — when set, GitHub Import connects straight to this repository"
          actions={
            <button className="btn-primary !py-1.5 text-[11px]" onClick={() => void saveRepository()} disabled={busy !== null || !data?.tokenConfigured}>
              {busy === "repository" ? <Spinner /> : <Link2 className="h-3 w-3" />} Save repository
            </button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Owner</label>
              <input
                className="field mt-1"
                value={owner}
                placeholder={data?.repository?.owner ?? "bigbrother"}
                onChange={(event) => setOwner(event.target.value)}
              />
            </div>
            <div>
              <label className="label">Repository</label>
              <input
                className="field mt-1"
                value={repoName}
                placeholder={data?.repository?.name ?? "Darknote-Bot"}
                onChange={(event) => setRepoName(event.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Branch (optional — defaults to the repository default branch)</label>
              <input
                className="field mt-1"
                value={branch}
                placeholder={data?.repository?.branch ?? "main"}
                onChange={(event) => setBranch(event.target.value)}
              />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              className="btn-ghost !py-1.5 text-[11px]"
              onClick={() => void run("clear-repo", () => apiDelete("/api/github/settings?target=repository"), "Repository configuration cleared")}
              disabled={busy !== null || !data?.repositoryConfigured}
            >
              Clear repository
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
            The repository is verified with the stored token before it is saved — a wrong owner or a private repository without access is rejected here,
            not later during an import.
          </p>
        </Panel>

        <Panel
          title="B/C. GitHub account & access token"
          subtitle="OAuth App authorization, or a fine-grained personal access token"
          actions={
            data?.oauthAppConfigured ? (
              <a className="btn-ghost !py-1.5 text-[11px]" href="/api/github/oauth/start">
                <Github className="h-3 w-3" /> Authorize with GitHub
              </a>
            ) : undefined
          }
        >
          <div className="space-y-3">
            <div>
              <label className="label">Access token (optional)</label>
              <div className="mt-1 flex flex-wrap gap-2">
                <input
                  className="field min-w-0 flex-1"
                  type="password"
                  value={token}
                  placeholder="ghp_… or github_pat_…"
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="btn-primary !py-1.5 text-[11px]" onClick={() => void saveToken()} disabled={busy !== null || token.length < 8}>
                  {busy === "token" ? <Spinner /> : <KeyRound className="h-3 w-3" />} Connect
                </button>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                Needs <span className="mono">repo</span> (read private repositories and push) and <span className="mono">read:user</span>. Classic or
                fine-grained both work; the token is verified with GitHub before it is stored, encrypted with AES-256-GCM, never logged and never returned.
                {data?.scopes?.length ? ` Current scopes: ${data.scopes.join(", ")}.` : ""}
              </p>
            </div>

            <div className="rounded-lg border border-ink-700/60 bg-ink-950/40 px-3 py-2.5">
              <p className="label">OAuth App (for the authorization flow)</p>
              <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                <input
                  className="field !py-1.5 text-xs"
                  value={clientId}
                  placeholder={data?.oauthClientId ?? "Client ID"}
                  onChange={(event) => setClientId(event.target.value)}
                />
                <input
                  className="field !py-1.5 text-xs"
                  type="password"
                  value={clientSecret}
                  placeholder="Client secret (leave blank to keep)"
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button className="btn-ghost !py-1.5 text-[11px]" onClick={() => void saveOAuthApp()} disabled={busy !== null || clientId.length < 4}>
                  {busy === "oauth" ? <Spinner /> : <Save className="h-3 w-3" />} Save OAuth App
                </button>
                <span className="text-[10px] text-slate-600">
                  Callback URL: <span className="mono">{typeof window !== "undefined" ? `${window.location.origin}/api/github/oauth/callback` : "/api/github/oauth/callback"}</span>
                </span>
              </div>
            </div>

            <p className="text-[10px] leading-relaxed text-slate-600">
              A GitHub email address is never accepted as identity — only a token GitHub resolves to an account grants repository access.
            </p>
          </div>
        </Panel>
      </div>

      <Panel
        title="8. Synchronization settings"
        subtitle="Automatic pushes of saved changes, and what is currently waiting"
        actions={
          <button className="btn-primary !py-1.5 text-[11px]" onClick={() => void saveSync()} disabled={busy !== null}>
            {busy === "sync" ? <Spinner /> : <Save className="h-3 w-3" />} Save
          </button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-[11px] text-slate-300">
            <input
              type="checkbox"
              checked={data?.autoSync ?? true}
              onChange={(event) => {
                const value = event.target.checked;
                void run("toggle", () => apiPut("/api/github/settings", { autoSync: value }));
              }}
            />
            Enable automatic synchronization
          </label>
          <div>
            <label className="label">Debounce delay (seconds)</label>
            <input
              className="field mt-1"
              value={String(delay ?? data?.syncDelaySeconds ?? 5)}
              onChange={(event) => setDelay(Number(event.target.value.replace(/[^0-9]/g, "")) || 5)}
            />
          </div>
        </div>

        <dl className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
          <Row label="Synchronization status" value={data?.autoSync ? "Automatic" : "Manual only"} />
          <Row label="Last verified" value={data?.lastVerifiedAt ? relative(data.lastVerifiedAt) : "never"} />
          <Row label="Account" value={data?.account?.login ?? "—"} />
          <Row label="Repository connection" value={data?.repository ? `${data.repository.owner}/${data.repository.name}` : "not configured"} />
        </dl>

        <div className="mt-3">
          <p className="label">Pending changes</p>
          {!pendingProjects.length ? (
            <p className="mt-1 text-[11px] text-slate-500">Nothing is waiting to be pushed.</p>
          ) : (
            <ul className="mt-1.5 space-y-1.5">
              {pendingProjects.map((project) => (
                <li key={project.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-700/60 bg-ink-950/40 px-2.5 py-1.5">
                  <span className="text-[11px] text-slate-200">{project.name}</span>
                  <Badge tone="warn">{project.pendingChanges} file(s)</Badge>
                  <span className="text-[10px] text-slate-600">{project.syncStatus}</span>
                  <button
                    className="btn-ghost ml-auto !px-2 !py-1 text-[10px]"
                    onClick={() =>
                      void run(`push:${project.id}`, () => apiPost("/api/github/sync", { projectId: project.id, action: "sync" }), "Push finished — see the project")
                    }
                    disabled={busy !== null}
                  >
                    {busy === `push:${project.id}` ? <Spinner className="h-2.5 w-2.5" /> : <Cloud className="h-2.5 w-2.5" />} Manual sync
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </div>
  );
}

function StatusCell({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: "good" | "bad" | "default";
}) {
  return (
    <div className="rounded-lg border border-ink-700/60 bg-ink-950/40 px-3 py-2">
      <p className="label">{label}</p>
      <p className={`mt-1 flex items-center gap-1.5 text-[11px] font-medium ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-slate-300"}`}>
        {tone === "good" ? <CheckCircle2 className="h-3 w-3" /> : tone === "bad" ? <XCircle className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-[10px] text-slate-600">{hint}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-ink-700/50 bg-ink-950/40 px-2.5 py-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-slate-200">{value}</dd>
    </div>
  );
}
