import { ApiError, ok, route } from '@/lib/api';
import { getConnectionView, requireClient } from '@/lib/github/credentials';
import { WEBHOOK_PATH, ensureWebhookSecret } from '@/lib/github/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Registers (or repairs) the push webhook on the connected repository.
 *
 * The signing secret is generated here, stored encrypted, and sent to GitHub as
 * part of the hook configuration — it is never returned to the browser, so the
 * panel cannot leak it. Re-running this is safe: an existing DARKNOTE hook is
 * updated in place instead of piling up duplicates.
 */
export const POST = route({ permission: 'settings.manage' }, async ({ req }) => {
  const connection = await getConnectionView();
  const owner = connection.repository?.owner;
  const repo = connection.repository?.name;
  if (!connection.connected || !owner || !repo) {
    throw new ApiError('Connect a GitHub repository first.', 424, 'github_not_connected');
  }

  const client = await requireClient();
  const secret = await ensureWebhookSecret();

  // Behind a proxy the request URL can be the internal origin; prefer the
  // configured public base when it exists.
  const configuredBase = process.env.DARKNOTE_PUBLIC_URL?.replace(/\/+$/, '');
  const requestOrigin = new URL(req.url);
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const forwardedHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const origin =
    configuredBase ||
    (forwardedHost
      ? `${forwardedProto ?? requestOrigin.protocol.replace(':', '')}://${forwardedHost}`
      : requestOrigin.origin);
  const url = `${origin}${WEBHOOK_PATH}`;

  if (!url.startsWith('https://') && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
    throw new ApiError(
      `GitHub requires a public HTTPS endpoint. The detected URL is ${url} — set DARKNOTE_PUBLIC_URL to the deployment URL and try again.`,
      400,
      'webhook_needs_https',
    );
  }

  const hooks = await client.listHooks(owner, repo);
  const existing = hooks.find((hook) => (hook.config?.url ?? '').includes(WEBHOOK_PATH));

  const hook = existing
    ? await client.updateHook(owner, repo, existing.id, { url, secret, events: ['push'] })
    : await client.createHook(owner, repo, { url, secret, events: ['push'] });

  return ok({
    registered: true,
    hookId: hook.id,
    url,
    events: ['push'],
    updated: Boolean(existing),
    // The secret itself stays server-side; this only proves one is stored.
    secretConfigured: true,
  });
});
