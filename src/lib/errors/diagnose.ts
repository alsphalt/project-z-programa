/**
 * Error diagnosis.
 *
 * The point of this module is that no error ever reaches the UI as "Request
 * failed" or "Something went wrong": every captured failure is turned into a
 * title, a component, a cause, an explanation and a concrete remedy, with the
 * file/line when the message actually contains one.
 *
 * Pure module — tested directly.
 */

export type ErrorSeverity = 'critical' | 'moderate' | 'minor';

export type ErrorSource =
  | 'api'
  | 'client'
  | 'scan'
  | 'deploy'
  | 'monitor'
  | 'assistant'
  | 'websocket'
  | 'runtime';

export interface DiagnosisInput {
  message: string;
  code?: string | null;
  status?: number | null;
  method?: string | null;
  endpoint?: string | null;
  source?: ErrorSource;
  details?: unknown;
}

export interface Diagnosis {
  title: string;
  severity: ErrorSeverity;
  component: string;
  rootCause: string;
  explanation: string;
  remedy: string;
  filePath: string | null;
  lineNumber: number | null;
  functionName: string | null;
}

/** Pull `file.js:12:5`, `/path/file.ts (line 12)` or `line 12` out of a message. */
export function extractLocation(message: string): { filePath: string | null; lineNumber: number | null } {
  const withLine = message.match(/((?:\.{0,2}\/)?[\w./@-]+\.[a-z]{1,5}):(\d{1,6})(?::(\d{1,4}))?/i);
  if (withLine) {
    return { filePath: withLine[1], lineNumber: Number(withLine[2]) };
  }
  const parenthesised = message.match(/((?:\.{0,2}\/)?[\w./@-]+\.[a-z]{1,5})\s*\((?:line\s*)?(\d{1,6})[,:]/i);
  if (parenthesised) {
    return { filePath: parenthesised[1], lineNumber: Number(parenthesised[2]) };
  }
  const lineOnly = message.match(/\bline\s+(\d{1,6})\b/i);
  return { filePath: null, lineNumber: lineOnly ? Number(lineOnly[1]) : null };
}

export function extractFunction(message: string): string | null {
  const named = message.match(/\b(?:in|at)\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (named) return named[1];
  const method = message.match(/\b([A-Za-z_$][\w$]*)\s+is not a function/);
  return method ? method[1] : null;
}

function endpointLabel(endpoint?: string | null): string {
  if (!endpoint) return 'the API';
  return endpoint.length > 90 ? `${endpoint.slice(0, 87)}…` : endpoint;
}

/** Route a failure to a specific, actionable explanation. */
export function diagnose(input: DiagnosisInput): Diagnosis {
  const message = (input.message ?? '').trim();
  const code = (input.code ?? '').toLowerCase();
  const status = input.status ?? null;
  const method = input.method ?? null;
  const endpoint = input.endpoint ?? null;
  const location = extractLocation(message);
  const fn = extractFunction(message);
  const component = input.source === 'client' ? 'Browser' : endpoint ? `${method ?? 'GET'} ${endpoint}` : 'DARKNOTE';

  const base = {
    filePath: location.filePath,
    lineNumber: location.lineNumber,
    functionName: fn,
  };

  // ---- transport / auth ----------------------------------------------------
  if (status === 401 || code === 'unauthenticated') {
    return {
      ...base,
      title: 'Session expired or not signed in',
      severity: 'critical',
      component,
      rootCause: 'The request reached the server without a valid session cookie.',
      explanation:
        'DARKNOTE authenticates every API call with a signed session cookie. Either the session expired (default 12 hours), the cookie was cleared, or the request came from another origin and the browser withheld it.',
      remedy: 'Sign in again from /login. If it keeps happening on a phone, check that cookies are enabled and that the site is served over the same host you signed in on.',
    };
  }

  if (code === 'csrf_failed') {
    return {
      ...base,
      title: 'Stale security token (CSRF)',
      severity: 'minor',
      component,
      rootCause: 'The form was rendered before a reload and its CSRF token no longer matches the session.',
      explanation:
        'Every state-changing request has to carry the token that belongs to the current session. Opening the app in two tabs, or leaving a form open across a redeploy, invalidates the older token.',
      remedy: 'Reload the page and repeat the action. Nothing was written to the server.',
    };
  }

  if (code === 'bad_origin') {
    return {
      ...base,
      title: 'Request blocked by origin check',
      severity: 'moderate',
      component,
      rootCause: 'The Origin header did not match the Host header, so the request was rejected as cross-site.',
      explanation:
        'Behind a proxy that rewrites the Host header, the browser origin and the server host disagree. DARKNOTE refuses those requests instead of trusting them.',
      remedy: 'Set DARKNOTE_APP_URL to the public URL and make sure the reverse proxy forwards the original Host header (X-Forwarded-Host), then reload.',
    };
  }

  if (status === 405) {
    return {
      ...base,
      title: `Method ${method ?? 'used'} is not allowed on ${endpointLabel(endpoint)}`,
      severity: 'moderate',
      component,
      rootCause: `The endpoint exists but does not implement ${method ?? 'that HTTP method'}.`,
      explanation:
        'The route answered 405, which means it was found and refused the verb. That happens when a client calls POST on a read-only route (or the reverse), or when the Pterodactyl panel version does not expose that method.',
      remedy: `Use the verb the route documents (the Error Center records the method that was actually sent). If this came from the panel, confirm the panel version supports that endpoint.`,
    };
  }

  if (status === 403 || code === 'forbidden') {
    if (/secret|credential/i.test(code) || /credential|session file|protected/i.test(message)) {
      return {
        ...base,
        title: 'Protected credential path refused',
        severity: 'moderate',
        component,
        rootCause: 'The path is classified as a WhatsApp session, API key store or credential file.',
        explanation:
          'DARKNOTE never reads, edits or deletes credential material through the browser. The refusal is a working safety rule, not a failure of the file.',
        remedy: 'Manage that file in the Pteroplanel file manager or over SFTP. Use the Download Center for exports instead.',
      };
    }
    if (/data|record/i.test(code) || /production data/i.test(message)) {
      return {
        ...base,
        title: 'Production data protected from this action',
        severity: 'moderate',
        component,
        rootCause: 'The target is a database file or a data record inside the project.',
        explanation:
          'Editing or deleting live records from the code tools could destroy bot state. Those paths are read-only here by design.',
        remedy: 'Download or export the data, change it in the panel/SFTP, or use the bot’s own database tooling.',
      };
    }
    return {
      ...base,
      title: 'Permission denied for this action',
      severity: 'moderate',
      component,
      rootCause: 'The signed-in role or the per-server grant does not include the required permission.',
      explanation:
        'Roles are viewer → operator → admin → owner. Each server can also carry explicit per-user permissions that override the role for some actions.',
      remedy: 'Ask an owner to grant the missing permission on this server (Admin Settings → server access), or sign in with a role that has it.',
    };
  }

  if (status === 404) {
    return {
      ...base,
      title: location.filePath ? `File not found: ${location.filePath}` : 'Resource not found',
      severity: 'moderate',
      component,
      rootCause: location.filePath
        ? 'The file was deleted, renamed or never existed on the panel.'
        : 'The endpoint or record does not exist (or was deleted since the page was rendered).',
      explanation: location.filePath
        ? 'The Pterodactyl Client API answered that the path is absent. A stale editor tab or an old index row is the usual reason.'
        : 'A 404 here means the route exists but the requested record does not.',
      remedy: location.filePath
        ? 'Run Project Explorer → Rescan to refresh the index, then reopen the file.'
        : 'Reload the page. If this came from the panel, confirm the server identifier still exists.',
    };
  }

  if (status === 409 || code === 'conflict') {
    return {
      ...base,
      title: 'The file changed while you were editing it',
      severity: 'moderate',
      component,
      rootCause: 'The SHA-256 on the panel no longer matches the hash the editor opened.',
      explanation:
        'Another operator, a deploy or a bot process wrote the file after it was opened. Writing anyway would silently discard their change.',
      remedy: 'Reopen the file, compare the two versions, and merge. Nothing was written to production.',
    };
  }

  if (status === 413 || code === 'file_too_large') {
    return {
      ...base,
      title: 'File exceeds the editor limit',
      severity: 'minor',
      component,
      rootCause: 'The file is bigger than the configured per-server editor limit.',
      explanation:
        'DARKNOTE streams large files in chunks, but the limit exists so a phone does not try to hold hundreds of megabytes in memory.',
      remedy: 'Raise “Editor file limit” for this server in Admin Settings, or download the file and edit it locally.',
    };
  }

  if (status === 415 || code === 'not_utf8_text') {
    return {
      ...base,
      title: 'File is not UTF-8 text',
      severity: 'minor',
      component,
      rootCause: 'The bytes are binary or use a legacy encoding such as Latin-1.',
      explanation:
        'Decoding them as UTF-8 would replace bytes with � and then save that corruption back over the file.',
      remedy: 'Open it with a binary tool over SFTP, or convert it to UTF-8 (iconv) before editing it here.',
    };
  }

  if (code === 'empty_write_blocked' || code === 'empty_body') {
    return {
      ...base,
      title: code === 'empty_body' ? 'Panel returned an empty file body' : 'Empty write refused',
      severity: 'critical',
      component,
      rootCause:
        code === 'empty_body'
          ? 'The panel answered 200 with no bytes while the directory listing reports a non-zero size.'
          : 'The editor buffer was empty while production held real content.',
      explanation:
        'Both states would destroy a working file if they were written back. DARKNOTE refuses them instead of trusting the surface.',
      remedy:
        code === 'empty_body'
          ? 'Check that the Client API key still has file.read and retry; if it persists, download the file over SFTP.'
          : 'Reload the file so the real source is in the editor, then make the edit again.',
    };
  }

  if (status === 429 || code === 'rate_limited') {
    return {
      ...base,
      title: 'Too many requests',
      severity: 'minor',
      component,
      rootCause: 'A per-user or per-IP rate limit was reached.',
      explanation: 'DARKNOTE limits bursts so a single caller cannot exhaust the panel API or the database.',
      remedy: 'Wait for the window to pass (typically 60 seconds) and retry. Batch large operations instead of repeating them.',
    };
  }

  if (status === 424 || /api key|ptlc|auth error/i.test(message)) {
    return {
      ...base,
      title: 'Pterodactyl rejected the API key',
      severity: 'critical',
      component,
      rootCause: 'The Client API key is invalid, expired, revoked or missing a required permission.',
      explanation:
        'The panel answered 401/403 for the key. DARKNOTE cannot read files, power or console access without a valid Client key on that server.',
      remedy:
        'Open the panel → Account → API Credentials, create a Client key with the needed permissions, paste it in Admin Settings → server → API key, then run “Test connection”.',
    };
  }

  // ---- panel / network -----------------------------------------------------
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return {
      ...base,
      title: 'Panel hostname could not be resolved',
      severity: 'critical',
      component,
      rootCause: 'DNS lookup for the panel host failed from the server running DARKNOTE.',
      explanation:
        'Either the panel URL is wrong or the host running DARKNOTE has no working DNS/egress.',
      remedy: 'Check the panel URL in Admin Settings, then test DNS from the host (getent hosts <panel-host>).',
    };
  }

  if (/ECONNREFUSED/i.test(message)) {
    return {
      ...base,
      title: 'Panel refused the connection',
      severity: 'critical',
      component,
      rootCause: 'Nothing is listening on that host/port, or a firewall dropped the connection.',
      explanation: 'The TCP connection never reached Pterodactyl, so no request was processed.',
      remedy: 'Confirm the panel is up and reachable from the DARKNOTE host (curl -I <panel-url>), and that outbound HTTPS is allowed.',
    };
  }

  if (/ETIMEDOUT|timeout|aborted/i.test(message)) {
    return {
      ...base,
      title: 'The panel did not answer in time',
      severity: 'moderate',
      component,
      rootCause: 'The request exceeded the timeout while waiting for Pterodactyl.',
      explanation:
        'Large directory walks or a struggling panel can exceed the limit; DARKNOTE aborts rather than hanging the page.',
      remedy: 'Retry. If it repeats on one folder, scan with a narrower project root or raise the timeout.',
    };
  }

  if (status === 502 || status === 424 || code === 'scan_failed' || code === 'unreachable') {
    return {
      ...base,
      title: 'Pterodactyl panel unreachable',
      severity: 'critical',
      component,
      rootCause: 'The panel URL, the API key or the network path to the panel failed.',
      explanation:
        'DARKNOTE talks to the panel over its Client API. When that hop fails, files, power actions, console and monitor all fail together.',
      remedy:
        'Open Admin Settings → the server → “Test connection”. It checks DNS, TLS, the key and each required permission and names the first failing one.',
    };
  }

  // ---- runtime -------------------------------------------------------------
  if (/whatsapp|session|logged out|qr/i.test(message) || code.startsWith('whatsapp')) {
    return {
      ...base,
      title: 'WhatsApp session is not connected',
      severity: 'critical',
      component: component === 'DARKNOTE' ? 'Bot runtime' : component,
      rootCause: 'The WhatsApp session is logged out, waiting for a QR scan, or its auth files are unreadable.',
      explanation:
        'The bot process can be running while WhatsApp is disconnected. DARKNOTE reports the two states separately so a green container is not mistaken for a working bot.',
      remedy:
        'Open Terminal & Logs, look for the QR or the logout reason, then re-pair the device. If it logged out repeatedly, clear the auth folder and pair again.',
    };
  }

  if (/crashed|exited|restart loop|out of memory|heap/i.test(message) || code === 'container_crashed') {
    return {
      ...base,
      title: 'Bot container crashed or is restarting',
      severity: 'critical',
      component: 'Bot runtime',
      rootCause: 'The process exited with a non-zero code (crash, OOM or a startup error).',
      explanation:
        'Pterodactyl restarts the container, so the state flips between starting and crashed while the real cause stays in the console output.',
      remedy:
        'Open Terminal & Logs and read the last lines before the exit. A syntax error or a missing dependency is the usual cause; the Error Center links the affected file when the message names one.',
    };
  }

  if (/cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(message)) {
    const missing = message.match(/Cannot find module ['"]([^'"]+)['"]/i)?.[1] ?? null;
    return {
      ...base,
      title: missing ? `Missing module: ${missing}` : 'A required module is missing',
      severity: 'critical',
      component: 'Bot runtime',
      rootCause: missing
        ? `"${missing}" is imported by the code but is not installed on the server.`
        : 'A required module is not present in node_modules.',
      explanation:
        'package.json can declare a dependency that was never installed (or was installed on another machine). The bot fails at require() time, before it can log anything useful.',
      remedy: missing
        ? `Add "${missing}" to package.json, run npm install in the panel console, then restart. The Project Explorer → package.json category shows which declared packages are missing.`
        : 'Run npm install in the panel console, then restart the bot.',
    };
  }

  if (/syntaxerror|unexpected token|unexpected end of input|unterminated/i.test(message)) {
    return {
      ...base,
      title: location.filePath ? `Syntax error in ${location.filePath}` : 'Syntax error in the project',
      severity: 'critical',
      component: location.filePath ? `File ${location.filePath}` : 'Source code',
      rootCause: 'A JavaScript file cannot be parsed, so the bot (or the validation step) stops there.',
      explanation:
        'The parser names the first token it could not accept. The line number points at the construct that broke, which is often one line above the reported one for bracket problems.',
      remedy: location.lineNumber
        ? `Open the file at line ${location.lineNumber} in the Code Editor, fix the construct, then validate before deploying.`
        : 'Open the file named in the message, fix the reported token, then validate before deploying.',
    };
  }

  if (code === 'validation_failed' || /validation failed/i.test(message)) {
    return {
      ...base,
      title: 'Change did not pass validation',
      severity: 'moderate',
      component,
      rootCause: 'The edited file failed the parse/JSON check before deployment, so it was not written.',
      explanation:
        'DARKNOTE validates first and only then writes. This error means production is untouched and the change is still only a draft.',
      remedy: 'Fix the reported line in the editor and deploy again. The draft is preserved.',
    };
  }

  if (code === 'deploy_failed' || code === 'rollback_failed' || /deployment failed/i.test(message)) {
    return {
      ...base,
      title: 'Deployment failed',
      severity: 'critical',
      component: 'Deployment',
      rootCause: 'A write, a hash verification or the restart step failed during deployment.',
      explanation:
        'DARKNOTE writes with a hash check, then reads the file back. A failure here means the deploy stopped at that step; the deployment record shows which file.',
      remedy:
        'Open Deployments, read the failing step, then use Rollback to restore the last good version. The pre-deploy backup is kept either way.',
    };
  }

  if (/EACCES|EPERM/i.test(message)) {
    return {
      ...base,
      title: 'Permission denied on the server filesystem',
      severity: 'critical',
      component,
      rootCause: 'The container user cannot read or write that path.',
      explanation: 'Ownership changed (root-owned file) or the path is outside the volume the server may write.',
      remedy: 'Fix ownership in the panel file manager (chown to the container user), or move the file into the server volume.',
    };
  }

  if (/ENOSPC/i.test(message)) {
    return {
      ...base,
      title: 'Server disk is full',
      severity: 'critical',
      component: 'Pterodactyl server',
      rootCause: 'The panel reported no space left while writing.',
      explanation: 'Writes fail once the volume is full; the file may be partially written.',
      remedy: 'Free space (logs, backups, old versions), then redeploy and verify the hash.',
    };
  }

  if (/JSON|Unexpected token <|not valid JSON/i.test(message)) {
    return {
      ...base,
      title: 'Invalid JSON',
      severity: 'moderate',
      component: location.filePath ? `File ${location.filePath}` : component,
      rootCause: 'A JSON file (package.json, config.json) cannot be parsed.',
      explanation:
        'A trailing comma, a comment or a smart quote makes the whole file unreadable to every tool that depends on it.',
      remedy: location.lineNumber
        ? `Open the file at line ${location.lineNumber}, fix the syntax, and let the validation step confirm it.`
        : 'Validate the file with a JSON parser before saving it.',
    };
  }

  // ---- fallback ------------------------------------------------------------
  return {
    ...base,
    title: message ? message.split('\n')[0].slice(0, 120) : 'Unclassified error',
    severity: status && status >= 500 ? 'critical' : 'moderate',
    component,
    rootCause: 'DARKNOTE captured the failure but the message does not match a known signature.',
    explanation:
      'The raw message and context are stored so the cause can be identified. Nothing was guessed: the fields below are exactly what the failing component reported.',
    remedy:
      'Open the detail view for the recorded context (endpoint, method, status, file). If it repeats, compare it with the console output for the same timestamp.',
  };
}

/** A stable key so the same failure aggregates instead of flooding the list. */
export function fingerprintOf(input: {
  source: string;
  component: string;
  code: string;
  message: string;
  filePath?: string | null;
  lineNumber?: number | null;
}): string {
  const normalised = input.message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<ts>')
    .replace(/\b\d{6,}\b/g, '<n>')
    .slice(0, 240)
    .toLowerCase();
  return `${input.source}|${input.component.slice(0, 120)}|${input.code}|${input.filePath ?? ''}:${input.lineNumber ?? 0}|${normalised}`;
}
