"use client";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)dn_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);

  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD"].includes(method)) {
    headers.set("x-csrf-token", csrfToken());
  }

  const res = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });

  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) {
    window.location.href = "/login";
    throw new ApiError(401, "unauthorized", "Session expired");
  }

  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await res.json().catch(() => null) : null;

  const envelope = payload as
    | { ok?: boolean; data?: unknown; error?: string | { code?: string; message?: string; details?: unknown }; code?: string; details?: unknown }
    | null;

  if (!res.ok || envelope?.ok === false) {
    const raw = envelope?.error;
    const nested = raw && typeof raw === "object" ? raw : null;
    throw new ApiError(
      res.status,
      nested?.code ?? envelope?.code ?? `http_${res.status}`,
      (typeof raw === "string" ? raw : nested?.message) ?? `Request failed (${res.status})`,
      nested?.details ?? envelope?.details,
    );
  }

  // Successful responses are wrapped as { ok: true, data: <payload> }.
  if (envelope && typeof envelope === "object" && "data" in envelope) return envelope.data as T;
  return payload as T;
}

export const apiGet = <T,>(path: string) => api<T>(path);
export const apiPost = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPut = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiDelete = <T,>(path: string) => api<T>(path, { method: "DELETE" });

/** Downloads through the authenticated API and saves the blob. */
export async function download(
  path: string,
  filename?: string,
): Promise<{ name: string; sha256: string | null }> {
  const res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: string | { code?: string; message?: string }; code?: string }
      | null;
    const raw = payload?.error;
    throw new ApiError(
      res.status,
      (raw && typeof raw === "object" ? raw.code : undefined) ?? payload?.code ?? "download_failed",
      (raw && typeof raw === "object" ? raw.message : raw) ?? `Download failed (${res.status})`,
    );
  }

  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  const name = filename ?? match?.[1] ?? "download.bin";

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  return { name, sha256: res.headers.get("x-darknote-sha256") };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
