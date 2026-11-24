"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, RefreshCw, Share, Smartphone, WifiOff, X } from "lucide-react";

type InstallOutcome = "accepted" | "dismissed" | "instructions" | "unavailable" | "installed";

type InstallState = "checking" | "available" | "ios" | "installed" | "unavailable";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type PwaContextValue = {
  installState: InstallState;
  updateReady: boolean;
  offline: boolean;
  promptInstall: () => Promise<InstallOutcome>;
  applyUpdate: () => void;
  openInstructions: () => void;
};

const PwaContext = createContext<PwaContextValue | null>(null);

function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports a desktop user agent.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const [installState, setInstallState] = useState<InstallState>("checking");
  const [updateReady, setUpdateReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadingRef = useRef(false);

  /* ---------------------------------------------------------- service worker */

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // The worker caches build output; in dev it would fight HMR, so it is only
    // registered for production builds (or with ?sw=1 for a manual check).
    const forced = new URLSearchParams(window.location.search).has("sw");
    if (process.env.NODE_ENV !== "production" && !forced) return;

    let cancelled = false;
    let visibilityListener: (() => void) | null = null;

    navigator.serviceWorker
      // `updateViaCache: "none"` keeps the HTTP cache from pinning an old worker
      // after a redeploy — the failure mode where a phone runs last week's bundle
      // for days and every fix appears not to have shipped.
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        if (cancelled) return;
        registrationRef.current = registration;

        const watch = (worker: ServiceWorker | null) => {
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              setUpdateReady(true);
            }
          });
        };

        watch(registration.waiting);
        watch(registration.installing);
        registration.addEventListener("updatefound", () => watch(registration.installing));

        // Check for a new deployment when the tab becomes visible again.
        let lastCheck = Date.now();
        visibilityListener = () => {
          if (document.visibilityState !== "visible") return;
          if (Date.now() - lastCheck < 30 * 60 * 1000) return;
          lastCheck = Date.now();
          void registration.update().catch(() => undefined);
        };
        document.addEventListener("visibilitychange", visibilityListener);

        if (registration.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
      })
      .catch(() => undefined);

    const onControllerChange = () => {
      // Only reload when the update was requested from this page.
      if (!reloadingRef.current) return;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      if (visibilityListener) document.removeEventListener("visibilitychange", visibilityListener);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  /* ----------------------------------------------------------- install state */

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandalone()) {
      setInstallState("installed");
      return;
    }

    const onPrompt = (event: Event) => {
      event.preventDefault();
      promptRef.current = event as BeforeInstallPromptEvent;
      setInstallState("available");
    };
    const onInstalled = () => {
      promptRef.current = null;
      setInstallState("installed");
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    const displayMode = window.matchMedia?.("(display-mode: standalone)");
    const onDisplayMode = () => {
      if (isStandalone()) setInstallState("installed");
    };
    displayMode?.addEventListener?.("change", onDisplayMode);

    // iOS never fires beforeinstallprompt: it gets manual instructions instead.
    const initial = isIos() ? "ios" : "checking";
    setInstallState(initial);

    const timer = window.setTimeout(() => {
      setInstallState((current) => (current === "checking" ? "unavailable" : current));
    }, 4000);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      displayMode?.removeEventListener?.("change", onDisplayMode);
      window.clearTimeout(timer);
    };
  }, []);

  /* --------------------------------------------------------- online / offline */

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    const waiting = registrationRef.current?.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    reloadingRef.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
    // Fallback in case controllerchange never fires.
    window.setTimeout(() => window.location.reload(), 1500);
  }, []);

  const promptInstall = useCallback(async (): Promise<InstallOutcome> => {
    if (installState === "installed" || isStandalone()) return "installed";

    const deferred = promptRef.current;
    if (deferred) {
      promptRef.current = null;
      try {
        await deferred.prompt();
        const choice = await deferred.userChoice;
        if (choice.outcome === "accepted") {
          setInstallState("installed");
          return "accepted";
        }
        // Chrome only allows a single prompt per event, so the button steps
        // aside until the browser offers a new one on a later page load.
        setInstallState("unavailable");
        return "dismissed";
      } catch {
        setInstallState("unavailable");
        return "unavailable";
      }
    }

    // No prompt available (iOS, or the browser declined): show manual steps.
    setSheetOpen(true);
    return "instructions";
  }, [installState]);

  const value = useMemo<PwaContextValue>(
    () => ({
      installState,
      updateReady,
      offline,
      promptInstall,
      applyUpdate,
      openInstructions: () => setSheetOpen(true),
    }),
    [installState, updateReady, offline, promptInstall, applyUpdate],
  );

  return (
    <PwaContext.Provider value={value}>
      {children}
      {sheetOpen && <InstallInstructionsSheet onClose={() => setSheetOpen(false)} />}
    </PwaContext.Provider>
  );
}

export function usePwaInstall() {
  const context = useContext(PwaContext);
  if (!context) throw new Error("usePwaInstall must be used inside <PwaProvider>");
  return context;
}

/* ------------------------------------------------------------------- UI bits */

export function InstallAppButton({
  variant = "ghost",
  className = "",
  label = "Install app",
}: {
  variant?: "ghost" | "primary" | "icon" | "row";
  className?: string;
  label?: string;
}) {
  const { installState, promptInstall } = usePwaInstall();
  if (installState !== "available" && installState !== "ios") return null;

  const handle = () => {
    void promptInstall();
  };

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={handle}
        title={label}
        aria-label={label}
        className={`rounded-md p-2 text-slate-400 transition hover:bg-ink-800 hover:text-accent-soft ${className}`}
      >
        <Download className="h-4 w-4" />
      </button>
    );
  }

  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={handle}
        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-slate-400 transition hover:bg-ink-800/70 hover:text-slate-200 ${className}`}
      >
        <Download className="h-4 w-4 text-slate-500" />
        <span className="truncate">{label}</span>
        <span className="ml-auto rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent-soft">
          new
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handle}
      className={`${variant === "primary" ? "btn-primary" : "btn-ghost"} ${className}`}
    >
      <Download className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/** Settings card: explains the current installability state. */
export function InstallAppCard() {
  const { installState, promptInstall, openInstructions } = usePwaInstall();
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);

  const describe = () => {
    switch (installState) {
      case "installed":
        return "Running as an installed app.";
      case "available":
        return "This browser can install the console as a standalone app.";
      case "ios":
        return "On iPhone and iPad, install from the Safari share menu.";
      case "checking":
        return "Checking whether this browser offers an install prompt…";
      default:
        return "This browser has not offered an install prompt. Open the console in Chrome, Edge or Safari over HTTPS, or use the browser menu's “Install app” entry.";
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <Smartphone className="h-4 w-4 text-accent-soft" />
          Install as an app
        </p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          {outcome === "accepted" ? "Installing — the app will appear on your home screen." : describe()}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {installState === "installed" ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Installed
          </span>
        ) : (
          <>
            {(installState === "available" || installState === "ios") && (
              <button
                type="button"
                className="btn-primary"
                onClick={async () => setOutcome(await promptInstall())}
              >
                <Download className="h-3.5 w-3.5" />
                Install
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={openInstructions}>
              How it works
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Bottom-right toast shown when a new deployment is waiting. */
export function PwaUpdateToast() {
  const { updateReady, applyUpdate } = usePwaInstall();
  const [dismissed, setDismissed] = useState(false);
  if (!updateReady || dismissed) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 sm:left-auto sm:right-5 sm:translate-x-0">
      <div className="flex items-center gap-3 rounded-xl border border-accent/35 bg-ink-900/95 px-3.5 py-3 shadow-glow backdrop-blur-xl animate-slideUp">
        <RefreshCw className="h-4 w-4 shrink-0 text-accent-soft" />
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-slate-300">
          A new version of the console is ready.
        </p>
        <button type="button" onClick={applyUpdate} className="btn-primary !px-2.5 !py-1.5 text-[11px]">
          Reload
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-md p-1 text-slate-500 hover:bg-ink-800 hover:text-slate-300"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Thin strip that appears when the browser loses its connection. */
export function OfflineNotice() {
  const { offline } = usePwaInstall();
  if (!offline) return null;
  return (
    <div className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
      <WifiOff className="h-3 w-3" />
      You are offline — showing the cached app shell. Actions will fail until the connection returns.
    </div>
  );
}

function InstallInstructionsSheet({ onClose }: { onClose: () => void }) {
  const ios = isIos();
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-2xl border border-ink-700 bg-ink-950 p-5 shadow-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Install Darknote</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Installing adds the console to your home screen or dock and opens it in its own window,
              without the browser chrome.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-ink-800 hover:text-slate-300" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <ol className="mt-4 space-y-3 text-xs text-slate-300">
          <li className="flex gap-2.5">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-ink-600 text-[10px] text-slate-400">1</span>
            <span>
              {ios ? (
                <>Tap the <Share className="inline h-3.5 w-3.5 align-text-bottom text-accent-soft" /> Share button in Safari’s toolbar.</>
              ) : (
                <>Open the browser menu (⋮ or ⋯) in the top-right corner.</>
              )}
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-ink-600 text-[10px] text-slate-400">2</span>
            <span>{ios ? "Scroll down and choose “Add to Home Screen”." : "Choose “Install app” / “Add to Home screen”."}</span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-ink-600 text-[10px] text-slate-400">3</span>
            <span>Confirm — Darknote opens in standalone mode and keeps working offline for the shell.</span>
          </li>
        </ol>

        <button type="button" onClick={onClose} className="btn-primary mt-5 w-full justify-center">
          Got it
        </button>
      </div>
    </div>
  );
}
