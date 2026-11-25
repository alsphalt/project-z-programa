"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  Loader2,
  MessageSquarePlus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AnswerBlockView, Prose } from "./rich";
import { apiGet, apiPost, errorMessage } from "@/lib/client";
import type { AnswerBlock, Citation } from "@/lib/bigbrother/shared";

type PanelMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  blocks: AnswerBlock[];
  citations: Citation[];
  engine: string | null;
};

type StatusPayload = {
  engine: { configured: boolean; model: string | null };
  counts: { openProblems: number };
};

type ConversationRow = { id: string; messageCount: number; updatedAt: string };

const SUGGESTIONS = ["How do I restart my bot?", "Why is Live Monitor showing Unknown?", "Where is my main.js?"];

/**
 * Messages the overlay keeps in memory. The full thread lives in PostgreSQL and
 * is paged by the workspace view; the overlay only needs the recent context.
 */
const PANEL_HISTORY_LIMIT = 60;

/**
 * The floating BIGBROTHER assistant.
 *
 * Compact overlay, not a page: it reuses the same chat endpoint, the same
 * conversation store and the same answer renderer as the full workspace, so the
 * history and context are shared instead of duplicated. Nothing here is faked —
 * the status pill reflects `engine.configured`, and a failed turn shows the real
 * error from the API.
 */
export function BigBrotherPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const loadedHistory = useRef(false);

  // Status is a real read of the backend, and it is only done once per mount.
  useEffect(() => {
    let cancelled = false;
    apiGet<StatusPayload>("/api/bigbrother/status")
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatusFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The most recent conversation is restored, so the panel continues the thread
  // the user already had instead of starting from nothing.
  //
  // Only the newest page is requested: a compact overlay that pulled a 2,000
  // turn thread into memory was the single largest client allocation in the
  // console, and it stayed resident for the whole session.
  useEffect(() => {
    if (!open || loadedHistory.current) return;
    loadedHistory.current = true;
    let cancelled = false;
    (async () => {
      try {
        const list = await apiGet<{ conversations: ConversationRow[] }>("/api/bigbrother/conversations");
        const latest = list.conversations[0];
        if (!latest || latest.messageCount === 0) return;
        const detail = await apiGet<{ messages: PanelMessage[]; hasMore?: boolean }>(
          `/api/bigbrother/conversations/${latest.id}?limit=${PANEL_HISTORY_LIMIT}`,
        );
        if (cancelled) return;
        setConversationId(latest.id);
        setHistoryTruncated(Boolean(detail.hasMore));
        setMessages(
          detail.messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .slice(-PANEL_HISTORY_LIMIT)
            .map((message) => ({
              id: message.id,
              role: message.role as "user" | "assistant",
              content: message.content,
              blocks: Array.isArray(message.blocks) ? message.blocks : [],
              citations: Array.isArray(message.citations) ? message.citations : [],
              engine: message.engine ?? null,
            })),
        );
      } catch {
        // A missing history is not an error worth interrupting the user for.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  /**
   * Release the thread when the overlay closes.
   *
   * `BigBrotherPanel` is mounted by the app shell for the whole session, so
   * whatever it holds stays in the heap until the tab dies. Dropping the
   * messages on close (and letting the next open re-read the newest page from
   * the database) keeps that cost at one page instead of one conversation.
   */
  useEffect(() => {
    if (open) return;
    loadedHistory.current = false;
    setMessages([]);
    setConversationId(null);
    setHistoryTruncated(false);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending, open]);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || sending) return;

    const optimistic: PanelMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: question,
      blocks: [],
      citations: [],
      engine: null,
    };
    setMessages((current) => [...current, optimistic]);
    setInput("");
    setError(null);
    setSending(true);

    try {
      const result = await apiPost<{
        conversationId: string;
        messageId: string;
        answer: { text: string; blocks: AnswerBlock[]; citations: Citation[]; engine: string | null };
      }>("/api/bigbrother/chat", {
        question,
        conversationId: conversationId ?? undefined,
      });
      setConversationId(result.conversationId);
      setMessages((current) => [
        ...current,
        {
          id: result.messageId,
          role: "assistant",
          content: result.answer.text,
          blocks: Array.isArray(result.answer.blocks) ? result.answer.blocks : [],
          citations: Array.isArray(result.answer.citations) ? result.answer.citations : [],
          engine: result.answer.engine ?? null,
        },
      ]);
    } catch (cause) {
      setError(errorMessage(cause));
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      setInput(question);
    } finally {
      setSending(false);
    }
  }, [conversationId, input, sending]);

  const copy = async (message: PanelMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(message.id);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setError("Clipboard access was refused by the browser.");
    }
  };

  const clear = () => {
    setMessages([]);
    setConversationId(null);
    setError(null);
    setInput("");
    inputRef.current?.focus();
  };

  if (!open) return null;

  const engineReady = status?.engine.configured === true;
  const statusLabel = statusFailed ? "Unavailable" : status ? (engineReady ? "Online" : "Degraded") : "Connecting…";
  const statusTone = statusFailed ? "bg-rose-400" : !status ? "bg-sky-400" : engineReady ? "bg-emerald-400" : "bg-amber-400";

  return (
    <div
      role="dialog"
      aria-label="BIGBROTHER AI assistant"
      className="bb-panel fixed right-2 z-50 flex w-[calc(100vw-1rem)] max-w-[392px] flex-col overflow-hidden rounded-2xl border border-accent/25 bg-ink-950/95 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl sm:right-6"
      style={{
        bottom: "calc(5.25rem + env(safe-area-inset-bottom, 0px))",
        height: "min(72vh, 560px)",
      }}
    >
      <header className="flex items-center gap-2.5 border-b border-ink-750/70 px-3 py-2.5">
        <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full border border-accent/40 bg-gradient-to-br from-accent/40 to-cyber/25">
          <span className="bb-orb-mist">
            <span />
            <span />
            <span />
          </span>
          <span className="relative z-10 text-[14px] leading-none">🌫️</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold tracking-[0.12em] text-slate-100">BIGBROTHER AI</p>
          <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
            <span className={`h-1.5 w-1.5 rounded-full ${statusTone}`} />
            {statusLabel}
          </p>
        </div>
        <button type="button" className="btn-ghost !p-1.5" title="New conversation" aria-label="New conversation" onClick={clear}>
          <MessageSquarePlus className="h-4 w-4" />
        </button>
        <button type="button" className="btn-ghost !p-1.5" title="Close" aria-label="Close assistant" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </header>

      <div ref={scrollRef} className="code-scroll flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !sending ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent-soft" />
              <p className="text-[12.5px] leading-relaxed text-slate-300">
                I am BIGBROTHER — I read the live panel data before answering. Ask about a server, a file, an error,
                or the platform itself.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="rounded-full border border-ink-700/70 px-2.5 py-1 text-[11px] text-slate-400 transition hover:border-accent/40 hover:text-slate-200"
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            {status?.counts.openProblems ? (
              <p className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-200">
                {status.counts.openProblems} open problem{status.counts.openProblems === 1 ? "" : "s"} detected in the
                panel. Ask &ldquo;what is broken?&rdquo; to start there.
              </p>
            ) : null}
            {status && !engineReady ? (
              <p className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-200">
                No AI model key is configured, so answers come from the local knowledge engine only.
              </p>
            ) : null}
          </div>
        ) : null}

        {historyTruncated ? (
          <p className="rounded-lg border border-ink-700/70 bg-ink-900/60 px-2.5 py-2 text-[10.5px] leading-relaxed text-slate-500">
            Showing the last {PANEL_HISTORY_LIMIT} messages. Older turns are kept in the database and are available in
            the full BIGBROTHER workspace.
          </p>
        ) : null}

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent/18 px-3 py-2 text-[12.5px] leading-relaxed text-slate-100">
                {message.content}
              </p>
            </div>
          ) : (
            <div key={message.id} className="space-y-1.5">
              <div className="rounded-2xl rounded-bl-sm border border-ink-750/70 bg-ink-900/60 px-3 py-2">
                <Prose text={message.content} />
                {message.blocks.length ? (
                  <div className="mt-2 space-y-2">
                    {message.blocks.map((block, index) => (
                      <AnswerBlockView key={`${message.id}-${index}`} block={block} />
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2 pl-1">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-slate-500 transition hover:text-slate-300"
                  onClick={() => void copy(message)}
                >
                  {copied === message.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied === message.id ? "Copied" : "Copy"}
                </button>
                {message.engine ? (
                  <span className="truncate text-[10px] uppercase tracking-[0.12em] text-slate-600">{message.engine}</span>
                ) : null}
              </div>
            </div>
          ),
        )}

        {sending ? (
          <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-ink-750/70 bg-ink-900/60 px-3 py-2 text-[11px] text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-soft" />
            BIGBROTHER is reading the panel…
          </div>
        ) : null}

        {error ? (
          <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-2.5 py-2 text-[11.5px] text-rose-200">
            {error}
          </p>
        ) : null}
      </div>

      <div className="border-t border-ink-750/70 p-2">
        <div className="flex items-end gap-1.5 rounded-xl border border-ink-700/80 bg-ink-950/70 px-2 py-1.5 focus-within:border-accent/45">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Ask BIGBROTHER…"
            className="max-h-24 flex-1 resize-none bg-transparent px-1 py-1 text-[12.5px] text-slate-100 outline-none placeholder:text-slate-600"
          />
          {messages.length ? (
            <button type="button" className="btn-ghost !p-1.5" title="Clear conversation" aria-label="Clear conversation" onClick={clear}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent text-white transition disabled:opacity-40"
            disabled={sending || input.trim().length === 0}
            onClick={() => void send()}
            aria-label="Send message"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
