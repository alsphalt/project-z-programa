"use client";

import { useEffect } from "react";

/**
 * Browser-side error capture.
 *
 * Uncaught exceptions and unhandled rejections are posted to the authenticated
 * report endpoint, de-duplicated per message and rate limited so a render loop
 * cannot flood the database. The reporter never reports its own failures.
 */

const recent = new Map<string, number>();
const WINDOW_MS = 60_000;

function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)dn_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function report(payload: {
  message: string;
  stack?: string;
  url?: string;
  code?: string;
  serverId?: string | null;
  context?: Record<string, unknown>;
}) {
  const key = payload.message.slice(0, 200);
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < WINDOW_MS) return;
  recent.set(key, now);
  if (recent.size > 80) {
    for (const [entry, at] of recent) {
      if (now - at > WINDOW_MS) recent.delete(entry);
    }
  }

  try {
    const serverId =
      typeof window !== "undefined" ? window.localStorage.getItem("dn.activeServer") : null;

    await fetch("/api/errors/report", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken(),
      },
      body: JSON.stringify({ ...payload, serverId: serverId ?? undefined }),
      keepalive: true,
    });
  } catch {
    // Reporting must never throw into the page.
  }
}

export function ErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      // Resource load failures have no Error object; they are not JS exceptions.
      if (!event.error && !event.message) return;
      if (event.message?.includes("/api/errors/report")) return;
      void report({
        message: event.message || "Unknown browser error",
        stack: event.error?.stack,
        url: event.filename ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}` : window.location.pathname,
        context: { origin: "window.onerror", lineno: event.lineno, colno: event.colno },
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "Unhandled promise rejection";
      if (message.includes("/api/errors/report")) return;
      void report({
        message,
        stack: reason instanceof Error ? reason.stack : undefined,
        url: window.location.pathname,
        context: { origin: "unhandledrejection" },
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
