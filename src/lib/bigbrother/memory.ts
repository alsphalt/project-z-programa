import 'server-only';
import { jsonb, parseJsonb, query, queryOne } from '../db';
import { uuid } from '../crypto';
import { ApiError } from '../api';

/**
 * Per-account conversation storage.
 *
 * Every statement filters on user_id, including the ones that read by primary
 * key. There is no query in this module that can return another account's
 * conversation, which is what makes the ownership check real rather than a UI
 * convention.
 */

export interface Conversation {
  id: string;
  userId: string;
  serverId: string | null;
  title: string;
  messageCount: number;
  lastIntent: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  blocks: unknown[];
  citations: unknown[];
  actions: unknown[];
  intent: string | null;
  engine: string | null;
  createdAt: string;
}

interface ConversationRow {
  id: string;
  user_id: string;
  server_id: string | null;
  title: string;
  message_count: number | string;
  last_intent: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  blocks: unknown;
  citations: unknown;
  actions: unknown;
  intent: string | null;
  engine: string | null;
  created_at: string;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    serverId: row.server_id,
    title: row.title,
    messageCount: Number(row.message_count ?? 0),
    lastIntent: row.last_intent,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: (['user', 'assistant', 'system'].includes(row.role) ? row.role : 'assistant') as Message['role'],
    content: row.content,
    blocks: parseJsonb<unknown[]>(row.blocks, []),
    citations: parseJsonb<unknown[]>(row.citations, []),
    actions: parseJsonb<unknown[]>(row.actions, []),
    intent: row.intent,
    engine: row.engine,
    createdAt: row.created_at,
  };
}

export function titleFromQuestion(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New conversation';
  return clean.length > 64 ? `${clean.slice(0, 61)}…` : clean;
}

export async function createConversation(
  userId: string,
  options: { serverId?: string | null; title?: string } = {},
): Promise<Conversation> {
  const id = uuid();
  await query(
    `insert into bigbrother_conversations (id, user_id, server_id, title) values ($1,$2,$3,$4)`,
    [id, userId, options.serverId ?? null, options.title ?? 'New conversation'],
  );
  return requireConversation(userId, id);
}

export async function listConversations(userId: string, limit = 40): Promise<Conversation[]> {
  const rows = await query<ConversationRow>(
    `select * from bigbrother_conversations
      where user_id = $1 and archived = false
      order by updated_at desc limit $2`,
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(mapConversation);
}

export async function requireConversation(userId: string, id: string): Promise<Conversation> {
  const row = await queryOne<ConversationRow>(
    'select * from bigbrother_conversations where id = $1 and user_id = $2',
    [id, userId],
  );
  if (!row) throw new ApiError('Conversation not found.', 404, 'conversation_not_found');
  return mapConversation(row);
}

/**
 * Message pagination.
 *
 * A long thread used to be serialised in full on every open: one row per turn,
 * each with its blocks, citations and actions, straight into the browser's
 * heap. On a phone with 2 GB of RAM that is what made the tab die with
 * "Aw, Snap!" rather than render. The reader now walks the thread backwards in
 * pages, newest first, and the client only ever holds the pages it asked for.
 */
export const MESSAGE_PAGE_SIZE = 40;
export const MESSAGE_PAGE_MAX = 200;

export interface MessagePage {
  conversation: Conversation;
  /** Oldest → newest, so the client can append without re-sorting. */
  messages: Message[];
  /** True when older messages exist before the first row of this page. */
  hasMore: boolean;
  /** Opaque cursor for the next (older) page, or null at the top of the thread. */
  nextCursor: string | null;
  /** Total messages in the conversation, for the UI counter. */
  total: number;
}

type Cursor = { at: string; id: string };

/**
 * `pg` returns `timestamptz` columns as `Date` objects while PGlite can return
 * strings. A cursor built from `Date.toString()` embeds "GMT+0800 (China
 * Standard Time)", which PostgreSQL refuses to cast back — so every timestamp is
 * normalised to ISO-8601 before it leaves the query.
 */
function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? '');
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString();
}

function encodeCursor(at: unknown, id: string): string {
  return `${toIsoTimestamp(at)}|${id}`;
}

/** Malformed cursors are rejected rather than treated as "start from the top". */
function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const split = raw.lastIndexOf('|');
  if (split <= 0) throw new ApiError('The message cursor is not valid.', 400, 'invalid_cursor');
  const at = raw.slice(0, split);
  const idPart = raw.slice(split + 1);
  const parsed = Date.parse(at);
  if (!at || !idPart || Number.isNaN(parsed)) {
    throw new ApiError('The message cursor is not valid.', 400, 'invalid_cursor');
  }
  return { at: new Date(parsed).toISOString(), id: idPart };
}

export async function getConversation(
  userId: string,
  id: string,
  options: { limit?: number; before?: string } = {},
): Promise<MessagePage> {
  const conversation = await requireConversation(userId, id);
  const requested = Number.isFinite(options.limit) ? Math.trunc(options.limit as number) : MESSAGE_PAGE_SIZE;
  const limit = Math.min(Math.max(requested || MESSAGE_PAGE_SIZE, 1), MESSAGE_PAGE_MAX);
  const cursor = decodeCursor(options.before);
  const columns = `id, conversation_id, role, content, blocks, citations, actions, intent, engine, created_at`;

  // `limit + 1` proves whether an older page exists without a second query.
  // The row comparison keeps paging stable when two turns share a timestamp.
  const rows = cursor
    ? await query<MessageRow>(
        `select ${columns}
           from bigbrother_messages
          where conversation_id = $1 and user_id = $2
            and (created_at, id) < ($3::timestamptz, $4::text)
          order by created_at desc, id desc
          limit $5`,
        [id, userId, cursor.at, cursor.id, limit + 1],
      )
    : await query<MessageRow>(
        `select ${columns}
           from bigbrother_messages
          where conversation_id = $1 and user_id = $2
          order by created_at desc, id desc
          limit $3`,
        [id, userId, limit + 1],
      );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const oldest = page[page.length - 1];
  const counter = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from bigbrother_messages where conversation_id = $1 and user_id = $2`,
    [id, userId],
  );

  return {
    conversation,
    messages: page.slice().reverse().map(mapMessage),
    hasMore,
    nextCursor: hasMore && oldest ? encodeCursor(oldest.created_at, oldest.id) : null,
    total: Number(counter?.count ?? 0),
  };
}

export interface AppendMessageInput {
  role: Message['role'];
  content: string;
  blocks?: unknown[];
  citations?: unknown[];
  actions?: unknown[];
  intent?: string | null;
  engine?: string | null;
}

export async function appendMessage(
  userId: string,
  conversationId: string,
  input: AppendMessageInput,
): Promise<Message> {
  await requireConversation(userId, conversationId);
  const id = uuid();
  const rows = await query<MessageRow>(
    `insert into bigbrother_messages (id, conversation_id, user_id, role, content, blocks, citations, actions, intent, engine)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
     returning id, conversation_id, role, content, blocks, citations, actions, intent, engine, created_at`,
    [
      id,
      conversationId,
      userId,
      input.role,
      input.content.slice(0, 24_000),
      jsonb(input.blocks ?? []),
      jsonb(input.citations ?? []),
      jsonb(input.actions ?? []),
      input.intent ?? null,
      input.engine ?? null,
    ],
  );

  await query(
    `update bigbrother_conversations set
       message_count = (select count(*) from bigbrother_messages where conversation_id = $1),
       last_intent = coalesce($3, last_intent),
       title = case when title = 'New conversation' and $4 <> '' then $4 else title end,
       updated_at = now()
     where id = $1 and user_id = $2`,
    [conversationId, userId, input.intent ?? null, input.role === 'user' ? titleFromQuestion(input.content) : ''],
  );

  return mapMessage(rows[0]);
}

export async function deleteConversation(userId: string, id: string): Promise<void> {
  const rows = await query<{ id: string }>(
    'delete from bigbrother_conversations where id = $1 and user_id = $2 returning id',
    [id, userId],
  );
  if (!rows.length) throw new ApiError('Conversation not found.', 404, 'conversation_not_found');
}

export async function renameConversation(userId: string, id: string, title: string): Promise<Conversation> {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) throw new ApiError('A conversation title cannot be empty.', 400, 'invalid_title');
  const rows = await query<{ id: string }>(
    'update bigbrother_conversations set title = $3, updated_at = now() where id = $1 and user_id = $2 returning id',
    [id, userId, clean],
  );
  if (!rows.length) throw new ApiError('Conversation not found.', 404, 'conversation_not_found');
  return requireConversation(userId, id);
}

export async function recentMessages(userId: string, conversationId: string, limit = 10): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `select id, conversation_id, role, content, blocks, citations, actions, intent, engine, created_at
       from bigbrother_messages
      where conversation_id = $1 and user_id = $2
      order by created_at desc limit $3`,
    [conversationId, userId, limit],
  );
  return rows.reverse().map(mapMessage);
}

// ---------------------------------------------------------------------------
// Long-term memory (explicit facts + the last conversation for "where did I stop")
// ---------------------------------------------------------------------------

export interface MemoryItem {
  key: string;
  value: unknown;
  updatedAt: string;
}

export async function listMemory(userId: string): Promise<MemoryItem[]> {
  const rows = await query<{ key: string; value: unknown; updated_at: string }>(
    'select key, value, updated_at from bigbrother_memory where user_id = $1 order by updated_at desc',
    [userId],
  );
  return rows.map((row) => ({ key: row.key, value: parseJsonb<unknown>(row.value, null), updatedAt: row.updated_at }));
}

export async function setMemory(userId: string, key: string, value: unknown): Promise<MemoryItem> {
  const clean = key.trim().slice(0, 120);
  if (!clean) throw new ApiError('A memory key is required.', 400, 'invalid_key');
  await query(
    `insert into bigbrother_memory (user_id, key, value) values ($1,$2,$3::jsonb)
     on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`,
    [userId, clean, jsonb(value)],
  );
  return { key: clean, value, updatedAt: new Date().toISOString() };
}

export async function deleteMemory(userId: string, key: string): Promise<void> {
  await query('delete from bigbrother_memory where user_id = $1 and key = $2', [userId, key]);
}

export interface Recall {
  lastConversation: Conversation | null;
  exchanges: Array<{ role: string; content: string; at: string }>;
  facts: MemoryItem[];
  /** True only when stored rows were actually found. */
  hasHistory: boolean;
}

/**
 * What "where did I stop?" is answered from: the most recent conversation's
 * stored messages plus explicitly saved facts. If there is nothing stored, the
 * caller is told — the assistant never claims to remember unsaved context.
 */
export async function recall(
  userId: string,
  options: { excludeConversationId?: string; serverId?: string | null } = {},
): Promise<Recall> {
  const conversation = await queryOne<ConversationRow>(
    `select * from bigbrother_conversations
      where user_id = $1 and ($2 = '' or id <> $2)
      order by updated_at desc limit 1`,
    [userId, options.excludeConversationId ?? ''],
  );

  if (!conversation) {
    return { lastConversation: null, exchanges: [], facts: await listMemory(userId), hasHistory: false };
  }

  const rows = await query<{ role: string; content: string; created_at: string }>(
    `select role, content, created_at from bigbrother_messages
      where conversation_id = $1 and user_id = $2 and role in ('user','assistant')
      order by created_at desc limit 8`,
    [conversation.id, userId],
  );

  return {
    lastConversation: mapConversation(conversation),
    exchanges: rows.reverse().map((row) => ({ role: row.role, content: row.content, at: row.created_at })),
    facts: await listMemory(userId),
    hasHistory: rows.length > 0,
  };
}

export async function logUsage(input: {
  userId?: string | null;
  kind: string;
  engine?: string | null;
  ok?: boolean;
  durationMs?: number;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query(
      `insert into bigbrother_usage (user_id, kind, engine, ok, duration_ms, detail)
       values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        input.userId ?? null,
        input.kind,
        input.engine ?? null,
        input.ok ?? true,
        Math.max(0, Math.round(input.durationMs ?? 0)),
        jsonb(input.detail ?? {}),
      ],
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[darknote] failed to write bigbrother usage', error);
  }
}
