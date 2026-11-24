import { z } from 'zod';
import { ApiError, ok, route } from '@/lib/api';
import {
  clearCredentials,
  clearRepositoryConfig,
  getConnectionView,
  requireClient,
  saveOAuthApp,
  saveRepositoryConfig,
  saveSyncConfig,
  saveToken,
} from '@/lib/github/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub connection configuration.
 *
 * Reads never include the token — only the encrypted-storage hint. Writes are
 * restricted to `settings.manage`, and a token is verified against GitHub before
 * it is stored.
 */

export const GET = route({ permission: 'file.read' }, async () => {
  const connection = await getConnectionView();
  return ok({
    connection,
    oauthCallbackPath: '/api/github/oauth/callback',
    note: 'The token is stored encrypted on the server and is never returned by any route.',
  });
});

const putSchema = z.object({
  oauthApp: z
    .object({
      clientId: z.string().trim().min(4).max(120),
      clientSecret: z.string().trim().min(8).max(200).optional(),
    })
    .optional(),
  token: z.string().trim().min(8).max(400).optional(),
  clearToken: z.boolean().optional(),
  repository: z
    .object({
      owner: z.string().trim().min(1).max(120),
      name: z.string().trim().min(1).max(120),
      branch: z.string().trim().max(200).optional(),
    })
    .nullable()
    .optional(),
  clearRepository: z.boolean().optional(),
  autoSync: z.boolean().optional(),
  syncDelaySeconds: z.number().int().min(2).max(120).optional(),
});

export const PUT = route({ permission: 'settings.manage' }, async ({ user, body }) => {
  const input = await body(putSchema);
  let view = await getConnectionView();

  if (input.oauthApp) {
    view = await saveOAuthApp({
      clientId: input.oauthApp.clientId,
      clientSecret: input.oauthApp.clientSecret,
      userId: user.id,
    });
  }

  if (input.token) {
    view = await saveToken({ token: input.token, userId: user.id });
  }

  if (input.clearToken) {
    view = await clearCredentials();
  }

  if (input.repository) {
    // The repository is verified with the stored token, so "configured" always
    // means "the panel could actually read it".
    const client = await requireClient();
    let repository;
    try {
      repository = await client.getRepository(input.repository.owner, input.repository.name);
    } catch (error) {
      throw new ApiError(
        `That repository is not accessible with the connected token: ${error instanceof Error ? error.message : String(error)}`,
        400,
        'repository_unreachable',
      );
    }
    view = await saveRepositoryConfig({
      owner: repository.owner?.login ?? input.repository.owner,
      name: repository.name,
      branch: input.repository.branch || repository.default_branch,
      verifiedDefaultBranch: repository.default_branch,
      userId: user.id,
    });
  }

  if (input.clearRepository) {
    view = await clearRepositoryConfig();
  }

  if (input.autoSync !== undefined || input.syncDelaySeconds !== undefined) {
    view = await saveSyncConfig({
      autoSync: input.autoSync,
      delaySeconds: input.syncDelaySeconds,
      userId: user.id,
    });
  }

  return ok({ connection: view });
});

export const DELETE = route({ permission: 'settings.manage' }, async ({ req }) => {
  const target = new URL(req.url).searchParams.get('target') ?? 'token';
  if (target === 'repository') {
    return ok({ connection: await clearRepositoryConfig(), removed: 'repository' });
  }
  if (target === 'token' || target === 'all') {
    const view = await clearCredentials();
    return ok({ connection: view, removed: 'credentials' });
  }
  throw new ApiError('Unknown target — use token or repository.', 400, 'bad_target');
});
