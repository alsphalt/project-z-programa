"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Eye, EyeOff, Fingerprint, KeyRound, Loader2, ShieldCheck, TerminalSquare } from "lucide-react";
import { ApiError, apiGet, apiPost, errorMessage } from "@/lib/client";
import { authenticateWithPasskey, hasPlatformAuthenticator, isWebAuthnSupported } from "@/lib/webauthn-client";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isPasswordValid,
  passwordChecklist,
  passwordProblems,
} from "@/lib/auth/password-policy";

type PublicPolicy = {
  registrationEnabled: boolean;
  passkeysEnabled: boolean;
  biometricLoginEnabled: boolean;
  branding: { product: string; credit: string };
};

type SessionInfo = {
  user: { id: string; name: string; email: string; role: string } | null;
  needsBootstrap: boolean;
  setupTokenConfigured?: boolean;
  env: { ok: boolean; missing: string[]; backupDriver: string };
  database?: { ok: boolean; error: string | null };
};

export default function LoginPage() {
  const router = useRouter();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [mode, setMode] = useState<"login" | "bootstrap">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [policy, setPolicy] = useState<PublicPolicy | null>(null);
  const [biometricSupported, setBiometricSupported] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricNote, setBiometricNote] = useState<string | null>(null);

  useEffect(() => {
    apiGet<PublicPolicy>("/api/auth/policy")
      .then(setPolicy)
      .catch(() => undefined);
    // Feature detection runs after mount so the server-rendered markup and the
    // first client paint agree.
    if (isWebAuthnSupported()) {
      void hasPlatformAuthenticator().then(setBiometricSupported);
    }
  }, []);

  useEffect(() => {
    apiGet<SessionInfo>("/api/auth/session")
      .then((data) => {
        setInfo(data);
        if (data.user) router.replace("/");
        if (data.needsBootstrap) setMode("bootstrap");
      })
      .catch((err) => {
        if (!(err instanceof ApiError) || err.status !== 401) setError(errorMessage(err));
      });
  }, [router]);

  /**
   * Biometric sign-in. The OS verifies the user; the server verifies the
   * signature over its own challenge. Password sign-in is untouched and always
   * available below.
   */
  const signInWithBiometrics = async () => {
    setError(null);
    setBiometricNote(null);
    setBiometricBusy(true);
    try {
      if (!biometricSupported) {
        setBiometricNote(
          "This device does not offer biometric authentication to the browser. Use your password — passkeys can be enrolled later from Settings → Security.",
        );
        return;
      }
      await authenticateWithPasskey(email.trim() || undefined);
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : errorMessage(err));
    } finally {
      setBiometricBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === "bootstrap") {
      const problems = passwordProblems(password);
      if (problems.length > 0) {
        setError(`Password is not ready yet — ${problems.join("; ")}.`);
        document.getElementById("password")?.focus();
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "login") {
        await apiPost("/api/auth/login", { email, password });
      } else {
        await apiPost("/api/auth/bootstrap", { email, name, password, setupToken });
        await apiPost("/api/auth/login", { email, password });
      }
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-ink-750/70 p-10 lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(109,94,252,0.13) 1px, transparent 1px), linear-gradient(to bottom, rgba(109,94,252,0.13) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse at 30% 20%, black, transparent 70%)",
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/40 bg-gradient-to-br from-accent/30 to-cyber/10">
              <ShieldCheck className="h-5 w-5 text-accent-soft" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-[0.22em] text-slate-100">DARKNOTE</p>
              <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Control Center</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-lg">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-slate-100">
            Remote command over your
            <span className="bg-gradient-to-r from-accent-soft to-cyber bg-clip-text text-transparent"> Pterodactyl bot</span>
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Discover the real files, edit them with hash-checked deployments, restart the bot only after verification,
            and roll back to any previous version. Your bot keeps running on its own server — this console drives it
            through the official panel API.
          </p>
          <ul className="mt-6 space-y-2 text-xs text-slate-500">
            <li className="flex items-center gap-2">
              <TerminalSquare className="h-3.5 w-3.5 text-cyber" /> Live console, resources and startup health
            </li>
            <li className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-accent-soft" /> API keys encrypted in Neon, never sent to the browser
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Backups, conflicts and audit trail on every write
            </li>
          </ul>
        </div>

        <p className="relative text-[11px] text-slate-600">
          Production files remain the source of truth. Nothing here replaces your bot.
        </p>
      </div>

      <div className="flex items-center justify-center px-5 py-10">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-6 lg:hidden">
            <p className="text-sm font-semibold tracking-[0.2em] text-slate-100">DARKNOTE CONTROL CENTER</p>
            <p className="mt-1 text-xs text-slate-500">Remote administration for your WhatsApp bot</p>
          </div>

          <h2 className="text-lg font-semibold text-slate-100">
            {mode === "login" ? "Administrator sign in" : "First-run setup"}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            {mode === "login"
              ? "Authenticate to reach the production server."
              : "No administrator exists yet. Create the owner account using the SETUP_TOKEN from your environment."}
          </p>

          {info?.env && !info.env.ok && info.env.missing.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              Server is missing environment variables: <span className="mono">{info.env.missing.join(", ")}</span>.
              Set them before signing in — see SETUP.md.
            </div>
          )}

          {/*
            The database probe always answers now, so a broken deployment explains
            itself here instead of only in the server log. Sign-in is disabled
            below while this is shown: posting credentials to a database that
            cannot start would fail with a 500 and tell the operator nothing.
          */}
          {info?.database && !info.database.ok && (
            <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-200">
              <span className="font-semibold">The database did not initialise.</span>{" "}
              <span className="mono break-words">{info.database.error ?? "No further detail was returned."}</span>
              <div className="mt-1 text-rose-200/70">
                Nothing was deleted. Fix the connection or migration above, redeploy, then reload this page.
              </div>
            </div>
          )}

          {mode === "bootstrap" && info && info.setupTokenConfigured === false && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              This deployment has no <span className="mono">SETUP_TOKEN</span> configured, so first-run setup is
              closed. Set it in the environment (or run <span className="mono">npm run create-admin</span>) and reload.
            </div>
          )}

          <div className="mt-5 space-y-3">
            {mode === "bootstrap" && (
              <div>
                <label className="label" htmlFor="name">
                  Full name
                </label>
                <input
                  id="name"
                  className="field mt-1"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                  autoComplete="name"
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="field mt-1"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="username"
                inputMode="email"
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-2">
                <label className="label" htmlFor="password">
                  Password
                </label>
                {mode === "bootstrap" && (
                  <span className="text-[10px] tabular-nums text-slate-600">
                    {Math.min(password.length, PASSWORD_MAX_LENGTH)}/{PASSWORD_MAX_LENGTH}
                  </span>
                )}
              </div>
              <div className="relative mt-1">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  className="field pr-11"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={mode === "bootstrap" ? PASSWORD_MIN_LENGTH : 8}
                  maxLength={PASSWORD_MAX_LENGTH}
                  autoComplete={mode === "bootstrap" ? "new-password" : "current-password"}
                  aria-describedby={mode === "bootstrap" ? "password-policy" : undefined}
                  aria-invalid={mode === "bootstrap" && password.length > 0 && !isPasswordValid(password)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-slate-500 transition hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  aria-controls="password"
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
              {mode === "bootstrap" && (
                <div className="mt-2">
                  <p id="password-policy-title" className="text-[11px] font-medium text-slate-400">
                    Password requirements
                  </p>
                  <ul
                    id="password-policy"
                    aria-labelledby="password-policy-title"
                    aria-live="polite"
                    className="mt-1 space-y-1"
                  >
                    {passwordChecklist(password).map((rule) => (
                      <li
                        key={rule.hint}
                        className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${
                          rule.met ? "text-emerald-400" : "text-slate-500"
                        }`}
                      >
                        <span className="mt-[1px] flex h-3 w-3 shrink-0 items-center justify-center">
                          {rule.met ? (
                            <Check className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <span className="h-1 w-1 rounded-full bg-slate-600" aria-hidden="true" />
                          )}
                        </span>
                        <span>
                          {rule.hint}
                          <span className="sr-only">
                            {rule.met ? " — requirement met" : " — requirement not met yet"}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {mode === "bootstrap" && (
              <div>
                <label className="label" htmlFor="token">
                  Setup token
                </label>
                <input
                  id="token"
                  className="field mono mt-1"
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  required
                  autoComplete="off"
                />
              </div>
            )}
          </div>

          {error && (
            <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn-primary mt-5 w-full"
            disabled={
              busy ||
              Boolean(info?.database && !info.database.ok) ||
              (mode === "bootstrap" && !isPasswordValid(password))
            }
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            {mode === "login" ? "Sign in" : "Create owner account"}
          </button>

          {mode === "login" && policy?.biometricLoginEnabled && (
            <>
              <div className="my-4 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-slate-600">
                <span className="h-px flex-1 bg-ink-750" /> or <span className="h-px flex-1 bg-ink-750" />
              </div>
              <button
                type="button"
                className="btn-ghost w-full"
                onClick={() => void signInWithBiometrics()}
                disabled={biometricBusy}
              >
                {biometricBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
                Sign in with fingerprint / face
              </button>
              <p className="mt-1.5 text-center text-[10px] leading-relaxed text-slate-600">
                {biometricSupported
                  ? "Your device verifies you. DARKNOTE stores only a public key."
                  : "No biometric authenticator detected on this device — password sign-in still works."}
              </p>
              {biometricNote && (
                <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                  {biometricNote}
                </p>
              )}
            </>
          )}

          {mode === "login" && policy?.registrationEnabled && (
            <Link href="/register" className="btn-ghost mt-2 w-full">
              Create an account
            </Link>
          )}

          {!info?.needsBootstrap && (
            <button
              type="button"
              onClick={() => setMode(mode === "login" ? "bootstrap" : "login")}
              className="mt-3 w-full text-center text-[11px] text-slate-500 hover:text-slate-300"
            >
              {mode === "login" ? "First run? Create the owner account" : "Back to sign in"}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
