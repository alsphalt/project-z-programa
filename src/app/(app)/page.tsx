"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Cpu,
  Database,
  FileWarning,
  GitBranch,
  HardDrive,
  Play,
  Radar,
  RefreshCw,
  Rocket,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useServers, useToast } from "@/components/providers";
import { PageHeader } from "@/components/app-shell";
import { Badge, ConfirmDialog, Empty, Meter, Panel, Spinner, Stat, Status } from "@/components/ui";
import { apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { bytes, duration, relative } from "@/lib/format";

type Monitor = {
  name: string;
  checkedAt: string;
  panel: {
    reachable: boolean;
    state: string;
    cpuPercent: number | null;
    memoryBytes: number | null;
    memoryLimitBytes: number | null;
    diskBytes: number | null;
    diskLimitBytes: number | null;
    uptimeMs: number | null;
    error: string | null;
  };
  bot: {
    state: string;
    whatsapp: string;
    whatsappSource: "bot-process" | "console-event" | "none";
    signal: string | null;
    detail: string;
    evidence: string[];
  };
  console: { streamState: string; lines: Array<{ ts: number; text: string; level: string }> };
  index: { files: number; folders: number; lastScanAt: string | null; lastScanStatus: string | null; lastScanMethod: string };
  sync: { lastSyncAt: string | null; pendingDrafts: number; openConflicts: number; changedFiles: number };
  deployments: { restarts: number; lastStatus: string | null; lastAt: string | null };
  errors: Array<{ level: string; message: string; at: string; source: string }>;
};

type DeploymentRow = {
  publicId: string;
  status: string;
  fileCount: number;
  startedAt: string;
  restartIssued: boolean;
  error: string | null;
};

type SyncOverview = {
  drafts: number;
  conflicts: number;
  events: number;
  deployment: number;
  lastScanAt: string | null;
  syncIntervalSeconds: number;
  lock: { owner: string; expiresAt: string } | null;
};

export default function OverviewPage() {
  const { activeServer, activeId, loading } = useServers();
  const { push } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPower, setConfirmPower] = useState<null | "restart" | "start" | "stop">(null);

  const monitor = useApi<Monitor>(activeId ? `/api/monitor?serverId=${activeId}` : null, { refreshMs: 20_000 });
  const deployments = useApi<{ deployments: DeploymentRow[] }>(
    activeId ? `/api/deployments?serverId=${activeId}` : null,
    { refreshMs: 30_000 },
  );
  const syncOverview = useApi<SyncOverview>(activeId ? `/api/servers/${activeId}/sync` : null, { refreshMs: 30_000 });

  const run = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await fn();
      push(message, "ok");
      await monitor.refresh();
      await deployments.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Loading servers…</div>;
  }

  if (!activeServer) {
    return (
      <>
        <PageHeader title="Overview" description="Connect your existing Pterodactyl server to begin." />
        <Panel title="No production server connected">
          <Empty
            title="Nothing to monitor yet"
            hint="Register the panel URL, a Client API key and the server identifier. The console verifies the connection with the real panel before saving it."
            action={
              <Link href="/settings" className="btn-primary">
                Connect Pterodactyl
              </Link>
            }
          />
        </Panel>
      </>
    );
  }

  const data = monitor.data;

  return (
    <>
      <PageHeader
        title="Overview"
        description={`${activeServer.name} · ${activeServer.serverIdentifier} · production files stay on Pterodactyl`}
        actions={
          <>
            <button
              className="btn-ghost"
              onClick={() => run("scan", () => apiPost(`/api/servers/${activeId}/discover`), "Discovery scan finished")}
              disabled={busy !== null}
            >
              {busy === "scan" ? <Spinner /> : <Radar className="h-3.5 w-3.5" />} Scan server
            </button>
            <button
              className="btn-ghost"
              onClick={() => run("sync", () => apiPost(`/api/servers/${activeId}/sync`), "Synchronisation complete")}
              disabled={busy !== null}
            >
              {busy === "sync" ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Sync now
            </button>
            <button className="btn-ghost" onClick={() => setConfirmPower("start")} disabled={busy !== null}>
              <Play className="h-3.5 w-3.5" /> Start
            </button>
            <button className="btn-primary" onClick={() => setConfirmPower("restart")} disabled={busy !== null}>
              <RefreshCw className="h-3.5 w-3.5" /> Restart bot
            </button>
            <button className="btn-danger" onClick={() => setConfirmPower("stop")} disabled={busy !== null}>
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          </>
        }
      />

      {monitor.error && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {monitor.error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Bot container"
          value={<Status status={data?.bot.state ?? "UNKNOWN"} />}
          hint={data?.panel.state ? `panel state: ${data.panel.state}` : "waiting for panel"}
          tone={data?.bot.state === "running" ? "good" : data?.panel.reachable ? "warn" : "bad"}
        />
        <Stat
          label="WhatsApp"
          value={<Status status={data?.bot.whatsapp ?? "UNKNOWN"} />}
          hint={
            data?.bot.whatsappSource === "bot-process"
              ? "reported by the bot process"
              : data?.bot.whatsapp === "unknown"
                ? "no connection event observed yet"
                : "from this process's console"
          }
          tone={data?.bot.whatsapp === "connected" ? "good" : data?.bot.whatsapp === "disconnected" || data?.bot.whatsapp === "logged_out" ? "bad" : "default"}
        />
        <Stat
          label="Sync state"
          value={
            <Status
              status={
                data?.sync.openConflicts
                  ? "CONFLICT"
                  : data?.sync.pendingDrafts
                    ? "DRAFT"
                    : data?.index.lastScanStatus ?? "UNKNOWN"
              }
              label={
                data?.sync.openConflicts
                  ? `${data.sync.openConflicts} conflict`
                  : data?.sync.pendingDrafts
                    ? `${data.sync.pendingDrafts} draft`
                    : "Synchronized"
              }
            />
          }
          hint={`last scan ${relative(data?.index.lastScanAt)}`}
        />
        <Stat
          label="Indexed files"
          value={data?.index.files ?? "—"}
          hint={`${data?.index.folders ?? 0} folders · ${data?.sync.changedFiles ?? 0} changed in 24h`}
          tone="accent"
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Upcoming work"
          subtitle="Live queue and the next scheduled reconciliation"
          actions={<Link href="/sync" className="text-[11px] text-accent-soft hover:underline">Open sync →</Link>}
        >
          {syncOverview.loading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-slate-500"><Spinner /> Loading work queue…</div>
          ) : syncOverview.error ? (
            <p className="text-xs text-rose-300">Could not load pending work: {syncOverview.error}</p>
          ) : (
            <div className="space-y-3">
              {(() => {
                const pending = syncOverview.data;
                const work = [
                  { label: "Drafts awaiting deployment", count: pending?.drafts ?? 0, icon: <Rocket className="h-4 w-4" />, href: "/editor", tone: "text-amber-300" },
                  { label: "Unresolved file conflicts", count: pending?.conflicts ?? 0, icon: <FileWarning className="h-4 w-4" />, href: "/sync", tone: "text-rose-300" },
                  { label: "Remote changes to review", count: pending?.events ?? 0, icon: <GitBranch className="h-4 w-4" />, href: "/sync", tone: "text-sky-300" },
                  { label: "Deployments queued or running", count: pending?.deployment ?? 0, icon: <Activity className="h-4 w-4" />, href: "/deployments", tone: "text-accent-soft" },
                ].filter((item) => item.count > 0);
                const nextScan = pending?.lastScanAt
                  ? new Date(new Date(pending.lastScanAt).getTime() + pending.syncIntervalSeconds * 1000)
                  : null;
                return (
                  <>
                    {work.length ? (
                      <ul className="divide-y divide-ink-750/60">
                        {work.map((item) => (
                          <li key={item.label}>
                            <Link href={item.href} className="flex items-center gap-3 py-2.5 hover:bg-ink-850/50">
                              <span className={item.tone}>{item.icon}</span>
                              <span className="min-w-0 flex-1 text-xs text-slate-300">{item.label}</span>
                              <Badge tone={item.count > 0 && item.label.includes("conflict") ? "bad" : "warn"}>{item.count}</Badge>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-3 text-xs text-emerald-200">
                        <CheckCircle2 className="h-4 w-4 shrink-0" /> No pending drafts, conflicts, changes, or deployments.
                      </div>
                    )}
                    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-ink-700/60 bg-ink-950/50 px-3 py-3">
                      <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-accent-soft" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-slate-200">Scheduled server scan</p>
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                          {nextScan && Number.isFinite(nextScan.getTime())
                            ? `Next poll is estimated ${relative(nextScan.toISOString())} (${nextScan.toLocaleString()}).`
                            : "No completed scan yet. Run a discovery scan to begin the polling cycle."}
                          {pending?.syncIntervalSeconds ? ` Repeats every ${Math.round(pending.syncIntervalSeconds / 60)} min.` : ""}
                        </p>
                        {pending?.lock && (
                          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-300">
                            <Clock3 className="h-3 w-3" /> Deployment lock held until {new Date(pending.lock.expiresAt).toLocaleString()}.
                          </p>
                        )}
                      </div>
                      <Link href="/discovery" className="btn-ghost shrink-0">Scan now</Link>
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </Panel>
        <Panel title="Schedule at a glance" subtitle="Configured polling cadence">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg border border-accent/20 bg-accent/10 p-2 text-accent-soft"><Clock3 className="h-4 w-4" /></div>
              <div>
                <p className="text-xs font-medium text-slate-200">Server reconciliation</p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {syncOverview.data?.syncIntervalSeconds
                    ? `Every ${Math.round(syncOverview.data.syncIntervalSeconds / 60)} minutes`
                    : "Waiting for schedule data"}
                </p>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Polling is the detection mechanism; the Pterodactyl Client API does not provide file-change events. The next time shown is an estimate based on the last scan and configured interval.
            </p>
            <Link href="/settings" className="text-[11px] text-accent-soft hover:underline">Review server settings →</Link>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Server resources"
          subtitle={data?.index.lastScanMethod ?? "polling"}
          actions={<Status status={data?.panel.reachable ? "CONNECTED" : "UNREACHABLE"} label={data?.panel.reachable ? "Panel reachable" : "Panel unreachable"} />}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <Meter label="CPU" value={data?.panel.cpuPercent ?? 0} max={data?.panel.cpuPercent === null ? null : 100} />
              <div className="flex items-baseline justify-between text-xs">
                <span className="flex items-center gap-1.5 text-slate-500"><Cpu className="h-3 w-3" /> CPU</span>
                <span className="text-slate-200">
                  {data?.panel.cpuPercent !== null && data?.panel.cpuPercent !== undefined ? `${data.panel.cpuPercent.toFixed(1)}%` : "—"}
                </span>
              </div>
              <Meter label="Memory" value={data?.panel.memoryBytes ?? 0} max={data?.panel.memoryLimitBytes ?? null} />
              <div className="flex items-baseline justify-between text-xs">
                <span className="flex items-center gap-1.5 text-slate-500"><Database className="h-3 w-3" /> RAM</span>
                <span className="text-slate-200">
                  {bytes(data?.panel.memoryBytes)} {data?.panel.memoryLimitBytes ? `/ ${bytes(data.panel.memoryLimitBytes)}` : ""}
                </span>
              </div>
              <Meter label="Disk" value={data?.panel.diskBytes ?? 0} max={data?.panel.diskLimitBytes ?? null} />
              <div className="flex items-baseline justify-between text-xs">
                <span className="flex items-center gap-1.5 text-slate-500"><HardDrive className="h-3 w-3" /> Disk</span>
                <span className="text-slate-200">
                  {bytes(data?.panel.diskBytes)} {data?.panel.diskLimitBytes ? `/ ${bytes(data.panel.diskLimitBytes)}` : ""}
                </span>
              </div>
            </div>

            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Uptime</dt>
                <dd className="text-slate-200">{duration(data?.panel.uptimeMs)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Checked</dt>
                <dd className="text-slate-200">{relative(data?.checkedAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Restarts (recent)</dt>
                <dd className="text-slate-200">{data?.deployments.restarts ?? 0}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Console</dt>
                <dd className="text-slate-200">{data?.console.streamState ?? "idle"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Last deploy</dt>
                <dd>
                  {data?.deployments.lastStatus ? (
                    <Status status={data.deployments.lastStatus} />
                  ) : (
                    <span className="text-slate-500">none yet</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          {data?.bot.evidence && data.bot.evidence.length > 0 && (
            <div className="mt-4 rounded-lg border border-ink-700/60 bg-ink-950/60 px-3 py-2">
              <p className="label mb-1">WhatsApp evidence</p>
              {data.bot.evidence.map((line, index) => (
                <p key={index} className="mono truncate text-[11px] text-slate-400">{line}</p>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Quick actions" subtitle="Everything runs against the live panel">
          <div className="grid gap-2">
            <Link href="/discovery" className="btn-ghost justify-start"><Radar className="h-3.5 w-3.5" /> Discover project files</Link>
            <Link href="/editor" className="btn-ghost justify-start"><TerminalSquare className="h-3.5 w-3.5" /> Open code editor</Link>
            <Link href="/cases" className="btn-ghost justify-start"><Rocket className="h-3.5 w-3.5" /> Case manager</Link>
            <Link href="/console" className="btn-ghost justify-start"><Activity className="h-3.5 w-3.5" /> Live console &amp; logs</Link>
            <Link href="/downloads" className="btn-ghost justify-start"><Database className="h-3.5 w-3.5" /> Download production files</Link>
          </div>
          <div className="mt-4 space-y-2 rounded-lg border border-ink-700/60 bg-ink-950/50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
            <p>
              Auto-restart after deploy is <span className="text-slate-300">{activeServer.state === "CONNECTED" ? "on" : "configured per server policy"}</span>.
              Every write is backed up and hash-verified before the bot is restarted.
            </p>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Latest deployments" subtitle="File writes, restarts and health results" actions={<Link href="/deployments" className="text-[11px] text-accent-soft hover:underline">All →</Link>}>
          {deployments.data?.deployments.length ? (
            <ul className="divide-y divide-ink-750/60">
              {deployments.data.deployments.slice(0, 5).map((deployment) => (
                <li key={deployment.publicId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="mono truncate text-[12px] text-slate-200">{deployment.publicId}</p>
                    <p className="truncate text-[11px] text-slate-500">
                      {deployment.fileCount} file(s) · {relative(deployment.startedAt)}
                      {deployment.restartIssued ? " · restarted" : ""}
                    </p>
                  </div>
                  <Status status={deployment.status} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No deployments yet" hint="Approved edits appear here once they are deployed to production." />
          )}
        </Panel>

        <Panel title="Recent errors" subtitle="Console output and failed operations">
          {data?.errors.length ? (
            <ul className="space-y-2">
              {data.errors.slice(0, 6).map((error, index) => (
                <li key={index} className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="bad">{error.source}</Badge>
                    <span className="text-[10px] text-slate-500">{relative(error.at)}</span>
                  </div>
                  <p className="mono mt-1 line-clamp-2 text-[11px] text-rose-200/90">{error.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No errors observed" hint="Console errors and failed deployments would appear here immediately." />
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmPower !== null}
        onClose={() => setConfirmPower(null)}
        onConfirm={async () => {
          const action = confirmPower;
          setConfirmPower(null);
          if (!action) return;
          await run(
            action,
            async () => {
              const result = await apiPost<{ observedState: string | null }>("/api/monitor", {
                serverId: activeId,
                action,
                confirm: "CONFIRM",
              });
              if (result.observedState) push(`Panel now reports ${result.observedState}`, "ok");
            },
            `${action} accepted by the panel`,
          );
        }}
        danger={confirmPower === "stop"}
        busy={busy === confirmPower}
        title={`${confirmPower ?? "Power"} the bot?`}
        description={
          <span>
            The panel receives <span className="mono">POST /api/client/servers/{activeServer.serverIdentifier}/power</span> with{" "}
            <span className="mono">{`{"signal":"${confirmPower ?? "restart"}"}`}</span>. WhatsApp reconnects with the existing
            session — no re-pairing required.
          </span>
        }
        confirmLabel={confirmPower === "stop" ? "Stop now" : confirmPower === "start" ? "Start now" : "Restart now"}
        requireText={confirmPower === "restart" ? "RESTART" : undefined}
      />
    </>
  );
}
