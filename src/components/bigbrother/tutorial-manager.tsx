"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, Plus, Trash2 } from "lucide-react";
import { Modal, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { api, apiDelete, apiPatch, apiPost, errorMessage } from "@/lib/client";
import { NAV_PAGES } from "@/lib/bigbrother/content";

type Asset = { id: string; filename: string; mime: string; sizeBytes: number; url: string; createdAt: string };
type Step = { id: string; index: number; title: string; body: string; assetId: string | null; assetUrl: string | null; link: string | null };
type Tutorial = {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  published: boolean;
  steps: Step[];
  updatedAt: string;
};

interface DraftStep {
  title: string;
  body: string;
  link: string;
  assetId: string | null;
}

const EMPTY_STEP: DraftStep = { title: "", body: "", link: "", assetId: null };

/**
 * Tutorial studio: create a tutorial, order its steps, attach screenshots and
 * link a step to a real Control Center page. Images are uploaded to the
 * authenticated asset endpoint and referenced by id.
 */
export function TutorialManager({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { push } = useToast();
  const [tab, setTab] = useState<"tutorials" | "images">("tutorials");
  const [loading, setLoading] = useState(false);
  const [tutorials, setTutorials] = useState<Tutorial[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [editing, setEditing] = useState<Tutorial | "new" | null>(null);

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [keywords, setKeywords] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([{ ...EMPTY_STEP }]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const stepFileInput = useRef<HTMLInputElement>(null);
  const stepTarget = useRef<number>(0);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ tutorials: Tutorial[]; assets: Asset[] }>("/api/bigbrother/tutorials");
      setTutorials(data.tutorials);
      setAssets(data.assets);
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) {
      setEditing(null);
      setTab("tutorials");
    }
  }, [open]);

  const beginEdit = (tutorial: Tutorial | "new") => {
    setEditing(tutorial);
    if (tutorial === "new") {
      setTitle("");
      setSummary("");
      setKeywords("");
      setSteps([{ ...EMPTY_STEP }]);
      return;
    }
    setTitle(tutorial.title);
    setSummary(tutorial.summary);
    setKeywords(tutorial.keywords.join(", "));
    setSteps(
      tutorial.steps.length
        ? tutorial.steps.map((step) => ({
            title: step.title,
            body: step.body,
            link: step.link ?? "",
            assetId: step.assetId,
          }))
        : [{ ...EMPTY_STEP }],
    );
  };

  const uploadFile = async (file: File, targetIndex?: number) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await api<{ asset: Asset }>("/api/bigbrother/assets", { method: "POST", body: form });
      setAssets((current) => [data.asset, ...current]);
      if (typeof targetIndex === "number") {
        setSteps((current) =>
          current.map((step, index) => (index === targetIndex ? { ...step, assetId: data.asset.id } : step)),
        );
      }
      push("Image uploaded", "ok");
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!title.trim()) {
      push("A tutorial needs a title.", "error");
      return;
    }
    const payload = {
      title: title.trim(),
      summary: summary.trim(),
      keywords: keywords
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean),
      steps: steps
        .filter((step) => step.title.trim() && step.body.trim())
        .map((step) => ({
          title: step.title.trim(),
          body: step.body.trim(),
          link: step.link.trim() || null,
          assetId: step.assetId,
        })),
    };
    if (!payload.steps.length) {
      push("Add at least one step with a title and text.", "error");
      return;
    }

    setSaving(true);
    try {
      if (editing === "new") {
        await apiPost("/api/bigbrother/tutorials", payload);
      } else if (editing) {
        await apiPatch(`/api/bigbrother/tutorials/${editing.id}`, payload);
      }
      push("Tutorial saved", "ok");
      setEditing(null);
      await load();
      onChanged?.();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };

  const removeTutorial = async (id: string) => {
    try {
      await apiDelete(`/api/bigbrother/tutorials/${id}`);
      push("Tutorial deleted", "ok");
      await load();
      onChanged?.();
    } catch (error) {
      push(errorMessage(error), "error");
    }
  };

  const removeAsset = async (id: string) => {
    try {
      await apiDelete(`/api/bigbrother/assets?id=${encodeURIComponent(id)}`);
      setAssets((current) => current.filter((asset) => asset.id !== id));
      setSteps((current) => current.map((step) => (step.assetId === id ? { ...step, assetId: null } : step)));
      push("Image deleted", "ok");
    } catch (error) {
      push(errorMessage(error), "error");
    }
  };

  const linkOptions = useMemo(() => NAV_PAGES.map((page) => ({ href: page.href, label: `${page.title} (${page.href})` })), []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="BIGBROTHER tutorials & images"
      subtitle="Upload your screenshots, attach them to steps, and link each step to a real page."
      footer={
        editing ? (
          <>
            <button className="btn-ghost" onClick={() => setEditing(null)} disabled={saving}>
              Back
            </button>
            <button className="btn-primary" onClick={() => void save()} disabled={saving || uploading}>
              {saving ? <Spinner /> : null} Save tutorial
            </button>
          </>
        ) : (
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <div className="mb-3 flex gap-1 rounded-lg border border-ink-700/70 bg-ink-950/50 p-1 text-xs">
        {(["tutorials", "images"] as const).map((value) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`flex-1 rounded-md px-3 py-1.5 capitalize transition ${
              tab === value ? "bg-accent/15 text-white" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {value} {value === "images" ? `(${assets.length})` : `(${tutorials.length})`}
          </button>
        ))}
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      )}

      {tab === "images" && !editing && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadFile(file);
                event.target.value = "";
              }}
            />
            <button className="btn-primary !py-1.5 text-xs" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <Spinner /> : <ImagePlus className="h-3.5 w-3.5" />} Upload image
            </button>
            <span className="text-[11px] text-slate-500">PNG, JPEG, GIF or WebP · up to 8 MB · verified by file bytes</span>
          </div>

          {assets.length === 0 ? (
            <p className="rounded-lg border border-dashed border-ink-600/60 px-3 py-6 text-center text-xs text-slate-500">
              No images yet. Upload the screenshots you want BIGBROTHER to show with a tutorial.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {assets.map((asset) => (
                <div key={asset.id} className="overflow-hidden rounded-lg border border-ink-700/70 bg-ink-950/50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={asset.url} alt={asset.filename} className="h-28 w-full object-cover" loading="lazy" />
                  <div className="flex items-center justify-between gap-1 px-2 py-1">
                    <span className="truncate text-[10px] text-slate-400" title={asset.filename}>
                      {asset.filename}
                    </span>
                    <button
                      className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                      onClick={() => void removeAsset(asset.id)}
                      aria-label={`Delete ${asset.filename}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "tutorials" && !editing && (
        <div className="space-y-2">
          <button className="btn-primary !py-1.5 text-xs" onClick={() => beginEdit("new")}>
            <Plus className="h-3.5 w-3.5" /> New tutorial
          </button>
          {tutorials.length === 0 ? (
            <p className="rounded-lg border border-dashed border-ink-600/60 px-3 py-6 text-center text-xs text-slate-500">
              No custom tutorials. Built-in procedures are always available; add one here to use your own screenshots.
            </p>
          ) : (
            tutorials.map((tutorial) => (
              <div key={tutorial.id} className="rounded-lg border border-ink-700/70 bg-ink-950/50 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium text-slate-100">{tutorial.title}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{tutorial.steps.length} step(s) · {tutorial.keywords.join(", ") || "no keywords"}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => beginEdit(tutorial)}>
                      Edit
                    </button>
                    <button
                      className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                      onClick={() => void removeTutorial(tutorial.id)}
                      aria-label="Delete tutorial"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {editing && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="label">Title</span>
              <input className="field mt-1" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Connect a Client API Key" />
            </label>
            <label className="block">
              <span className="label">Keywords (comma separated)</span>
              <input className="field mt-1" value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="api key, ptlc, panel" />
            </label>
          </div>
          <label className="block">
            <span className="label">Summary</span>
            <textarea className="field mt-1 min-h-[64px]" value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>

          <input
            ref={stepFileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file, stepTarget.current);
              event.target.value = "";
            }}
          />
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="label">Steps</p>
              <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => setSteps((current) => [...current, { ...EMPTY_STEP }])}>
                <Plus className="h-3 w-3" /> Add step
              </button>
            </div>

            {steps.map((step, index) => (
              <div key={index} className="rounded-lg border border-ink-700/70 bg-ink-950/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-400">Step {index + 1}</span>
                  {steps.length > 1 && (
                    <button
                      className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                      onClick={() => setSteps((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      aria-label="Remove step"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <input
                  className="field mb-2"
                  placeholder="Step title"
                  value={step.title}
                  onChange={(event) =>
                    setSteps((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, title: event.target.value } : item)))
                  }
                />
                <textarea
                  className="field mb-2 min-h-[70px]"
                  placeholder="What the user should do, and what they should see"
                  value={step.body}
                  onChange={(event) =>
                    setSteps((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, body: event.target.value } : item)))
                  }
                />
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="field !w-auto min-w-[180px] text-xs"
                    value={step.link}
                    onChange={(event) =>
                      setSteps((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, link: event.target.value } : item)))
                    }
                  >
                    <option value="">No page link</option>
                    {linkOptions.map((option) => (
                      <option key={option.href} value={option.href}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn-ghost !py-1 text-[10px]"
                    onClick={() => {
                      stepTarget.current = index;
                      stepFileInput.current?.click();
                    }}
                    disabled={uploading}
                  >
                    <ImagePlus className="h-3 w-3" /> {step.assetId ? "Replace image" : "Attach image"}
                  </button>
                  {step.assetId && (
                    <span className="flex items-center gap-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={assets.find((asset) => asset.id === step.assetId)?.url ?? ""}
                        alt=""
                        className="h-8 w-12 rounded border border-ink-600 object-cover"
                      />
                      <button className="text-[10px] text-rose-300 hover:underline" onClick={() => setSteps((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, assetId: null } : item)))}>
                        remove
                      </button>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
