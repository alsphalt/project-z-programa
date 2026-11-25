"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  FileCode2,
  FolderOpen,
  Info,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import type { AnswerBlock } from "@/lib/bigbrother/shared";

/**
 * Deliberately small Markdown renderer.
 *
 * It supports the subset the assistant emits: paragraphs, bullet/numbered lists,
 * headings, bold, inline code, fenced code and links. Internal links use the App
 * Router; external links open in a new tab with noopener. Only http(s) targets
 * become anchors, so a model cannot inject a javascript: URL.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\))/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(INLINE).filter((part) => part !== "");
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const [, label, href] = link;
      if (href.startsWith("/")) {
        return (
          <Link key={key} href={href}>
            {label}
          </Link>
        );
      }
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

export function Prose({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const nodes: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      nodes.push(
        <pre key={`code-${index}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const Tag = (heading[1].length === 1 ? "h1" : heading[1].length === 2 ? "h2" : "h3") as "h1" | "h2" | "h3";
      nodes.push(<Tag key={`h-${index}`}>{renderInline(heading[2], `h-${index}`)}</Tag>);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      nodes.push(
        <ul key={`ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`li-${index}-${itemIndex}`}>{renderInline(item, `li-${index}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      nodes.push(
        <ol key={`ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`oli-${index}-${itemIndex}`}>{renderInline(item, `oli-${index}-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[index].trim()) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    nodes.push(
      <p key={`p-${index}`} className="whitespace-pre-line">
        {renderInline(paragraph.join("\n"), `p-${index}`)}
      </p>,
    );
  }

  return <div className="bb-prose">{nodes}</div>;
}

function InternalLink({ href, children }: { href?: string; children: React.ReactNode }) {
  if (!href) return <span className="text-[12px] text-slate-400">{children}</span>;
  if (/^https?:\/\//.test(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[12px] text-accent-soft hover:underline"
      >
        {children}
        <ArrowUpRight className="h-3 w-3" />
      </a>
    );
  }
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-[12px] text-accent-soft hover:underline">
      {children}
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  );
}

const STATUS_ICON = {
  ok: CheckCircle2,
  good: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  unknown: CircleDashed,
} as const;

const STATUS_TONE = {
  ok: "text-emerald-300 border-emerald-500/30 bg-emerald-500/5",
  warn: "text-amber-300 border-amber-500/30 bg-amber-500/5",
  fail: "text-rose-300 border-rose-500/30 bg-rose-500/5",
  unknown: "text-slate-400 border-ink-600/60 bg-ink-900/40",
} as const;

const SEVERITY_TONE: Record<string, string> = {
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  moderate: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  minor: "border-sky-500/40 bg-sky-500/10 text-sky-200",
};

export function AnswerBlockView({ block }: { block: AnswerBlock }) {
  if (block.type === "images") {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {block.images.map((image) => (
          <figure key={image.url} className="overflow-hidden rounded-lg border border-ink-600/70 bg-ink-950/60">
            {/* Images are authenticated routes; plain img keeps the URL out of next/image's proxy. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.url} alt={image.caption} className="h-32 w-full object-cover" loading="lazy" />
            <figcaption className="px-2 py-1 text-[10px] text-slate-400">{image.caption}</figcaption>
          </figure>
        ))}
      </div>
    );
  }

  if (block.type === "note") {
    const tone =
      block.tone === "bad"
        ? "border-rose-500/35 bg-rose-500/8 text-rose-100"
        : block.tone === "warn"
          ? "border-amber-500/35 bg-amber-500/8 text-amber-100"
          : "border-ink-600/60 bg-ink-900/60 text-slate-300";
    const Icon = block.tone === "info" ? Info : block.tone === "warn" ? AlertTriangle : ShieldAlert;
    return (
      <div className={`flex gap-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${tone}`}>
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-80" />
        <p className="whitespace-pre-line">{block.text}</p>
      </div>
    );
  }

  if (block.type === "steps") {
    return (
      <div className="rounded-xl border border-ink-700/70 bg-ink-950/40 p-3">
        {block.title && <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{block.title}</p>}
        <ol className="space-y-3">
          {block.steps.map((step, index) => (
            <li key={`${step.title}-${index}`} className="flex gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 text-[10px] font-semibold text-accent-soft">
                {index + 1}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="text-[12.5px] font-medium text-slate-100">{step.title}</p>
                <p className="text-[12px] leading-relaxed text-slate-400">{step.body}</p>
                {step.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={step.imageUrl}
                    alt={step.title}
                    className="mt-1 max-h-56 w-full rounded-lg border border-ink-600/60 object-cover"
                    loading="lazy"
                  />
                )}
                {step.link && <InternalLink href={step.link}>{step.linkLabel ?? "Open"}</InternalLink>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (block.type === "files") {
    return (
      <div className="space-y-2">
        {block.title && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{block.title}</p>}
        {block.items.map((item, index) => (
          <div key={`${item.path}-${index}`} className="rounded-lg border border-ink-700/70 bg-ink-950/50 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="mono truncate text-[12px] text-slate-100" title={item.path}>
                  {item.path}
                  {item.line ? <span className="text-slate-500">:{item.line}</span> : null}
                </p>
                <p className="mt-0.5 text-[10.5px] text-slate-500">
                  {[item.kind, item.label ? `${item.label}` : null].filter(Boolean).join(" · ") || "indexed file"}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <InternalLink href={item.openHref}>
                  <FileCode2 className="h-3 w-3" /> Edit
                </InternalLink>
                <InternalLink href={item.explorerHref}>
                  <FolderOpen className="h-3 w-3" /> Locate
                </InternalLink>
              </div>
            </div>
            {item.snippet && (
              <pre className="code-scroll mt-2 max-h-28 overflow-auto rounded border border-ink-700/60 bg-ink-950/80 px-2 py-1.5 text-[11px] text-slate-400">
                {item.snippet}
              </pre>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (block.type === "errors") {
    return (
      <div className="space-y-2">
        {block.title && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{block.title}</p>}
        {block.items.map((item) => (
          <div key={item.id} className="rounded-lg border border-ink-700/70 bg-ink-950/50 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${SEVERITY_TONE[item.severity] ?? SEVERITY_TONE.minor}`}>
                {item.severity}
              </span>
              <span className="rounded-full border border-ink-600/60 bg-ink-800/60 px-2 py-0.5 text-[10px] text-slate-300">{item.code}</span>
              <span className="text-[10px] text-slate-500">
                {item.occurrences}× · {item.source}
              </span>
            </div>
            <p className="mt-1.5 text-[12.5px] font-medium text-slate-100">{item.title}</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">
              <span className="text-slate-500">Cause: </span>
              {item.rootCause}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-emerald-200/80">
              <span className="text-slate-500">Fix: </span>
              {item.recommendation}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              {item.filePath && (
                <span className="mono truncate text-[10.5px] text-slate-500" title={item.filePath}>
                  {item.filePath}
                  {item.line ? `:${item.line}` : ""}
                </span>
              )}
              <InternalLink href={item.href}>Open record</InternalLink>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (block.type === "diagnostics") {
    return (
      <div className="rounded-xl border border-ink-700/70 bg-ink-950/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{block.title ?? "Diagnostics"}</p>
          <span className="text-[10px] text-slate-600">{new Date(block.at).toLocaleTimeString()}</span>
        </div>
        <ul className="space-y-1.5">
          {block.findings.map((finding) => {
            const Icon = STATUS_ICON[finding.status] ?? STATUS_ICON.unknown;
            return (
              <li
                key={finding.id}
                className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] ${STATUS_TONE[finding.status] ?? STATUS_TONE.unknown}`}
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-100">{finding.label}</p>
                  <p className="text-slate-400">{finding.detail}</p>
                </div>
                {finding.href && <InternalLink href={finding.href}>Open</InternalLink>}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (block.type === "links") {
    return (
      <div className="space-y-1.5">
        {block.title && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{block.title}</p>}
        {block.items.map((item, index) =>
          item.href ? (
            <Link
              key={`${item.label}-${index}`}
              href={item.href}
              className="flex items-start justify-between gap-2 rounded-lg border border-ink-700/70 bg-ink-950/40 px-2.5 py-1.5 text-[12px] text-slate-200 transition hover:border-accent/40 hover:bg-ink-900/60"
            >
              <span className="min-w-0">
                <span className="block">{item.label}</span>
                {item.detail && <span className="mt-0.5 block text-[10.5px] leading-relaxed text-slate-500">{item.detail}</span>}
              </span>
              <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0 text-slate-500" />
            </Link>
          ) : (
            <div key={`${item.label}-${index}`} className="flex items-start gap-2 text-[12px] text-slate-300">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent/70" />
              <span>{item.label}</span>
            </div>
          ),
        )}
      </div>
    );
  }

  if (block.type === "report") {
    return (
      <div className="rounded-xl border border-ink-700/70 bg-ink-950/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{block.title}</p>
          <button
            type="button"
            className="btn-ghost !px-2 !py-1 text-[10px]"
            onClick={() => void navigator.clipboard.writeText(block.markdown)}
          >
            Copy
          </button>
        </div>
        <pre className="code-scroll max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950/80 px-3 py-2 text-[11px] text-slate-300">
          {block.markdown}
        </pre>
      </div>
    );
  }

  return null;
}
