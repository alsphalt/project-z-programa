/**
 * Parsers for the error intelligence pipeline.
 *
 * Everything here works on real text produced by Node, npm, Pterodactyl and the
 * WhatsApp bot (Baileys). Nothing is invented: when a field cannot be extracted
 * it stays null and the UI says so.
 */

export interface ParsedLocation {
  filePath: string | null;
  line: number | null;
  column: number | null;
  functionName: string | null;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const LOG_PREFIX =
  /^\s*(?:\[[^\]]{0,32}\]\s*)?(?:\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?\s*)?(?:\[?(?:error|warn|info|debug|fatal|trace)\]?\s*[-:])?\s*/i;

export function stripAnsi(input: string): string {
  return String(input ?? '').replace(ANSI, '').replace(/\r/g, '');
}

/** Remove volatile parts (timestamps, ids, hex) so repeats share a fingerprint. */
export function normalizeForFingerprint(message: string): string {
  return stripAnsi(message)
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b\d{10,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** First stack frame that belongs to the project rather than the runtime. */
export function parseStack(stack: string | null | undefined): ParsedLocation {
  if (!stack) return { filePath: null, line: null, column: null, functionName: null };
  const lines = stripAnsi(stack).split('\n');
  let fallback: ParsedLocation | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('at ') || /node:internal|\(internal\//.test(line)) continue;
    const match =
      line.match(/^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/) ?? line.match(/^at\s+(.+?):(\d+):(\d+)$/);
    if (!match) continue;
    const named = match.length === 5;
    const location: ParsedLocation = {
      functionName: named ? match[1].trim() : null,
      filePath: named ? match[2] : match[1],
      line: Number(named ? match[3] : match[2]),
      column: Number(named ? match[4] : match[3]),
    };
    if (!location.filePath || location.filePath.startsWith('node:')) continue;
    if (location.filePath.includes('node_modules')) {
      fallback ??= location;
      continue;
    }
    return location;
  }
  return fallback ?? { filePath: null, line: null, column: null, functionName: null };
}

/**
 * Extract a location from a single console line. Handles the shapes the bot and
 * Node actually print: "at fn (/data/x.js:12:4)", "x.js:12:4", and the
 * `path:line` form used by SyntaxError messages.
 */
export function parseLineLocation(text: string): ParsedLocation {
  const clean = stripAnsi(text);
  const atFrame = clean.match(/\(?([^\s()]+\.(?:js|cjs|mjs|ts|json)):(\d+):(\d+)\)?/);
  if (atFrame) {
    return { filePath: atFrame[1], line: Number(atFrame[2]), column: Number(atFrame[3]), functionName: null };
  }
  const shortFrame = clean.match(/\b([\w./-]+\.(?:js|cjs|mjs|ts)):(\d+)\b(?!:)/);
  if (shortFrame) {
    return { filePath: shortFrame[1], line: Number(shortFrame[2]), column: null, functionName: null };
  }
  return { filePath: null, line: null, column: null, functionName: null };
}

export interface ParsedConsoleLine {
  /** False for ordinary log output, so the scanner stays cheap. */
  isError: boolean;
  code: string | null;
  message: string;
  location: ParsedLocation;
}

const ERROR_LINE =
  /\b(error|exception|fatal|failed|failure|cannot find module|module_not_found|unhandledpromiserejection|unhandled rejection|syntaxerror|referenceerror|typeerror|rangeerror|econnrefused|econnreset|etimedout|eaddrInuse|enospc|eacces|npm err|invalid session|logged out|stream errored|connection closed|connection lost|timed out|401|403|405|429|500|502|503)\b/i;

const WARN_ONLY = /\b(warn|warning|deprecated|retry|reconnecting|reconnect)\b/i;

/** Classify one console line. `code` is a real error code when present. */
export function parseConsoleLine(text: string): ParsedConsoleLine {
  const clean = stripAnsi(text).trim();
  const location = parseLineLocation(clean);

  const codeMatch = clean.match(/\b(E[A-Z_]{3,}|MODULE_NOT_FOUND|ERR_[A-Z_]+|ERESOLVE|ETARGET|EJSONPARSE|ECONNREFUSED|ENOTFOUND)\b/);
  const npmCode = clean.match(/npm ERR!\s*code\s+([A-Z_]+)/i);
  const httpMatch = clean.match(/\b(?:status(?: code)?\s*:?\s*)?(4\d\d|5\d\d)\b/);
  const code = npmCode?.[1] ?? codeMatch?.[1] ?? (httpMatch ? `HTTP_${httpMatch[1]}` : null);

  const isError = ERROR_LINE.test(clean) && !(WARN_ONLY.test(clean) && !/\berror\b/i.test(clean));
  return { isError, code, message: clean.slice(0, 1500), location };
}

/** `Cannot find module 'foo'` → `foo`. */
export function extractModuleName(message: string): string | null {
  const match = message.match(/cannot find module ['"`]?([^'"`\s]+)['"`]?/i);
  return match?.[1] ?? null;
}

/** `POST /api/monitor 405` or `endpoint: /api/x, method: POST`. */
export function extractEndpoint(message: string): { endpoint: string | null; method: string | null; status: number | null } {
  const clean = stripAnsi(message);
  const withMethod = clean.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/api\/[^\s,)'"]+)/i);
  const bare = clean.match(/(\/api\/[a-z0-9/_-]+)/i);
  const status = clean.match(/\b(4\d\d|5\d\d)\b/);
  return {
    endpoint: withMethod?.[2] ?? bare?.[1] ?? null,
    method: withMethod?.[1]?.toUpperCase() ?? null,
    status: status ? Number(status[1]) : null,
  };
}

/** Extract JSON-ish structured details from a Baileys/WhatsApp log line. */
export function whatsappSignals(message: string): string[] {
  const signals: string[] = [];
  const lower = message.toLowerCase();
  if (/logged out|401|unauthorized|device (was )?removed|credentials (removed|deleted)/.test(lower)) {
    signals.push('session-logged-out');
  }
  if (/bad session|invalid session|session (closed|invalid)|no session|session file/.test(lower)) {
    signals.push('session-invalid');
  }
  if (/qr|pairing code|link your device/.test(lower)) signals.push('pairing-required');
  if (/stream errored|connection closed|connection lost|connection terminated|reconnecting/.test(lower)) {
    signals.push('connection-dropped');
  }
  if (/timed out|timeout|etimedout/.test(lower)) signals.push('timeout');
  if (/econnrefused|enotfound|econnreset|network|socket hang up/.test(lower)) signals.push('network');
  if (/conflict|replaced|another session/.test(lower)) signals.push('session-conflict');
  if (/banned|blocked|restricted|temporarily/.test(lower)) signals.push('account-restricted');
  return signals;
}
