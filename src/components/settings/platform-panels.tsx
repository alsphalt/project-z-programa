"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Fingerprint,
  Github,
  Loader2,
  Lock,
  Smartphone,
  Trash2,
  UserPlus,
} from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPut, errorMessage } from "@/lib/client";
import { useServers, useToast } from "@/components/providers";
import { Badge, Empty, Panel, Spinner } from "@/components/ui";
import { relative } from "@/lib/format";
import {
  hasPlatformAuthenticator,
  isWebAuthnSupported,
  listPasskeys,
  registerPasskey,
  removePasskey,
  type CredentialSummary,
} from "@/lib/webauthn-client";
import type { PlatformSettings } from "@/lib/settings/platform";

/**
 * Administrator panels for the platform switches added with this release.
 *
 * Each panel writes through its own API route, keeps the server value as the
 * source of truth, and shows the value it read back — no local optimism about
 * whether a toggle was saved.
 */

function usePlatformSettings() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await apiGet<{ settings: PlatformSettings }>("/api/settings/platform");
      setSettings(data.settings);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { settings, error, reload, setSettings };
}

// --------------------------------------------------------------- biometric

export function BiometricSettingsPanel() {
  const { push } = useToast();
  const platform = usePlatformSettings();
  const [credentials, setCredentials] = useState<CredentialSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState<{ webauthn: boolean; platform: boolean }>({
    webauthn: false,
    platform: false,
  });
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await listPasskeys();
      setCredentials(data.credentials);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    setSupported({ webauthn: isWebAuthnSupported(), platform: false });
    if (isWebAuthnSupported()) {
      void hasPlatformAuthenticator().then((value) => setSupported({ webauthn: true, platform: value }));
    }
  }, [load]);

  const enrol = async () => {
    setBusy("enrol");
    setError(null);
    try {
      await registerPasskey(label.trim() || undefined);
      setLabel("");
      await load();
      push("Biometric sign-in enrolled on this device", "ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string) => {
    setBusy(`revoke-${id}`);
    try {
      setCredentials(await removePasskey(id));
      push("Device removed — it can no longer sign in", "ok");
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const savePolicy = async (patch: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const data = await apiPut<{ settings: PlatformSettings }>("/api/settings/platform", { security: patch });
      platform.setSettings(data.settings);
      push("Security policy saved", "ok");
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title="Biometric authentication"
        subtitle="Optional fingerprint or face sign-in through WebAuthn. Only a public key is stored — never a fingerprint, face image or template."
      >
        {!supported.webauthn ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            This browser cannot use passkeys. Biometric enrolment needs a current browser over HTTPS, or the installed
            app (the Android WebView enables the same WebAuthn path, with the OS performing the biometric check).
            Password sign-in is unaffected.
          </p>
        ) : !supported.platform ? (
          <p className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
            No built-in authenticator was detected on this device, so there is nothing to enrol here. A security key or
            a device with Windows Hello / Touch ID / Android biometrics can still be added later.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <label className="label">Device label (optional)</label>
              <input
                className="field mt-1"
                placeholder="e.g. Pixel 8 — fingerprint"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={80}
              />
            </div>
            <button className="btn-primary" disabled={busy !== null} onClick={() => void enrol()}>
              {busy === "enrol" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5" />}
              Enrol this device
            </button>
          </div>
        )}

        {error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}

        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Registered devices</p>
          {!credentials ? (
            <p className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
              <Spinner /> Reading enrolled credentials…
            </p>
          ) : credentials.length === 0 ? (
            <Empty title="No biometric device enrolled" hint="Enrol one above. Your password still works either way." />
          ) : (
            <ul className="mt-2 divide-y divide-ink-750/60">
              {credentials.map((credential) => (
                <li key={credential.id} className="flex flex-wrap items-center gap-2 py-2">
                  <Smartphone className="h-3.5 w-3.5 shrink-0 text-accent-soft" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-slate-200">{credential.label}</p>
                    <p className="text-[10px] text-slate-500">
                      {credential.attachment ?? "platform"} · added {relative(credential.createdAt)} ·{" "}
                      {credential.lastUsedAt ? `last used ${relative(credential.lastUsedAt)}` : "never used"}
                      {credential.backupEligible ? " · synced passkey" : ""}
                    </p>
                  </div>
                  <Badge tone="good">active</Badge>
                  <button
                    className="btn-danger !px-2 !py-1 text-[10px]"
                    disabled={busy !== null}
                    onClick={() => void revoke(credential.id)}
                  >
                    {busy === `revoke-${credential.id}` ? <Spinner /> : <Trash2 className="h-3 w-3" />} Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel title="Sign-in policy" subtitle="Applies to every account on this deployment">
        <ul className="space-y-2 text-[11px]">
          <li className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-slate-300">Allow passkeys (WebAuthn)</span>
            <Toggle
              value={platform.settings?.security.passkeysEnabled ?? true}
              busy={busy === "passkeys"}
              onChange={(value) => void savePolicy({ passkeysEnabled: value }, "passkeys")}
            />
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-slate-300">
              Allow biometric sign-in
              <span className="block text-[10px] text-slate-600">
                Off means every account signs in with a password, even with a passkey enrolled.
              </span>
            </span>
            <Toggle
              value={platform.settings?.security.biometricLoginEnabled ?? true}
              disabled={!platform.settings?.security.passkeysEnabled}
              busy={busy === "biometric"}
              onChange={(value) => void savePolicy({ biometricLoginEnabled: value }, "biometric")}
            />
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-slate-300">
              Require user verification
              <span className="block text-[10px] text-slate-600">
                The authenticator must confirm it is you (biometric or device PIN) — not just a tap.
              </span>
            </span>
            <Toggle
              value={platform.settings?.security.requireUserVerification ?? true}
              busy={busy === "uv"}
              onChange={(value) => void savePolicy({ requireUserVerification: value }, "uv")}
            />
          </li>
        </ul>
        <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
          Biometric verification happens on the device. DARKNOTE stores the credential id, a public key, a signature
          counter and the device label. Challenges are single-use and verified server-side.
        </p>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------ registration

export function RegistrationSettingsPanel() {
  const { push } = useToast();
  const platform = usePlatformSettings();
  const [busy, setBusy] = useState<string | null>(null);

  const save = async (patch: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const data = await apiPut<{ settings: PlatformSettings }>("/api/settings/platform", { registration: patch });
      platform.setSettings(data.settings);
      push("Registration policy saved", "ok");
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const enabled = platform.settings?.registration.enabled ?? true;

  return (
    <Panel
      title="Sign-up and account persistence"
      subtitle="Registration is a permanent feature of DARKNOTE. It is never expired, hidden or removed by an update — only this switch changes it."
      actions={<Badge tone={enabled ? "good" : "warn"}>{enabled ? "open" : "closed"}</Badge>}
    >
      <div className="space-y-3 text-[11px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-slate-300">
            Allow new users to register
            <span className="block text-[10px] text-slate-600">
              Existing accounts are unaffected. Every account lives in the database and survives restarts and
              redeployments.
            </span>
          </span>
          <Toggle
            value={enabled}
            busy={busy === "enabled"}
            onChange={(value) => void save({ enabled: value }, "enabled")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-slate-300">
            Role for new accounts
            <span className="block text-[10px] text-slate-600">
              Viewer is read-only. Raise it deliberately: a new account can push files to GitHub from the first day.
            </span>
          </span>
          <select
            className="field !w-auto !py-1 text-[11px]"
            value={platform.settings?.registration.defaultRole ?? "viewer"}
            disabled={busy !== null}
            onChange={(event) => void save({ defaultRole: event.target.value }, "role")}
          >
            <option value="viewer">VIEWER</option>
            <option value="operator">OPERATOR</option>
            <option value="admin">ADMIN</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Link href="/register" className="btn-ghost !py-1 text-[11px]" target="_blank">
            <UserPlus className="h-3 w-3" /> Open the sign-up page
          </Link>
          <span className="text-slate-600">Accounts are hashed with bcrypt (cost 12) and never deleted automatically.</span>
        </div>
        {platform.error && <p className="text-rose-300">{platform.error}</p>}
      </div>
    </Panel>
  );
}

// --------------------------------------------------------- github bindings

type BindingRow = {
  id: string;
  serverId: string;
  serverName: string;
  projectId: string;
  repo: string | null;
  branch: string | null;
  pathPrefix: string;
  autoSync: boolean;
};

export function GitHubBindingsPanel() {
  const { push } = useToast();
  const { servers, activeId } = useServers();
  const [bindings, setBindings] = useState<BindingRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeId) {
      setBindings([]);
      return;
    }
    try {
      const data = await apiGet<{ bindings: BindingRow[] }>(`/api/github/binding?serverId=${activeId}`);
      setBindings(data.bindings);
    } catch (err) {
      push(errorMessage(err), "error");
      setBindings([]);
    }
  }, [activeId, push]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (serverId: string) => {
    setBusy(serverId);
    try {
      await apiDelete(`/api/github/binding?serverId=${serverId}`);
      await load();
      push("Binding removed — the repository and its history are untouched", "ok");
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (serverId: string, autoSync: boolean) => {
    setBusy(serverId);
    try {
      await apiPatch("/api/github/binding", { serverId, autoSync });
      await load();
    } catch (err) {
      push(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Servers bound to a repository"
      subtitle="FILE MANAGER and the CODE EDITOR push through these bindings, using the same connection and queue as CRASH AND FIX."
      actions={<Github className="h-4 w-4 text-accent-soft" />}
    >
      {!bindings ? (
        <p className="flex items-center gap-2 text-[11px] text-slate-500">
          <Spinner /> Reading bindings…
        </p>
      ) : bindings.length === 0 ? (
        <Empty
          title="No server is bound yet"
          hint="Bind one from the File Manager or the Code Editor — the repository is verified against GitHub before it is stored."
        />
      ) : (
        <ul className="divide-y divide-ink-750/60">
          {bindings.map((binding) => (
            <li key={binding.id} className="flex flex-wrap items-center gap-2 py-2 text-[11px]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-slate-200">{binding.serverName}</p>
                <p className="mono truncate text-[10px] text-slate-500">
                  {binding.repo ?? "repository missing"}
                  {binding.branch ? `@${binding.branch}` : ""}
                  {binding.pathPrefix ? `:${binding.pathPrefix}` : ""}
                </p>
              </div>
              <label className="flex items-center gap-1.5 text-slate-400">
                <input
                  type="checkbox"
                  checked={binding.autoSync}
                  disabled={busy !== null}
                  onChange={(event) => void toggle(binding.serverId, event.target.checked)}
                />
                auto
              </label>
              <Link href={`/files`} className="btn-ghost !px-2 !py-1 text-[10px]">
                Open
              </Link>
              <button
                className="btn-danger !px-2 !py-1 text-[10px]"
                disabled={busy !== null}
                onClick={() => void remove(binding.serverId)}
              >
                {busy === binding.serverId ? <Spinner /> : <Trash2 className="h-3 w-3" />} Unbind
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10px] text-slate-600">
        Registered servers: {servers.map((server) => server.name).join(", ") || "none"}.
      </p>
    </Panel>
  );
}

function Toggle({
  value,
  onChange,
  busy,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled || busy}
      onClick={() => onChange(!value)}
      className={`inline-flex h-5 w-9 items-center rounded-full border transition ${
        value ? "border-emerald-500/50 bg-emerald-500/25" : "border-ink-600 bg-ink-800"
      } ${disabled ? "opacity-40" : ""}`}
    >
      <span
        className={`ml-0.5 h-3.5 w-3.5 rounded-full transition ${value ? "translate-x-4 bg-emerald-300" : "bg-slate-500"}`}
      />
    </button>
  );
}
