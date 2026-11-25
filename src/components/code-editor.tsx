"use client";

import dynamic from "next/dynamic";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { editor as MonacoEditorNamespace } from "monaco-editor";
import { Spinner } from "@/components/ui";
import { bootstrapMonaco } from "@/lib/editor/monaco";

/**
 * The code surface.
 *
 * Four things used to make this blank while the file header still rendered:
 *
 * 0. `dynamic(() => import("@monaco-editor/react"))` handed React the module
 *    namespace instead of the `Editor` component. React had no valid element
 *    type for the surface, so the header rendered and the code area did not.
 *    The import below selects `mod.Editor` explicitly.
 * 1. The wrapper was `h-[calc(100%-52px)]` inside a parent with no height, so the
 *    percentage resolved to `auto`; @monaco-editor/react then applied
 *    `height: 100%` to a zero-height box and Monaco laid out a 0 px editor. The
 *    editor is now measured with a ResizeObserver and given an explicit pixel
 *    height, so it can never be 0.
 * 2. Monaco was loaded from a CDN. When that host is unreachable the loader never
 *    resolves and the area stays empty forever. It is now served from this origin
 *    (see lib/editor/monaco.ts).
 * 3. Any failure was silent. Failures now fall through to a plain-text surface
 *    that renders the same file contents, with the reason shown.
 */

const MonacoSurface = dynamic(() => import("@monaco-editor/react").then((mod) => mod.Editor), {
  ssr: false,
});

/** Monaco measures glyphs through canvas, which does not understand `var(--x)`. */
const MONO_FONT =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export interface CodeEditorProps {
  /** Model identity. Changing it swaps the buffer, like switching tabs. */
  path: string;
  value: string;
  language: string;
  large: boolean;
  readOnly?: boolean;
  /** Soft-wrap long lines. Off by default so horizontal scrolling is preserved. */
  wrap?: boolean;
  onChange: (value: string) => void;
  onMount?: (editor: any, monaco: any) => void;
}

type Phase = "loading" | "ready" | "plain";

class SurfaceBoundary extends Component<
  { fallback: ReactNode; onError: (message: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error instanceof Error ? error.message : String(error));
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PlainSurface({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <textarea
      className="mono h-full w-full resize-none overflow-auto whitespace-pre bg-[#0b0d13] p-3 text-[12px] leading-[1.6] text-slate-100 outline-none"
      style={{ tabSize: 2, cursor: readOnly ? "default" : "text" }}
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      wrap="off"
      aria-label="Source code"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function CodeEditor({
  path,
  value,
  language,
  large,
  readOnly,
  wrap = false,
  onChange,
  onMount,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<any>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [phase, setPhase] = useState<Phase>("loading");
  const [failure, setFailure] = useState<string | null>(null);

  // Measure the host instead of trusting percentage heights: a 0 px size is the
  // one thing that makes Monaco render absolutely nothing.
  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;

    const measure = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setBox((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };

    measure();
    // Older Android WebViews have no ResizeObserver; the window listeners below
    // still keep the editor sized instead of throwing during mount.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    bootstrapMonaco()
      .then(() => {
        if (alive) setPhase("ready");
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setPhase("plain");
      });
    return () => {
      alive = false;
    };
  }, []);

  const fallbackHeight = useMemo(() => {
    if (typeof window === "undefined") return 420;
    return Math.max(320, Math.round(window.innerHeight * 0.55));
  }, []);
  const height = box.height >= 80 ? box.height : fallbackHeight;

  const options = useMemo<MonacoEditorNamespace.IStandaloneEditorConstructionOptions>(() => {
    const compact = typeof window !== "undefined" && window.innerWidth < 640;
    return {
      readOnly: Boolean(readOnly),
      largeFileOptimizations: true,
      occurrencesHighlight: large ? "off" : "singleFile",
      minimap: { enabled: !large && !compact },
      fontSize: compact ? 12 : 13,
      fontFamily: MONO_FONT,
      // Wrapping is a deliberate toggle. Off by default so a long source line
      // scrolls sideways instead of disappearing past the right edge.
      wordWrap: wrap ? "on" : "off",
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 6,
      glyphMargin: false,
      folding: !large,
      autoIndent: "full",
      bracketPairColorization: { enabled: !large },
      matchBrackets: large ? "never" : "always",
      automaticLayout: true,
      tabSize: 2,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      padding: { top: 10, bottom: 24 },
      quickSuggestions: !large,
      suggestOnTriggerCharacters: !large,
      wordBasedSuggestions: large ? "off" : "currentDocument",
      codeLens: false,
      renderWhitespace: "selection",
      maxTokenizationLineLength: large ? 2000 : 20000,
      renderLineHighlight: large ? "none" : "line",
      stickyScroll: { enabled: false },
      // Long lines must scroll inside the editor, and the find widget must not be
      // clipped by the panel's `overflow-hidden`.
      fixedOverflowWidgets: true,
      overviewRulerLanes: compact ? 0 : 3,
      hideCursorInOverviewRuler: compact,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        alwaysConsumeMouseWheel: false,
        useShadows: false,
      },
      contextmenu: !compact,
      mouseWheelZoom: false,
      accessibilitySupport: "auto",
    };
  }, [large, readOnly, wrap]);

  const handleError = useCallback((message: string) => {
    setFailure(message);
    setPhase("plain");
  }, []);

  /**
   * Monaco lays out against its container at mount time. `automaticLayout` is
   * enough most of the time, but an editor created while the page was still
   * settling can keep a stale 0 px viewport. Re-measuring explicitly means the
   * visible area always matches the host box.
   */
  useEffect(() => {
    if (phase !== "ready" || !editorRef.current) return;
    if (box.width < 1 || box.height < 1) return;
    editorRef.current.layout({ width: box.width, height: box.height });
  }, [phase, box.width, box.height]);

  /**
   * Last line of defence: if Monaco is mounted but its model is empty while the
   * file clearly is not, push the real text into it. If that still fails, show
   * the plain-text surface (same bytes) instead of an empty box.
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const timer = setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const expected = valueRef.current;
      try {
        const model = editor.getModel();
        if (expected.length > 0 && (!model || model.getValueLength() === 0)) {
          editor.setValue(expected);
        }
        if (expected.length > 0 && editor.getModel()?.getValueLength() === 0) {
          handleError("the editor model stayed empty after loading the file");
        }
      } catch (error) {
        handleError(error instanceof Error ? error.message : String(error));
      }
    }, 1_200);
    return () => clearTimeout(timer);
  }, [phase, path, handleError]);

  const plain = (
    <PlainSurface value={value} onChange={onChange} readOnly={readOnly} />
  );

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-[#0b0d13]">
      {phase === "ready" ? (
        <SurfaceBoundary fallback={plain} onError={handleError}>
          <MonacoSurface
            height={height}
            width="100%"
            path={path}
            language={language}
            value={value}
            theme="vs-dark"
            options={options}
            onChange={(next) => onChange(next ?? "")}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              // The model is created before layout in some Android WebViews; if
              // its value is missing, seed it from the file we were given.
              const model = editor.getModel();
              if (value.length > 0 && (!model || model.getValueLength() === 0)) {
                editor.setValue(value);
              }
              const host = hostRef.current;
              if (host) {
                const rect = host.getBoundingClientRect();
                editor.layout({
                  width: Math.max(1, Math.round(rect.width)),
                  height: Math.max(80, Math.round(rect.height)),
                });
              }
              onMount?.(editor, monaco);
            }}
          />
        </SurfaceBoundary>
      ) : (
        <div className="flex h-full w-full flex-col">
          {phase === "plain" && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-tight text-amber-200">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1">
                Plain editor — Monaco could not start ({failure ?? "unknown error"}). The text below is
                the real file content and stays editable.
              </span>
              <button
                className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-400/40 px-1.5 py-0.5 hover:bg-amber-400/10"
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="h-2.5 w-2.5" /> Reload
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">{plain}</div>
          {phase === "loading" && (
            <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900/90 px-2 py-1 text-[10px] text-slate-400">
              <Spinner /> Starting editor…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
