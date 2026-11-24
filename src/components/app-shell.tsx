"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  Code2,
  Database,
  Download,
  FileCode2,
  FolderTree,
  FolderSearch,
  Gauge,
  HardHat,
  History,
  Github,
  LayoutDashboard,
  LogOut,
  Menu,
  Radar,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  X,
} from "lucide-react";
import { useEffect } from "react";
import { useServers } from "./providers";
import { InstallAppButton, OfflineNotice, PwaUpdateToast, usePwaInstall } from "./pwa";
import { Status } from "./ui";
import { apiGet, apiPost } from "@/lib/client";
import { BigBrotherOrb } from "./bigbrother/orb";
import { BigBrotherPanel } from "./bigbrother/panel";
import { ErrorReporter } from "./error-reporter";
import { NotificationBell } from "./notification-bell";
import { useChristmas } from "./christmas/provider";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/monitor", label: "Live Monitor", icon: Gauge },
  { href: "/crash-and-fix", label: "CRASH AND FIX", icon: HardHat },
  { href: "/projects", label: "Projects & Imports", icon: Github },
  { href: "/discovery", label: "Server Discovery", icon: Radar },
  { href: "/files", label: "File Manager", icon: FolderTree },
  { href: "/explorer", label: "Project Explorer", icon: FolderSearch },
  { href: "/editor", label: "Code Editor", icon: Code2 },
  { href: "/cases", label: "Case Manager", icon: Workflow },
  { href: "/search", label: "Global Search", icon: Search },
  { href: "/sync", label: "Synchronization", icon: ArrowLeftRight },
  { href: "/deployments", label: "Deployments", icon: FileCode2 },
  { href: "/activity", label: "Activity Logs", icon: History },
  { href: "/backups", label: "Backups & Versions", icon: Database },
  { href: "/downloads", label: "Download Center", icon: Download },
  { href: "/console", label: "Terminal & Logs", icon: TerminalSquare },
  { href: "/errors", label: "Error Center", icon: ShieldAlert },
  { href: "/settings", label: "Admin Settings", icon: Settings },
];

/** Sidebar install entry. Renders nothing (and no separator) when the browser
 *  cannot install the app, so the chrome stays clean on unsupported browsers. */
function InstallRow() {
  const { installState } = usePwaInstall();
  if (installState !== "available" && installState !== "ios") return null;
  return (
    <div className="border-t border-ink-750/80 px-2 pb-1 pt-2">
      <InstallAppButton variant="row" />
    </div>
  );
}

export function AppShell({
  user,
  children,
}: {
  user: { name: string; email: string; role: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { servers, activeServer, activeId, setActiveId, loading } = useServers();
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openProblems, setOpenProblems] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { mode } = useChristmas();

  // One cheap read per session so the floating orb can show a real problem dot.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ counts: { openProblems: number } }>("/api/bigbrother/status")
      .then((data) => {
        if (!cancelled) setOpenProblems(data.counts.openProblems);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = async () => {
    await apiPost("/api/auth/logout").catch(() => undefined);
    window.location.href = "/login";
  };

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition ${
              active
                ? "bg-accent/13 text-white shadow-[inset_0_0_0_1px_rgba(109,94,252,0.28)]"
                : "text-slate-400 hover:bg-ink-800/70 hover:text-slate-200"
            }`}
          >
            <Icon className={`h-4 w-4 ${active ? "text-accent-soft" : "text-slate-500 group-hover:text-slate-300"}`} />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-4 py-4">
      <div className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-accent/30 bg-gradient-to-br from-accent/30 to-cyber/10">
        <ShieldCheck className="h-4.5 w-4.5 text-accent-soft" />
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-ink-900 bg-emerald-400" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold tracking-[0.16em] text-slate-100">DARKNOTE</p>
        <p className="truncate text-[10px] uppercase tracking-[0.24em] text-slate-500">
          {mode === "off" ? "Control Center" : "Jimmy M, Tech"}
        </p>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-ink-750/80 bg-ink-950/70 backdrop-blur-xl lg:flex">
        {brand}
        <div className="mx-3 mb-2 rounded-lg border border-ink-750/80 bg-ink-900/60 px-2.5 py-2">
          <p className="label">Production server</p>
          <p className="mt-1 truncate text-xs font-medium text-slate-200">
            {loading ? "Loading…" : activeServer?.name ?? "No server connected"}
          </p>
          {activeServer ? (
            <div className="mt-1 flex items-center justify-between">
              <Status status={activeServer.state} />
              <span className="mono text-[10px] text-slate-600">{activeServer.apiKeyHint}</span>
            </div>
          ) : (
            <Link href="/settings" className="mt-1 inline-block text-[11px] text-accent-soft hover:underline">
              Connect Pterodactyl →
            </Link>
          )}
        </div>
        {nav}
        <InstallRow />
        <div className="border-t border-ink-750/80 px-3 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-700 text-[11px] font-semibold text-slate-200">
              {user.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-200">{user.name}</p>
              <p className="truncate text-[10px] uppercase tracking-wider text-slate-500">{user.role}</p>
            </div>
            <button onClick={signOut} className="rounded-md p-1.5 text-slate-500 hover:bg-ink-800 hover:text-rose-300" title="Sign out">
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="relative flex h-full w-[268px] flex-col border-r border-ink-700 bg-ink-950">
            <div className="flex items-center justify-between">
              {brand}
              <button onClick={() => setOpen(false)} className="mr-3 rounded-md p-1.5 text-slate-400 hover:bg-ink-800">
                <X className="h-4 w-4" />
              </button>
            </div>
            {nav}
            <InstallRow />
            <div className="border-t border-ink-750 px-4 py-3 text-xs text-slate-400">
              <p className="font-medium text-slate-200">{user.name}</p>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">{user.role}</p>
              <button onClick={signOut} className="mt-2 text-[11px] text-rose-300 hover:underline">
                Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      <div className="lg:pl-[248px]">
        <div className="xmas-ribbon h-[2px] w-full opacity-80" aria-hidden="true" />
        <header className="sticky top-0 z-30 border-b border-ink-750/70 bg-ink-950/80 backdrop-blur-xl">
          <div className="flex items-center gap-2 px-3 py-2.5 sm:px-6">
            <button
              onClick={() => setOpen(true)}
              className="rounded-md p-2 text-slate-400 hover:bg-ink-800 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </button>

            <div className="relative min-w-0 flex-1">
              <button
                onClick={() => setPickerOpen((value) => !value)}
                className="flex max-w-full items-center gap-2 rounded-lg border border-ink-700/70 bg-ink-900/70 px-2.5 py-1.5 text-xs text-slate-200 hover:border-ink-600"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span className="truncate font-medium">{activeServer?.name ?? "Select server"}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-slate-500" />
              </button>

              {pickerOpen && (
                <div className="absolute left-0 top-full z-40 mt-1 w-[min(340px,90vw)] overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl">
                  {servers.length === 0 && (
                    <p className="px-3 py-3 text-xs text-slate-500">No servers registered yet.</p>
                  )}
                  {servers.map((server) => (
                    <button
                      key={server.id}
                      onClick={() => {
                        setActiveId(server.id);
                        setPickerOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-ink-800 ${
                        server.id === activeId ? "bg-ink-800/70" : ""
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-200">{server.name}</span>
                        <span className="mono block truncate text-[10px] text-slate-500">{server.serverIdentifier}</span>
                      </span>
                      <Status status={server.state} />
                    </button>
                  ))}
                  <Link
                    href="/settings"
                    onClick={() => setPickerOpen(false)}
                    className="block border-t border-ink-750 px-3 py-2 text-[11px] text-accent-soft hover:bg-ink-800"
                  >
                    Manage connections →
                  </Link>
                </div>
              )}
            </div>

            {activeServer?.state === "UNREACHABLE" && (
              <span className="hidden items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300 sm:flex">
                <AlertTriangle className="h-3 w-3" /> Panel unreachable
              </span>
            )}

            <NotificationBell />

            <InstallAppButton variant="icon" className="hidden sm:inline-flex" />

            <Link href="/sync" className="btn-ghost !px-2 !py-1.5 text-[11px]">
              Sync
            </Link>
            <Link href="/monitor" className="btn-primary !px-2.5 !py-1.5 text-[11px]">
              Live status
            </Link>
          </div>
        </header>

        <OfflineNotice />

        <main className="mx-auto w-full max-w-[1500px] px-3 py-4 sm:px-6 sm:py-6">{children}</main>
      </div>

      <PwaUpdateToast />
      <ErrorReporter />
      <BigBrotherOrb
        hasProblems={openProblems > 0}
        open={assistantOpen}
        onOpen={() => setAssistantOpen((current) => !current)}
      />
      <BigBrotherPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-100 sm:text-xl">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
