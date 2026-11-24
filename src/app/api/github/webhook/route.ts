import { NextResponse } from 'next/server';
import { publicRoute } from '@/lib/api';
import { findProjectByRepo } from '@/lib/projects/repo';
import { pullRemoteChanges } from '@/lib/github/pull';
import {
  claimDelivery,
  finishDelivery,
  parsePushEvent,
  readWebhookSecret,
  verifyWebhookSignature,
} from '@/lib/github/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub → DARKNOTE push notification.
 *
 * This endpoint is public by necessity; the HMAC signature is the authentication.
 * The verified payload is the only source of truth for repository, branch and
 * commit, so a forged body cannot point the engine at another project.
 *
 * A 2xx means "received and accounted for" — including deliveries we chose to
 * ignore — so GitHub does not retry them. Only a transient failure returns 5xx,
 * which is exactly when a retry is useful.
 */
export const POST = publicRoute(async (req) => {
  const secret = await readWebhookSecret();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'The webhook secret is not configured. Register the webhook from Admin Settings → GitHub.' },
      { status: 503 },
    );
  }

  const raw = await req.text();
  const signature = req.headers.get('x-hub-signature-256');
  if (!verifyWebhookSignature(raw, signature, secret)) {
    return NextResponse.json({ ok: false, error: 'Invalid signature.' }, { status: 401 });
  }

  const event = req.headers.get('x-github-event') ?? 'unknown';
  const deliveryId = req.headers.get('x-github-delivery');
  if (!deliveryId) {
    // GitHub always sends it; without it we cannot de-duplicate retries.
    return NextResponse.json({ ok: false, error: 'Missing X-GitHub-Delivery.' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: 'Body is not JSON.' }, { status: 400 });
  }

  const push = parsePushEvent(event, payload, deliveryId);

  if (!push) {
    await claimDelivery({ deliveryId, event });
    await finishDelivery(deliveryId, 'ignored', 'Not a branch push.');
    return NextResponse.json({ ok: true, ignored: true, reason: 'not_a_branch_push' });
  }

  const project = await findProjectByRepo(push.owner, push.repo, push.branch);
  const claimed = await claimDelivery({
    deliveryId,
    event,
    push,
    projectId: project?.id ?? null,
  });

  if (!claimed) {
    // A retried delivery: the first attempt already did the work.
    await finishDelivery(deliveryId, 'duplicated');
    return NextResponse.json({ ok: true, duplicate: true });
  }

  if (!project) {
    await finishDelivery(deliveryId, 'ignored', `No project is connected to ${push.repoFullName}@${push.branch}.`);
    return NextResponse.json({ ok: true, ignored: true, reason: 'no_project_for_repository' });
  }

  try {
    const outcome = await pullRemoteChanges(project.id, {
      trigger: 'webhook',
      headSha: push.commitSha,
    });
    await finishDelivery(deliveryId, outcome.conflicts.length ? 'conflict' : 'applied', outcome.detail);
    return NextResponse.json(
      {
        ok: true,
        projectId: project.id,
        commit: outcome.toCommit,
        applied: outcome.applied,
        deleted: outcome.deleted,
        conflicts: outcome.conflicts.map((conflict) => conflict.path),
        unchanged: outcome.unchanged,
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishDelivery(deliveryId, 'failed', message);
    // 502 makes GitHub retry the delivery, which is what we want for a
    // transient failure (GitHub API hiccup, database restart).
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
});
