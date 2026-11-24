"use client";

import { useEffect, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";

export function RetryButton() {
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <>
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          window.location.reload();
        }}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
        Try again
      </button>
      <a href="/" className="btn-ghost">
        Home
      </a>
      <span className="sr-only" aria-live="polite">
        {online ? "Connection restored" : "Still offline"}
      </span>
    </>
  );
}
