import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodSchema } from 'zod';
import { currentCsrfToken, requirePermission, requireUser, type SessionUser } from './auth/session';
import type { Permission } from './auth/permissions';
import { PterodactylError } from './pterodactyl/client';
import { PathError } from './security/paths';
import { captureError } from './errors/store';
import type { ErrorSource } from './errors/types';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, status = 400, code = 'bad_request', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export interface FailContext {
  method?: string;
  path?: string;
  userId?: string | null;
  serverId?: string | null;
}

function sourceForPath(pathname: string | undefined): ErrorSource {
  if (!pathname) return 'api';
  if (/^\/api\/auth\b/.test(pathname)) return 'auth';
  if (/^\/api\/files\b|^\/api\/downloads\b/.test(pathname)) return 'files';
  if (/^\/api\/drafts\b|^\/api\/versions\b/.test(pathname)) return 'editor';
  if (/^\/api\/deployments\b/.test(pathname)) return 'deployment';
  if (/^\/api\/backups\b/.test(pathname)) return 'storage';
  if (/^\/api\/console\b/.test(pathname)) return 'console';
  if (/^\/api\/monitor\b/.test(pathname)) return 'console';
  if (/^\/api\/servers\b/.test(pathname)) return 'panel';
  return 'api';
}

/**
 * Record a failed request in Error Intelligence. Deliberately runs after the
 * response shape is decided and can never throw into the caller.
 */
function recordFailure(error: unknown, context: FailContext, status: number, code: string): void {
  const pathname = context.path;
  const isPanel = error instanceof PterodactylError;
  const source: ErrorSource = isPanel
    ? 'panel'
    : error instanceof PathError
      ? sourceForPath(pathname) === 'api'
        ? 'files'
        : sourceForPath(pathname)
      : code === 'csrf_failed' || code === 'unauthenticated' || code === 'forbidden'
        ? 'auth'
        : sourceForPath(pathname);

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'An unknown failure occurred';

  const pterodactyl = error instanceof PterodactylError ? error : null;
  captureError({
    message,
    source,
    code: pterodactyl?.code ?? code,
    stack: error instanceof Error ? error.stack ?? null : null,
    serverId: context.serverId ?? null,
    userId: context.userId ?? null,
    endpoint: pterodactyl?.endpoint || pathname || null,
    httpMethod: context.method ?? null,
    httpStatus: pterodactyl?.status || status,
    context: {
      route: pathname ?? null,
      errorName: error instanceof Error ? error.name : typeof error,
    },
  });
}

export function fail(error: unknown, context: FailContext = {}): NextResponse {
  if (error instanceof ApiError) {
    // Confirmation prompts and "already applied" are user intent, not failures.
    if (!['confirmation_required'].includes(error.code)) {
      recordFailure(error, context, error.status, error.code);
    }
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    recordFailure(error, context, 422, 'validation_error');
    return NextResponse.json(
      {
        ok: false,
        error: 'Validation failed',
        code: 'validation_error',
        details: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
      },
      { status: 422 },
    );
  }
  if (error instanceof PathError) {
    recordFailure(error, context, 400, 'unsafe_path');
    return NextResponse.json({ ok: false, error: error.message, code: 'unsafe_path' }, { status: 400 });
  }
  if (error instanceof PterodactylError) {
    recordFailure(error, context, error.status || 502, error.code);
    if (error.code === 'file_too_large') {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code, details: { endpoint: error.endpoint } },
        { status: 413 },
      );
    }
    const status =
      error.isAuthError ? 424 : error.isNotFound ? 404 : error.isRateLimited ? 429 : error.status === 413 ? 413 : 502;
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        code: error.code,
        details: { status: error.status, endpoint: error.endpoint },
      },
      { status },
    );
  }
  const statusCode = (error as { statusCode?: number })?.statusCode;
  if (statusCode === 401) {
    recordFailure(error, context, 401, 'unauthenticated');
    return NextResponse.json({ ok: false, error: 'Not authenticated', code: 'unauthenticated' }, { status: 401 });
  }
  if (statusCode === 403) {
    recordFailure(error, context, 403, 'forbidden');
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  recordFailure(error, context, 500, 'server_error');
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error('[darknote] api error:', error);
  }
  return NextResponse.json({ ok: false, error: message, code: 'server_error' }, { status: 500 });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function assertCsrf(req: NextRequest): Promise<void> {
  if (!MUTATING.has(req.method)) return;
  const header = req.headers.get('x-csrf-token');
  const expected = await currentCsrfToken();
  if (!expected || !header || header !== expected) {
    throw new ApiError('CSRF validation failed. Reload the page and try again.', 403, 'csrf_failed');
  }
  const origin = req.headers.get('origin');
  if (origin) {
    const host = req.headers.get('host');
    try {
      if (new URL(origin).host !== host) {
        throw new ApiError('Cross-origin request rejected.', 403, 'bad_origin');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('Invalid Origin header.', 403, 'bad_origin');
    }
  }
}

type Params = Record<string, string>;

interface HandlerArgs<P extends Params> {
  req: NextRequest;
  user: SessionUser;
  params: P;
  body: <T>(schema: ZodSchema<T>) => Promise<T>;
}

export function route<P extends Params = Params>(
  options: { permission: Permission | null; csrf?: boolean },
  handler: (args: HandlerArgs<P>) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    let actor: SessionUser | null = null;
    try {
      if (options.csrf !== false) await assertCsrf(req);
      const user = options.permission ? await requirePermission(options.permission) : await requireUser();
      actor = user;
      const params = ctx?.params ? await ctx.params : ({} as P);
      const body = async <T>(schema: ZodSchema<T>): Promise<T> => {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          raw = {};
        }
        return schema.parse(raw);
      };
      return await handler({ req, user, params, body });
    } catch (error) {
      return fail(error, {
        method: req.method,
        path: new URL(req.url).pathname,
        userId: actor?.id ?? null,
        serverId: new URL(req.url).searchParams.get('serverId'),
      });
    }
  };
}

export function publicRoute(handler: (req: NextRequest) => Promise<Response>) {
  return async (req: NextRequest): Promise<Response> => {
    try {
      return await handler(req);
    } catch (error) {
      return fail(error);
    }
  };
}

/** Small in-process limiter; keeps a single client from hammering the panel. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new ApiError('Slow down — too many requests. Try again shortly.', 429, 'rate_limited');
  }
}

export function searchParams(req: NextRequest): URLSearchParams {
  return new URL(req.url).searchParams;
}
