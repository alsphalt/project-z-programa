/**
 * Error Intelligence — diagnosis rules.
 *
 * Every rule turns raw evidence (a real message, stack, HTTP status, console
 * line, panel response) into a specific explanation. No rule emits "Something
 * went wrong": if the evidence is insufficient the fallback says exactly which
 * facts are missing.
 */
import type { Diagnosis, ErrorSource, RawErrorInput, Severity } from './types';
import type { RouteLookup } from './routes';
import {
  extractEndpoint,
  extractModuleName,
  normalizeForFingerprint,
  parseLineLocation,
  parseStack,
  stripAnsi,
  whatsappSignals,
} from './parse';

export interface ProjectEvidence {
  /** True when the file index contains node_modules (dependency probe). */
  hasNodeModules: boolean | null;
  hasPackageJson: boolean | null;
  /** Indexed paths (bounded list) used to check whether a file exists. */
  paths: string[];
  /** Files matching the module name, when the caller could look it up. */
  moduleCandidates?: string[];
  /** Existing WhatsApp session artefacts, from the index only (never contents). */
  sessionArtifacts?: string[];
  /** Latest console evidence the caller attached. */
  consoleEvidence?: string[];
  containerState?: string | null;
  whatsappState?: string | null;
  whatsappSource?: string | null;
}

export interface DiagnosisEvidence {
  route?: RouteLookup;
  project?: ProjectEvidence;
  /** Deployment detail for deployment-sourced errors. */
  deployment?: { id: string; status: string; error?: string | null; health?: unknown } | null;
}

interface Candidate extends Omit<Diagnosis, 'code'> {
  code?: string;
}

interface Ctx {
  input: RawErrorInput;
  message: string;
  clean: string;
  lower: string;
  code: string;
  status: number | null;
  endpoint: string | null;
  method: string | null;
  filePath: string | null;
  line: number | null;
  column: number | null;
  functionName: string | null;
  evidence: DiagnosisEvidence;
  signals: string[];
}

function buildContext(input: RawErrorInput, evidence: DiagnosisEvidence): Ctx {
  const message = stripAnsi(input.message ?? '').trim();
  const location = parseStack(input.stack) ;
  const lineLocation = parseLineLocation(message);
  const parsedEndpoint = extractEndpoint(message);
  const filePath = input.filePath ?? location.filePath ?? lineLocation.filePath ?? null;
  return {
    input,
    message,
    clean: message.replace(/\s+/g, ' '),
    lower: message.toLowerCase(),
    code: (input.code ?? '').trim(),
    status: input.httpStatus ?? parsedEndpoint.status ?? null,
    endpoint: input.endpoint ?? parsedEndpoint.endpoint ?? null,
    method: input.httpMethod ?? parsedEndpoint.method ?? null,
    filePath,
    line: input.line ?? location.line ?? lineLocation.line ?? null,
    column: input.column ?? location.column ?? lineLocation.column ?? null,
    functionName: input.functionName ?? location.functionName ?? null,
    evidence,
    signals: whatsappSignals(message),
  };
}

function severityFor(source: ErrorSource, status: number | null): Severity {
  if (status && status >= 500) return 'critical';
  if (source === 'whatsapp' || source === 'deployment' || source === 'panel') return 'critical';
  if (status && status >= 400) return 'moderate';
  return 'moderate';
}

const SOURCE_TITLES: Record<ErrorSource, string> = {
  whatsapp: 'WhatsApp bot runtime',
  panel: 'Pterodactyl connection',
  console: 'Terminal output',
  api: 'Backend API request',
  frontend: 'Frontend',
  auth: 'Authentication',
  websocket: 'WebSocket connection',
  files: 'File manager',
  editor: 'Code editor',
  explorer: 'Project Explorer',
  deployment: 'Deployment',
  packages: 'Package installation',
  power: 'Bot power action',
  storage: 'Backup storage',
  database: 'Database',
};

function firstLine(text: string, max = 220): string {
  const line = text.split('\n').map((value) => value.trim()).filter(Boolean)[0] ?? text;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function rules(ctx: Ctx): Candidate | null {
  const { lower, clean, code, status, endpoint, method, evidence, signals } = ctx;

  // ---- HTTP method mismatch (the defect behind "Request failed (405)") ------
  if (status === 405) {
    const route = evidence.route;
    const where = endpoint ?? 'the requested endpoint';
    const verb = method ?? 'this method';
    if (!route || route.unavailable) {
      return {
        title: `${verb} ${where} returned 405 — route table unavailable`,
        code: code || 'HTTP_405',
        severity: 'moderate',
        source: ctx.input.source,
        rootCause:
          'The server answered 405 Method Not Allowed, which means the URL exists but the HTTP method is not exported. The route table could not be read from disk in this build, so the exact handler could not be confirmed.',
        why: `Next.js only accepts the verbs a route file exports. ${verb} was sent to ${where}, and no handler for it was found in the readable route tree.`,
        recommendation:
          'Open the route folder for that endpoint under src/app/api and confirm an exported handler for this verb. The terminal can run `find src/app/api -name route.ts`.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath,
        line: ctx.line,
        column: ctx.column,
        functionName: ctx.functionName,
        endpoint,
        httpMethod: method,
        httpStatus: 405,
        evidence: [`HTTP 405 returned by ${verb} ${where}`, 'Route table could not be read from disk'],
      };
    }
    if (route.exists && route.uploadedMethods.length && method && !route.uploadedMethods.includes(method as never)) {
      return {
        title: `${verb} ${where} is not handled — the route exports ${route.uploadedMethods.join(', ')} only`,
        code: code || 'HTTP_405',
        severity: 'moderate',
        source: ctx.input.source === 'api' ? 'api' : 'panel',
        rootCause: `The route file ${route.file} exists but exports ${route.uploadedMethods.join(', ')}. Next.js answers 405 for any other verb, so the request never reached a handler.`,
        why: `The browser sent ${verb} ${where}. Because ${route.file} has no \`export ${method}\`, the request was rejected before any application code ran. Nothing was written and the panel was never called.`,
        recommendation: `Add an exported ${verb} handler to ${route.file} that performs the action, or change the caller to use ${route.uploadedMethods[0]} if that is the intended verb.`,
        repairAuthority: 'approval',
        repairKind: 'add_http_method',
        filePath: route.file,
        line: null,
        column: null,
        functionName: null,
        endpoint: where,
        httpMethod: method,
        httpStatus: 405,
        evidence: [
          `Route matched: ${route.file}`,
          `Exported methods: ${route.uploadedMethods.join(', ')}`,
          `Requested method: ${verb}`,
        ],
      };
    }
    if (route.exists && method && route.uploadedMethods.includes(method as never)) {
      return {
        title: `${verb} ${where} was rejected with 405 upstream`,
        code: code || 'HTTP_405',
        severity: 'critical',
        source: 'panel',
        rootCause: `The control center does export ${verb} for ${where}, so the 405 did not come from Next.js. It came from the upstream Pterodactyl panel, which rejects this verb on the target route.`,
        why: 'Pterodactyl returns 405 when a route is called with a verb it does not implement (for example GET on a POST-only endpoint). The request left this application successfully.',
        recommendation:
          'Compare the panel call with the Pterodactyl Client API: power is POST /api/client/servers/{id}/power, files are POST/PUT under /api/client/servers/{id}/files/*. The endpoint and status are shown above; nothing in production was changed.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath,
        line: ctx.line,
        column: ctx.column,
        functionName: ctx.functionName,
        endpoint: where,
        httpMethod: method,
        httpStatus: 405,
        evidence: [`Route exists: ${route.file}`, `It does export ${verb}`],
      };
    }
    return {
      title: `No route matches ${verb} ${where}`,
      code: code || 'HTTP_405',
      severity: 'moderate',
      source: 'api',
      rootCause: `No API route file serves ${where}. A 405 without a matching route usually means a reverse proxy or a rewritten path sits in front of the app.`,
      why: `${verb} ${where} reached a server that does not expose this path.`,
      recommendation:
        'Check the request URL in the browser network panel, then confirm the path exists under src/app/api. If the app is behind a proxy, confirm the proxy does not rewrite /api.',
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath,
      line: ctx.line,
      column: ctx.column,
      functionName: ctx.functionName,
      endpoint,
      httpMethod: method,
      httpStatus: 405,
      evidence: [`No route matched ${where}`],
    };
  }

  // ---- Pterodactyl credential problems -------------------------------------
  if (ctx.input.source === 'panel' || /pterodactyl|ptlc_|ptla_|panel/i.test(clean)) {
    if (code === 'application_key_used' || /ptla_/.test(clean)) {
      return {
        title: 'Application API key used where a Client key is required',
        code: 'application_key_used',
        severity: 'critical',
        source: 'panel',
        rootCause:
          'The stored credential starts with ptla_, which is an Application API key. Application keys authenticate /api/application only; every /api/client route rejects them.',
        why: 'The control center reads files and sends power signals through the Client API. With an Application key, the panel answers 401 and no file or power operation can succeed.',
        recommendation:
          'In the panel open Account → API Credentials → Create API Key (this produces ptlc_…), then paste it in DARKNOTE → Admin Settings → Pterodactyl connection and run Test connection.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint: endpoint, httpMethod: method, httpStatus: status,
        evidence: ['Credential prefix: ptla_', 'Client API requires ptlc_'],
      };
    }
    if (status === 403 || code === 'permission_denied' || /forbidden|not authorized/i.test(clean)) {
      return {
        title: 'The panel account is missing a required subuser permission',
        code: code || 'panel_permission_denied',
        severity: 'critical',
        source: 'panel',
        rootCause:
          'The Client API key is valid, but the account behind it does not have the subuser permission this operation needs on that server.',
        why: `Pterodactyl enforces permissions per server. ${endpoint ? `The call to ${endpoint} was refused with 403` : 'The call was refused with 403'}, so the action never executed.`,
        recommendation:
          'In the panel open the server → Users (or the subuser entry for this account) and grant the missing permission. File operations need file.read/file.write/file.create/file.delete/file.rename; power needs control.start/control.stop/control.restart; the console needs control.console and websocket.connect.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint, httpMethod: method, httpStatus: 403,
        evidence: ['Panel answered 403 Forbidden', clean.slice(0, 200)],
      };
    }
    if (status === 401 || code === 'unauthenticated' || /invalid api key|unauthorized/i.test(clean)) {
      return {
        title: 'The panel rejected the Client API key (401)',
        code: code || 'panel_unauthorized',
        severity: 'critical',
        source: 'panel',
        rootCause:
          'The key was not accepted: it may have been deleted in the panel, revoked, or encrypted with a different DARKNOTE_SECRET and therefore unreadable.',
        why: 'Without a valid Client key every panel read and write fails at the first request, so file lists, monitoring and deployments all stop.',
        recommendation:
          'Re-create the Client API key (ptlc_…) in Account → API Credentials, save it in Admin Settings, then run Test connection. If DARKNOTE_SECRET was changed, stored keys must be re-entered.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint, httpMethod: method, httpStatus: 401,
        evidence: ['Panel answered 401 Unauthorized'],
      };
    }
    if (status === 404) {
      return {
        title: 'The panel has no server with that identifier (404)',
        code: code || 'panel_server_not_found',
        severity: 'critical',
        source: 'panel',
        rootCause:
          'The stored server identifier does not match a server visible to this account. This is the short identifier from the panel URL, not the server name.',
        why: `Every Client API route is scoped to /api/client/servers/{identifier}. With an unknown identifier the panel answers 404 before doing anything.`,
        recommendation:
          'Open the server in the panel and copy the short identifier from https://your-panel/server/<identifier>. Update it in Admin Settings and test the connection.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint, httpMethod: method, httpStatus: 404,
        evidence: ['Panel answered 404 for the server identifier'],
      };
    }
    if (status === 429) {
      return {
        title: 'The panel is rate limiting this account (429)',
        code: code || 'panel_rate_limited',
        severity: 'moderate',
        source: 'panel',
        rootCause: 'Pterodactyl throttles Client API calls per key. Too many requests were sent in a short window.',
        why: 'The panel refused the call before executing it, so the operation did not happen. Repeated retries extend the throttle window.',
        recommendation:
          'Wait for the retry window, then retry once. If this repeats during normal use, raise the scan interval in Settings or reduce concurrent tabs polling the monitor.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint, httpMethod: method, httpStatus: 429,
        evidence: ['Panel answered 429 Too Many Requests'],
      };
    }
    if (status === 0 || code === 'connection_error' || /enotfound|eai_again|econnrefused|certificate|self.signed|socket hang up|timed? ?out/i.test(clean)) {
      return {
        title: 'The panel could not be reached from this server',
        code: code || 'panel_unreachable',
        severity: 'critical',
        source: 'panel',
        rootCause:
          'The TCP/TLS connection to the panel failed. The panel host may be down, DNS may not resolve from this host, the certificate may be rejected, or a firewall may block the port.',
        why: 'No HTTP response arrived, so no file, console or power operation could be performed. Nothing was changed in production.',
        recommendation:
          'From the machine running DARKNOTE run `curl -I https://<panel-host>` and `getent hosts <panel-host>`. Confirm the panel URL in Settings has no /api/client suffix and that port 443 is allowed outbound.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint, httpMethod: method, httpStatus: status,
        evidence: [firstLine(clean), 'No HTTP response received'],
      };
    }
  }

  // ---- WhatsApp runtime ----------------------------------------------------
  // Only lines that are demonstrably about the WhatsApp client reach these rules.
  // A dependency conflict or a generic socket message must not be mistaken for a
  // session problem just because it contains the word "conflict" or "closed".
  const whatsappContext =
    ctx.input.source === 'whatsapp' ||
    /whatsapp|baileys|whiskeysockets|pairing code|scan the qr|logged out|device (?:was )?removed|stream errored|connection (?:closed|lost), (?:retrying|reconnecting)/i.test(
      clean,
    );
  if (whatsappContext) {
    const artifacts = evidence.project?.sessionArtifacts ?? [];
    const hasSession = artifacts.length > 0;
    if (signals.includes('session-logged-out')) {
      return {
        title: 'The WhatsApp session was logged out by the phone',
        code: 'WHATSAPP_LOGGED_OUT',
        severity: 'critical',
        source: 'whatsapp',
        rootCause: hasSession
          ? `The panel reports a linked-device logout (401/device removed). The session folder still exists (${artifacts.slice(0, 3).join(', ')}) but its credentials are no longer valid.`
          : 'The bot received a logout event, but no WhatsApp session artefacts were found in the file index, so the pairing was already incomplete or removed.',
        why: 'Baileys receives a 401 / stream error 401 when the device is unlinked from the phone (WhatsApp → Linked devices → log out), or when the account is restricted. The stored credentials are then permanently invalid — retrying reconnects the socket but cannot restore the session.',
        recommendation:
          'Restart the bot and watch the console for the pairing QR or pairing code, then link the device again from WhatsApp → Linked devices. Do not delete the session folder until the new pairing succeeds, so the old credentials remain available for diagnosis.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean), `session artefacts indexed: ${hasSession ? artifacts.length : 0}`],
      };
    }
    if (signals.includes('session-invalid') || signals.includes('session-conflict')) {
      return {
        title: signals.includes('session-conflict')
          ? 'The WhatsApp session is open in another process'
          : 'The stored WhatsApp session cannot be used',
        code: signals.includes('session-conflict') ? 'WHATSAPP_SESSION_CONFLICT' : 'WHATSAPP_SESSION_INVALID',
        severity: 'critical',
        source: 'whatsapp',
        rootCause: signals.includes('session-conflict')
          ? 'A second process or another host connected with the same credentials. WhatsApp closes the older socket with a conflict/replaced stream error.'
          : 'The session directory exists but its credential files are unreadable, incomplete, or encrypted for a different bot version.',
        why: 'Baileys needs a complete, single-writer auth state. A second writer or a half-written creds.json makes the handshake fail before any message can be sent.',
        recommendation: signals.includes('session-conflict')
          ? 'Make sure only one bot instance runs on this server. Stop duplicate processes, then restart once and confirm the console prints a single connection-open event.'
          : 'Restart the bot and inspect the console for the exact Baileys error. If credentials are corrupt, re-pair the device (Linked devices) — take a backup of the session folder first.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean), `session artefacts indexed: ${hasSession ? artifacts.length : 0}`],
      };
    }
    if (signals.includes('pairing-required')) {
      return {
        title: 'The bot is waiting for a WhatsApp device pairing',
        code: 'WHATSAPP_PAIRING_REQUIRED',
        severity: 'moderate',
        source: 'whatsapp',
        rootCause: 'No valid linked device is stored, so the runtime printed a QR code or pairing code instead of opening a session.',
        why: 'A WhatsApp session only becomes usable after the phone approves this device. Until then the socket stays in a pre-auth state and messages are not delivered.',
        recommendation:
          'Open Terminal & Logs and read the current QR or 8-character pairing code, then link it from WhatsApp → Linked devices → Link a device. The monitor flips to connected only after the console prints a connection-open event.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean)],
      };
    }
    if (signals.includes('network') || signals.includes('timeout')) {
      return {
        title: 'The WhatsApp connection is failing on the network layer',
        code: signals.includes('timeout') ? 'WHATSAPP_NETWORK_TIMEOUT' : 'WHATSAPP_NETWORK_ERROR',
        severity: 'critical',
        source: 'whatsapp',
        rootCause:
          'The socket to WhatsApp could not be established or was reset. This is a transport problem (DNS, blocked egress, proxy, or the host dropping long-lived connections), not a logout.',
        why: 'The bot never reached the WhatsApp servers, so the session state cannot advance and the badge stays offline even though the container is running.',
        recommendation:
          'From the server console run `curl -I https://web.whatsapp.com` and check outbound DNS. If the host sits behind a proxy, set HTTPS_PROXY for the bot. Then restart and watch for a connection-open line.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean)],
      };
    }
    if (signals.includes('connection-dropped') || ctx.code === 'WHATSAPP_DISCONNECTED') {
      return {
        title: 'The WhatsApp connection dropped and is reconnecting',
        code: 'WHATSAPP_CONNECTION_DROPPED',
        severity: 'moderate',
        source: 'whatsapp',
        rootCause:
          'The socket closed after being open. Baileys emits connection closed/stream errored for transient network loss, a server-side restart, or a replaced session.',
        why: 'While the socket is closed the bot cannot receive or send messages. Baileys reconnects automatically, but the session only counts as healthy again after a new connection-open event.',
        recommendation:
          'Watch Terminal & Logs for the next "connection open" line. If it never returns, restart the container once. Repeated drops point to host networking or a second process using the same session.',
        repairAuthority: 'safe',
        repairKind: 'restart_bot',
        filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean)],
      };
    }
    if (ctx.code === 'WHATSAPP_NOT_LINKED' || /not connected|offline|unknown/i.test(clean)) {
      return {
        title: 'The bot process is running but no WhatsApp session is linked',
        code: 'WHATSAPP_NOT_LINKED',
        severity: 'critical',
        source: 'whatsapp',
        rootCause:
          'The container is running, yet no connection-open event was observed for the current process and no status file reported a live session.',
        why: 'A running container only proves the process started. It does not prove WhatsApp authenticated — the console must print a connection event, or the bot must write its status file.',
        recommendation:
          'Open Terminal & Logs and look for the most recent WhatsApp line. If it is a QR/pairing line, link the device. If there is no line at all, the bot may be stuck before its WhatsApp client initialises — check startup logs above it.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [
          `container state: ${evidence.project?.containerState ?? 'unknown'}`,
          `whatsapp state: ${evidence.project?.whatsappState ?? 'unknown'} (source: ${evidence.project?.whatsappSource ?? 'none'})`,
        ],
      };
    }
  }

  // ---- Packages & dependencies --------------------------------------------
  const moduleName = extractModuleName(clean);
  if (moduleName || code === 'MODULE_NOT_FOUND' || /cannot find module/i.test(clean)) {
    const local = moduleName?.startsWith('.') || moduleName?.startsWith('/');
    const candidates = evidence.project?.moduleCandidates ?? [];
    const known = Boolean(evidence.project?.hasNodeModules);
    return {
      title: moduleName ? `Module "${moduleName}" cannot be resolved` : 'A required module is missing at runtime',
      code: code || 'MODULE_NOT_FOUND',
      severity: 'critical',
      source: 'packages',
      rootCause: local
        ? `The bot required ${moduleName}, a project-relative path that does not exist.`
        : `Node could not resolve "${moduleName ?? 'a dependency'}" from the bot's working directory. ${known ? 'node_modules exists, so the package is either absent from it or was installed for a different directory.' : 'The file index shows no node_modules directory at this level, so dependencies were probably never installed after the last deploy.'}`,
      why: 'Node resolves require() from node_modules upwards from the entry file. A missing package, a package.json that was deployed without running npm install, or a wrong working directory all produce this error at startup, which is why the bot exits instead of connecting to WhatsApp.',
      recommendation: moduleName && !local
        ? `Open Terminal & Logs and run \`npm install ${moduleName}\` (or \`npm install\` if package.json already lists it), then restart. Deployments can deploy package.json but cannot install packages.`
        : 'Confirm the import path and that the file was deployed. Project Explorer shows the indexed file list; if the file is missing there, it was never uploaded.',
      repairAuthority: moduleName && !local ? 'approval' : 'none',
      repairKind: moduleName && !local ? 'install_dependencies' : null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [
        firstLine(clean),
        `node_modules present: ${known === null ? 'not determined' : known ? 'yes' : 'no'}`,
        ...(candidates.length ? [`matching indexed files: ${candidates.slice(0, 3).join(', ')}`] : []),
      ],
    };
  }

  // ---- Syntax / reference / type errors -----------------------------------
  if (/syntaxerror|unexpected token|unexpected end of input|invalid or unexpected token/i.test(clean)) {
    return {
      title: ctx.filePath
        ? `Syntax error in ${ctx.filePath.split('/').pop()}${ctx.line ? ` at line ${ctx.line}` : ''}`
        : 'Syntax error in the bot source',
      code: code || 'SYNTAX_ERROR',
      severity: 'critical',
      source: 'console',
      rootCause: ctx.filePath
        ? `Node's parser rejected ${ctx.filePath}${ctx.line ? `:${ctx.line}${ctx.column ? `:${ctx.column}` : ''}` : ''}. The file is not valid JavaScript for the configured module mode.`
        : 'A JavaScript file failed to parse. The console line did not include a file:line, so the exact location could not be extracted.',
      why: 'The process cannot start when a required file does not parse. Nothing after the failing require() runs, so the bot exits before it ever opens a WhatsApp socket.',
      recommendation: ctx.filePath
        ? `Open ${ctx.filePath} in the Code Editor at line ${ctx.line ?? 1}, fix the reported token, then validate and deploy. The editor refuses a deploy that still fails node --check.`
        : 'Open the file named in the console line in the Code Editor, or search the project for the reported fragment, then validate before deploying.',
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  if (/referenceerror/i.test(clean)) {
    return {
      title: ctx.filePath ? `ReferenceError in ${ctx.filePath.split('/').pop()}` : 'ReferenceError at runtime',
      code: code || 'REFERENCE_ERROR',
      severity: 'critical',
      source: 'console',
      rootCause: 'Code referenced a name that is not defined in that scope — typically a missing import, a typo, or a variable used before initialisation.',
      why: 'The error is thrown while handling an update, so that message fails and the surrounding handler can abort. The bot process itself may stay up, which is why the container looks healthy while a command does nothing.',
      recommendation: `Open ${ctx.filePath ?? 'the file in the stack'} at line ${ctx.line ?? 1}, confirm the identifier is imported or declared, then deploy the fix. The stack frame above names the function.`,
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  if (/typeerror/i.test(clean)) {
    return {
      title: ctx.filePath ? `TypeError in ${ctx.filePath.split('/').pop()}` : 'TypeError at runtime',
      code: code || 'TYPE_ERROR',
      severity: 'moderate',
      source: 'console',
      rootCause: 'A value had a different shape than the code assumed (undefined property, calling a non-function, or reading from null).',
      why: 'This fails only the code path that received the unexpected value — often a message without the expected field — so it can look intermittent.',
      recommendation: `Inspect ${ctx.filePath ?? 'the stack frame'} at line ${ctx.line ?? 1} and guard the value before use. The console line above contains the property name that was undefined.`,
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  if (/unhandled ?(promise ?)?rejection/i.test(clean)) {
    return {
      title: 'An unhandled promise rejection reached the process',
      code: code || 'UNHANDLED_REJECTION',
      severity: 'critical',
      source: 'console',
      rootCause: 'A promise rejected and nothing caught it. On current Node versions this terminates the process by default, which restarts the container in a loop.',
      why: 'The failing async operation (often a network call to WhatsApp or a filesystem read) throws after the handler returned, so no try/catch is in scope.',
      recommendation: `Add a .catch() or try/catch around the await at ${ctx.filePath ?? 'the reported frame'}${ctx.line ? `:${ctx.line}` : ''}, and log the reason so the next occurrence names its source. Restart the bot once the guard is deployed.`,
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  // ---- Node/system errno ---------------------------------------------------
  if (/eaddrinuse/i.test(clean) || code === 'EADDRINUSE') {
    return {
      title: 'The bot port is already in use',
      code: 'EADDRINUSE',
      severity: 'critical',
      source: 'console',
      rootCause: 'Another process is bound to the same port, usually an older instance of the bot that did not exit before the restart.',
      why: 'The new process cannot bind, exits immediately, and the panel reports a restart loop. The old process keeps serving with stale code.',
      recommendation: 'Stop the server from Live Monitor, wait for the state to reach offline, then start it once. If it repeats, the startup command may launch two processes (for example `npm start` plus a second node entry).',
      repairAuthority: 'approval',
      repairKind: 'restart_bot',
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  if (/enospc|no space left/i.test(clean)) {
    return {
      title: 'The server disk is full',
      code: 'ENOSPC',
      severity: 'critical',
      source: 'storage',
      rootCause: 'A write failed because the container volume has no free space.',
      why: 'Node cannot write session files, logs or temp files, so the bot crashes on startup or loses its WhatsApp session state.',
      recommendation: 'Open File Manager and clear old logs and backups, or raise the disk limit in the panel. Backups & Versions shows what DARKNOTE itself stores (outside the container).',
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  if (/eacces|eperm|permission denied/i.test(clean)) {
    return {
      title: 'A filesystem operation was denied',
      code: code || 'EACCES',
      severity: 'moderate',
      source: 'files',
      rootCause: 'The process user does not own the target file or directory, or the file mode is read-only.',
      why: 'The write is refused by the OS, so the file stays unchanged — but the operation that depended on it fails.',
      recommendation: `Check ownership and mode of ${ctx.filePath ?? 'the reported path'} in the panel file manager (or via SFTP) and make it writable by the container user.`,
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  // ---- npm ----------------------------------------------------------------
  if (/npm err|eresolve|etarget|e404|npm warn deprecated/i.test(clean) || code.startsWith('ERR_')) {
    if (/eresolve|peer dep/i.test(clean)) {
      return {
        title: 'npm could not resolve the dependency tree (ERESOLVE)',
        code: code || 'ERESOLVE',
        severity: 'moderate',
        source: 'packages',
        rootCause: 'Two packages require incompatible versions of the same peer dependency, so npm refused to build a tree.',
        why: 'Installation stops, node_modules is left partially updated, and the bot can fail on the next require().',
        recommendation: 'In Terminal & Logs run `npm install --legacy-peer-deps` once, or pin the conflicting package in package.json. Do not deploy a package.json that still conflicts.',
        repairAuthority: 'approval',
        repairKind: 'install_dependencies',
        filePath: null, line: null, column: null, functionName: null,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean)],
      };
    }
    if (/etarget|e404|notarget|404 not found/i.test(clean)) {
      return {
        title: 'A dependency version does not exist on the registry',
        code: code || 'ETARGET',
        severity: 'moderate',
        source: 'packages',
        rootCause: 'package.json requests a version the registry does not publish (typo, unpublished version, or a private package without credentials).',
        why: 'npm aborts before writing the module, so the bot keeps running the previous code until it restarts — then fails to load the new dependency.',
        recommendation: 'Open package.json in the Code Editor, correct the version to a published one (`npm view <pkg> versions` in the console), then install again.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean)],
      };
    }
    return {
      title: 'Package installation failed',
      code: code || 'NPM_ERROR',
      severity: 'moderate',
      source: 'packages',
      rootCause: 'npm exited non-zero. The line above names the failing stage (resolve, fetch, or link).',
      why: 'Without a completed install the bot may be missing a module at startup, which shows up later as MODULE_NOT_FOUND.',
      recommendation: 'Read the npm output in Terminal & Logs, fix the reported package or registry problem, then run `npm install` again and restart.',
      repairAuthority: 'approval',
      repairKind: 'install_dependencies',
      filePath: null, line: null, column: null, functionName: null,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  // ---- JSON / configuration ----------------------------------------------
  if (/ejsonparse|unexpected token .* in json|json at position|does not parse/i.test(clean)) {
    return {
      title: 'A JSON configuration file is invalid',
      code: code || 'JSON_PARSE_ERROR',
      severity: 'critical',
      source: 'editor',
      rootCause: `${ctx.filePath ?? 'A JSON file'} could not be parsed. A trailing comma, a comment, or a truncated write is the usual cause.`,
      why: 'The bot reads its configuration at startup; a parse failure aborts that read, so the process exits or falls back to defaults that may not match production.',
      recommendation: `Open ${ctx.filePath ?? 'the JSON file'} in the Code Editor — it validates JSON before deploy — fix the reported position, then deploy.`,
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  // ---- Deployment ---------------------------------------------------------
  if (ctx.input.source === 'deployment' || /deploy|rollback|health check/i.test(clean)) {
    if (code === 'validation_failed' || /validation failed/i.test(clean)) {
      return {
        title: 'The deployment was blocked by file validation',
        code: 'validation_failed',
        severity: 'moderate',
        source: 'deployment',
        rootCause: 'The proposed content failed the pre-deploy check (syntax, JSON parse, size, or binary), so nothing was written.',
        why: 'DARKNOTE validates before touching production. The deployment stopped at the validation step and production files are still the previous version.',
        recommendation: 'Fix the reported error in the Code Editor, use Validate, then deploy again. The editor shows the same validation result before you deploy.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean)],
      };
    }
    if (/health check failed|startup health|crashed|did not reach|timeout/i.test(clean)) {
      return {
        title: 'The bot did not start cleanly after deployment',
        code: 'deployment_health_failed',
        severity: 'critical',
        source: 'deployment',
        rootCause: 'After the restart, the container either returned to offline, never reached running, or printed a fatal startup error. Files were restored from their pre-deploy backups.',
        why: 'A syntax-valid file can still fail at runtime (missing module, bad environment value, unhandled rejection). The health check caught that and rolled back instead of leaving a broken process.',
        recommendation: 'Open the deployment record to read the captured startup lines, fix the runtime cause, and deploy again. Production currently holds the previous verified content.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean), ...(evidence.deployment?.id ? [`deployment: ${evidence.deployment.id}`] : [])],
      };
    }
    if (code === 'deployment_locked') {
      return {
        title: 'Another deployment holds the server lock',
        code: 'deployment_locked',
        severity: 'minor',
        source: 'deployment',
        rootCause: 'A deployment lock is active for this server, so a second write was refused to prevent two writers racing.',
        why: 'Two concurrent deployments could interleave writes and leave production in a mixed state, so the lock is intentional.',
        recommendation: 'Wait for the running deployment to finish (Deployments shows its status), then retry. An abandoned lock expires automatically after ten minutes.',
        repairAuthority: 'safe',
        repairKind: 'clear_stale_lock',
        filePath: null, line: null, column: null, functionName: null,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean)],
      };
    }
    if (/rolled back|rollback/i.test(clean)) {
      return {
        title: 'The deployment was rolled back',
        code: 'deployment_rolled_back',
        severity: 'critical',
        source: 'deployment',
        rootCause: 'A write or the post-deploy health check failed, so DARKNOTE restored the files this deployment had already changed.',
        why: 'Rollback keeps production on the last known content instead of leaving a half-applied change.',
        recommendation: 'Open Deployments → the failed record to see which step failed and the captured console output, then correct the cause before deploying again.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
        endpoint: null, httpMethod: null, httpStatus: null,
        evidence: [firstLine(clean), ...(evidence.deployment?.error ? [evidence.deployment.error] : [])],
      };
    }
  }

  // ---- Authentication -----------------------------------------------------
  if (ctx.input.source === 'auth' || /csrf|invalid email or password|locked|too many failed attempts|sign-in|password did not match/i.test(clean)) {
    if (/csrf/i.test(clean)) {
      return {
        title: 'The request was rejected by CSRF validation',
        code: 'csrf_failed',
        severity: 'minor',
        source: 'auth',
        rootCause: 'The x-csrf-token header was missing or did not match the token bound to this session — typically a stale tab, or a session that was revoked in another tab.',
        why: 'Mutating requests require a double-submit token. Without it the request is refused before any handler runs, so nothing changed.',
        recommendation: 'Reload the page (this refreshes the token) and repeat the action. If it persists, sign out and sign in again.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: 403,
        evidence: [firstLine(clean)],
      };
    }
    if (/password did not match|invalid email or password|unknown account|sign-in failed/i.test(clean)) {
      return {
        title: 'Sign-in failed: the credentials did not match',
        code: code || 'auth_bad_credentials',
        severity: 'minor',
        source: 'auth',
        rootCause: /unknown account/i.test(clean)
          ? 'No active administrator account exists for that email address.'
          : 'The password did not match the bcrypt hash stored for that account.',
        why: 'The attempt is counted against the email and the client IP. After the configured threshold the account is locked for the login window, even for the correct password.',
        recommendation:
          'Check the email spelling and caps lock, then try again. An owner can reset a password from Admin Settings → Accounts. Failed attempts expire after DARKNOTE_LOGIN_WINDOW_MINUTES.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: 401,
        evidence: [firstLine(clean)],
      };
    }
    if (/too many failed|locked/i.test(clean)) {
      return {
        title: 'The account is temporarily locked after failed sign-ins',
        code: 'auth_locked',
        severity: 'moderate',
        source: 'auth',
        rootCause: 'The failed-attempt counter for this email/IP passed the configured threshold (DARKNOTE_LOGIN_MAX_ATTEMPTS).',
        why: 'Throttling prevents password guessing. Valid credentials are refused until the window expires.',
        recommendation: 'Wait for the login window (15 minutes by default), or have an owner reset the password. Check Admin Settings → security posture for the active thresholds.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: 429,
        evidence: [firstLine(clean)],
      };
    }
    if (ctx.status === 401 || /unauthenticated|session expired|not authenticated/i.test(clean)) {
      return {
        title: 'The session is missing or expired',
        code: 'unauthenticated',
        severity: 'minor',
        source: 'auth',
        rootCause: 'No valid dn_session cookie was presented, or the session passed its expiry / was revoked.',
        why: 'Every API route resolves the session first. Without one the request is refused and the UI returns to the sign-in page.',
        recommendation: 'Sign in again. If this happens repeatedly, check DARKNOTE_SESSION_HOURS and whether another tab signed out (which revokes the session).',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: 401,
        evidence: [firstLine(clean)],
      };
    }
  }

  // ---- Files / editor -----------------------------------------------------
  if (code === 'file_too_large' || status === 413) {
    return {
      title: 'The file exceeds the configured editor limit',
      code: 'file_too_large',
      severity: 'minor',
      source: 'editor',
      rootCause: 'The file is larger than the per-server editor limit or the process ceiling. DARKNOTE refuses rather than truncating.',
      why: 'Reading or writing a partial file would corrupt production, so the request is rejected with the real sizes.',
      recommendation: 'Raise the per-server limit in Admin Settings (it is clamped by DARKNOTE_MAX_EDITOR_BYTES), or edit the file over SFTP and re-scan.',
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: null, column: null, functionName: null,
      endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: 413,
      evidence: [firstLine(clean)],
    };
  }
  if (code === 'conflict' || status === 409) {
    return {
      title: 'The production file changed while you were editing',
      code: 'conflict',
      severity: 'moderate',
      source: 'editor',
      rootCause: 'The expected SHA-256 no longer matches the remote file, so the write was refused to avoid overwriting someone else\'s change.',
      why: 'Optimistic concurrency: editing against a stale hash would silently discard the newer content.',
      recommendation: 'Re-open the file (the editor reloads the current production bytes), merge your change, then deploy. Nothing was written by the blocked attempt.',
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: null, column: null, functionName: null,
      endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: 409,
      evidence: [firstLine(clean)],
    };
  }
  if (code === 'secret_blocked' || code === 'unsafe_path' || /protected path|path traversal/i.test(clean)) {
    return {
      title: 'The operation targeted a protected path',
      code: code || 'secret_blocked',
      severity: 'minor',
      source: ctx.input.source === 'editor' ? 'editor' : 'files',
      rootCause: 'The path resolved to a WhatsApp session, credential file, private key, or escaped the project root.',
      why: 'These files are excluded by policy. Reading or writing them could expose sessions or credentials, so the request is refused before any panel call.',
      recommendation: 'Choose a path inside the project that is not a session/credential file. If you truly need a protected file, use SFTP outside DARKNOTE and rotate credentials afterwards.',
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: null, column: null, functionName: null,
      endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: ctx.status,
      evidence: [firstLine(clean)],
    };
  }

  // ---- WebSocket / console -------------------------------------------------
  if (ctx.input.source === 'websocket' || /websocket|handshake|socket|console (not attached|reconnecting|gave up)/i.test(clean)) {
    return {
      title: 'The console websocket is not attached',
      code: code || 'CONSOLE_WEBSOCKET_DOWN',
      severity: 'moderate',
      source: 'websocket',
      rootCause: /gave up/i.test(clean)
        ? 'The socket exhausted its reconnect attempts. Each attempt failed before authentication completed.'
        : /token/i.test(clean)
          ? 'The short-lived panel websocket token expired; the socket was closed and a fresh token is required.'
          : 'The websocket handshake to the panel failed (network, proxy, or permission), so live console output is unavailable.',
      why: 'Without the socket the monitor cannot read console output, and the deployment health check has no evidence — it reports unknown rather than healthy.',
      recommendation: 'Check that the panel host is reachable and websocket.connect is granted, then open Terminal & Logs; the reconnect loop rebuilds the socket automatically. Fixing the network fixes monitoring and deployment verification together.',
      repairAuthority: 'safe',
      repairKind: 'reattach_console',
      filePath: null, line: null, column: null, functionName: null,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  // ---- Database ------------------------------------------------------------
  if (ctx.input.source === 'database' || /database|postgres|pglite|relation .* does not exist|password authentication failed/i.test(clean)) {
    return {
      title: 'The administration database is not usable',
      code: code || 'DATABASE_ERROR',
      severity: 'critical',
      source: 'database',
      rootCause: /relation .* does not exist/i.test(clean)
        ? 'The schema has not been applied to this database, or DATABASE_URL points at a different database than the one that was migrated.'
        : /password authentication failed|28p01/i.test(clean)
          ? 'The PostgreSQL credentials in DATABASE_URL were rejected.'
          : 'The connection to PostgreSQL failed or was interrupted.',
      why: 'Sessions, indexes, deployments and error history all live in this database. Without it the control center cannot authenticate or record anything.',
      recommendation: 'Verify DATABASE_URL and DATABASE_SSL, then run `npm run db:check` (it connects, applies the idempotent schema and prints the table count). On Neon, confirm the branch still exists and the pooled host is used.',
      repairAuthority: 'none',
      repairKind: null,
      filePath: null, line: null, column: null, functionName: null,
      endpoint: null, httpMethod: null, httpStatus: null,
      evidence: [firstLine(clean)],
    };
  }

  // ---- Frontend ------------------------------------------------------------
  if (ctx.input.source === 'frontend') {
    if (/chunkloaderror|loading chunk|failed to fetch dynamically imported module/i.test(clean)) {
      return {
        title: 'A page chunk failed to load after a new build',
        code: 'CHUNK_LOAD_ERROR',
        severity: 'minor',
        source: 'frontend',
        rootCause: 'The browser asked for a build asset that no longer exists because the app was redeployed while the tab was open.',
        why: 'Next.js chunk names change per build; the old tab keeps the old manifest.',
        recommendation: 'Reload the page. If it persists, hard-reload to clear the cached manifest.',
        repairAuthority: 'none',
        repairKind: null,
        filePath: null, line: null, column: null, functionName: null,
        endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: ctx.status,
        evidence: [firstLine(clean)],
      };
    }
    return {
      title: 'A browser-side exception was reported',
      code: code || 'FRONTEND_ERROR',
      severity: 'moderate',
      source: 'frontend',
      rootCause: ctx.filePath ? `An uncaught exception in the page bundle at ${ctx.filePath}${ctx.line ? `:${ctx.line}` : ''}.` : 'An uncaught exception in the browser bundle.',
      why: 'The component tree that threw stops rendering, so the affected panel disappears instead of showing data.',
      recommendation: 'Reload once to rule out a stale chunk. If it repeats, the stack frame above points at the component — check that API payload shape matches what the page expects.',
      repairAuthority: 'none',
      repairKind: null,
      filePath: ctx.filePath, line: ctx.line, column: ctx.column, functionName: ctx.functionName,
      endpoint: ctx.endpoint, httpMethod: ctx.method, httpStatus: ctx.status,
      evidence: [firstLine(clean)],
    };
  }

  return null;
}

/**
 * Diagnose one captured failure. A rule always wins; the fallback is explicit
 * about what is missing instead of pretending to know.
 */
export function diagnose(input: RawErrorInput, evidence: DiagnosisEvidence = {}): Diagnosis {
  const ctx = buildContext(input, evidence);
  const candidate = rules(ctx);

  if (candidate) {
    const evidenceLines = [...(input.evidence ?? []), ...(candidate.evidence ?? [])]
      .map((line) => stripAnsi(String(line)).trim())
      .filter(Boolean);
    return {
      title: candidate.title,
      code: candidate.code || input.code || 'UNCLASSIFIED',
      severity: candidate.severity,
      source: candidate.source,
      rootCause: candidate.rootCause,
      why: candidate.why,
      recommendation: candidate.recommendation,
      filePath: candidate.filePath ?? null,
      line: candidate.line ?? null,
      column: candidate.column ?? null,
      functionName: candidate.functionName ?? null,
      endpoint: candidate.endpoint ?? null,
      httpMethod: candidate.httpMethod ?? null,
      httpStatus: candidate.httpStatus ?? null,
      repairAuthority: candidate.repairAuthority,
      repairKind: candidate.repairKind,
      evidence: [...new Set(evidenceLines)].slice(0, 12),
    };
  }

  const known = [
    input.code ? `code=${input.code}` : null,
    ctx.status ? `http=${ctx.status}` : null,
    ctx.filePath ? `file=${ctx.filePath}${ctx.line ? `:${ctx.line}` : ''}` : null,
  ].filter(Boolean);

  return {
    title: `${SOURCE_TITLES[input.source]} reported an unclassified failure`,
    code: input.code || 'UNCLASSIFIED',
    severity: severityFor(input.source, ctx.status),
    source: input.source,
    rootCause: `The message did not match any known signature. Captured facts: ${known.length ? known.join(', ') : 'none beyond the message'}.`,
    why: 'DARKNOTE records what the component actually printed. Without a matching signature it will not invent a cause — the raw message and the component above are the reliable evidence.',
    recommendation:
      'Open the source component named above and compare the message with its logs. If this repeats, add the signature to the Error Intelligence rules so the next occurrence is explained automatically.',
    filePath: ctx.filePath,
    line: ctx.line,
    column: ctx.column,
    functionName: ctx.functionName,
    endpoint: ctx.endpoint,
    httpMethod: ctx.method,
    httpStatus: ctx.status,
    repairAuthority: 'none',
    repairKind: null,
    evidence: [...new Set([...(input.evidence ?? []), firstLine(ctx.clean)])].slice(0, 12),
  };
}

export function fingerprintFor(input: RawErrorInput, diagnosis: Diagnosis): string {
  return [
    input.source,
    diagnosis.code,
    diagnosis.filePath ?? '',
    normalizeForFingerprint(input.message ?? ''),
  ].join('|');
}
