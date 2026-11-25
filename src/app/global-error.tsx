"use client";

import { useEffect } from "react";

/**
 * Last resort: the root layout itself failed.
 *
 * Inline styles only — the CSS bundle is exactly what may not have loaded —
 * and no providers, because they may be the cause. The real message is shown
 * rather than a generic apology, and the error is still reported.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // `reportRenderError` is imported lazily: pulling a component module into
    // the root failure path could fail for the same reason this page rendered.
    void import("@/components/error-boundary")
      .then((module) => module.reportRenderError("root", error))
      .catch(() => undefined);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="dark" />
        <title>Darknote Control Center</title>
      </head>
      <body
        style={{
          margin: 0,
          background: "#05060a",
          color: "#e7eaf3",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 480,
            border: "1px solid rgba(244,63,94,.35)",
            background: "#0b0d13",
            borderRadius: 16,
            padding: 22,
          }}
        >
          <p style={{ margin: 0, fontSize: 10, letterSpacing: ".18em", color: "#fda4af", fontWeight: 600 }}>
            DARKNOTE / STARTUP FAILURE
          </p>
          <h1 style={{ margin: "8px 0 0", fontSize: 19, fontWeight: 600 }}>The console could not start</h1>
          <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.6, color: "#94a3b8" }}>
            This is the application shell failing, not one panel. Retry first; if it repeats, check the server
            configuration and the deployment logs.
          </p>
          <pre
            style={{
              marginTop: 14,
              maxHeight: 180,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#05060a",
              border: "1px solid #1c2334",
              borderRadius: 10,
              padding: 12,
              fontSize: 11,
              lineHeight: 1.55,
              color: "#fecdd3",
            }}
          >
            {error.message || "Unknown startup error"}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                flex: "1 1 auto",
                border: 0,
                borderRadius: 10,
                background: "#6d5efc",
                color: "#fff",
                padding: "11px 14px",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                flex: "1 1 auto",
                border: "1px solid #2a3348",
                borderRadius: 10,
                background: "transparent",
                color: "#cbd5e1",
                padding: "11px 14px",
                fontSize: 14,
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
