import { z } from 'zod';
import { ApiError, ok, rateLimit, route } from '@/lib/api';
import { assertServerAccess, getServer } from '@/lib/servers/repo';
import { answer } from '@/lib/bigbrother/engine';
import {
  appendMessage,
  createConversation,
  logUsage,
  requireConversation,
  setMemory,
} from '@/lib/bigbrother/memory';
import { listAssets } from '@/lib/bigbrother/assets';
import { recordError } from '@/lib/errors/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  question: z.string().min(1).max(4000),
  conversationId: z.string().max(80).optional(),
  serverId: z.string().max(120).optional().nullable(),
  imageAssetIds: z.array(z.string().max(80)).max(4).optional(),
});

/**
 * One assistant turn.
 *
 * Ownership is enforced twice: the conversation must belong to the caller, and a
 * server id is only accepted when the caller has access to that server. The
 * answer is composed from real tools before it is stored.
 */
export const POST = route({ permission: null }, async ({ body, user }) => {
  const input = await body(schema);
  rateLimit(`bigbrother:${user.id}`, 20, 60_000);

  const question = input.question.trim();
  if (!question) throw new ApiError('Ask a question first.', 400, 'empty_question');

  let server = null;
  if (input.serverId) {
    server = await assertServerAccess(user, input.serverId, 'console.read');
  } else if (input.conversationId) {
    const conversation = await requireConversation(user.id, input.conversationId);
    if (conversation.serverId) server = await getServer(conversation.serverId);
  }

  const conversation = input.conversationId
    ? await requireConversation(user.id, input.conversationId)
    : await createConversation(user.id, { serverId: server?.id ?? null });

  // Attached images must belong to this account; the URLs are stored with the
  // message so a user can see exactly which reference was attached.
  let attachments: Array<{ url: string; caption: string }> = [];
  if (input.imageAssetIds?.length) {
    const owned = await listAssets(user.id, 100);
    const allowed = new Map(owned.map((asset) => [asset.id, asset]));
    attachments = input.imageAssetIds
      .filter((id) => allowed.has(id))
      .map((id) => ({ url: `/api/bigbrother/assets/${id}`, caption: allowed.get(id)?.filename ?? 'Attached image' }));
    if (attachments.length !== input.imageAssetIds.length) {
      throw new ApiError('One of the attached images does not belong to your account.', 403, 'asset_forbidden');
    }
  }

  await appendMessage(user.id, conversation.id, {
    role: 'user',
    content: question,
    blocks: attachments.length
      ? [{ type: 'images', images: attachments }]
      : [],
    intent: null,
    engine: null,
  });

  const started = Date.now();
  let result;
  try {
    result = await answer({
      question,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      server,
      conversationId: conversation.id,
    });
  } catch (error) {
    // A failed turn is itself diagnostics-worthy, and the user gets a truthful
    // message instead of a fabricated answer.
    await recordError({
      message: error instanceof Error ? error.message : String(error),
      source: 'api',
      serverId: server?.id ?? null,
      userId: user.id,
      endpoint: '/api/bigbrother/chat',
      httpMethod: 'POST',
      code: 'bigbrother_turn_failed',
      context: { conversationId: conversation.id },
      evidence: ['The assistant turn failed before an answer was produced'],
    });
    throw error;
  }

  const allImages = [...attachments, ...result.images];
  const blocks = allImages.length
    ? [{ type: 'images' as const, images: allImages }, ...result.blocks]
    : result.blocks;

  const assistantMessage = await appendMessage(user.id, conversation.id, {
    role: 'assistant',
    content: result.text,
    blocks,
    citations: result.citations,
    actions: result.actions,
    intent: result.intent,
    engine: result.engine,
  });

  // Persist the working context that makes a later "where did I stop?" real.
  await setMemory(user.id, 'last_topic', {
    intent: result.intent,
    question: question.slice(0, 300),
    conversationId: conversation.id,
    serverId: server?.id ?? null,
    at: new Date().toISOString(),
  });

  await logUsage({
    userId: user.id,
    kind: 'chat',
    engine: result.engine,
    ok: true,
    durationMs: Date.now() - started,
    detail: { intent: result.intent, conversationId: conversation.id, blocks: result.blocks.length },
  });

  return ok({
    conversationId: conversation.id,
    messageId: assistantMessage.id,
    answer: {
      text: result.text,
      blocks,
      citations: result.citations,
      actions: result.actions,
      images: result.images,
      suggestions: result.suggestions,
      intent: result.intent,
      engine: result.engine,
    },
  });
});
