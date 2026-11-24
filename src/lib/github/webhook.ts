import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { jsonb, query, queryOne } from '../db';
import { decryptSecret, encryptSecret, randomToken } from '../crypto';

/**
 * GitHub webhook handling.
 *
 * A webhook is unauthenticated by nature, so the signature is the only proof
 * that a delivery really came from GitHub. Everything else — repository, branch,
 * commit — is read from the *verified* payload, never from the query string.
 *
 * Deliveries are recorded by their `X-GitHub-Delivery` id before any work runs.
 * GitHub retries deliveries, and a retry must not replay a pull that already
 * applied, so a duplicate id is rejected instead of processed twice.
 */

export const WEBHOOK_SECRET_KEY = 'github_webhook_secret';
export const WEBHOOK_PATH = '/api/github/webhook';

/** Constant-time comparison of the `sha256=…` signature GitHub sends. */
export function verifyWebhookSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  const given = header.trim();
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/** Creates the signing secret once and returns it; the caller shows it to GitHub only. */
export async function ensureWebhookSecret(): Promise<string> {
  const existing = await queryOne<{ value: unknown }>(
    `select value from platform_settings where key = $1`,
    [WEBHOOK_SECRET_KEY],
  );
  const stored = existing?.value as { secret?: string } | undefined;
  if (stored?.secret) {
    try {
      return decryptSecret(stored.secret);
    } catch {
      // An unreadable secret (rotated DARKNOTE_SECRET) is replaced, not ignored:
      // a webhook that can never verify is worse than a re-registration.
    }
  }
  const secret = randomToken(32);
  await query(
    `insert into platform_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [WEBHOOK_SECRET_KEY, jsonb({ secret: encryptSecret(secret) })],
  );
  return secret;
}

export async function readWebhookSecret(): Promise<string | null> {
  const envSecret = process.env.DARKNOTE_GITHUB_WEBHOOK_SECRET;
  if (envSecret && envSecret.length >= 16) return envSecret;
  const row = await queryOne<{ value: unknown }>(
    `select value from platform_settings where key = $1`,
    [WEBHOOK_SECRET_KEY],
  );
  const stored = row?.value as { secret?: string } | undefined;
  if (!stored?.secret) return null;
  try {
    return decryptSecret(stored.secret);
  } catch {
    return null;
  }
}

export interface PushEvent {
  deliveryId: string;
  event: string;
  repoFullName: string;
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  commitMessage: string | null;
}

/**
 * Extracts what the sync engine needs from a `push` payload.
 * Returns null for events that are not a branch push (tag pushes, deletes of
 * non-branch refs, other event types) so the caller can record them as ignored.
 */
export function parsePushEvent(event: string, payload: unknown, deliveryId: string): PushEvent | null {
  if (event !== 'push') return null;
  const body = payload as {
    ref?: string;
    after?: string;
    deleted?: boolean;
    repository?: { full_name?: string; name?: string; owner?: { login?: string; name?: string } };
    head_commit?: { message?: string } | null;
  };
  if (!body || body.deleted) return null;
  const ref = body.ref ?? '';
  if (!ref.startsWith('refs/heads/')) return null;
  const commitSha = body.after ?? '';
  // All-zero SHA means the branch was deleted.
  if (!commitSha || /^0+$/.test(commitSha)) return null;

  const fullName = body.repository?.full_name ?? '';
  const [ownerFromName, repoFromName] = fullName.split('/');
  const owner = body.repository?.owner?.login ?? body.repository?.owner?.name ?? ownerFromName ?? '';
  const repo = body.repository?.name ?? repoFromName ?? '';
  if (!owner || !repo) return null;

  return {
    deliveryId,
    event,
    repoFullName: fullName || `${owner}/${repo}`,
    owner,
    repo,
    branch: ref.slice('refs/heads/'.length),
    commitSha,
    commitMessage: body.head_commit?.message?.split('\n')[0] ?? null,
  };
}

export type DeliveryStatus = 'received' | 'ignored' | 'duplicated' | 'applied' | 'conflict' | 'failed';

/**
 * Claims a delivery id. Returns false when it was already seen, which is the
 * signal to answer 200 without doing the work again (GitHub retries deliveries).
 */
export async function claimDelivery(options: {
  deliveryId: string;
  event: string;
  action?: string | null;
  push?: PushEvent | null;
  projectId?: string | null;
}): Promise<boolean> {
  const inserted = await query<{ id: string }>(
    `insert into github_webhook_deliveries
       (id, event, action, repo_full_name, branch, commit_sha, project_id, status)
     values ($1,$2,$3,$4,$5,$6,$7,'received')
     on conflict (id) do nothing
     returning id`,
    [
      options.deliveryId,
      options.event,
      options.action ?? null,
      options.push?.repoFullName ?? null,
      options.push?.branch ?? null,
      options.push?.commitSha ?? null,
      options.projectId ?? null,
    ],
  );
  return inserted.length > 0;
}

export async function finishDelivery(
  deliveryId: string,
  status: DeliveryStatus,
  message?: string | null,
): Promise<void> {
  await query(
    `update github_webhook_deliveries
        set status = $2, message = $3, processed_at = now()
      where id = $1`,
    [deliveryId, status, message ?? null],
  );
}

/** Recent deliveries, newest first — shown in the sync status panel. */
export async function recentDeliveries(limit = 10) {
  const capped = Math.min(Math.max(limit, 1), 50);
  return query<{
    id: string;
    event: string;
    repo_full_name: string | null;
    branch: string | null;
    commit_sha: string | null;
    status: string;
    message: string | null;
    received_at: string;
    processed_at: string | null;
  }>(
    `select id, event, repo_full_name, branch, commit_sha, status, message, received_at, processed_at
       from github_webhook_deliveries
      order by received_at desc
      limit $1`,
    [capped],
  );
}
