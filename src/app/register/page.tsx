"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Check, Fingerprint, Loader2, ShieldCheck, UserPlus } from "lucide-react";
import { apiGet, apiPost, errorMessage } from "@/lib/client";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isPasswordValid,
  passwordChecklist,
} from "@/lib/auth/password-policy";
import { hasPlatformAuthenticator, registerPasskey } from "@/lib/webauthn-client";

type Policy = {
  registrationEnabled: boolean;
  passkeysEnabled: boolean;
  biometricLoginEnabled: boolean;
  branding: { product: string; credit: string };
};

/**
 * Self-service registration.
 *
 * Always reachable while `registration.enabled` is true — nothing here expires,
 * hides itself after a period, or is removed by a deployment. Accounts are rows
 * in the same database everything else uses, so they survive restarts and
 * redeploys.
 */
export default function RegisterPage() {
  const router = useRouter();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ passkeys: boolean } | null>(null);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState<string | null>(null);
  const [biometricDone, setBiometricDone] = useState(false);

  useEffect(() => {
    apiGet<Policy>("/api/auth/policy")
      .then(setPolicy)
      .catch(() => setPolicy(null));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!isPasswordValid(form.password)) {
      setError("The password does not meet the policy yet.");
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost<{ registered: boolean; signedIn: boolean }>("/api/auth/register", form);
      if (result.signedIn) {
        setCreated({ passkeys: Boolean(policy?.passkeysEnabled) });
      } else {
        router.replace("/login");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const enrolBiometric = async () => {
    setBiometricBusy(true);
    setBiometricError(null);
    try {
      const supported = await hasPlatformAuthenticator();
      if (!supported) {
        setBiometricError(
          "This device does not offer a built-in biometric authenticator. You can add one later from Settings → Security on a supported device.",
        );
        return;
      }
      await registerPasskey();
      setBiometricDone(true);
    } catch (err) {
      setBiometricError(err instanceof Error ? err.message : errorMessage(err));
    } finally {
      setBiometricBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/40 bg-gradient-to-br from-accent/30 to-cyber/10">
            <ShieldCheck className="h-5 w-5 text-accent-soft" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-[0.22em] text-slate-100">DARKNOTE</p>
            <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">POWERED BY JIMMY M, TECH</p>
          </div>
        </div>

        {created ? (
          <div className="panel px-5 py-5">
            <h1 className="text-lg font-semibold text-slate-100">Account created</h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              You are signed in. Your account is stored in the persistent database and survives restarts and
              redeployments.
            </p>

            {created.passkeys && (
              <div className="mt-4 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-3">
                <p className="flex items-center gap-2 text-xs font-medium text-slate-200">
                  <Fingerprint className="h-4 w-4 text-accent-soft" /> Enable biometric authentication
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  Optional. The device verifies your fingerprint or face; DARKNOTE only stores a public key. Your
                  password still works.
                </p>
                {biometricDone ? (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-300">
                    <Check className="h-3.5 w-3.5" /> Enrolled — you can use it next time you sign in.
                  </p>
                ) : (
                  <button className="btn-ghost mt-2 !py-1.5 text-[11px]" disabled={biometricBusy} onClick={() => void enrolBiometric()}>
                    {biometricBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5" />}
                    Enrol this device
                  </button>
                )}
                {biometricError && <p className="mt-2 text-[11px] text-rose-300">{biometricError}</p>}
              </div>
            )}

            <button className="btn-primary mt-4 w-full" onClick={() => router.replace("/")}>
              Continue to the dashboard
            </button>
          </div>
        ) : policy && !policy.registrationEnabled ? (
          <div className="panel px-5 py-5">
            <h1 className="text-lg font-semibold text-slate-100">Registration is closed</h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              An administrator has switched off self-service registration. Existing accounts can still sign in. The
              switch is in Admin Settings → Accounts and can be turned back on at any time.
            </p>
            <Link href="/login" className="btn-ghost mt-4 w-full">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="panel px-5 py-5">
            <h1 className="text-lg font-semibold text-slate-100">Create your account</h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {policy
                ? "Registration is permanent while it is enabled. New accounts start with the "
                    + "read-only role an administrator configured."
                : "Checking registration policy…"}
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="label" htmlFor="name">
                  Full name
                </label>
                <input
                  id="name"
                  className="field mt-1"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  required
                  minLength={2}
                  autoComplete="name"
                />
              </div>
              <div>
                <label className="label" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  className="field mt-1"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
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
                  <span className="text-[10px] tabular-nums text-slate-600">
                    {Math.min(form.password.length, PASSWORD_MAX_LENGTH)}/{PASSWORD_MAX_LENGTH}
                  </span>
                </div>
                <input
                  id="password"
                  type="password"
                  className="field mt-1"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  maxLength={PASSWORD_MAX_LENGTH}
                  autoComplete="new-password"
                  aria-describedby="password-policy"
                />
                <ul id="password-policy" className="mt-2 space-y-1" aria-live="polite">
                  {passwordChecklist(form.password).map((rule) => (
                    <li
                      key={rule.hint}
                      className={`flex items-start gap-1.5 text-[11px] ${rule.met ? "text-emerald-400" : "text-slate-500"}`}
                    >
                      <span className="mt-[1px] flex h-3 w-3 shrink-0 items-center justify-center">
                        {rule.met ? (
                          <Check className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <span className="h-1 w-1 rounded-full bg-slate-600" aria-hidden="true" />
                        )}
                      </span>
                      {rule.hint}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {error && (
              <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary mt-4 w-full" disabled={busy || !isPasswordValid(form.password)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              Create account
            </button>

            <Link href="/login" className="mt-3 block text-center text-[11px] text-slate-500 hover:text-slate-300">
              Already have an account? Sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
