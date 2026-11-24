import 'server-only';
import { headers } from 'next/headers';
import { jsonb, query } from './db';
import type { Principal } from './auth/permissions';

export interface AuditInput {
  user?: Pick<Principal, 'id' | 'email'> | null;
  serverId?: string | null;
  action: string;
  target?: string | null;
  severity?: 'info' | 'warning' | 'critical';
  detail?: Record<string, unknown>;
}

/** Append-only audit trail. Never store credentials or file contents here. */
export async function logActivity(input: AuditInput): Promise<void> {
  let ip = '';
  let userAgent = '';
  try {
    const h = await headers();
    ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? '';
    userAgent = h.get('user-agent') ?? '';
  } catch {
    /* headers() is unavailable outside a request scope (e.g. background job) */
  }
  try {
    await query(
      `insert into activity_logs (user_id, user_email, server_id, action, target, severity, ip, user_agent, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        input.user?.id ?? null,
        input.user?.email ?? null,
        input.serverId ?? null,
        input.action,
        input.target ?? null,
        input.severity ?? 'info',
        ip,
        userAgent,
        jsonb(input.detail ?? {}),
      ],
    );
  } catch (error) {
    // Auditing must never break the operation it observes, but it must be visible.
    // eslint-disable-next-line no-console
    console.error('[darknote] failed to write audit log', error);
  }
}
