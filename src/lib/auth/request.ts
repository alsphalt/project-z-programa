import 'server-only';
import type { NextRequest } from 'next/server';
import { env } from '../env';
import { resolveRelyingParty, type RelyingParty } from './webauthn';

/** The relying party for this request: origin(s) + rpId, derived from headers. */
export function relyingPartyFrom(req: NextRequest): RelyingParty {
  return resolveRelyingParty({
    originHeader: req.headers.get('origin'),
    hostHeader: req.headers.get('host'),
    appUrl: env.appUrl || null,
    rpName: 'DARKNOTE',
  });
}

export function requestIp(req: NextRequest): string {
  if (env.trustProxy) {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    const real = req.headers.get('x-real-ip');
    if (real) return real;
  }
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function requestUserAgent(req: NextRequest): string {
  return req.headers.get('user-agent') ?? '';
}
