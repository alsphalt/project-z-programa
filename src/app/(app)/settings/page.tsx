"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { KeyRound, Plug, Save, ShieldCheck, Trash2, UserPlus, Zap } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { InstallAppCard } from "@/components/pwa";
import { GitHubSettings } from "@/components/projects/github-settings";
import {
  BiometricSettingsPanel,
  GitHubBindingsPanel,
  RegistrationSettingsPanel,
} from "@/components/settings/platform-panels";
import { Badge, ConfirmDialog, Empty, Panel, Spinner, Status } from "@/components/ui";
import { apiDelete, apiPatch, apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { relative } from "@/lib/format";

type Settings = {
  me: { name: string; email: string; role: string };
  env: { ok: boolean; missing: string[]; backupDriver: string; autoRestart: boolean };
  storage: { driver: string; ready: boolean; detail: string };
  limits: { maxFileEditBytes: number; indexMaxContentBytes: number; scanIntervalSeconds: number; deployRestart: boolean; sensitiveExportRole: string };
  users: Array<{ id: string; email: string; name: string; role: string; isActive: boolean; lastLoginAt: string | null; activeSessions: number }>;
  activeSessions: number;
  servers: Array<{ id: string; name: string; state: string; rootPath: string; lastSeenAt: string | null }>;
  security: Record<string, string>;
};

type ServerDetail = {
  server: {
    id: string; name: string; panelUrl: string; serverIdentifier: string; rootPath: string; apiKeyHint: string; state: string;
    maxFileBytes: number; editorCeilingBytes: number;
    policy: {
      autoRestart: boolean; healthTimeoutMs: number; healthyPatterns: string[]; failurePatterns: string[];
      ignore: string[]; maxScanDepth: number; maxScanFiles: number; indexContent: boolean;
    };
  };
};

type Capability = { key: string; label: string; ok: boolean | null; detail: string };

export default function SettingsPage() {
  const { servers, activeId, setActiveId, reload } = useServers();
  const { push } = useToast();
  const settings = useApi<Settings>("/api/settings");
  const detail = useApi<ServerDetail>(activeId ? `/api/servers/${activeId}` : null);
  const [tab, setTab] = useState<"servers" | "github" | "accounts" | "security">("servers");

  // `?tab=github` is used by the OAuth callback and by the "open GitHub
  // configuration" button in the import dialog.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (
      requested === "github" ||
      requested === "accounts" ||
      requested === "security" ||
      requested === "servers"
    ) {
      setTab(requested);
    }
    const connected = new URLSearchParams(window.location.search).get("github");
    const failure = new URLSearchParams(window.location.search).get("github_error");
    if (connected === "connected") push("GitHub account connected", "ok");
    if (failure) push(failure, "error");
  }, [push]);

  const [form, setForm] = useState({ name: "", panelUrl: "", apiKey: "", serverIdentifier: "", rootPath: "/" });
  const [busy, setBusy] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capability[] | null>(null);

  const [policy, setPolicy] = useState<null | ServerDetail["server"]["policy"]>(null);
  const [editorLimitMb, setEditorLimitMb] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "VIEWER" });
  const [password, setPassword] = useState({ currentPassword: "", newPassword: "" });

  const connect = async () => {
    setBusy("connect");
    try {
      const result = await apiPost<{ server: { id: string } }>("/api/servers", form);
      push("Server registered — run a discovery scan next", "ok");
      setForm({ name: "", panelUrl: "", apiKey: "", serverIdentifier: "", rootPath: "/" });
      await reload();
      setActiveId(result.server.id);
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const test = async (deep: boolean) => {
    if (!activeId) return;
    setBusy("test");
    try {
      const result = await apiPost<{ capabilities: Capability[] }>(`/api/servers/${activeId}/test`, { deep });
      setCaps(result.capabilities);
      push("Connection checks finished", "ok");
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const savePolicy = async () => {
    if (!activeId || !policy) return;
    setBusy("policy");
    try {
      const ceilingMb = Math.round((detail.data?.server.editorCeilingBytes ?? 64 * 1024 * 1024) / 1024 / 1024);
      const maxFileBytes =
        editorLimitMb === null
          ? undefined
          : Math.max(1, Math.min(Math.round(editorLimitMb), ceilingMb)) * 1024 * 1024;
      await apiPatch(`/api/servers/${activeId}`, maxFileBytes === undefined ? { policy } : { policy, maxFileBytes });
      push("Server policy saved", "ok");
      await detail.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const createUser = async () => {
    setBusy("user");
    try {
      await apiPost("/api/settings", { action: "create-user", ...newUser });
      push("Account created", "ok");
      setNewUser({ name: "", email: "", password: "", role: "VIEWER" });
      await settings.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const changePassword = async () => {
    setBusy("password");
    try {
      await apiPost("/api/settings", { action: "change-password", ...password });
      push("Password changed — all sessions revoked. Sign in again.", "ok");
      setPassword({ currentPassword: "", newPassword: "" });
      setTimeout(() => (window.location.href = "/login"), 1200);
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const currentPolicy = policy ?? detail.data?.server.policy ?? null;
  const currentEditorLimitMb =
    editorLimitMb ?? Math.round((detail.data?.server.maxFileBytes ?? 16 * 1024 * 1024) / 1024 / 1024);
  const editorCeilingMb = Math.round((detail.data?.server.editorCeilingBytes ?? 64 * 1024 * 1024) / 1024 / 1024);

  return (
    <>
      <PageHeader
        title="Admin Settings"
        description="Connections, permissions, deployment policy and platform configuration."
        actions={
          <div className="flex gap-1 rounded-lg border border-ink-700/70 bg-ink-900/60 p-1">
            {(["servers", "github", "accounts", "security"] as const).map((key) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`rounded-md px-2.5 py-1 text-[11px] capitalize ${tab === key ? "bg-accent/20 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {key}
              </button>
            ))}
          </div>
        }
      />

      {settings.data?.env && !settings.data.env.ok && (
        <p className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          Missing environment variables: <span className="mono">{settings.data.env.missing.join(", ")}</span>
        </p>
      )}

      {tab === "servers" && (
        <div className="space-y-4">
          <Panel title="Connected servers" subtitle="Only servers you register here are reachable">
            {servers.length === 0 ? (
              <Empty title="No servers yet" hint="Add your existing Pterodactyl server below. Nothing is created there — the console only reads and writes files you already own." />
            ) : (
              <ul className="divide-y divide-ink-750/60">
                {servers.map((server) => (
                  <li key={server.id} className="flex flex-wrap items-center gap-2 py-2">
                    <button onClick={() => setActiveId(server.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-xs font-medium text-slate-200">{server.name}</p>
                      <p className="mono truncate text-[10px] text-slate-500">{server.panelUrl} · {server.serverIdentifier} · root {server.rootPath}</p>
                    </button>
                    <Status status={server.state} />
                    <span className="text-[10px] text-slate-600">seen {relative(server.lastSeenAt)}</span>
                    <button className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300" onClick={() => setRemoveTarget(server.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Register a Pterodactyl server" subtitle="Verified against the panel before it is saved">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Display name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} placeholder="Darknote production" />
              <Field label="Panel URL" value={form.panelUrl} onChange={(value) => setForm({ ...form, panelUrl: value })} placeholder="https://panel.example.com" />
              <Field label="Server identifier" value={form.serverIdentifier} onChange={(value) => setForm({ ...form, serverIdentifier: value })} placeholder="1a2b3c4d" />
              <Field label="Project root (optional)" value={form.rootPath} onChange={(value) => setForm({ ...form, rootPath: value })} placeholder="/" />
              <div className="sm:col-span-2">
                <Field label="Client API key" value={form.apiKey} onChange={(value) => setForm({ ...form, apiKey: value })} placeholder="pacc_…" type="password" />
                <p className="mt-1 text-[10px] text-slate-600">
                  Create it in the panel under Account → API Credentials (Client key, not Application key). It is encrypted with AES-256-GCM before it is stored.
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn-primary" onClick={connect} disabled={busy !== null || !form.name || !form.panelUrl || !form.apiKey || !form.serverIdentifier}>
                {busy === "connect" ? <Spinner /> : <Plug className="h-3.5 w-3.5" />} Verify &amp; connect
              </button>
              <span className="text-[11px] text-slate-600">The key is never returned by any API route.</span>
            </div>
          </Panel>

          {activeId && (
            <Panel
              title="Connection tests"
              subtitle="Read-only checks by default; the write probe creates and removes a temporary file"
              actions={
                <>
                  <button className="btn-ghost !py-1.5 text-[11px]" onClick={() => void test(false)} disabled={busy !== null}>
                    {busy === "test" ? <Spinner /> : <Zap className="h-3 w-3" />} Run checks
                  </button>
                  <button className="btn-ghost !py-1.5 text-[11px]" onClick={() => void test(true)} disabled={busy !== null}>
                    Deep test (write probe)
                  </button>
                </>
              }
            >
              {caps ? (
                <ul className="divide-y divide-ink-750/60">
                  {caps.map((capability) => (
                    <li key={capability.key} className="flex items-start justify-between gap-3 py-1.5">
                      <div className="min-w-0">
                        <p className="text-[11px] text-slate-200">{capability.label}</p>
                        <p className="text-[10px] text-slate-500">{capability.detail}</p>
                      </div>
                      <Badge tone={capability.ok === true ? "good" : capability.ok === false ? "bad" : "default"}>
                        {capability.ok === null ? "not probed" : capability.ok ? "pass" : "fail"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="No checks run yet" hint="Run the checks to see exactly which panel capabilities work with this key." />
              )}
            </Panel>
          )}

          {currentPolicy && (
            <Panel
              title="Deployment & scanning policy"
              subtitle={`${detail.data?.server.name ?? ""} · applied to every deploy and scan`}
              actions={
                <button className="btn-primary !py-1.5 text-[11px]" onClick={savePolicy} disabled={busy !== null}>
                  {busy === "policy" ? <Spinner /> : <Save className="h-3 w-3" />} Save policy
                </button>
              }
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={currentPolicy.autoRestart}
                    onChange={(event) => setPolicy({ ...currentPolicy, autoRestart: event.target.checked })}
                  />
                  Restart the bot automatically after a verified deploy
                </label>
                <label className="flex items-center gap-2 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={currentPolicy.indexContent}
                    onChange={(event) => setPolicy({ ...currentPolicy, indexContent: event.target.checked })}
                  />
                  Keep file contents in the search index
                </label>
                <Field
                  label="Health timeout (ms)"
                  value={String(currentPolicy.healthTimeoutMs)}
                  onChange={(value) => setPolicy({ ...currentPolicy, healthTimeoutMs: Number(value) || 45000 })}
                />
                <Field
                  label="Max scan depth"
                  value={String(currentPolicy.maxScanDepth)}
                  onChange={(value) => setPolicy({ ...currentPolicy, maxScanDepth: Number(value) || 6 })}
                />
                <Field
                  label="Max files per scan"
                  value={String(currentPolicy.maxScanFiles)}
                  onChange={(value) => setPolicy({ ...currentPolicy, maxScanFiles: Number(value) || 2500 })}
                />
                <Field
                  label={`Editor file limit (MB) — ceiling ${editorCeilingMb} MB`}
                  value={String(currentEditorLimitMb)}
                  onChange={(value) => setEditorLimitMb(Number(value.replace(/[^0-9]/g, "")) || 1)}
                />
                <div className="text-[10px] leading-relaxed text-slate-600">
                  Files up to this size open in the chunked editor and are backed up server-side before every write. The
                  process-wide ceiling is set by DARKNOTE_MAX_EDITOR_BYTES.
                </div>
                <div className="text-[10px] leading-relaxed text-slate-600">
                  Ignored folders: {currentPolicy.ignore.join(", ")}
                </div>
                <div className="sm:col-span-2">
                  <label className="label">Healthy startup patterns (one per line)</label>
                  <textarea
                    className="field mono mt-1 h-24 text-[11px]"
                    value={currentPolicy.healthyPatterns.join("\n")}
                    onChange={(event) => setPolicy({ ...currentPolicy, healthyPatterns: event.target.value.split("\n").filter(Boolean) })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="label">Failure patterns (one per line)</label>
                  <textarea
                    className="field mono mt-1 h-24 text-[11px]"
                    value={currentPolicy.failurePatterns.join("\n")}
                    onChange={(event) => setPolicy({ ...currentPolicy, failurePatterns: event.target.value.split("\n").filter(Boolean) })}
                  />
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}

      {tab === "github" && (
        <div className="space-y-4">
          <GitHubSettings />
          <GitHubBindingsPanel />
        </div>
      )}

      {tab === "accounts" && (
        <div className="space-y-4">
          <RegistrationSettingsPanel />

          <Panel title="Administrators" subtitle="Role ceilings: owner > admin > operator > viewer">
            {settings.data?.users.length ? (
              <ul className="divide-y divide-ink-750/60">
                {settings.data.users.map((user) => (
                  <li key={user.id} className="flex flex-wrap items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-slate-200">{user.name} <span className="text-slate-600">· {user.email}</span></p>
                      <p className="text-[10px] text-slate-500">
                        {user.role} · {user.activeSessions} active session(s) · last login {relative(user.lastLoginAt)}
                      </p>
                    </div>
                    {!user.isActive && <Badge tone="bad">disabled</Badge>}
                    <select
                      className="field !w-auto !py-1 text-[11px]"
                      value={user.role}
                      onChange={async (event) => {
                        try {
                          await apiPost("/api/settings", { action: "update-user", userId: user.id, role: event.target.value });
                          push("Role updated", "ok");
                          await settings.refresh();
                        } catch (error) {
                          push(errorMessage(error), "error");
                        }
                      }}
                    >
                      {["OWNER", "ADMIN", "OPERATOR", "VIEWER"].map((role) => <option key={role} value={role}>{role}</option>)}
                    </select>
                    <button
                      className="btn-ghost !px-2 !py-1 text-[10px]"
                      onClick={async () => {
                        try {
                          await apiPost("/api/settings", { action: "update-user", userId: user.id, isActive: !user.isActive });
                          await settings.refresh();
                        } catch (error) {
                          push(errorMessage(error), "error");
                        }
                      }}
                    >
                      {user.isActive ? "Disable" : "Enable"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Only your account exists" hint="Accounts are managed here, not in the panel." />
            )}
          </Panel>

          <Panel title="Add an administrator" subtitle="Minimum 12-character password">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" value={newUser.name} onChange={(value) => setNewUser({ ...newUser, name: value })} />
              <Field label="Email" value={newUser.email} onChange={(value) => setNewUser({ ...newUser, email: value })} />
              <Field label="Password" type="password" value={newUser.password} onChange={(value) => setNewUser({ ...newUser, password: value })} />
              <div>
                <label className="label">Role</label>
                <select className="field mt-1" value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}>
                  {["ADMIN", "OPERATOR", "VIEWER", "OWNER"].map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              </div>
            </div>
            <button className="btn-primary mt-3" onClick={createUser} disabled={busy !== null || !newUser.email || newUser.password.length < 12}>
              {busy === "user" ? <Spinner /> : <UserPlus className="h-3.5 w-3.5" />} Create account
            </button>
          </Panel>
        </div>
      )}

      {tab === "security" && (
        <div className="space-y-4">
          <BiometricSettingsPanel />

          <Panel title="Platform" subtitle="Environment and storage as seen by the server">
            <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
              <Row label="Environment" value={settings.data?.env.ok ? "complete" : `missing ${settings.data?.env.missing.join(", ")}`} />
              <Row label="Backup driver" value={settings.data?.storage.driver ?? "—"} />
              <Row label="Backup location" value={settings.data?.storage.detail ?? "—"} />
              <Row label="Editor byte limit" value={String(settings.data?.limits.maxFileEditBytes ?? "—")} />
              <Row label="Index content limit" value={String(settings.data?.limits.indexMaxContentBytes ?? "—")} />
              <Row label="Scan interval" value={`${settings.data?.limits.scanIntervalSeconds ?? "—"}s`} />
              <Row label="Auto restart" value={settings.data?.limits.deployRestart ? "enabled" : "disabled"} />
              <Row label="Sensitive exports" value={settings.data?.limits.sensitiveExportRole ?? "OWNER"} />
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/api/health" className="btn-ghost !py-1.5 text-[11px]" target="_blank">Health endpoint</Link>
              <Link href="/console" className="btn-ghost !py-1.5 text-[11px]">Open terminal</Link>
            </div>
          </Panel>

          <Panel title="Controls in force">
            <ul className="space-y-1.5 text-[11px] text-slate-400">
              {Object.entries(settings.data?.security ?? {}).map(([key, value]) => (
                <li key={key} className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                  <span><span className="capitalize text-slate-300">{key.replace(/([A-Z])/g, " $1")}:</span> {value}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Installable app" subtitle="Progressive Web App — home screen or dock, offline shell, own window">
            <InstallAppCard />
          </Panel>

          <Panel title="Change my password" subtitle="Revokes every session, including this one">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Current password" type="password" value={password.currentPassword} onChange={(value) => setPassword({ ...password, currentPassword: value })} />
              <Field label="New password (12+ chars)" type="password" value={password.newPassword} onChange={(value) => setPassword({ ...password, newPassword: value })} />
            </div>
            <button
              className="btn-primary mt-3"
              onClick={changePassword}
              disabled={busy !== null || password.newPassword.length < 12 || !password.currentPassword}
            >
              {busy === "password" ? <Spinner /> : <KeyRound className="h-3.5 w-3.5" />} Change password
            </button>
          </Panel>
        </div>
      )}


      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (!removeTarget) return;
          setBusy("remove");
          try {
            await apiDelete(`/api/servers/${removeTarget}`);
            push("Server registration removed — the panel itself is untouched", "ok");
            setRemoveTarget(null);
            await reload();
          } catch (error) {
            push(errorMessage(error), "error");
          } finally {
            setBusy(null);
          }
        }}
        busy={busy === "remove"}
        danger
        title="Remove this server registration?"
        description="The connection, index and history for this server are deleted from the control center. Files on Pterodactyl are not touched."
        confirmLabel="Remove"
        requireText="REMOVE"
      />
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="field mt-1" value={value} type={type} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
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
