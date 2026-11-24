import 'server-only';
import { ApiError } from '../api';
import { jsonb, parseJsonb, query, queryOne } from '../db';
import { randomToken, uuid } from '../crypto';
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  describeDevice,
  fromBase64Url,
  toBase64Url,
  verifyAuthentication,
  verifyRegistration,
  type AuthenticationResponseInput,
  type RegistrationResponseInput,
  type RelyingParty,
} from './webauthn';

/**
 * Passkey / biometric credential storage and ceremony handling.
 *
 * The rules this module enforces:
 *  - a challenge is issued by us, stored server-side, single-use and short-lived;
 *  - enrolling requires a signed-in account; signing in requires a credential we
 *    enrolled for an active account;
 *  - only public keys, counters and device metadata are stored — never a
 *    biometric sample, and never a private key;
 *  - a credential can be revoked by the owner (or an administrator) at any time,
 *    and revocation is immediate.
 */

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  algorithm: number;
  counter: string | number;
  transports: unknown;
  device_label: string | null;
  attachment: string | null;
  aaguid: string | null;
  backup_eligible: boolean;
  backup_state: boolean;
  user_verified: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CredentialView {
  id: string;
  label: string;
  attachment: string | null;
  transports: string[];
  backupEligible: boolean;
  backupState: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  aaguid: string | null;
}

function toView(row: CredentialRow): CredentialView {
  return {
    id: row.id,
    label: row.device_label || 'Biometric device',
    attachment: row.attachment,
    transports: parseJsonb<string[]>(row.transports, []),
    backupEligible: Boolean(row.backup_eligible),
    backupState: Boolean(row.backup_state),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    aaguid: row.aaguid,
  };
}

export async function listCredentials(userId: string): Promise<CredentialView[]> {
  const rows = await query<CredentialRow>(
    `select * from webauthn_credentials
      where user_id = $1 and revoked_at is null
      order by created_at desc`,
    [userId],
  );
  return rows.map(toView);
}

export async function countCredentials(userId: string): Promise<number> {
  const row = await queryOne<{ count: string | number }>(
    `select count(*)::int as count from webauthn_credentials where user_id = $1 and revoked_at is null`,
    [userId],
  );
  return Number(row?.count ?? 0);
}

/**
 * Revocation is a soft delete: the row stays for the audit trail, but the
 * credential can never authenticate again (`revoked_at is not null` is a filter,
 * not a hint).
 */
export async function revokeCredential(options: {
  credentialRowId: string;
  userId: string;
  actorId: string;
  allowAnyUser?: boolean;
}): Promise<boolean> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `select id, user_id from webauthn_credentials where id = $1 and revoked_at is null`,
    [options.credentialRowId],
  );
  if (!row) return false;
  if (!options.allowAnyUser && row.user_id !== options.userId) return false;
  await query(`update webauthn_credentials set revoked_at = now(), revoked_by = $2 where id = $1`, [
    row.id,
    options.actorId,
  ]);
  return true;
}

async function issueChallenge(input: {
  purpose: 'register' | 'authenticate';
  userId: string | null;
  rp: RelyingParty;
  ip: string;
  userAgent: string;
}): Promise<string> {
  const challenge = toBase64Url(randomToken(32));
  const id = uuid();
  await query(
    `insert into webauthn_challenges (id, challenge, purpose, user_id, rp_id, origin, ip, user_agent, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
    [
      id,
      challenge,
      input.purpose,
      input.userId,
      input.rp.id,
      input.rp.origins[0] ?? '',
      input.ip,
      input.userAgent,
      new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    ],
  );
  // Opportunistic cleanup: expired challenges are worthless, keep the table tiny.
  await query(`delete from webauthn_challenges where expires_at < now() - interval '1 hour'`).catch(() => undefined);
  return challenge;
}

interface ChallengeRow {
  id: string;
  challenge: string;
  purpose: string;
  user_id: string | null;
  rp_id: string | null;
  origin: string | null;
  expires_at: string;
  used_at: string | null;
}

/**
 * Consume a challenge exactly once. The `used_at is null` guard in the UPDATE is
 * what makes a replayed response fail even if two requests arrive together.
 */
async function consumeChallenge(input: {
  purpose: 'register' | 'authenticate';
  rpId: string;
  userId?: string | null;
}): Promise<ChallengeRow> {
  const row = await queryOne<ChallengeRow>(
    `update webauthn_challenges
        set used_at = now()
      where id = (
        select id from webauthn_challenges
         where purpose = $1 and used_at is null and expires_at > now() and rp_id = $2
           ${
             input.userId === undefined
               ? ''
               : // A challenge issued without an email ("sign in with your device") has
                 // no user attached; it is still single-use and rp-bound, and the
                 // assertion is verified against the credential's own key.
                 'and (user_id is not distinct from $3 or user_id is null)'
           }
         order by created_at desc limit 1
      )
      returning *`,
    input.userId === undefined ? [input.purpose, input.rpId] : [input.purpose, input.rpId, input.userId],
  );
  if (!row) {
    throw new ApiError(
      'This biometric ceremony has expired or was already used. Start again — nothing was changed.',
      400,
      'challenge_missing',
    );
  }
  return row;
}

export interface RegistrationOptionsResult {
  options: ReturnType<typeof buildRegistrationOptions>;
  challenge: string;
  relyingParty: { id: string; name: string };
}

export async function registrationOptions(input: {
  user: { id: string; email: string; name: string };
  rp: RelyingParty;
  ip: string;
  userAgent: string;
  requireUserVerification: boolean;
}): Promise<RegistrationOptionsResult> {
  const existing = await query<{ credential_id: string; transports: unknown }>(
    `select credential_id, transports from webauthn_credentials where user_id = $1 and revoked_at is null`,
    [input.user.id],
  );
  const challenge = await issueChallenge({
    purpose: 'register',
    userId: input.user.id,
    rp: input.rp,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  const options = buildRegistrationOptions({
    rp: input.rp,
    user: input.user,
    challenge,
    excludeCredentials: existing.map((row) => ({
      id: row.credential_id,
      transports: parseJsonb<string[]>(row.transports, []),
    })),
    requireUserVerification: input.requireUserVerification,
  });
  return { options, challenge, relyingParty: { id: input.rp.id, name: input.rp.name } };
}

export interface EnrolResult {
  credential: CredentialView;
  credentialId: string;
}

export async function enrolCredential(input: {
  user: { id: string; email: string; name: string };
  response: RegistrationResponseInput;
  rp: RelyingParty;
  requireUserVerification: boolean;
  ip: string;
  userAgent: string;
  label?: string | null;
}): Promise<EnrolResult> {
  const challenge = await consumeChallenge({ purpose: 'register', rpId: input.rp.id, userId: input.user.id });
  const verified = verifyRegistration({
    response: input.response,
    expectedChallenge: challenge.challenge,
    rp: input.rp,
    requireUserVerification: input.requireUserVerification,
  });

  const duplicate = await queryOne<{ id: string }>(
    `select id from webauthn_credentials where credential_id = $1`,
    [verified.credentialId],
  );
  if (duplicate) {
    throw new ApiError(
      'This device is already enrolled. Sign in with it, or remove it from the device list first.',
      409,
      'credential_exists',
    );
  }

  const id = uuid();
  const label = (input.label ?? '').trim().slice(0, 80) || describeDevice(input.userAgent);
  const row = await queryOne<CredentialRow>(
    `insert into webauthn_credentials
       (id, user_id, credential_id, public_key, algorithm, counter, transports, device_label, attachment,
        aaguid, backup_eligible, backup_state, user_verified, last_ip)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      id,
      input.user.id,
      verified.credentialId,
      toBase64Url(verified.publicKey),
      verified.algorithm,
      verified.counter,
      jsonb(verified.transports),
      label,
      verified.attachment,
      verified.aaguid,
      verified.backupEligible,
      verified.backupState,
      verified.userVerified,
      input.ip,
    ],
  );
  if (!row) throw new ApiError('The credential could not be stored.', 500, 'credential_store_failed');
  return { credential: toView(row), credentialId: verified.credentialId };
}

export interface AuthenticationOptionsResult {
  options: ReturnType<typeof buildAuthenticationOptions>;
  challenge: string;
}

/**
 * Sign-in options.
 *
 * With an email address the response is restricted to that account's enrolled
 * credentials. Without one, the browser is allowed to offer a discoverable
 * passkey ("sign in with your device"), and the account is resolved from the
 * credential id in the response — never from a value the client asserts.
 */
export async function authenticationOptions(input: {
  email?: string | null;
  rp: RelyingParty;
  ip: string;
  userAgent: string;
  requireUserVerification: boolean;
}): Promise<AuthenticationOptionsResult> {
  let userId: string | null = null;
  let allowCredentials: Array<{ id: string; transports?: string[] }> = [];

  const email = (input.email ?? '').trim().toLowerCase();
  if (email) {
    const user = await queryOne<{ id: string; is_active: boolean }>(
      `select id, is_active from admin_users where lower(email) = $1`,
      [email],
    );
    if (user?.is_active) {
      userId = user.id;
      const rows = await query<{ credential_id: string; transports: unknown }>(
        `select credential_id, transports from webauthn_credentials where user_id = $1 and revoked_at is null`,
        [user.id],
      );
      allowCredentials = rows.map((row) => ({
        id: row.credential_id,
        transports: parseJsonb<string[]>(row.transports, []),
      }));
    }
  }

  const challenge = await issueChallenge({
    purpose: 'authenticate',
    userId,
    rp: input.rp,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  const options = buildAuthenticationOptions({
    rpId: input.rp.id,
    challenge,
    allowCredentials,
    requireUserVerification: input.requireUserVerification,
  });
  return { options, challenge };
}

export interface AuthenticatedPasskey {
  userId: string;
  credentialRowId: string;
  label: string;
}

export async function authenticatePasskey(input: {
  response: AuthenticationResponseInput;
  rp: RelyingParty;
  requireUserVerification: boolean;
  ip: string;
  userAgent: string;
}): Promise<AuthenticatedPasskey> {
  const credentialId = input.response.id || input.response.rawId;
  if (!credentialId) throw new ApiError('The assertion carries no credential id.', 400, 'credential_missing');

  const row = await queryOne<CredentialRow & { is_active: boolean }>(
    `select c.*, u.is_active
       from webauthn_credentials c
       join admin_users u on u.id = c.user_id
      where c.credential_id = $1`,
    [credentialId],
  );
  if (!row || row.revoked_at) {
    throw new ApiError(
      'That credential is not enrolled on this deployment. Use your password, or enrol this device again.',
      401,
      'credential_unknown',
    );
  }
  if (!row.is_active) {
    throw new ApiError('This account is disabled.', 403, 'account_disabled');
  }

  const challenge = await consumeChallenge({
    purpose: 'authenticate',
    rpId: input.rp.id,
    userId: row.user_id,
  });

  const verified = verifyAuthentication({
    response: input.response,
    expectedChallenge: challenge.challenge,
    rp: input.rp,
    credential: {
      credentialId: row.credential_id,
      publicKey: fromBase64Url(row.public_key),
      counter: Number(row.counter ?? 0),
      algorithm: Number(row.algorithm),
    },
    requireUserVerification: input.requireUserVerification,
  });

  await query(
    `update webauthn_credentials
        set counter = $2, last_used_at = now(), last_ip = $3, backup_state = $4
      where id = $1`,
    [row.id, verified.newCounter, input.ip, verified.backupState],
  );

  return {
    userId: row.user_id,
    credentialRowId: row.id,
    label: row.device_label || 'Biometric device',
  };
}
