"use client";

import { useEffect } from "react";
import { RecoveryCard, reportRenderError } from "@/components/error-boundary";

/**
 * Boundary for the authenticated workspace.
 *
 * It sits inside the app layout, so the sidebar, the server picker and the
 * session stay usable while one page fails. That is the difference between a
 * broken panel and a broken app.
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void reportRenderError("workspace", error);
  }, [error]);

  return (
    <RecoveryCard
      scope="This workspace page"
      message={error.message || "The page could not be rendered."}
      digest={error.digest}
      onRetry={reset}
    />
  );
}
