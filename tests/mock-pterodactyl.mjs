/**
 * Minimal Pterodactyl Client API double.
 *
 * It implements the endpoints this application actually calls, against an
 * in-memory filesystem, so the real service code can be exercised end to end
 * without touching a live panel. It is a test harness — not a substitute for
 * verifying against your panel.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const now = () => new Date().toISOString();

export function createMockPanel({ apiKey = 'test-key', identifier = 'abc12345', seed = {} } = {}) {
  /** @type {Map<string, {content: Buffer, mtime: string}>} */
  const files = new Map();
  const directories = new Set(['/']);
  const signed = new Map();
  const powers = [];
  const writes = [];
  /** Files whose `/files/contents` answers 200 with an empty body (the reported bug). */
  const emptyBodies = new Set();
  /** Every request the client made, so tests can prove the verb and the path. */
  const calls = [];
  /** Mirrors the real panel: the container state follows the last power signal. */
  let containerState = 'running';
  /** Lines Wings would relay to an authenticated console socket. */
  const consoleHistory = ['DARKNOTE L2 starting', 'Loaded 12 plugins', 'Connected to WhatsApp'];
  const consoleSockets = new Set();
  let wsConnections = 0;

  const put = (path, text) => {
    if (!path.startsWith('/')) path = `/${path}`;
    files.set(path, { content: Buffer.from(text, 'utf8'), mtime: now() });
    const parts = path.split('/').filter(Boolean);
    let cursor = '';
    for (const part of parts.slice(0, -1)) {
      cursor += `/${part}`;
      directories.add(cursor);
    }
  };
  const mkdir = (path) => {
    if (!path.startsWith('/')) path = `/${path}`;
    directories.add(path);
    const parts = path.split('/').filter(Boolean);
    let cursor = '';
    for (const part of parts) {
      cursor += `/${part}`;
      directories.add(cursor);
    }
  };

  const defaults = {
    '/BIGBRO.js': [
      '#!/usr/bin/env node',
      "'use strict';",
      'async function handleMessage(conn, m) {',
      '  const command = m.text.split(" ")[0].slice(1);',
      '  switch (command) {',
      "    case 'menu': {",
      '      await m.reply("menu");',
      '      break;',
      '    }',
      "    case 'ping': {",
      '      await m.reply("pong");',
      '      break;',
      '    }',
      "    case 'play': {",
      '      await m.reply("playing");',
      '      break;',
      '    }',
      '    default:',
      '      break;',
      '  }',
      '}',
      'module.exports = { handleMessage };',
      '',
    ].join('\n'),
    '/index.js': "const { handleMessage } = require('./BIGBRO');\nconsole.log('DARKNOTE L2 starting');\n",
    '/package.json': JSON.stringify({ name: 'base-bot-wa', version: '1.0.0', main: 'index.js' }, null, 2),
    '/config.json': JSON.stringify({ botName: 'DARKNOTE L2', prefix: '.', ownerNumber: '254107287140' }, null, 2),
    '/lib/msg.js': "module.exports = { smsg: (m) => m };\n",
    '/database/owner.json': '{"owners":[]}\n',
    '/auth/creds.json': '{"secret":"should-never-be-read"}\n',
    '/.env': 'API_KEY=should-never-be-read\n',
    ...seed,
  };
  for (const [path, text] of Object.entries(defaults)) put(path, text);
  mkdir('/lib');
  mkdir('/database');
  mkdir('/auth');

  const list = (directory) => {
    const dir = directory.replace(/\/$/, '') || '/';
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names = new Set();
    for (const path of files.keys()) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (rest && !rest.includes('/')) names.add(rest);
      }
    }
    for (const path of directories) {
      if (path !== dir && path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (rest && !rest.includes('/')) names.add(rest);
      }
    }
    return [...names].sort().map((name) => {
      const full = `${prefix}${name}`.replace('//', '/');
      const file = files.get(full);
      const isDir = !file;
      return {
        name,
        mode: isDir ? 'drwxr-xr-x' : '-rw-r--r--',
        mode_bits: '644',
        size: file ? file.content.byteLength : 0,
        is_file: !isDir,
        is_symlink: false,
        mimetype: isDir ? 'inode/directory' : 'text/plain',
        created_at: file?.mtime ?? now(),
        modified_at: file?.mtime ?? now(),
      };
    });
  };

  const wss = new WebSocketServer({ noServer: true });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const unauthorized = () => send(401, { errors: [{ detail: 'Unauthenticated' }] });
    // A real panel answers a wrong verb with 405 and never runs the action. The
    // mock must do the same, otherwise a GET/PUT power call would look fine here
    // and fail in production.
    const methodNotAllowed = (allowed) =>
      send(405, { errors: [{ code: 'MethodNotAllowedHttpException', detail: `Method ${req.method} is not allowed; use ${allowed.join(' or ')}.` }] });
    const notFound = () => send(404, { errors: [{ detail: 'Not found' }] });
    const noContent = () => send(204, '');

    if (url.pathname.startsWith('/signed/')) {
      const token = url.pathname.slice('/signed/'.length);
      const target = signed.get(token);
      if (!target) return notFound();
      return send(200, target.content, 'application/octet-stream');
    }

    if (url.pathname.startsWith('/upload/')) {
      const token = url.pathname.slice('/upload/'.length);
      const directory = signed.get(token)?.directory;
      if (!directory) return notFound();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const text = raw.toString('latin1');
      const match = /name="files"; filename="([^"]+)"\r?\n(?:[^\r\n]*\r?\n)?\r?\n/.exec(text);
      if (!match) return send(422, { errors: [{ detail: 'No file part' }] });
      const name = match[1];
      const start = match.index + match[0].length;
      const boundary = text.lastIndexOf('\r\n--');
      const body = raw.subarray(start, boundary === -1 ? raw.length : boundary);
      put(`${directory.replace(/\/$/, '')}/${name}`, body.toString('utf8'));
      writes.push({ path: `${directory}/${name}`, bytes: body.byteLength });
      return noContent();
    }

    if (!url.pathname.startsWith('/api/client')) return notFound();
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${apiKey}`) return unauthorized();

    const rest = url.pathname.slice('/api/client'.length) || '/';
    if (rest === '/' || rest === '') return send(200, { name: 'Mock Pterodactyl', meta: { version: '1.11.0' } });
    if (rest === '/account') {
      return send(200, { attributes: { id: 1, email: 'admin@example.com', username: 'admin', root_admin: true } });
    }
    if (rest === '/permissions') {
      return send(200, {
        control: ['console', 'start', 'stop', 'restart'],
        file: ['read', 'write', 'create', 'delete', 'rename', 'compress', 'decompress', 'upload', 'download'],
        websocket: ['connect'],
        backup: ['read', 'create', 'download'],
        startup: ['read'],
        user: ['read'],
      });
    }
    if (!rest.startsWith('/servers/')) return notFound();
    const trimmed = rest.slice('/servers/'.length);
    const [serverId, ...tailParts] = trimmed.split('/');
    if (serverId !== identifier) return notFound();
    const tail = `/${tailParts.join('/')}`.replace(/\/$/, '') || '';

    calls.push({ method: req.method, path: url.pathname, search: url.search });

    const filesOp = tail.startsWith('/files') ? tail.slice('/files'.length) : null;
    const allowedMethods =
      tail === ''
        ? ['GET']
        : tail === '/backups'
          ? ['GET', 'POST']
          : ['/resources', '/startup', '/activity', '/websocket'].includes(tail)
            ? ['GET']
            : ['/power', '/command'].includes(tail)
              ? ['POST']
              : filesOp === '/list' || filesOp === '/contents' || filesOp === '/download' || filesOp === '/upload'
                ? ['GET']
                : ['/write', '/delete', '/create-folder', '/copy', '/compress', '/decompress'].includes(filesOp)
                  ? ['POST']
                  : filesOp === '/rename' || filesOp === '/chmod'
                    ? ['PUT']
                    : null;
    if (allowedMethods && !allowedMethods.includes(req.method)) {
      return methodNotAllowed(allowedMethods);
    }

    if (tail === '') {
      return send(200, {
        attributes: {
          identifier,
          name: 'Darknote L2',
          node: 'node-01',
          status: null,
          is_suspended: false,
          limits: { memory: 1024, swap: 0, disk: 4096, io: 500, cpu: 100 },
          sftp_details: { ip: '127.0.0.1', port: 2022, username: `user.${identifier}` },
        },
      });
    }
    if (tail === '/resources') {
      return send(200, {
        current_state: containerState,
        is_suspended: false,
        resources: {
          memory_bytes: 268435456,
          memory_limit_bytes: 1073741824,
          cpu_absolute: 12.5,
          disk_bytes: 52428800,
          network_rx_bytes: 1000,
          network_tx_bytes: 2000,
          uptime: 3_600_000,
        },
      });
    }
    if (tail === '/startup') {
      return send(200, { attributes: { current_startup_command: 'node index.js', docker_image: 'node:20' } });
    }
    if (tail === '/activity') return send(200, { data: [] });
    if (tail === '/websocket') {
      return send(200, {
        data: { token: 'ws-token', socket: `ws://127.0.0.1:${port}/api/client/servers/${identifier}/websocket` },
      });
    }
    if (tail === '/power') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      powers.push({ ...payload, method: req.method, path: url.pathname });
      if (payload.signal === 'stop' || payload.signal === 'kill') containerState = 'offline';
      else containerState = 'running';
      return noContent();
    }
    if (tail === '/command') return noContent();
    if (tail === '/backups') return send(200, { data: [] });

    if (tail.startsWith('/files')) {
      const op = tail.slice('/files'.length);
      if (op === '/list') {
        return send(200, { data: list(url.searchParams.get('directory') ?? '/').map((attributes) => ({ attributes })) });
      }
      if (op === '/contents') {
        const requested = url.searchParams.get('file');
        const file = files.get(requested);
        if (!file) return notFound();
        // A real panel does this when the subuser lost file.read, or when a proxy
        // drops the body: 200, no bytes, but the directory listing still shows the
        // file's size.
        if (emptyBodies.has(requested)) return send(200, '', 'text/plain');
        return send(200, file.content, 'text/plain');
      }
      if (op === '/write') {
        const target = url.searchParams.get('file');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        put(target, Buffer.concat(chunks).toString('utf8'));
        writes.push({ path: target, bytes: Buffer.concat(chunks).byteLength });
        return noContent();
      }
      if (op === '/download') {
        const file = files.get(url.searchParams.get('file'));
        if (!file) return notFound();
        const token = randomUUID();
        signed.set(token, { content: file.content });
        return send(200, { attributes: { url: `http://127.0.0.1:${port}/signed/${token}` } });
      }
      if (op === '/upload') {
        const token = randomUUID();
        signed.set(token, { directory: url.searchParams.get('directory') ?? '/' });
        return send(200, { attributes: { url: `http://127.0.0.1:${port}/upload/${token}` } });
      }
      if (op === '/delete' || op === '/create-folder' || op === '/rename' || op === '/copy' || op === '/chmod') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (op === '/delete') {
          for (const name of payload.files ?? []) files.delete(`${payload.root.replace(/\/$/, '')}/${name}`.replace('//', '/'));
        }
        if (op === '/create-folder') mkdir(`${payload.root.replace(/\/$/, '')}/${payload.name}`);
        if (op === '/rename') {
          // Pterodactyl resolves from/to relative to `root` unless already absolute.
          const root = String(payload.root ?? '/').replace(/\/$/, '');
          const resolve = (value) => {
            const raw = String(value);
            return raw.startsWith('/') ? raw : `${root}/${raw}`.replace('//', '/');
          };
          for (const entry of payload.files ?? []) {
            const from = resolve(entry.from);
            const to = resolve(entry.to);
            const file = files.get(from);
            if (file) {
              files.delete(from);
              files.set(to, file);
            }
          }
        }
        return noContent();
      }
      if (op === '/compress' || op === '/decompress') return noContent();
    }

    return notFound();
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.endsWith('/websocket')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wsConnections += 1;
      consoleSockets.add(ws);
      ws.on('error', () => undefined);
      ws.on('close', () => consoleSockets.delete(ws));
      ws.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (message.event === 'auth') {
          // Wings rejects a bad JWT with `jwt error` and closes the socket.
          if (message.args?.[0] !== 'ws-token') {
            ws.send(JSON.stringify({ event: 'jwt error', args: ['invalid token'] }));
            ws.close();
            return;
          }
          ws.send(JSON.stringify({ event: 'auth success', args: [null] }));
          ws.send(JSON.stringify({ event: 'status', args: [containerState] }));
          return;
        }
        if (message.event === 'send logs') {
          for (const line of consoleHistory) {
            ws.send(JSON.stringify({ event: 'console output', args: [line] }));
          }
          return;
        }
        if (message.event === 'send stats') {
          ws.send(JSON.stringify({ event: 'status', args: [containerState] }));
        }
      });
    });
  });

  let port = 0;
  return {
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    get identifier() {
      return identifier;
    },
    get apiKey() {
      return apiKey;
    },
    powers,
    writes,
    calls,
    get containerState() {
      return containerState;
    },
    get wsConnections() {
      return wsConnections;
    },
    /** Push a line to every attached console, as the container's stdout would. */
    emitConsole(line) {
      consoleHistory.push(line);
      for (const ws of consoleSockets) {
        try {
          ws.send(JSON.stringify({ event: 'console output', args: [line] }));
        } catch {
          /* socket already closed */
        }
      }
    },
    setContainerState(state) {
      containerState = state;
    },
    files,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
      return this;
    },
    async stop() {
      for (const ws of consoleSockets) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
      consoleSockets.clear();
      await new Promise((resolve) => wss.close(() => resolve(undefined)));
      await new Promise((resolve) => server.close(resolve));
    },
    /** Signals received, with the verb and path that carried them. */
    powersFor(signal) {
      return powers.filter((entry) => entry.signal === signal);
    },
    /** Change a file behind the application's back, as an admin would in the panel. */
    externalEdit(path, text) {
      put(path, text);
    },
    read(path) {
      return files.get(path)?.content.toString('utf8') ?? null;
    },
    /** Make `/files/contents` return an empty 200 body for this path. */
    breakBody(path, broken = true) {
      if (broken) emptyBodies.add(path);
      else emptyBodies.delete(path);
    },
  };
}
