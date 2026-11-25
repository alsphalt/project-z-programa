"use client";

import { useEffect } from "react";
import { startSentinel } from "@/lib/perf/sentinel";
import { invalidateApi } from "@/lib/use-api";

/**
 * Mounts the client crash sentinel for the console (see lib/perf/sentinel.ts).
 *
 * It also gives the app one concrete reaction to memory pressure: drop the
 * response cache, which is the largest chunk of JavaScript heap this app keeps
 * on purpose (each `/api/monitor` entry carries the console tail). Everything
 * that matters is re-fetched from PostgreSQL on the next render, so releasing it
 * is free — unlike a renderer being killed mid-session.
 *
 * Renders nothing.
 */
export function CrashSentinel() {
  useEffect(() => {
    const handle = startSentinel({
      onMemoryPressure: () => {
        invalidateApi();
      },
    });
    return () => handle.stop();
  }, []);

  return null;
}
