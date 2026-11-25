import 'server-only';
import { query, queryOne } from '../db';
import { testConnection, type ServerRecord } from '../servers/repo';
import { parseConsoleLine, whatsappSignals } from './parse';
import { recordError } from './store';
import type { ErrorSource } from './types';

/**
 * Collectors for every subsystem Error Intelligence monitors.
 *
 * Console output is the busiest source, so ingestion is rate limited per server
 * and de-duplicated in memory before anything reaches the database.
 */

interface Bucket {
  windowStart: number;
  count: number;
  seen: Map<string, number>;
}

const buckets = new Map<string, Bucket>();
const MAX_PER_MINUTE = 20;
const DEDUPE_MS = 60_000;

function bucketFor(serverId: string): Bucket {
  let bucket = buckets.get(serverId);
  if (!bucket) {
    bucket = { windowStart: Date.now(), count: 0, seen: new Map() };
    buckets.set(serverId, bucket);
  }
  return bucket;
}

/** Lines the bot prints that look like errors but are ordinary conversation. */
const BENIGN = [
  /^>\s/, // echoed command
  /error\s*[:=]\s*(false|0|null|none)\b/i,
  /no errors? (found|detected)/i,
  /error handler (registered|loaded)/i,
  /0 errors/i,
  /errorlog.*(rotated|cleared)/i,
];

function shouldSkip(text: string): boolean {
  return BENIGN.some((pattern) => pattern.test(text));
}

export interface IngestResult {
  captured: boolean;
  reason?: string;
}

/** Ingest exactly one console line. Returns whether a new event was stored. */
export async function ingestConsoleLine(serverId: string, raw: string): Promise<IngestResult> {
  const text = raw.trim();
  if (!text || shouldSkip(text)) return { captured: false, reason: 'benign' };

  const parsed = parseConsoleLine(text);
  if (!parsed.isError) return { captured: false, reason: 'not-an-error' };

  const bucket = bucketFor(serverId);
  const now = Date.now();
  if (now - bucket.windowStart > 60_000) {
    bucket.windowStart = now;
    bucket.count = 0;
    bucket.seen.clear();
  }
  const key = parsed.message.slice(0, 300);
  const seenAt = bucket.seen.get(key);
  if (seenAt && now - seenAt < DEDUPE_MS) return { captured: false, reason: 'duplicate' };
  bucket.seen.set(key, now);
  if (bucket.count >= MAX_PER_MINUTE) return { captured: false, reason: 'rate-limited' };
  bucket.count += 1;

  const signals = whatsappSignals(parsed.message);
  const source: ErrorSource = signals.length ? 'whatsapp' : /npm |pnpm |yarn /i.test(parsed.message) ? 'packages' : 'console';

  await recordError({
    message: parsed.message,
    source,
    code: parsed.code,
    serverId,
    filePath: parsed.location.filePath,
    line: parsed.location.line,
    column: parsed.location.column,
    functionName: parsed.location.functionName,
    context: { origin: 'console', signals },
    evidence: [parsed.message],
  });
  return { captured: true };
}

/** Scan a buffered tail (used by the manual scan and by the monitor). */
export async function scanConsoleLines(serverId: string, lines: string[]): Promise<number> {
  let captured = 0;
  for (const line of lines.slice(-200)) {
    const result = await ingestConsoleLine(serverId, line);
    if (result.captured) captured += 1;
    if (captured >= 15) break;
  }
  return captured;
}

/** Failed or rolled-back deployments, with their captured health verdict. */
export async function scanDeployments(server: ServerRecord, sinceDays = 7): Promise<number> {
  const rows = await query<{
    id: string;
    status: string;
    error: string | null;
    health: unknown;
    started_at: string;
    finished_at: string | null;
  }>(
    `select id, status, error, health, started_at, finished_at from deployments
      where server_id = $1 and status in ('failed','rolled_back')
        and started_at > now() - ($2 || ' days')::interval
      order by started_at desc limit 10`,
    [server.id, sinceDays],
  );

  let captured = 0;
  for (const row of rows) {
    const message = row.error ?? `Deployment ${row.id} finished with status ${row.status}.`;
    await recordError({
      message,
      source: 'deployment',
      serverId: server.id,
      code: row.status === 'rolled_back' ? 'deployment_rolled_back' : 'deployment_failed',
      context: { deploymentId: row.id, status: row.status, health: row.health, at: row.started_at },
      evidence: [message],
      at: row.finished_at ?? row.started_at,
    });
    captured += 1;
  }
  return captured;
}

/** Panel reachability + credential probe. One real API round-trip. */
export async function scanPanel(server: ServerRecord): Promise<boolean> {
  const result = await testConnection(server);
  if (result.ok) return false;
  await recordError({
    message: result.error ?? 'The panel connection test failed without an error message.',
    source: 'panel',
    serverId: server.id,
    endpoint: '/api/client/servers',
    httpMethod: 'GET',
    context: { panelUrl: server.panelUrl, identifier: server.serverIdentifier, latencyMs: result.latencyMs },
    evidence: [`latency: ${result.latencyMs} ms`, `panel: ${server.panelUrl}`],
  });
  return true;
}

/**
 * Derive a WhatsApp problem from stored runtime facts. Never guesses: the event
 * is only recorded when the container is running and the session is not known
 * to be connected.
 */
export async function scanWhatsApp(server: ServerRecord): Promise<boolean> {
  const row = await queryOne<{
    container_state: string;
    whatsapp_state: string;
    whatsapp_signal: string | null;
    last_error: string | null;
    checked_at: string;
  }>(
    `select container_state, whatsapp_state, whatsapp_signal, last_error, checked_at
       from bot_status where server_id = $1`,
    [server.id],
  );
  if (!row) return false;

  const container = row.container_state ?? 'unknown';
  const whatsapp = row.whatsapp_state ?? 'unknown';
  if (container !== 'running') return false;
  if (whatsapp === 'connected') return false;
  if (whatsapp === 'qr_pending') {
    await recordError({
      message: 'The bot is running and waiting for a device pairing (QR / pairing code).',
      source: 'whatsapp',
      serverId: server.id,
      code: 'WHATSAPP_PAIRING_REQUIRED',
      context: { container, whatsapp, checkedAt: row.checked_at },
      evidence: [row.whatsapp_signal ?? 'no signal line captured'],
    });
    return true;
  }
  if (whatsapp === 'logged_out') {
    await recordError({
      message: row.whatsapp_signal ?? 'WhatsApp session logged out (device unlinked).',
      source: 'whatsapp',
      serverId: server.id,
      code: 'WHATSAPP_LOGGED_OUT',
      context: { container, whatsapp, checkedAt: row.checked_at },
      evidence: [row.whatsapp_signal ?? 'no signal line captured'],
    });
    return true;
  }
  if (whatsapp === 'disconnected') {
    await recordError({
      message: row.whatsapp_signal ?? 'The WhatsApp connection is closed while the container is running.',
      source: 'whatsapp',
      serverId: server.id,
      code: 'WHATSAPP_DISCONNECTED',
      context: { container, whatsapp, checkedAt: row.checked_at },
      evidence: [row.whatsapp_signal ?? 'no signal line captured'],
    });
    return true;
  }

  await recordError({
    message: `The container is running but WhatsApp state is ${whatsapp}: no connection event has been observed for this process.`,
    source: 'whatsapp',
    serverId: server.id,
    code: 'WHATSAPP_NOT_LINKED',
    context: { container, whatsapp, checkedAt: row.checked_at, origin: 'bot_status' },
    evidence: [
      `container: ${container}`,
      `whatsapp: ${whatsapp}`,
      ...(row.last_error ? [`last console error: ${row.last_error}`] : []),
    ],
  });
  return true;
}

export interface ScanSummary {
  serverId: string;
  serverName: string;
  consoleEvents: number;
  deploymentEvents: number;
  panelProblem: boolean;
  whatsappProblem: boolean;
  error?: string;
}

/** One scan over every source that can be checked on demand. */
export async function scanServer(server: ServerRecord, lines: string[]): Promise<ScanSummary> {
  const summary: ScanSummary = {
    serverId: server.id,
    serverName: server.name,
    consoleEvents: 0,
    deploymentEvents: 0,
    panelProblem: false,
    whatsappProblem: false,
  };
  try {
    summary.consoleEvents = await scanConsoleLines(server.id, lines);
    summary.deploymentEvents = await scanDeployments(server);
    summary.whatsappProblem = await scanWhatsApp(server);
    summary.panelProblem = await scanPanel(server);
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    await recordError({
      message: summary.error,
      source: 'console',
      serverId: server.id,
      code: 'ERROR_SCAN_FAILED',
      evidence: ['The diagnostic scan itself failed'],
    });
  }
  return summary;
}

/** Map a browser-reported failure onto the same pipeline. */
export async function recordFrontendError(input: {
  message: string;
  stack?: string;
  url?: string;
  serverId?: string | null;
  userId?: string | null;
  code?: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  await recordError({
    message: input.message,
    source: 'frontend',
    code: input.code,
    stack: input.stack ?? null,
    serverId: input.serverId ?? null,
    userId: input.userId ?? null,
    endpoint: input.url ?? null,
    context: { ...(input.context ?? {}), origin: 'browser' },
    evidence: [input.message, ...(input.stack ? input.stack.split('\n').slice(0, 3) : [])],
  });
}
