import { NextRequest } from 'next/server';
import { assertServerAccess } from '@/lib/servers/repo';
import { requireUser } from '@/lib/auth/session';
import { attachConsole, consoleBuffer } from '@/lib/services/console';
import { fail, ApiError } from '@/lib/api';
import { classifyLine } from '@/lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Server-Sent Events carrying real panel console output.
 *
 * One authenticated Pterodactyl websocket is kept alive per server (see
 * services/console.ts). This route only relays the lines that socket receives —
 * it does not open its own connection, so the monitor, terminal and deployment
 * health check all observe the same output.
 */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const user = await requireUser();
    const serverId = req.nextUrl.searchParams.get('serverId');
    if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
    const server = await assertServerAccess(user, serverId, 'console.read');

    attachConsole(server);
    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const initial = consoleBuffer(server.id);
        emit('ready', {
          serverId: server.id,
          transport: 'sse',
          source: 'pterodactyl-websocket',
          state: initial.state,
          backlog: initial.lines.length,
          revision: initial.revision,
        });
        for (const entry of initial.entries.slice(-200)) {
          emit('line', { ts: entry.ts, text: entry.text, level: classifyLine(entry.text) });
        }
        let lastErrorSent: string | null = null;
        if (initial.error) {
          lastErrorSent = initial.error;
          emit('error', { message: initial.error, state: initial.state });
        }

        let seen = initial.revision;
        let lastState = initial.state;
        let lastHeartbeat = Date.now();

        const onAbort = () => {
          closed = true;
        };
        req.signal.addEventListener('abort', onAbort);

        while (!closed) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          if (closed) break;

          const buffer = consoleBuffer(server.id);
          if (buffer.revision < seen) {
            // The ring buffer was trimmed; resynchronise from the start.
            seen = 0;
          }
          if (buffer.revision > seen) {
            const fresh = buffer.entries.slice(-Math.max(1, buffer.revision - seen));
            for (const entry of fresh) {
              emit('line', { ts: entry.ts, text: entry.text, level: classifyLine(entry.text) });
            }
            seen = buffer.revision;
          }
          if (buffer.state !== lastState) {
            lastState = buffer.state;
            emit('state', { state: buffer.state, error: buffer.error });
          }
          if (buffer.error && buffer.error !== lastErrorSent) {
            lastErrorSent = buffer.error;
            emit('error', { message: buffer.error, state: buffer.state });
          }
          if (!buffer.error) lastErrorSent = null;
          if (Date.now() - lastHeartbeat > 15_000) {
            lastHeartbeat = Date.now();
            emit('ping', { at: Date.now(), state: buffer.state });
          }
        }

        req.signal.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return fail(error);
  }
}
