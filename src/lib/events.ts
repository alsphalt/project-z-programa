import 'server-only';
import { consoleBuffer } from './services/console';

/**
 * In-process event hub for Server-Sent Events.
 *
 * The platform is designed to run as one long-lived Node process (`next start`).
 * With multiple instances each instance only streams the work it performed —
 * the UI always re-reads authoritative state over REST, so a missed event is a
 * latency problem, never a correctness problem.
 */
export type LiveEvent =
  | { type: 'hello'; at: string; transport: 'sse'; detection: 'polling' }
  | { type: 'status'; at: string; data: unknown }
  | { type: 'sync'; at: string; data: unknown }
  | { type: 'console'; at: string; data: { lines: string[]; updatedAt: number; error: string | null } }
  | { type: 'deployment'; at: string; data: unknown }
  | { type: 'files'; at: string; data: unknown }
  | { type: 'error'; at: string; message: string }
  | { type: 'ping'; at: string };

type Listener = (event: LiveEvent) => void;

const channels = new Map<string, Set<Listener>>();

export function subscribe(serverId: string, listener: Listener): () => void {
  let set = channels.get(serverId);
  if (!set) {
    set = new Set();
    channels.set(serverId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) channels.delete(serverId);
  };
}

export function publish(serverId: string, event: Omit<LiveEvent, 'at'> & { at?: string }): void {
  const payload = { ...event, at: event.at ?? new Date().toISOString() } as LiveEvent;
  for (const listener of channels.get(serverId) ?? []) {
    try {
      listener(payload);
    } catch {
      /* a broken client must not break other listeners */
    }
  }
}

export function subscriberCount(serverId: string): number {
  return channels.get(serverId)?.size ?? 0;
}

/** SSE frames: `event:` + `data:` with a blank line terminator. */
export function frame(event: LiveEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

/**
 * Build an SSE response that pushes console output and heartbeats.
 * Console text is real output captured from the panel websocket by
 * `captureConsole`; when the panel cannot be attached the stream says so.
 */
export function consoleStream(serverId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let detach: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: LiveEvent) => {
        try {
          controller.enqueue(encoder.encode(frame(event)));
        } catch {
          /* controller already closed */
        }
      };
      send({ type: 'hello', at: new Date().toISOString(), transport: 'sse', detection: 'polling' });
      const initial = consoleBuffer(serverId);
      send({ type: 'console', at: new Date().toISOString(), data: initial });

      detach = subscribe(serverId, (event) => {
        if (event.type === 'console') send(event);
      });
      heartbeat = setInterval(() => {
        const buffer = consoleBuffer(serverId);
        send({ type: 'console', at: new Date().toISOString(), data: buffer });
        send({ type: 'ping', at: new Date().toISOString() });
      }, 4000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      detach?.();
    },
  });
}
