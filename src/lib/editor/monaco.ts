"use client";

/**
 * Monaco bootstrap.
 *
 * The editor is served from this origin (`/monaco/vs`, copied at build time by
 * scripts/copy-monaco.mjs) so a phone on a network that blocks the CDN still gets
 * a working editor. If the local copy is missing the CDN is used instead, and if
 * neither is reachable the caller switches to the plain-text surface — which shows
 * the same file contents rather than an empty box.
 *
 * @monaco-editor/loader can only be initialised once per page: `init()` flips an
 * internal `isInitialized` flag and caches a single promise, so a failed load can
 * never be retried with a different `paths.vs`. That is why the base URL is
 * decided *before* the first init call, and why the UI offers a page reload
 * instead of an in-place retry.
 */
import { loader } from "@monaco-editor/react";

/** Kept in step with the `monaco-editor` version in package.json. */
const MONACO_VERSION = "0.52.2";

export const LOCAL_MONACO_BASE = "/monaco/vs";
export const CDN_MONACO_BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;

export interface MonacoBootstrap {
  base: string;
  /** Monaco namespace (`monaco.editor`, `monaco.Range`, …). */
  monaco: any;
}

let pending: Promise<MonacoBootstrap> | null = null;

async function reachable(url: string, timeoutMs = 8_000): Promise<boolean> {
  if (typeof fetch !== "function") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "same-origin" });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve Monaco once per page load.
 *
 * The returned promise is cached (including its rejection) because Monaco's
 * loader cannot be re-initialised after a failure.
 */
export function bootstrapMonaco(): Promise<MonacoBootstrap> {
  if (pending) return pending;

  pending = (async () => {
    const localAvailable = await reachable(`${LOCAL_MONACO_BASE}/loader.js`);
    const base = localAvailable ? LOCAL_MONACO_BASE : CDN_MONACO_BASE;

    if (!localAvailable && !(await reachable(`${CDN_MONACO_BASE}/loader.js`))) {
      throw new Error(
        `Monaco is not reachable: ${LOCAL_MONACO_BASE}/loader.js is missing on this deployment and the CDN is blocked on this network.`,
      );
    }

    loader.config({ paths: { vs: base } });
    const monaco = await loader.init();
    if (!monaco || !monaco.editor) {
      throw new Error("Monaco returned no editor API — the loaded script is not monaco-editor.");
    }
    return { base, monaco };
  })();

  return pending;
}

/** Test seam: forget the cached bootstrap (never used in the UI). */
export function resetMonacoBootstrapForTests(): void {
  pending = null;
}
