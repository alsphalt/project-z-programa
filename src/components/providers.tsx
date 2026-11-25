"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiGet, errorMessage } from "@/lib/client";

export type ServerSummary = {
  id: string;
  name: string;
  panelUrl: string;
  serverIdentifier: string;
  rootPath: string;
  state: string;
  lastSeenAt: string | null;
  lastError: string | null;
  apiKeyHint: string;
  counts: { files: number; deployments: number; scans: number };
  myLevel: string | null;
};

type ServerContextValue = {
  servers: ServerSummary[];
  activeServer: ServerSummary | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ servers: ServerSummary[] }>("/api/servers");
      setServers(data.servers);
      setError(null);
      setActiveIdState((current) => {
        if (current && data.servers.some((server) => server.id === current)) return current;
        const stored = typeof window !== "undefined" ? window.localStorage.getItem("dn.activeServer") : null;
        if (stored && data.servers.some((server) => server.id === stored)) return stored;
        return data.servers[0]?.id ?? null;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    if (typeof window !== "undefined") window.localStorage.setItem("dn.activeServer", id);
  }, []);

  const value = useMemo<ServerContextValue>(() => {
    const activeServer = servers.find((server) => server.id === activeId) ?? null;
    return { servers, activeServer, activeId, setActiveId, loading, error, reload };
  }, [servers, activeId, setActiveId, loading, error, reload]);

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServers(): ServerContextValue {
  const context = useContext(ServerContext);
  if (!context) throw new Error("useServers must be used inside ServerProvider");
  return context;
}

// --------------------------------------------------------------------- toasts

type Toast = { id: number; message: string; kind: "ok" | "error" | "info" };
type ToastContextValue = { push: (message: string, kind?: Toast["kind"]) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, kind }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4 sm:bottom-6">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto max-w-md animate-slideUp rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur ${
              toast.kind === "error"
                ? "border-rose-500/40 bg-rose-950/80 text-rose-200"
                : toast.kind === "ok"
                  ? "border-emerald-500/40 bg-emerald-950/80 text-emerald-200"
                  : "border-ink-600 bg-ink-850/95 text-slate-200"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) return { push: () => undefined };
  return context;
}
