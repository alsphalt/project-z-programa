"use client";

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * Error containment for the console.
 *
 * Before this existed there was no boundary anywhere in the app: one throw
 * during render — a panel payload with an unexpected shape, a Monaco mount
 * failure, an undefined field in a row — unmounted the whole tree. On a phone
 * that is indistinguishable from the "Aw, Snap!" crash the user reported, and
 * it took the navigation with it, so there was no way back except reloading.
 *
 * A boundary keeps the failure inside the panel that caused it, shows the real
 * error, and offers a retry that remounts only that subtree.
 */

type BoundaryProps = {
  /** Human name of the region, e.g. "Live Monitor". */
  scope: string;
  children: ReactNode;
  /** Compact variant for widgets embedded in a page. */
  compact?: boolean;
  /** Optional callback for local handling (e.g. falling back to plain text). */
  onError?: (error: Error, info: ErrorInfo) => void;
};

type BoundaryState = { error: Error | null; attempt: number };

function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)dn_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/**
 * Records the failure in the server's error store so it appears in the Error
 * Center. Reporting is best effort and must never throw into the render path.
 */
export async function reportRenderError(scope: string, error: Error, info?: ErrorInfo): Promise<void> {
  try {
    const serverId =
      typeof window !== "undefined" ? window.localStorage.getItem("dn.activeServer") : null;
    await fetch("/api/errors/report", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true,
      headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken() },
      body: JSON.stringify({
        message: `[render:${scope}] ${error.message || "Unknown render error"}`,
        stack: [error.stack, info?.componentStack].filter(Boolean).join("\n\n--- component stack ---\n"),
        url: typeof window !== "undefined" ? window.location.pathname : undefined,
        code: "react_render_error",
        serverId: serverId ?? undefined,
        context: { scope, boundary: true },
      }),
    });
  } catch {
    /* diagnostics are optional; recovery is not */
  }
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
    void reportRenderError(this.props.scope, error, info);
  }

  private retry = () => {
    this.setState((current) => ({ error: null, attempt: current.attempt + 1 }));
  };

  render() {
    if (!this.state.error) {
      // Keying the fragment remounts the subtree on retry, so a component that
      // failed while mounting gets a genuinely fresh start.
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }

    if (this.props.compact) {
      return (
        <div className="rounded-lg border border-rose-500/35 bg-rose-500/[0.07] p-3">
          <p className="flex items-center gap-2 text-[11px] font-medium text-rose-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {this.props.scope} could not render
          </p>
          <p className="mt-1 break-words text-[11px] leading-relaxed text-rose-200/80">
            {this.state.error.message}
          </p>
          <button type="button" onClick={this.retry} className="btn-ghost mt-2 !py-1 text-[11px]">
            <RotateCcw className="h-3 w-3" /> Retry
          </button>
        </div>
      );
    }

    return (
      <RecoveryCard
        scope={this.props.scope}
        message={this.state.error.message}
        onRetry={this.retry}
      />
    );
  }
}

/**
 * The recovery surface shared by section boundaries and route error files.
 * It states what failed, keeps the rest of the console reachable, and never
 * hides the message behind a friendly placeholder.
 */
export function RecoveryCard({
  scope,
  message,
  digest,
  onRetry,
}: {
  scope: string;
  message: string;
  digest?: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto my-6 w-full max-w-xl">
      <div className="rounded-xl border border-rose-500/35 bg-ink-900/80 p-5 shadow-panel">
        <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-rose-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          {scope} failed to render
        </p>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">
          The rest of the console is still running. Retry this section, or go back to the overview — nothing was
          written to the server by this failure.
        </p>
        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700/70 bg-ink-950 p-3 text-[11px] leading-relaxed text-rose-200">
          {message}
          {digest ? `\n\ndigest: ${digest}` : ""}
        </pre>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onRetry} className="btn-primary">
            <RotateCcw className="h-3.5 w-3.5" /> Retry
          </button>
          <Link href="/" className="btn-ghost">
            Back to overview
          </Link>
          <button type="button" onClick={() => window.location.reload()} className="btn-ghost">
            Reload console
          </button>
        </div>
        <p className="mt-3 text-[10.5px] leading-relaxed text-slate-500">
          This failure was reported to the Error Center with its component stack.
        </p>
      </div>
    </div>
  );
}
