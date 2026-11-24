import 'server-only';
import WebSocket from 'ws';
import { query, queryOne } from '../db';
import { uuid } from '../crypto';
import type { ServerRecord } from '../servers/repo';
import { serverClient } from '../servers/repo';
import { sleep } from '../util/async';
import type { PterodactylClient } from '../pterodactyl/client';
import { ingestConsoleLine } from '../errors/collect';

const MAX_LINES = 1500;
const MAX_RECONNECTS = 8;
const IDLE_CLOSE_MS = 10 * 60_000;
const STATUS_PROBE_TTL_MS = 15_000;

export type ConsoleState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

interface Line {
  ts: number;
  text: string;
}

interface WhatsAppTracker {
  state: 'connected' | 'disconnected' | 'qr_pending' | 'logged_out' | 'unknown';
  signal: string | null;
  source: 'bot-process' | 'console-event' | 'none';
  evidence: string[];
  generation: number;
  changedAt: number | null;
}

interface Buffer {
  lines: Line[];
  updatedAt: number;
  /** Increments on every appended line, so SSE relays can send only new output. */
  revision: number;
  error: string | null;
  state: ConsoleState;
  containerState: string | null;
  whatsapp: WhatsAppTracker;
  lastAttachedAt: number;
  lastMessageAt: number;
}

function emptyTracker(): WhatsAppTracker {
  return {
    state: 'unknown',
    signal: null,
    source: 'none',
    evidence: [],
    generation: 0,
    changedAt: null,
  };
}

const buffers = new Map<string, Buffer>();

function bufferFor(serverId: string): Buffer {
  let buffer = buffers.get(serverId);
  if (!buffer) {
    buffer = {
      lines: [],
      updatedAt: 0,
      revision: 0,
      error: null,
      state: 'idle',
      containerState: null,
      whatsapp: emptyTracker(),
      lastAttachedAt: 0,
      lastMessageAt: 0,
    };
    buffers.set(serverId, buffer);
  }
  return buffer;
}

export function consoleBuffer(serverId: string): {
  lines: string[];
  entries: Line[];
  updatedAt: number;
  revision: number;
  error: string | null;
  state: ConsoleState;
  containerState: string | null;
} {
  const buffer = bufferFor(serverId);
  return {
    lines: buffer.lines.map((line) => line.text),
    entries: [...buffer.lines],
    updatedAt: buffer.updatedAt,
    revision: buffer.revision,
    error: buffer.error,
    state: buffer.state,
    containerState: buffer.containerState,
  };
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
}

// ---------------------------------------------------------------------------
// WhatsApp state
// ---------------------------------------------------------------------------

/**
 * Lines that mean a new bot process has started. When one appears, any earlier
 * connection event belongs to a previous process and is discarded instead of
 * being reported as the current state.
 */
const PROCESS_START_RE =
  /(darknote|whatsapp bot).{0,40}(starting|started|booting|online|ready)|starting darknote|bot started|loaded \d+ (plugin|command)|launching|now running/i;

const WHATSAPP_EVENT_PATTERNS: Array<{
  state: 'connected' | 'qr_pending' | 'logged_out' | 'disconnected';
  re: RegExp;
  strong: boolean;
}> = [
  {
    state: 'connected',
    re: /connected to whatsapp|whatsapp (?:is )?connected|connection (?:is )?open|opened connection to whatsapp|logged in successfully|session (?:restored|resumed)|authenticated successfully|pairing successful|connection established/i,
    strong: true,
  },
  {
    state: 'logged_out',
    re: /logged out|session (?:closed|invalid)|invalid session|bad session|401 unauthorized|credentials (?:removed|deleted)|device (?:was )?removed/i,
    strong: true,
  },
  {
    state: 'qr_pending',
    re: /scan the qr|qr code|pairing code|enter this code|link your device/i,
    strong: true,
  },
  {
    // Deliberately specific: a bare "disconnected" in a user-facing string or a
    // log line about another service must not flip the WhatsApp badge.
    state: 'disconnected',
    re: /connection closed|connection lost|disconnected from whatsapp|whatsapp (?:is )?disconnected|stream errored|reconnecting to whatsapp|connection (?:closed|terminated), retrying/i,
    strong: false,
  },
];

/** Kept for callers that only have a list of plain lines. */
export function inferWhatsAppState(lines: string[]): {
  state: 'connected' | 'disconnected' | 'qr_pending' | 'logged_out' | 'unknown';
  signal: string | null;
} {
  const tracker = emptyTracker();
  for (const line of lines) applyWhatsAppLine(tracker, line);
  return { state: tracker.state, signal: tracker.signal };
}

function applyWhatsAppLine(tracker: WhatsAppTracker, raw: string): void {
  const line = raw.trim();
  if (!line) return;

  if (PROCESS_START_RE.test(line)) {
    tracker.generation += 1;
    tracker.state = 'unknown';
    tracker.signal = null;
    tracker.source = 'none';
    tracker.evidence = [];
    tracker.changedAt = null;
    return;
  }

  for (const pattern of WHATSAPP_EVENT_PATTERNS) {
    if (!pattern.re.test(line)) continue;
    // Weak patterns only count as a state change when a connection was already
    // observed in this process; otherwise they remain evidence, not a verdict.
    if (!pattern.strong && tracker.state === 'unknown') {
      if (tracker.evidence.length < 8) tracker.evidence.push(line.slice(0, 240));
      return;
    }
    tracker.state = pattern.state;
    tracker.signal = line.slice(0, 240);
    tracker.source = 'console-event';
    tracker.changedAt = Date.now();
    tracker.evidence.push(line.slice(0, 240));
    if (tracker.evidence.length > 8) tracker.evidence.splice(0, tracker.evidence.length - 8);
    return;
  }
}

/**
 * Optional authoritative probe.
 *
 * Pterodactyl cannot expose a container's HTTP port, so the control center reads
 * a status file written by the bot itself. Set DARKNOTE_BOT_STATUS_PATH (for
 * example `/data/status.json`) once the bot writes
 * `{"whatsapp":"connected","startedAt":"..."}` on every connection update. Until
 * then the console-event tracker above is used, and its evidence is labelled.
 */
async function probeBotStatus(
  server: ServerRecord,
  client: PterodactylClient,
): Promise<{ state: 'connected' | 'disconnected'; signal: string; checkedAt: number } | null> {
  const statusPath = (process.env.DARKNOTE_BOT_STATUS_PATH ?? '').trim();
  if (!statusPath) return null;
  const buffer = bufferFor(server.id);
  const last = (buffer as Buffer & { statusProbeAt?: number }).statusProbeAt ?? 0;
  if (Date.now() - last < STATUS_PROBE_TTL_MS) return null;
  (buffer as Buffer & { statusProbeAt?: number }).statusProbeAt = Date.now();
  try {
    const text = await client.readFile(statusPath, 256 * 1024);
    const parsed = JSON.parse(text) as { whatsapp?: string; state?: string; startedAt?: string };
    const raw = String(parsed.whatsapp ?? parsed.state ?? '').toLowerCase();
    if (!['connected', 'disconnected', 'qr_pending', 'logged_out'].includes(raw)) return null;
    const at = parsed.startedAt ? Date.parse(parsed.startedAt) : NaN;
    if (Number.isFinite(at) && buffer.whatsapp.changedAt !== null && at < buffer.whatsapp.changedAt - 60_000) {
      return null;
    }
    return {
      state: raw as 'connected' | 'disconnected',
      signal: `bot status file ${statusPath}: whatsapp=${raw}${parsed.startedAt ? ` startedAt=${parsed.startedAt}` : ''}`,
      checkedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistent panel websocket
// ---------------------------------------------------------------------------

interface Session {
  key: string;
  server: ServerRecord;
  ws: WebSocket | null;
  connecting: boolean;
  attempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout | null;
  stopped: boolean;
  lastOpenAt: number;
  lastMessageAt: number;
}

const sessions = new Map<string, Session>();

function sessionKey(server: ServerRecord): string {
  return `${server.id}:${server.panelUrl}:${server.serverIdentifier}`;
}

function setState(serverId: string, state: ConsoleState, error?: string | null): void {
  const buffer = bufferFor(serverId);
  buffer.state = state;
  if (error !== undefined) buffer.error = error;
}

function appendLine(serverId: string, raw: string): void {
  const text = stripAnsi(raw);
  if (!text.trim()) return;
  const buffer = bufferFor(serverId);
  buffer.lines.push({ ts: Date.now(), text });
  if (buffer.lines.length > MAX_LINES) buffer.lines.splice(0, buffer.lines.length - MAX_LINES);
  buffer.updatedAt = Date.now();
  buffer.revision += 1;
  buffer.lastMessageAt = Date.now();
  applyWhatsAppLine(buffer.whatsapp, text);
  // Every captured line also feeds Error Intelligence. This is the only place
  // the console buffer is written, so no producer can bypass diagnosis.
  void ingestConsoleLine(serverId, text);
}

function scheduleReconnect(session: Session, reason: string): void {
  if (session.stopped) return;
  const buffer = bufferFor(session.server.id);
  if (session.attempts >= MAX_RECONNECTS) {
    setState(session.server.id, 'error', `Console websocket gave up after ${MAX_RECONNECTS} attempts: ${reason}`);
    return;
  }
  const delay = Math.min(30_000, 1000 * 2 ** session.attempts);
  session.attempts += 1;
  setState(session.server.id, 'reconnecting', `Console reconnecting in ${Math.round(delay / 1000)}s: ${reason}`);
  buffer.error = `Console reconnecting: ${reason}`;
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    void connect(session);
  }, delay);
  session.reconnectTimer.unref?.();
}

async function connect(session: Session): Promise<void> {
  if (session.stopped || session.connecting || session.ws) return;
  session.connecting = true;
  const server = session.server;
  setState(server.id, session.attempts ? 'reconnecting' : 'connecting', null);

  try {
    const client = await serverClient(server);
    const credentials = await client.getWebsocketCredentials();
    const origin = new URL(server.panelUrl).host;
    const ws = new WebSocket(credentials.socket, {
      origin: server.panelUrl,
      handshakeTimeout: 15_000,
      headers: {
        'User-Agent': 'DarknoteControlCenter/1.0',
        Origin: server.panelUrl,
      },
    });
    session.ws = ws;
    session.connecting = false;

    ws.on('open', () => {
      session.lastOpenAt = Date.now();
      ws.send(JSON.stringify({ event: 'auth', args: [credentials.token] }));
      // Wings drops idle sockets; a light ping keeps the relay alive.
      session.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ event: 'ping' }));
          } catch {
            /* close handler will reconnect */
          }
        }
      }, 25_000);
      session.heartbeat.unref?.();
    });

    ws.on('message', (raw) => {
      session.attempts = 0;
      session.lastMessageAt = Date.now();
      let payload: { event?: string; args?: unknown[] };
      try {
        payload = JSON.parse(String(raw)) as { event?: string; args?: unknown[] };
      } catch {
        return;
      }
      const event = payload.event ?? '';
      const args = Array.isArray(payload.args) ? payload.args : [];

      switch (event) {
        case 'auth success':
          setState(server.id, 'live', null);
          try {
            ws.send(JSON.stringify({ event: 'send logs', args: [null] }));
            ws.send(JSON.stringify({ event: 'send stats', args: [null] }));
          } catch {
            /* handled by close */
          }
          break;
        case 'console output':
          for (const value of args) appendLine(server.id, String(value ?? ''));
          break;
        case 'install output':
          for (const value of args) appendLine(server.id, String(value ?? ''));
          break;
        case 'status':
          bufferFor(server.id).containerState = String(args[0] ?? '').toLowerCase() || null;
          break;
        case 'token expiring':
        case 'token expired':
          // Tokens are short lived; mint a fresh one rather than dying here.
          closeSession(session, false, 'panel token expired');
          scheduleReconnect(session, 'panel token expired');
          break;
        case 'daemon error':
        case 'jwt error':
          setState(server.id, 'error', String(args[0] ?? event));
          break;
        default:
          break;
      }
    });

    ws.on('error', (error) => {
      setState(server.id, session.attempts ? 'reconnecting' : 'error', `Console websocket: ${error.message}`);
    });

    ws.on('close', (code, reason) => {
      if (session.heartbeat) clearInterval(session.heartbeat);
      session.heartbeat = null;
      session.ws = null;
      if (session.stopped) {
        setState(server.id, 'idle', null);
        return;
      }
      const detail = `closed (${code}${reason?.length ? ` ${String(reason)}` : ''})`;
      scheduleReconnect(session, detail);
    });
  } catch (error) {
    session.connecting = false;
    session.ws = null;
    const message = error instanceof Error ? error.message : String(error);
    setState(server.id, 'error', message);
    scheduleReconnect(session, message);
  }
}

function closeSession(session: Session, permanent: boolean, reason?: string): void {
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
  if (session.heartbeat) clearInterval(session.heartbeat);
  session.heartbeat = null;
  if (permanent) session.stopped = true;
  const ws = session.ws;
  session.ws = null;
  if (ws && ws.readyState <= WebSocket.OPEN) {
    try {
      ws.close(1000, reason?.slice(0, 120));
    } catch {
      /* already closed */
    }
  }
}

/**
 * Attach to the panel console for a server. Idempotent: repeated calls reuse the
 * live socket instead of opening a new one, which is what makes the monitor,
 * terminal and deployment health check see the same output.
 */
export function attachConsole(server: ServerRecord): void {
  const key = sessionKey(server);
  for (const [existingKey, existing] of sessions) {
    if (existingKey !== key) {
      closeSession(existing, true, 'server configuration changed');
      sessions.delete(existingKey);
    }
  }
  let session = sessions.get(key);
  if (!session) {
    session = {
      key,
      server,
      ws: null,
      connecting: false,
      attempts: 0,
      reconnectTimer: null,
      heartbeat: null,
      stopped: false,
      lastOpenAt: 0,
      lastMessageAt: 0,
    };
    sessions.set(key, session);
  } else {
    session.server = server;
  }
  bufferFor(server.id).lastAttachedAt = Date.now();
  if (!session.ws && !session.connecting) void connect(session);
}

export function detachConsole(serverId: string): void {
  for (const [key, session] of sessions) {
    if (session.server.id === serverId) {
      closeSession(session, true, 'detached');
      sessions.delete(key);
    }
  }
}

// Release sockets nobody has looked at for a while (keeps a long-lived process
// from holding a panel connection per server forever).
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    const buffer = buffers.get(session.server.id);
    if (buffer && now - buffer.lastAttachedAt > IDLE_CLOSE_MS) {
      closeSession(session, true, 'idle');
      sessions.delete(key);
      buffer.state = 'idle';
    }
  }
}, 60_000);
sweeper.unref?.();

// Exposed for diagnostics/tests.
export function consoleDiagnostics(): Array<{ serverId: string; state: ConsoleState; lines: number; error: string | null }> {
  return [...buffers.entries()].map(([serverId, buffer]) => ({
    serverId,
    state: buffer.state,
    lines: buffer.lines.length,
    error: buffer.error,
  }));
}

/**
 * Wait, briefly, for the live socket to produce output. Used by the console page
 * on first load and by the post-deploy health check. Never invents lines.
 */
export async function captureConsole(
  server: ServerRecord,
  durationMs = 6000,
): Promise<{ lines: string[]; error?: string }> {
  attachConsole(server);
  const buffer = bufferFor(server.id);
  if (buffer.lines.length) return { lines: buffer.lines.map((line) => line.text), error: buffer.error ?? undefined };

  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (buffer.lines.length) {
      return { lines: buffer.lines.map((line) => line.text), error: buffer.error ?? undefined };
    }
    if (buffer.state === 'error') break;
  }
  return { lines: [], error: buffer.error ?? undefined };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusView {
  containerState: string;
  whatsappState: string;
  whatsappSignal: string | null;
  whatsappSource: 'bot-process' | 'console-event' | 'none';
  whatsappEvidence: string[];
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  diskBytes: number | null;
  uptimeMs: number | null;
  restartCount: number;
  isSuspended: boolean;
  checkedAt: string;
  consoleError?: string | null;
  consoleState: ConsoleState;
  recentErrors: string[];
}

const ERROR_PATTERNS = /(error:|syntaxerror|referenceerror|typeerror|cannot find module|module_not_found|econnrefused|unhandledpromiserejection|failed to connect|logged out)/i;

export async function refreshStatus(server: ServerRecord): Promise<StatusView> {
  attachConsole(server);
  const client = await serverClient(server);

  // Resources are the authority for container state and usage. A failure here is
  // reported, not smoothed over with zeroes.
  const resources = await client.getResources();

  const buffer = bufferFor(server.id);
  const wa = buffer.whatsapp;

  const probe = await probeBotStatus(server, client);
  const whatsappState = probe ? probe.state : wa.state;
  const whatsappSignal = probe ? probe.signal : wa.signal;
  const whatsappSource: StatusView['whatsappSource'] = probe ? 'bot-process' : wa.state === 'unknown' ? 'none' : 'console-event';

  const container = String(resources.current_state ?? buffer.containerState ?? 'unknown').toLowerCase();
  const cpu = resources.resources?.cpu_absolute ?? null;
  const memory = resources.resources?.memory_bytes ?? null;
  const memoryLimit = resources.resources?.memory_limit_bytes ?? null;
  const disk = resources.resources?.disk_bytes ?? null;
  const uptime = resources.resources?.uptime ?? null;

  const restartRow = await queryOne<{ count: string | number }>(
    'select count(*)::int as count from deployments where server_id = $1 and restart_performed = true',
    [server.id],
  );
  const restartCount = Number(restartRow?.count ?? 0);
  const lines = buffer.lines.map((line) => line.text);
  const recentErrors = lines.filter((line) => ERROR_PATTERNS.test(line)).slice(-12);
  const lastError = recentErrors[recentErrors.length - 1] ?? null;

  await query(
    `insert into bot_status (id, server_id, container_state, whatsapp_state, whatsapp_signal, cpu_percent,
       memory_bytes, memory_limit_bytes, disk_bytes, uptime_ms, restart_count, last_error, checked_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     on conflict (server_id) do update set container_state = excluded.container_state,
       whatsapp_state = excluded.whatsapp_state, whatsapp_signal = excluded.whatsapp_signal,
       cpu_percent = excluded.cpu_percent, memory_bytes = excluded.memory_bytes,
       memory_limit_bytes = excluded.memory_limit_bytes, disk_bytes = excluded.disk_bytes,
       uptime_ms = excluded.uptime_ms, restart_count = excluded.restart_count,
       last_error = excluded.last_error, checked_at = now()`,
    [
      uuid(),
      server.id,
      container,
      whatsappState,
      whatsappSignal,
      cpu,
      memory,
      memoryLimit,
      disk,
      uptime,
      restartCount,
      lastError,
    ],
  );

  return {
    containerState: container,
    whatsappState,
    whatsappSignal,
    whatsappSource,
    whatsappEvidence: probe ? [probe.signal] : wa.evidence.slice(-4),
    cpuPercent: cpu,
    memoryBytes: memory,
    memoryLimitBytes: memoryLimit,
    diskBytes: disk,
    uptimeMs: uptime,
    restartCount,
    isSuspended: Boolean(resources.is_suspended),
    checkedAt: new Date().toISOString(),
    consoleError: buffer.error,
    consoleState: buffer.state,
    recentErrors,
  };
}

export async function sendConsoleCommand(server: ServerRecord, command: string): Promise<void> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Command is empty');
  const client = await serverClient(server);
  await client.sendCommand(trimmed);
}

/**
 * Wait for the container to come back up after a restart and look for fatal
 * errors in the startup output. Returns an honest health verdict, never a guess:
 * `unknown` means we could not observe the startup.
 */
export async function waitForStartup(
  server: ServerRecord,
  timeoutSeconds: number,
): Promise<{
  healthy: boolean;
  verdict: 'healthy' | 'crashed' | 'timeout' | 'unknown';
  detail: string;
  logs: string[];
  observedStates: string[];
}> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const client = await serverClient(server);
  const states: string[] = [];
  let runningStreak = 0;
  let sawRunning = false;

  while (Date.now() < deadline) {
    try {
      const resources = await client.getResources();
      const state = String(resources.current_state ?? 'unknown');
      if (states[states.length - 1] !== state) states.push(state);
      if (state === 'running') {
        sawRunning = true;
        runningStreak += 1;
      } else {
        runningStreak = 0;
      }
      if (runningStreak >= 2) break;
      if (state === 'offline' && sawRunning) {
        return {
          healthy: false,
          verdict: 'crashed',
          detail: 'Container returned to offline after starting — inspect the console output.',
          logs: consoleBuffer(server.id).lines.slice(-120),
          observedStates: states,
        };
      }
    } catch (error) {
      states.push(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(3000);
  }

  // Give the persistent socket a moment to flush startup output.
  const capture = await captureConsole(server, 5000);
  const logs = capture.lines.slice(-200);
  const fatal = logs.filter((line) =>
    /(syntaxerror|cannot find module|error: cannot find|unhandledpromiserejection|referenceerror is not defined|econnrefused|invalid session)/i.test(
      line,
    ),
  );

  const observed = !capture.error && logs.length > 0;
  if (!observed) {
    return {
      healthy: false,
      verdict: 'unknown',
      detail: `Container state: ${states.slice(-1)[0] ?? 'unobserved'}. No console output could be observed (${
        capture.error ?? 'the panel websocket returned no lines'
      }), so startup health cannot be verified.`,
      logs,
      observedStates: states,
    };
  }
  if (!sawRunning) {
    return {
      healthy: false,
      verdict: 'timeout',
      detail: `Container did not reach "running" within ${timeoutSeconds}s (states: ${states.join(' → ') || 'unobserved'}).`,
      logs,
      observedStates: states,
    };
  }
  if (fatal.length) {
    return {
      healthy: false,
      verdict: 'crashed',
      detail: `Startup logs contain ${fatal.length} fatal error line(s): ${fatal[0].slice(0, 200)}`,
      logs,
      observedStates: states,
    };
  }

  const whatsapp = bufferFor(server.id).whatsapp;
  return {
    healthy: true,
    verdict: 'healthy',
    detail: `Container running and ${logs.length} startup line(s) observed with no fatal errors. WhatsApp state: ${whatsapp.state}${
      whatsapp.signal ? ` (${whatsapp.signal.slice(0, 120)})` : ''
    }.`,
    logs,
    observedStates: states,
  };
}

export async function power(server: ServerRecord, signal: 'start' | 'stop' | 'restart' | 'kill'): Promise<void> {
  const client = await serverClient(server);
  // Pterodactyl Client API: POST /api/client/servers/{identifier}/power
  // with {"signal":"start|stop|restart|kill"}.
  await client.sendPower(signal);
  // Reuse (or re-establish) the console so new output is captured immediately.
  attachConsole(server);
}

export async function restartCount(serverId: string): Promise<number> {
  const row = await queryOne<{ count: string | number }>(
    'select count(*)::int as count from deployments where server_id = $1 and restart_performed = true',
    [serverId],
  );
  return Number(row?.count ?? 0);
}

export async function recentActivity(serverId: string, limit = 25) {
  return query(
    `select action, target, severity, user_email, detail, created_at from activity_logs
      where server_id = $1 order by created_at desc limit $2`,
    [serverId, limit],
  );
}

/** Exported for the status route: which probe mode is active. */
export function botStatusProbePath(): string | null {
  const statusPath = (process.env.DARKNOTE_BOT_STATUS_PATH ?? '').trim();
  return statusPath || null;
}

