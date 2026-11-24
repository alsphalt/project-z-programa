import { z } from 'zod';
import { route, ok } from '@/lib/api';
import { assertServerAccess, serverClient, setConnectionState, testConnection } from '@/lib/servers/repo';
import { logActivity } from '@/lib/audit';
import { randomToken } from '@/lib/crypto';
import { joinRemote } from '@/lib/security/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface Params extends Record<string, string> {
  id: string;
}

interface Capability {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string;
}

const bodySchema = z.object({ deep: z.boolean().optional() }).default({});

/**
 * Capability probe.
 *
 * Each check performs the real operation it claims to test. The write check is
 * the only one that touches the filesystem, it is off by default, it writes a
 * single scratch file inside the project root and removes it immediately.
 */
export const POST = route<Params>({ permission: 'file.read' }, async ({ user, params, body, req }) => {
  const server = await assertServerAccess(user, params.id, 'file.read');
  let deep = true;
  try {
    const parsed = bodySchema.parse(await req.json());
    deep = parsed.deep ?? true;
  } catch {
    deep = true;
  }
  void body;

  const base = await testConnection(server);
  const capabilities: Capability[] = [
    {
      key: 'auth',
      label: 'Client API authentication',
      ok: base.ok,
      detail: base.ok
        ? `Authenticated as ${base.account?.username ?? 'panel user'}${base.account?.rootAdmin ? ' (root admin)' : ''} in ${base.latencyMs} ms`
        : (base.error ?? 'Authentication failed'),
    },
    {
      key: 'server',
      label: 'Server identification',
      ok: Boolean(base.server),
      detail: base.server
        ? `${base.server.name} (${base.server.identifier}) — state ${base.server.state}${base.server.suspended ? ', suspended' : ''}`
        : 'The server identifier was not resolved by the panel.',
    },
  ];

  if (base.ok) {
    const client = await serverClient(server);

    try {
      const entries = await client.listFiles(server.projectRoot);
      capabilities.push({
        key: 'files.list',
        label: 'File listing',
        ok: true,
        detail: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} listed in ${server.projectRoot}`,
      });
    } catch (error) {
      capabilities.push({
        key: 'files.list',
        label: 'File listing',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const entries = await client.listFiles(server.projectRoot);
      const candidate = entries.find((entry) => entry.is_file && Number(entry.size) < 512 * 1024);
      if (!candidate) throw new Error('No readable file smaller than 512 KB in the project root');
      const content = await client.readFile(joinRemote(server.projectRoot, candidate.name), 1024 * 1024);
      capabilities.push({
        key: 'files.read',
        label: 'File reading',
        ok: true,
        detail: `Read ${candidate.name} (${content.length} chars)`,
      });
    } catch (error) {
      capabilities.push({
        key: 'files.read',
        label: 'File reading',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (deep) {
      const probe = joinRemote(server.projectRoot, `.darknote-write-test-${randomToken(4).replace(/[^a-zA-Z0-9]/g, '')}.tmp`);
      try {
        const payload = `darknote write probe ${new Date().toISOString()}`;
        await client.writeFile(probe, payload);
        const readBack = await client.readFile(probe, 64 * 1024);
        await client.deleteFiles(server.projectRoot, [probe.split('/').pop()!]);
        capabilities.push({
          key: 'files.write',
          label: 'File writing (verified)',
          ok: readBack === payload,
          detail:
            readBack === payload
              ? 'Wrote a scratch file, read it back byte-for-byte and deleted it.'
              : 'The panel accepted the write but the content read back differs.',
        });
      } catch (error) {
        capabilities.push({
          key: 'files.write',
          label: 'File writing (verified)',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      capabilities.push({
        key: 'files.write',
        label: 'File writing',
        ok: null,
        detail: 'Skipped — run the deep test to write a scratch file.',
      });
    }

    try {
      const credentials = await client.getWebsocketCredentials();
      capabilities.push({
        key: 'console',
        label: 'Console access',
        ok: Boolean(credentials?.token && credentials?.socket),
        detail: credentials?.token
          ? `Websocket credentials issued for ${credentials.socket}`
          : 'The panel did not return websocket credentials.',
      });
    } catch (error) {
      capabilities.push({
        key: 'console',
        label: 'Console access',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const permissions = base.permissions ?? {};
    const control = permissions.control ?? permissions['control.console'];
    capabilities.push({
      key: 'restart',
      label: 'Restart permission',
      ok: Array.isArray(control) ? control.includes('restart') || control.includes('start') : null,
      detail: Array.isArray(control)
        ? control.includes('restart')
          ? 'The key may restart the server.'
          : `The key exposes only: ${control.join(', ') || 'nothing'}. Restart will be refused by the panel.`
        : 'The panel did not expose a permission map for this key; restart permission is unknown until used.',
    });
  }

  await setConnectionState(server.id, base.ok ? 'connected' : 'failed', base.ok ? null : (base.error ?? null), {
    connectedNow: base.ok,
  });
  await logActivity({
    user,
    serverId: server.id,
    action: 'server.connection_test',
    target: server.name,
    severity: base.ok ? 'info' : 'warning',
    detail: { ok: base.ok, latencyMs: base.latencyMs, deep, error: base.error ?? null },
  });

  return ok({
    ok: base.ok,
    latencyMs: base.latencyMs,
    panel: base.panel,
    account: base.account,
    server: base.server,
    error: base.error ?? null,
    capabilities,
  });
});
