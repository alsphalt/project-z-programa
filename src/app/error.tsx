"use client";

import { useEffect } from "react";
import { RecoveryCard, reportRenderError } from "@/components/error-boundary";

/**
 * Route-level boundary.
 *
 * Next renders this in place of the failed segment, so the layout, the theme
 * and the PWA registration all survive. Diagnostics go to the Error Center.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void reportRenderError("route", error);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-3xl px-3 py-6">
      <RecoveryCard
        scope="This page"
        message={error.message || "The page could not be rendered."}
        digest={error.digest}
        onRetry={reset}
      />
    </main>
  );
}
