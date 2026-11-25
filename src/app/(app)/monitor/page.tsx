"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity, AlertTriangle, Play, RefreshCw, Square, Upload } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Panel, Spinner, Stat, Status } from "@/components/ui";
import { ImportDialog } from "@/components/projects/import-dialog";
import { apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { bytes, duration, relative } from "@/lib/format";

type Monitor = {
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
  console: {
    streamState: string;
    streamError: string | null;
    attached: boolean;
    lines: Array<{ ts: number; text: string; level: string }>;
  };
  index: { lastScanAt: string | null; lastScanStatus: string | null; lastScanMethod: string };
  sync: { pendingDrafts: number; openConflicts: number };
  deployments: { restarts: number; lastStatus: string | null; lastAt: string | null };
  errors: Array<{ level: string; message: string; at: string; source: string }>;
};

type PowerResult = { action: string; observedState: string | null; endpoint: string; method: string };

export default function MonitorPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const monitor = useApi<Monitor>(activeId ? `/api/monitor?serverId=${activeId}` : null, { refreshMs: 10_000 });
  const [confirm, setConfirm] = useState<null | "restart" | "start" | "stop">(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const data = monitor.data;

  const power = async (action: "restart" | "start" | "stop") => {
    setBusy(true);
    try {
      const result = await apiPost<PowerResult>("/api/monitor", { serverId: activeId, action, confirm: "CONFIRM" });
      push(
        `${action} accepted by POST ${result.endpoint}${result.observedState ? ` — panel now reports ${result.observedState}` : ""}`,
        "ok",
      );
      await monitor.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link className="btn-primary" href="/settings">Connect server</Link>} />;
  }

  const cpu = data?.panel.cpuPercent;
  const memory = data?.panel.memoryBytes;
  const disk = data?.panel.diskBytes;
  const whatsappTone =
    data?.bot.whatsapp === "connected" ? "good" : data?.bot.whatsapp === "disconnected" || data?.bot.whatsapp === "logged_out" ? "bad" : "default";

  return (
    <>
      <PageHeader
        title="Live Monitor"
        description="Container state, WhatsApp connection, resources and console output — read straight from the panel."
        actions={
          <>
            <button className="btn-ghost" onClick={() => setImportOpen(true)}>
              <Upload className="h-3.5 w-3.5" /> Upload a file
            </button>
            <button className="btn-ghost" onClick={() => void monitor.refresh()} disabled={monitor.loading}>
              {monitor.loading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </button>
            <button className="btn-ghost" onClick={() => setConfirm("start")} disabled={busy}><Play className="h-3.5 w-3.5" /> Start</button>
            <button className="btn-primary" onClick={() => setConfirm("restart")} disabled={busy}><RefreshCw className="h-3.5 w-3.5" /> Restart</button>
            <button className="btn-danger" onClick={() => setConfirm("stop")} disabled={busy}><Square className="h-3.5 w-3.5" /> Stop</button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Container"
          value={<Status status={data?.bot.state ?? "unknown"} />}
          hint={data?.panel.reachable ? `panel: ${data.panel.state}` : "panel not answering"}
          tone={data?.bot.state === "running" ? "good" : data?.panel.reachable ? "warn" : "bad"}
        />
        <Stat
          label="WhatsApp link"
          value={<Status status={data?.bot.whatsapp ?? "unknown"} />}
          hint={
            data?.bot.whatsappSource === "bot-process"
              ? "reported by the bot process"
              : data?.bot.whatsappSource === "console-event"
                ? "from this process's console output"
                : "not observed yet"
          }
          tone={whatsappTone}
        />
        <Stat
          label="CPU"
          value={cpu === null || cpu === undefined ? "—" : `${cpu.toFixed(1)}%`}
          hint={cpu === null || cpu === undefined ? "not reported" : "panel reported"}
        />
        <Stat
          label="RAM"
          value={bytes(memory)}
          hint={data?.panel.memoryLimitBytes ? `limit ${bytes(data.panel.memoryLimitBytes)}` : memory === null ? "not reported" : "no limit set"}
        />
      </div>

      {!data?.panel.reachable && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">The panel is not answering.</p>
            <p className="mt-0.5 text-rose-200/80">{data?.panel.error ?? "Check the panel URL and Client API key in Settings."}</p>
            <p className="mt-1 text-rose-200/60">No CPU, RAM or container values are shown because none were received.</p>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Console tail"
          subtitle={`stream: ${data?.console.streamState ?? "idle"} · ${data?.console.lines.length ?? 0} lines buffered`}
          actions={<Link href="/console" className="text-[11px] text-accent-soft hover:underline">Full terminal →</Link>}
        >
          {data?.console.streamError && (
            <p className="mb-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-200">
              {data.console.streamError}
            </p>
          )}
          {data?.console.lines.length ? (
            <div className="code-scroll max-h-[340px] overflow-auto rounded-lg border border-ink-700/70 bg-ink-950/80 px-3 py-2">
              {data.console.lines.slice(-80).map((line, index) => (
                <div key={`${line.ts}-${index}`} className={`cv-auto ${line.level === "error" ? "text-rose-300" : line.level === "warn" ? "text-amber-300" : line.level === "system" ? "text-cyber/80" : "text-slate-300"}`}>
                  {line.text}
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title={data?.console.attached ? "Console attached — no output yet" : "Console not attached"}
              hint={
                data?.console.attached
                  ? "The websocket is authenticated against the panel. Lines appear as the bot prints them."
                  : "The control center could not attach to the server console. The reason is shown above."
              }
              action={<Link href="/console" className="btn-ghost">Open terminal</Link>}
            />
          )}
        </Panel>

        <Panel title="Runtime facts">
          <dl className="space-y-2 text-xs">
            <Row label="Uptime" value={duration(data?.panel.uptimeMs)} />
            <Row label="Disk" value={`${bytes(disk)}${data?.panel.diskLimitBytes ? ` / ${bytes(data.panel.diskLimitBytes)}` : ""}`} />
            <Row label="Console socket" value={<Status status={data?.console.streamState ?? "idle"} />} />
            <Row label="WhatsApp source" value={data?.bot.whatsappSource ?? "none"} />
            <Row label="Restarts recorded" value={String(data?.deployments.restarts ?? 0)} />
            <Row label="Last deploy" value={data?.deployments.lastStatus ? <Status status={data.deployments.lastStatus} /> : "none"} />
            <Row label="Last scan" value={relative(data?.index.lastScanAt)} />
            <Row label="Scan method" value={data?.index.lastScanMethod ?? "—"} />
            <Row label="Pending drafts" value={String(data?.sync.pendingDrafts ?? 0)} />
            <Row label="Open conflicts" value={String(data?.sync.openConflicts ?? 0)} />
            <Row label="Checked" value={relative(data?.checkedAt)} />
          </dl>
          <p className="mt-3 rounded-lg border border-ink-700/60 bg-ink-950/50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500">
            {data?.bot.detail ??
              "A running container does not prove WhatsApp is linked. State is only shown when the bot process or its own console events report it."}
          </p>
          {data?.bot.signal && (
            <p className="mono mt-2 truncate text-[10px] text-slate-600" title={data.bot.signal}>
              {data.bot.signal}
            </p>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Errors & warnings" subtitle="Console errors, panel failures, failed deployments">
          {data?.errors.length ? (
            <ul className="space-y-2">
              {data.errors.map((error, index) => (
                <li key={`${error.at}-${index}`} className="rounded-lg border border-ink-700/60 bg-ink-900/50 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <Badge tone={error.source === "console" ? "bad" : "warn"}>{error.source}</Badge>
                    <span className="text-[10px] text-slate-500">{relative(error.at)}</span>
                  </div>
                  <p className="mono mt-1 break-words text-[11px] text-slate-300">{error.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Nothing failing right now" hint="Errors surface here the moment the console or a deployment reports one." />
          )}
        </Panel>

        <Panel title="Startup health checks" subtitle="What a deploy waits for before calling the bot healthy">
          <ul className="space-y-2 text-xs text-slate-400">
            <li className="flex gap-2"><Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" /> Healthy patterns come from the server policy (e.g. “connected to WhatsApp”, “connection open”).</li>
            <li className="flex gap-2"><Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" /> Failure patterns (SyntaxError, Cannot find module, unhandled rejection) fail the deployment.</li>
            <li className="flex gap-2"><Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyber" /> Health is judged from the live console after the restart, not from the fact that files were written.</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/settings" className="btn-ghost !py-1.5 text-[11px]">Edit patterns</Link>
            <Link href="/deployments" className="btn-ghost !py-1.5 text-[11px]">Deployment history</Link>
          </div>
        </Panel>
      </div>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && void power(confirm)}
        busy={busy}
        danger={confirm === "stop"}
        title={`${confirm ?? "Power"} the server?`}
        description={`The panel receives POST /api/client/servers/${activeServer.serverIdentifier}/power with {"signal":"${confirm ?? "restart"}"}. This acts on the running bot, not on the files.`}
        confirmLabel={`Yes, ${confirm}`}
      />
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-200">{value}</dd>
    </div>
  );
}
