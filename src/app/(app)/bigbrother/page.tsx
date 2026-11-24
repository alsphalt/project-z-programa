"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  ImagePlus,
  Loader2,
  Menu,
  MessageSquarePlus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useServers, useToast } from "@/components/providers";
import { ConfirmDialog, Spinner } from "@/components/ui";
import { BigBrotherAmbient } from "@/components/bigbrother/ambient";
import { AnswerBlockView, Prose } from "@/components/bigbrother/rich";
import { TutorialManager } from "@/components/bigbrother/tutorial-manager";
import { api, apiDelete, apiPost, errorMessage } from "@/lib/client";
import type { AnswerAction, AnswerBlock, Citation } from "@/lib/bigbrother/shared";
import { allowsDecorativeMotion, readRenderProfile } from "@/lib/perf/profile";

type Conversation = {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  serverId: string | null;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  blocks: AnswerBlock[];
  citations: Citation[];
  actions: AnswerAction[];
  intent: string | null;
  engine: string | null;
  createdAt: string;
};

type Status = {
  engine: { configured: boolean; model: string | null; host: string | null; mode: string };
  counts: { conversations: number; tutorials: number; memoryFacts: number; pages: number; openProblems: number };
  scope: string[];
};

type Asset = { id: string; url: string; filename: string };

/** One page of a thread, as returned by the conversations endpoint. */
type ThreadPage = {
  conversation: Conversation;
  messages: Message[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
};

/** Messages fetched per request when scrolling back through a thread. */
const THREAD_PAGE_SIZE = 40;
/** Hard ceiling for messages held in the browser, however far back the user pages. */
const MAX_THREAD_MESSAGES = 240;

const SUGGESTIONS = [
  "Where can I find my plugins?",
  "How do I restart my bot?",
  "Where can I get the Pterodactyl Client API Key?",
  "Why is my Live Monitor showing Unknown?",
  "Where is my main.js file?",
  "Why am I getting a 405?",
];

function timeAgo(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function OrbMark({ size = 30 }: { size?: number }) {
  return (
    <span
      className="relative grid shrink-0 place-items-center rounded-full border border-accent/40 bg-gradient-to-br from-accent/40 to-cyber/25"
      style={{ width: size, height: size }}
    >
      <span className="bb-orb-mist">
        <span />
        <span />
        <span />
      </span>
      <span className="relative z-10 text-[13px] leading-none">🌫️</span>
    </span>
  );
}

function BigBrotherView() {
  const params = useSearchParams();
  const router = useRouter();
  const { activeId, activeServer } = useServers();
  const { push } = useToast();

  const [status, setStatus] = useState<Status | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId_, setActiveId] = useState<string | null>(params.get("c"));
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [totalMessages, setTotalMessages] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tutorialsOpen, setTutorialsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingImages, setPendingImages] = useState<Asset[]>([]);
  const [uploading, setUploading] = useState(false);
  const [anim, setAnim] = useState(true);

  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const refreshConversations = useCallback(async () => {
    try {
      const data = await api<{ conversations: Conversation[] }>("/api/bigbrother/conversations");
      setConversations(data.conversations);
    } catch {
      /* the thread still works; the list will retry on the next action */
    }
  }, []);

  /**
   * Thread loading is paged.
   *
   * The workspace used to request the whole conversation and keep it in React
   * state; a few thousand turns of answers with blocks and citations is tens of
   * megabytes of JS objects, which is what an Android renderer answers with
   * "Aw, Snap!". One page at a time keeps the heap flat while every message
   * stays reachable through "Load earlier".
   */
  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true);
    try {
      const data = await api<ThreadPage>(
        `/api/bigbrother/conversations/${id}?limit=${THREAD_PAGE_SIZE}`,
      );
      setMessages(data.messages.slice(-MAX_THREAD_MESSAGES));
      setOlderCursor(data.nextCursor);
      setTotalMessages(data.total);
      setActiveId(id);
    } catch (error) {
      push(errorMessage(error), "error");
      setActiveId(null);
    } finally {
      setLoadingThread(false);
    }
  }, [push]);

  const loadEarlier = useCallback(async () => {
    if (!activeId_ || !olderCursor || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const data = await api<ThreadPage>(
        `/api/bigbrother/conversations/${activeId_}?limit=${THREAD_PAGE_SIZE}&before=${encodeURIComponent(olderCursor)}`,
      );
      setMessages((current) => [...data.messages, ...current].slice(-MAX_THREAD_MESSAGES));
      setOlderCursor(data.nextCursor);
      setTotalMessages(data.total);
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setLoadingEarlier(false);
    }
  }, [activeId_, olderCursor, loadingEarlier, push]);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<Status>("/api/bigbrother/status");
        setStatus(data);
      } catch {
        /* status is informational */
      }
    })();
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    const stored = window.localStorage.getItem("bb.anim");
    if (stored === "off") setAnim(false);
    // `?profile=safe|reduced` is the device-wide diagnostic switch: it wins over
    // the stored per-page preference, without overwriting it.
    if (!allowsDecorativeMotion(readRenderProfile())) setAnim(false);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("bb.anim", anim ? "on" : "off");
  }, [anim]);

  useEffect(() => {
    const initial = params.get("c");
    if (initial) void loadThread(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, sending]);

  const startNew = () => {
    setActiveId(null);
    setMessages([]);
    setOlderCursor(null);
    setTotalMessages(0);
    setSidebarOpen(false);
    router.replace("/bigbrother");
    textarea.current?.focus();
  };

  const openConversation = (id: string) => {
    setSidebarOpen(false);
    router.replace(`/bigbrother?c=${id}`);
    void loadThread(id);
  };

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || sending) return;
    setDraft("");
    setSending(true);

    const localUser: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content: question,
      blocks: pendingImages.length ? [{ type: "images", images: pendingImages.map((asset) => ({ url: asset.url, caption: asset.filename })) }] : [],
      citations: [],
      actions: [],
      intent: null,
      engine: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, localUser]);

    try {
      const data = await api<{
        conversationId: string;
        messageId: string;
        answer: {
          text: string;
          blocks: AnswerBlock[];
          citations: Citation[];
          actions: AnswerAction[];
          intent: string;
          engine: string;
        };
      }>("/api/bigbrother/chat", {
        method: "POST",
        body: JSON.stringify({
          question,
          conversationId: activeId_ ?? undefined,
          serverId: activeId ?? undefined,
          imageAssetIds: pendingImages.map((asset) => asset.id),
        }),
      });

      setPendingImages([]);
      setMessages((current) => [
        ...current,
        {
          id: data.messageId,
          role: "assistant",
          content: data.answer.text,
          blocks: data.answer.blocks,
          citations: data.answer.citations,
          actions: data.answer.actions,
          intent: data.answer.intent,
          engine: data.answer.engine,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (!activeId_) {
        setActiveId(data.conversationId);
        router.replace(`/bigbrother?c=${data.conversationId}`);
      }
      void refreshConversations();
    } catch (error) {
      push(errorMessage(error), "error");
      setMessages((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: `I could not complete that answer: ${errorMessage(error)}. Nothing was guessed to fill the gap.`,
          blocks: [],
          citations: [],
          actions: [],
          intent: null,
          engine: null,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const runScan = async () => {
    try {
      const result = await apiPost<{ servers: number; summaries: Array<{ consoleEvents: number; deploymentEvents: number; panelProblem: boolean; whatsappProblem: boolean }> }>(
        "/api/errors/scan",
        activeId ? { serverId: activeId } : {},
      );
      const captured = result.summaries.reduce(
        (sum, item) => sum + item.consoleEvents + item.deploymentEvents + (item.panelProblem ? 1 : 0) + (item.whatsappProblem ? 1 : 0),
        0,
      );
      push(`Diagnostic scan finished over ${result.servers} server(s); ${captured} signal(s) recorded.`, "ok");
    } catch (error) {
      push(errorMessage(error), "error");
    }
  };

  const deleteConversation = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDelete(`/api/bigbrother/conversations/${deleteTarget.id}`);
      setConversations((current) => current.filter((item) => item.id !== deleteTarget.id));
      if (activeId_ === deleteTarget.id) startNew();
      push("Conversation deleted", "ok");
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const uploadImage = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await api<{ asset: Asset }>("/api/bigbrother/assets", { method: "POST", body: form });
      setPendingImages((current) => [...current, data.asset].slice(0, 4));
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setUploading(false);
    }
  };

  const engineLabel = useMemo(() => {
    if (!status) return "Grounded in DARKNOTE data";
    return status.engine.configured
      ? `Model: ${status.engine.model} · grounded tools`
      : "Grounded engine · no model key configured";
  }, [status]);

  return (
    <div className="relative -m-3 flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      <BigBrotherAmbient enabled={anim} cycleMs={22_000} />

      <div className="relative z-10 flex min-h-0 flex-1">
        {/* Desktop conversation rail */}
        <aside className="hidden w-[264px] shrink-0 flex-col border-r border-ink-700/60 bg-ink-950/72 backdrop-blur-xl lg:flex">
          <SidebarContent
            conversations={conversations}
            activeId={activeId_}
            onSelect={openConversation}
            onNew={startNew}
            onDelete={setDeleteTarget}
            onTutorials={() => setTutorialsOpen(true)}
            engineLabel={engineLabel}
            counts={status?.counts}
          />
        </aside>

        {/* Mobile rail */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
            <aside className="relative flex h-full w-[286px] flex-col border-r border-ink-700 bg-ink-950/95 backdrop-blur-xl">
              <div className="flex items-center justify-between px-3 py-3">
                <span className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Conversations</span>
                <button className="rounded p-1 text-slate-400 hover:bg-ink-800" onClick={() => setSidebarOpen(false)} aria-label="Close">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <SidebarContent
                conversations={conversations}
                activeId={activeId_}
                onSelect={openConversation}
                onNew={startNew}
                onDelete={setDeleteTarget}
                onTutorials={() => {
                  setSidebarOpen(false);
                  setTutorialsOpen(true);
                }}
                engineLabel={engineLabel}
                counts={status?.counts}
              />
            </aside>
          </div>
        )}

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-ink-700/50 bg-ink-950/55 px-3 py-2.5 backdrop-blur-xl sm:px-5">
            <button className="rounded-md p-1.5 text-slate-400 hover:bg-ink-800 lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Conversations">
              <Menu className="h-4 w-4" />
            </button>
            <OrbMark size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold tracking-[0.18em] text-slate-100">BIGBROTHER</p>
              <p className="truncate text-[10px] text-slate-500">{engineLabel}</p>
            </div>
            <button
              className="btn-ghost !px-2 !py-1 text-[10px]"
              onClick={() => setAnim((value) => !value)}
              title={anim ? "Reduce the background animation" : "Enable the background animation"}
            >
              <Sparkles className="h-3 w-3" /> {anim ? "Reduce motion" : "Animate"}
            </button>
            <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => setTutorialsOpen(true)}>
              <BookOpen className="h-3 w-3" /> <span className="hidden sm:inline">Tutorials</span>
            </button>
            <button className="btn-primary !px-2 !py-1 text-[10px]" onClick={startNew}>
              <MessageSquarePlus className="h-3 w-3" /> <span className="hidden sm:inline">New</span>
            </button>
          </header>

          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6">
            <div className="mx-auto w-full max-w-3xl space-y-4">
              {!messages.length && !loadingThread && (
                <div className="rounded-2xl border border-ink-700/60 bg-ink-950/78 p-5 shadow-panel backdrop-blur-xl sm:p-7">
                  <div className="flex items-center gap-3">
                    <OrbMark size={44} />
                    <div>
                      <p className="text-base font-semibold tracking-[0.16em] text-slate-100">BIGBROTHER</p>
                      <p className="text-[11px] text-slate-500">The intelligence of the DARKNOTE Control Center</p>
                    </div>
                  </div>
                  <p className="mt-4 text-[13px] leading-relaxed text-slate-300">
                    I know every page here, the real file index of your bot project, and the errors DARKNOTE has captured.
                    Ask me where something is, to find a file, or why something failed — I will check and show the evidence.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => void send(suggestion)}
                        className="rounded-full border border-ink-600/70 bg-ink-900/70 px-3 py-1.5 text-left text-[11.5px] text-slate-300 transition hover:border-accent/50 hover:text-white"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                  {activeServer ? (
                    <p className="mt-4 text-[10.5px] text-slate-500">
                      Active server: <span className="text-slate-300">{activeServer.name}</span> · file and error answers use its data.
                    </p>
                  ) : (
                    <p className="mt-4 text-[10.5px] text-amber-300/80">
                      No server selected. Navigation answers work; file and runtime answers need a connected server.
                    </p>
                  )}
                </div>
              )}

              {loadingThread && (
                <p className="flex items-center gap-2 text-xs text-slate-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading conversation…
                </p>
              )}

              {olderCursor ? (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => void loadEarlier()}
                    disabled={loadingEarlier}
                    className="btn-ghost !py-1.5 text-[11px] disabled:opacity-60"
                  >
                    {loadingEarlier ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUp className="h-3 w-3" />}
                    {loadingEarlier
                      ? "Loading earlier messages…"
                      : `Load earlier messages${totalMessages ? ` (${Math.max(0, totalMessages - messages.length)} older)` : ""}`}
                  </button>
                </div>
              ) : null}

              {messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md border border-accent/25 bg-accent/12 px-3.5 py-2.5 backdrop-blur">
                      <p className="whitespace-pre-line text-[13px] leading-relaxed text-slate-100">{message.content}</p>
                      {message.blocks?.map((block, index) => (
                        <div key={index} className="mt-2">
                          <AnswerBlockView block={block} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div key={message.id} className="flex gap-2.5">
                    <OrbMark size={28} />
                    <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-ink-700/60 bg-ink-950/82 px-3.5 py-3 shadow-panel backdrop-blur-xl">
                      <Prose text={message.content} />
                      {message.blocks?.length ? (
                        <div className="mt-2.5 space-y-2.5">
                          {message.blocks.map((block, index) => (
                            <AnswerBlockView key={index} block={block} />
                          ))}
                        </div>
                      ) : null}
                      {message.actions?.length ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {message.actions.map((action, index) =>
                            action.kind === "scan" ? (
                              <button
                                key={`${action.label}-${index}`}
                                onClick={() => void runScan()}
                                className="rounded-full border border-ink-600/70 bg-ink-900/70 px-2.5 py-1 text-[11px] text-slate-200 transition hover:border-accent/50"
                              >
                                {action.label}
                              </button>
                            ) : action.href ? (
                              <Link
                                key={`${action.label}-${index}`}
                                href={action.href}
                                className="rounded-full border border-ink-600/70 bg-ink-900/70 px-2.5 py-1 text-[11px] text-slate-200 transition hover:border-accent/50 hover:text-white"
                              >
                                {action.label} →
                              </Link>
                            ) : null,
                          )}
                        </div>
                      ) : null}
                      {message.citations?.length ? (
                        <details className="mt-2.5 text-[10px] text-slate-500">
                          <summary className="cursor-pointer select-none hover:text-slate-400">What this is based on</summary>
                          <ul className="mt-1 space-y-0.5">
                            {message.citations.map((citation, index) => (
                              <li key={index}>
                                <span className="text-slate-400">{citation.label}</span>
                                {citation.detail ? ` — ${citation.detail}` : ""}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-600">
                        <span>{timeAgo(message.createdAt)}</span>
                        {message.intent && <span className="rounded border border-ink-700 px-1.5 py-0.5">{message.intent}</span>}
                        {message.engine && <span className="truncate">{message.engine}</span>}
                      </p>
                    </div>
                  </div>
                ),
              )}

              {sending && (
                <div className="flex items-center gap-2.5">
                  <OrbMark size={28} />
                  <div className="flex items-center gap-1.5 rounded-full border border-ink-700/60 bg-ink-950/80 px-3 py-2 backdrop-blur">
                    <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-accent" />
                    <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-accent [animation-delay:120ms]" />
                    <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-accent [animation-delay:240ms]" />
                    <span className="ml-1 text-[11px] text-slate-400">Checking DARKNOTE…</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-ink-700/50 bg-ink-950/72 px-3 py-2.5 backdrop-blur-xl sm:px-6">
            <div className="mx-auto w-full max-w-3xl">
              {pendingImages.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pendingImages.map((asset) => (
                    <div key={asset.id} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={asset.url} alt={asset.filename} className="h-12 w-16 rounded border border-ink-600 object-cover" />
                      <button
                        className="absolute -right-1.5 -top-1.5 rounded-full border border-ink-700 bg-ink-950 p-0.5 text-slate-400 hover:text-rose-300"
                        onClick={() => setPendingImages((current) => current.filter((item) => item.id !== asset.id))}
                        aria-label="Remove image"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2 rounded-2xl border border-ink-600/70 bg-ink-900/85 px-2 py-1.5 shadow-glow">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadImage(file);
                    event.target.value = "";
                  }}
                />
                <button
                  className="mb-0.5 rounded-lg p-2 text-slate-400 hover:bg-ink-800 hover:text-slate-200"
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading || pendingImages.length >= 4}
                  title="Attach a screenshot"
                  aria-label="Attach a screenshot"
                >
                  {uploading ? <Spinner /> : <ImagePlus className="h-4 w-4" />}
                </button>
                <textarea
                  ref={textarea}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send(draft);
                    }
                  }}
                  rows={1}
                  placeholder="Ask about a page, a file, an error or a procedure…"
                  className="max-h-32 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[13px] text-slate-100 outline-none placeholder:text-slate-600"
                />
                <button
                  className="mb-0.5 grid h-9 w-9 place-items-center rounded-lg bg-accent text-white transition disabled:opacity-40"
                  onClick={() => void send(draft)}
                  disabled={!draft.trim() || sending}
                  aria-label="Send"
                >
                  {sending ? <Spinner /> : <ArrowUp className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-1.5 px-1 text-[10px] text-slate-600">
                Enter sends · Shift+Enter adds a line · answers are grounded in this server&apos;s index, errors and pages · production changes always need confirmation
              </p>
            </div>
          </div>
        </section>
      </div>

      <TutorialManager open={tutorialsOpen} onClose={() => setTutorialsOpen(false)} onChanged={() => void refreshConversations()} />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void deleteConversation()}
        busy={deleting}
        danger
        title="Delete this conversation?"
        description={
          <>
            “{deleteTarget?.title}” and its messages are removed from your account. This cannot be undone, and I will no longer be able to continue from it.
          </>
        }
        confirmLabel="Delete conversation"
      />
    </div>
  );
}

function SidebarContent({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onTutorials,
  engineLabel,
  counts,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (conversation: Conversation) => void;
  onTutorials: () => void;
  engineLabel: string;
  counts?: Status["counts"];
}) {
  return (
    <>
      <div className="px-3 pb-2 pt-3">
        <button className="btn-primary w-full !py-2 text-xs" onClick={onNew}>
          <MessageSquarePlus className="h-3.5 w-3.5" /> New conversation
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 && (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-slate-500">
            No saved conversations yet. The first question creates one, and it stays available here.
          </p>
        )}
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 transition ${
              conversation.id === activeId ? "bg-accent/12 text-white" : "text-slate-300 hover:bg-ink-800/70"
            }`}
          >
            <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(conversation.id)}>
              <span className="block truncate text-[12px]">{conversation.title}</span>
              <span className="block text-[10px] text-slate-500">
                {conversation.messageCount} message(s) · {timeAgo(conversation.updatedAt)}
              </span>
            </button>
            <button
              className="rounded p-1 text-slate-600 opacity-0 transition hover:bg-rose-500/10 hover:text-rose-300 group-hover:opacity-100"
              onClick={() => onDelete(conversation)}
              aria-label={`Delete ${conversation.title}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="space-y-2 border-t border-ink-700/60 px-3 py-3">
        <button className="btn-ghost w-full !py-1.5 text-[11px]" onClick={onTutorials}>
          <BookOpen className="h-3 w-3" /> Tutorials & images
        </button>
        <Link href="/errors" className="btn-ghost w-full !py-1.5 text-[11px]">
          <Sparkles className="h-3 w-3" /> Error Center
          {counts?.openProblems ? <span className="ml-1 rounded-full bg-rose-500/20 px-1.5 text-[10px] text-rose-200">{counts.openProblems}</span> : null}
        </Link>
        <p className="text-[10px] leading-relaxed text-slate-600">
          {engineLabel}
          {counts ? ` · ${counts.pages} pages · ${counts.tutorials} tutorial(s)` : ""}
        </p>
      </div>
    </>
  );
}

export default function BigBrotherPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[60vh] items-center justify-center text-xs text-slate-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening BIGBROTHER…
        </div>
      }
    >
      <BigBrotherView />
    </Suspense>
  );
}
