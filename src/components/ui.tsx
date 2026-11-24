"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { statusStyle } from "@/lib/format";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-750/70 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`px-4 py-4 sm:px-5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad" | "accent";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : tone === "accent"
            ? "text-accent-soft"
            : "text-slate-100";
  return (
    <div className="panel-flat px-3.5 py-3">
      <p className="label">{label}</p>
      <p className={`mt-1.5 truncate text-lg font-semibold tracking-tight ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function Status({ status, label }: { status: string | null | undefined; label?: string }) {
  const style = statusStyle(status);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${style.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot} ${style.dot.includes("amber") || style.dot.includes("sky") ? "animate-pulseSoft" : ""}`} />
      {label ?? style.label}
    </span>
  );
}

export function Badge({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad" | "accent" | "cyber";
}) {
  const tones: Record<string, string> = {
    default: "border-ink-600/70 bg-ink-800/70 text-slate-300",
    good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    bad: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    accent: "border-accent/40 bg-accent/10 text-accent-soft",
    cyber: "border-cyber/30 bg-cyber/10 text-cyber",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Meter({ value, max, label }: { value: number; max: number | null; label?: string }) {
  const pct = max && max > 0 ? Math.min(100, Math.round((value / max) * 100)) : null;
  const tone = pct === null ? "bg-slate-600" : pct > 85 ? "bg-rose-400" : pct > 65 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div>
      {label && (
        <div className="mb-1 flex justify-between text-[11px] text-slate-500">
          <span>{label}</span>
          <span>{pct === null ? "no limit" : `${pct}%`}</span>
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${pct ?? 100}%`, opacity: pct === null ? 0.4 : 1 }} />
      </div>
    </div>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-700/70 px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint && <p className="max-w-md text-xs leading-relaxed text-slate-500">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 className={`h-4 w-4 animate-spin ${className}`} />;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-ink-600/70 bg-ink-900 shadow-2xl sm:rounded-xl ${
          wide ? "sm:max-w-5xl" : "sm:max-w-lg"
        }`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-ink-750 px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-100">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-ink-800 hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-ink-750 px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  danger = false,
  requireText,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const blocked = Boolean(requireText) && typed.trim() !== requireText;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={blocked || busy}
          >
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-300">
        <div className="leading-relaxed">{description}</div>
        {requireText && (
          <div>
            <p className="mb-1 text-xs text-slate-500">
              Type <span className="mono text-slate-300">{requireText}</span> to confirm
            </p>
            <input className="field mono" value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
          </div>
        )}
      </div>
    </Modal>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn-ghost !px-2 !py-1 text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard permissions can be denied; the value stays selectable.
        }
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ code, maxHeight = 320 }: { code: string; maxHeight?: number }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <pre
      ref={ref}
      className="code-scroll overflow-auto rounded-lg border border-ink-700/70 bg-ink-950/80 px-3 py-2.5 text-slate-300"
      style={{ maxHeight }}
    >
      {code}
    </pre>
  );
}
