"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { apiGet } from "@/lib/client";

interface Notifications {
  errors: { open: number; critical: number; moderate: number; minor: number; last24h: number };
  activity: { last24h: number; warnings24h: number; critical24h: number; lastEventAt: string | null };
  deployments: { failed24h: number };
  total: number;
}

/**
 * The numeric error counter in the header.
 *
 * `total` is the number of *open* problems in Error Intelligence plus failed
 * deployments in the last 24 hours — the same figures the Error Center and the
 * Deployments page show, read from the same tables, so the badge can never
 * count something those pages do not list. It is read on mount and when the tab
 * regains focus; there is no timer, because a phone should not poll for a bell.
 */
export function NotificationBell() {
  const [data, setData] = useState<Notifications | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await apiGet<Notifications>("/api/notifications");
      setData(result);
      setFailed(false);
    } catch {
      // A bell that cannot reach the API says so instead of showing a stale 0.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const count = data?.total ?? 0;
  const label = failed
    ? "Problem counter unavailable"
    : count === 0
      ? "No open problems"
      : `${count} open problem${count === 1 ? "" : "s"} — ${data?.errors.open ?? 0} error event(s), ${data?.deployments.failed24h ?? 0} failed deployment(s) in 24h`;

  return (
    <Link
      href="/errors"
      aria-label={label}
      title={label}
      className="relative rounded-md p-2 text-slate-400 hover:bg-ink-800 hover:text-slate-200"
    >
      {failed ? <BellOff className="h-4 w-4 text-amber-400" /> : <Bell className="h-4 w-4" />}
      {count > 0 && (
        <span
          className={`absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full px-1 text-center text-[10px] font-semibold leading-4 ${
            (data?.errors.critical ?? 0) > 0 ? "bg-rose-500 text-white" : "bg-amber-500 text-ink-950"
          }`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
