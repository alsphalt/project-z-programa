import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { RetryButton } from "./retry-button";

export const metadata: Metadata = {
  title: "Offline",
  description: "The Darknote Control Center cannot reach the network.",
  robots: { index: false, follow: false },
};

/**
 * Served by the service worker when a navigation fails with no network.
 * This route must stay outside the authenticated `(app)` group and must stay
 * static, because the worker precaches the rendered HTML at install time.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-ink-700 bg-ink-900/80">
          <WifiOff className="h-6 w-6 text-amber-300" />
        </div>
        <h1 className="mt-5 text-lg font-semibold tracking-tight text-slate-100">No connection</h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Darknote Control Center needs a live connection to reach your Pterodactyl panel. The app shell is cached,
          but nothing can be changed until the network is back.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <RetryButton />
        </div>
        <p className="mono mt-6 text-[10px] uppercase tracking-[0.22em] text-slate-600">offline · cached shell</p>
      </div>
    </main>
  );
}
