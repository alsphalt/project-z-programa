"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Send, TerminalSquare, Trash2, Wifi, WifiOff } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Panel, Spinner, Status } from "@/components/ui";
import { apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";

type Line = { ts: number; text: string; level: string };

/**
 * Lines kept in memory. 600 rows of text is already more than a phone can show,
 * and every extra row is a DOM node, a layout box and a string held for the life
 * of the page.
 */
const MAX_LINES = 600;
type Monitor = { console: { streamState: string; streamError: string | null; lines: Line[] }; bot: { state: string } };

export default function ConsolePage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const monitor = useApi<Monitor>(activeId ? `/api/monitor?serverId=${activeId}&lines=400` : null);
  const [lines, setLines] = useState<Line[]>([]);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [command, setCommand] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (monitor.data?.console.lines) setLines(monitor.data.console.lines.slice(-MAX_LINES));
  }, [monitor.data]);

  /**
   * Live output, batched.
   *
   * A busy bot writes several lines a second. The previous version called
   * `setLines()` (and therefore re-rendered the whole tail) once per line and
   * copied the 800-entry array every time: on a phone that is a React commit per
   * log line, which is how a console turns into a space heater and then a dead
   * renderer.
   *
   * Now incoming lines are buffered and flushed four times a second at most, the
   * tail is capped, and the stream is closed while the tab is hidden — a
   * background console has nothing to show and no reason to hold a connection
   * (or its decode buffers) open.
   */
  useEffect(() => {
    if (!activeId) return;

    let source: EventSource | null = null;
    let buffer: Line[] = [];
    let flushTimer: number | null = null;
    let closed = false;

    const flush = () => {
      flushTimer = null;
      if (buffer.length === 0) return;
      const incoming = buffer;
      buffer = [];
      setLines((current) => {
        const next = current.length + incoming.length > MAX_LINES ? current.concat(incoming) : current.concat(incoming);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };

    const schedule = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(flush, 250);
    };

    const open = () => {
      if (closed || source) return;
      const connection = new EventSource(`/api/console?serverId=${activeId}`);
      source = connection;
      connection.addEventListener("ready", () => setConnected(true));
      connection.addEventListener("line", (event) => {
        try {
          buffer.push(JSON.parse((event as MessageEvent).data) as Line);
        } catch {
          return; // ignore malformed frames
        }
        // A burst must not grow an unbounded buffer before the next tick.
        if (buffer.length >= 120) flush();
        else schedule();
      });
      connection.onerror = () => setConnected(false);
    };

    const close = () => {
      if (!source) return;
      source.close();
      source = null;
      setConnected(false);
    };

    const onVisibility = () => {
      if (document.hidden) {
        flush();
        close();
        return;
      }
      open();
    };

    open();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      closed = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, [activeId]);

  /**
   * Follow the tail without an animation per line.
   *
   * A busy bot prints many lines a second, and `scrollIntoView({ behavior:
   * "smooth" })` restarted a compositor animation for every one of them — the
   * console spent its whole frame budget animating a scrollbar. Writing
   * `scrollTop` is one layout pass and lands in the same place.
   */
  useEffect(() => {
    if (!autoScroll) return;
    const scroller = bottom.current?.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [lines, autoScroll]);

  const visible = useMemo(
    () =>
      lines.filter((line) => {
        if (onlyErrors && line.level !== "error") return false;
        if (filter && !line.text.toLowerCase().includes(filter.toLowerCase())) return false;
        return true;
      }),
    [lines, filter, onlyErrors],
  );

  const send = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await apiPost("/api/console/command", { serverId: activeId, command: pending, confirm: "EXECUTE" });
      push("Command accepted by the panel — watch for its output", "ok");
      setPending(null);
      setCommand("");
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  return (
    <>
      <PageHeader
        title="Terminal & Logs"
        description="Live console output relayed from the panel over a server-side websocket. Read-only viewing is separate from commands."
        actions={
          <>
            <Status status={connected ? "CONNECTED" : "DISCONNECTED"} label={connected ? "stream live" : "stream closed"} />
            <button className="btn-ghost" onClick={() => setLines([])}><Trash2 className="h-3.5 w-3.5" /> Clear view</button>
            <button className="btn-ghost" onClick={() => void monitor.refresh()}>Refresh</button>
          </>
        }
      />

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input className="field !w-56 !py-1.5 text-xs" placeholder="Filter output" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <input type="checkbox" checked={onlyErrors} onChange={(event) => setOnlyErrors(event.target.checked)} /> errors only
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> auto-scroll
        </label>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-slate-500">
          {connected ? <Wifi className="h-3 w-3 text-emerald-400" /> : <WifiOff className="h-3 w-3 text-rose-400" />}
          {monitor.data?.console.streamError ?? `${lines.length} lines`}
        </span>
      </div>

      <Panel bodyClassName="!p-0" className="overflow-hidden">
        <div className="h-[58dvh] overflow-auto bg-ink-950/90 px-3 py-2">
          {visible.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Empty title="No output" hint="The console websocket attaches automatically. If the container is offline there is nothing to print." />
            </div>
          ) : (
            <div className="code-scroll">
              {visible.map((line, index) => (
                <div
                  key={`${line.ts}-${index}`}
                  className={`cv-auto ${
                    line.level === "error"
                      ? "text-rose-300"
                      : line.level === "warn"
                        ? "text-amber-300"
                        : line.level === "system"
                          ? "text-cyber/80"
                          : "text-slate-300"
                  }`}
                >
                  <span className="mr-2 select-none text-slate-700">{new Date(line.ts).toLocaleTimeString()}</span>
                  {line.text}
                </div>
              ))}
              <div ref={bottom} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-ink-750 bg-ink-900/70 px-3 py-2">
          <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <input
            className="field mono !py-1.5 text-xs"
            placeholder="Server console command (sent to stdin of the container process)"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && command.trim()) setPending(command.trim());
            }}
          />
          <button className="btn-primary !py-1.5 text-[11px]" disabled={!command.trim()} onClick={() => setPending(command.trim())}>
            <Send className="h-3 w-3" /> Send
          </button>
        </div>
      </Panel>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
        Console input runs inside the bot's container and can execute arbitrary code. It requires admin permission and an
        explicit confirmation. Output only appears when the process actually writes it — nothing is simulated.
      </p>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={send}
        busy={busy}
        danger
        title="Send this command to production?"
        description={
          <div className="space-y-2">
            <pre className="mono max-h-24 overflow-auto rounded border border-ink-700 bg-ink-950/70 px-2 py-1 text-[11px] text-amber-200">{pending}</pre>
            <p className="text-[11px] text-slate-500">The bot's process receives this on stdin. A restart is not implied.</p>
          </div>
        }
        confirmLabel="Send command"
        requireText="EXECUTE"
      />

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Panel title="Log files" subtitle="Read them through the file manager">
          <div className="flex flex-wrap gap-2">
            <Link href="/files?path=%2Flogs" className="btn-ghost !py-1.5 text-[11px]">/logs</Link>
            <Link href="/files" className="btn-ghost !py-1.5 text-[11px]">Browse root</Link>
            <Link href="/search?q=Error" className="btn-ghost !py-1.5 text-[11px]">Search for errors</Link>
          </div>
        </Panel>
        <Panel title="Stream behaviour">
          <p className="text-[11px] leading-relaxed text-slate-500">
            The connection is authenticated with a short-lived panel token on the server. Tokens are refreshed automatically
            and never exposed to the browser. Five consecutive reconnect failures stop the stream and surface the error here.
          </p>
          {monitor.loading && <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500"><Spinner /> loading status…</p>}
        </Panel>
      </div>
    </>
  );
}
