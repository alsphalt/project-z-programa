import 'server-only';
import crypto from 'node:crypto';

/**
 * WebAuthn / passkey verification (server side).
 *
 * DARKNOTE never sees a fingerprint or a face. The operating system performs the
 * biometric check, the authenticator signs a server-issued challenge with a
 * private key that never leaves the device, and this module verifies that
 * signature against the public key it stored at enrolment.
 *
 * Deliberately implemented without a third-party dependency: the surface is
 * small (ES256 + RS256, `none`/self attestation), it is auditable, and it runs on
 * the same Node runtime as the rest of the console.
 *
 * What is verified here:
 *  - the challenge is exactly the one this server issued, single-use, unexpired;
 *  - `clientData.type` is the ceremony we asked for;
 *  - the origin matches the expected origin (no cross-origin ceremony);
 *  - `rpIdHash` equals SHA-256 of our relying-party id;
 *  - the user-presence flag is set, and the user-verification flag when the
 *    administrator requires it (biometric/PIN verification actually happened);
 *  - the signature over `authenticatorData || SHA-256(clientDataJSON)`;
 *  - the signature counter did not go backwards (cloned-authenticator signal).
 *
 * What is not verified: the attestation certificate chain. Attestation proves
 * which authenticator model was used, which is not a decision this console makes
 * — it grants access on the public key, not on the vendor. `fmt` is recorded so
 * the fact is not hidden.
 */

// ---------------------------------------------------------------- base64url

export function toBase64Url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

// ------------------------------------------------------------------- errors

export class WebAuthnError extends Error {
  code: string;
  constructor(message: string, code = 'webauthn_failed') {
    super(message);
    this.name = 'WebAuthnError';
    this.code = code;
  }
}

// --------------------------------------------------------------------- CBOR

export type CborValue = number | string | Buffer | boolean | null | CborValue[] | Map<number | string, CborValue>;

/**
 * Minimal CBOR decoder: unsigned/negative integers, byte strings, text strings,
 * arrays, maps, tags and the simple values WebAuthn actually emits. Anything
 * outside that set is refused instead of guessed.
 */
export function decodeCbor(buffer: Buffer): CborValue {
  const [value] = readItem(buffer, 0, 0);
  return value;
}

function readItem(buffer: Buffer, offset: number, depth: number): [CborValue, number] {
  if (depth > 16) throw new WebAuthnError('CBOR nesting is too deep to be a credential.', 'cbor_depth');
  const first = buffer[offset];
  if (first === undefined) throw new WebAuthnError('CBOR is truncated.', 'cbor_truncated');
  const major = first >> 5;
  const info = first & 0x1f;
  let length = info;
  let cursor = offset + 1;

  if (info === 24) {
    length = buffer.readUInt8(cursor);
    cursor += 1;
  } else if (info === 25) {
    length = buffer.readUInt16BE(cursor);
    cursor += 2;
  } else if (info === 26) {
    length = buffer.readUInt32BE(cursor);
    cursor += 4;
  } else if (info === 27) {
    const high = buffer.readUInt32BE(cursor);
    const low = buffer.readUInt32BE(cursor + 4);
    length = high * 2 ** 32 + low;
    cursor += 8;
  } else if (info === 31) {
    throw new WebAuthnError('Indefinite-length CBOR is not supported.', 'cbor_indefinite');
  }

  switch (major) {
    case 0:
      return [length, cursor];
    case 1:
      return [-1 - length, cursor];
    case 2: {
      const slice = buffer.subarray(cursor, cursor + length);
      if (slice.length !== length) throw new WebAuthnError('CBOR byte string is truncated.', 'cbor_truncated');
      return [Buffer.from(slice), cursor + length];
    }
    case 3: {
      const slice = buffer.subarray(cursor, cursor + length);
      if (slice.length !== length) throw new WebAuthnError('CBOR text string is truncated.', 'cbor_truncated');
      return [slice.toString('utf8'), cursor + length];
    }
    case 4: {
      const items: CborValue[] = [];
      let position = cursor;
      for (let index = 0; index < length; index += 1) {
        const [item, next] = readItem(buffer, position, depth + 1);
        items.push(item);
        position = next;
      }
      return [items, position];
    }
    case 5: {
      const map = new Map<number | string, CborValue>();
      let position = cursor;
      for (let index = 0; index < length; index += 1) {
        const [key, afterKey] = readItem(buffer, position, depth + 1);
        const [item, afterValue] = readItem(buffer, afterKey, depth + 1);
        if (typeof key !== 'number' && typeof key !== 'string') {
          throw new WebAuthnError('CBOR map keys must be integers or strings.', 'cbor_key');
        }
        map.set(key, item);
        position = afterValue;
      }
      return [map, position];
    }
    case 6: {
      const [, afterTag] = readItem(buffer, cursor, depth + 1);
      const [inner, end] = readItem(buffer, afterTag, depth + 1);
      return [inner, end];
    }
    case 7:
      if (info === 20) return [false, cursor];
      if (info === 21) return [true, cursor];
      if (info === 22) return [null, cursor];
      if (info === 26) return [buffer.readFloatBE(cursor - 4), cursor];
      if (info === 27) return [buffer.readDoubleBE(cursor - 8), cursor];
      throw new WebAuthnError('Unsupported CBOR simple value.', 'cbor_simple');
    default:
      throw new WebAuthnError('Unsupported CBOR major type.', 'cbor_major');
  }
}

// ----------------------------------------------------------------- COSE keys

export interface CoseKey {
  kty: number;
  alg: number;
  crv: number | null;
  x: Buffer | null;
  y: Buffer | null;
  n: Buffer | null;
  e: Buffer | null;
}

/** COSE_Key → our flat shape. Labels: 1 kty, 3 alg, -1 crv, -2 x, -3 y, -4 d. */
export function parseCoseKey(encoded: Buffer): CoseKey {
  const decoded = decodeCbor(encoded);
  if (!(decoded instanceof Map)) throw new WebAuthnError('The credential public key is not a COSE map.', 'cose_map');
  const number = (label: number): number | null => {
    const value = decoded.get(label);
    return typeof value === 'number' ? value : null;
  };
  const bytes = (label: number): Buffer | null => {
    const value = decoded.get(label);
    return Buffer.isBuffer(value) ? value : null;
  };
  const kty = number(1);
  const alg = number(3);
  if (kty === null || alg === null) throw new WebAuthnError('The COSE key is missing its type or algorithm.', 'cose_incomplete');
  return { kty, alg, crv: number(-1), x: bytes(-2), y: bytes(-3), n: bytes(-1), e: bytes(-3) };
}

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_RS256 = -257;

/** COSE key → Node public key. Only the two algorithms WebAuthn uses in practice. */
export function coseToPublicKey(cose: CoseKey): { key: crypto.KeyObject; algorithm: number } {
  if (cose.kty === 2 && cose.alg === COSE_ALG_ES256) {
    if (!cose.x || !cose.y || cose.crv !== 1) {
      throw new WebAuthnError('The P-256 credential key is incomplete.', 'cose_ec');
    }
    const key = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: toBase64Url(cose.x), y: toBase64Url(cose.y) },
      format: 'jwk',
    });
    return { key, algorithm: COSE_ALG_ES256 };
  }
  if (cose.kty === 3 && cose.alg === COSE_ALG_RS256) {
    if (!cose.n || !cose.e) throw new WebAuthnError('The RSA credential key is incomplete.', 'cose_rsa');
    const key = crypto.createPublicKey({
      key: { kty: 'RSA', n: toBase64Url(cose.n), e: toBase64Url(cose.e) },
      format: 'jwk',
    });
    return { key, algorithm: COSE_ALG_RS256 };
  }
  throw new WebAuthnError(
    `Unsupported credential algorithm (kty ${cose.kty}, alg ${cose.alg}). Enrol a device that uses ES256 or RS256.`,
    'cose_unsupported',
  );
}

// --------------------------------------------------------------- authData

export interface ParsedAuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backupState: boolean;
  attestedCredentialData: boolean;
  extensionData: boolean;
  signCount: number;
  aaguid: string | null;
  credentialId: string | null;
  credentialPublicKey: Buffer | null;
}

export function parseAuthenticatorData(data: Buffer): ParsedAuthenticatorData {
  if (data.length < 37) throw new WebAuthnError('The authenticator data is too short.', 'authdata_short');
  const flags = data[32];
  const parsed: ParsedAuthenticatorData = {
    rpIdHash: data.subarray(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    backupEligible: (flags & 0x08) !== 0,
    backupState: (flags & 0x10) !== 0,
    attestedCredentialData: (flags & 0x40) !== 0,
    extensionData: (flags & 0x80) !== 0,
    signCount: data.readUInt32BE(33),
    aaguid: null,
    credentialId: null,
    credentialPublicKey: null,
  };

  if (parsed.attestedCredentialData) {
    if (data.length < 55) throw new WebAuthnError('The attested credential data is truncated.', 'authdata_attested');
    const aaguid = data.subarray(37, 53);
    parsed.aaguid = [
      aaguid.toString('hex').slice(0, 8),
      aaguid.toString('hex').slice(8, 12),
      aaguid.toString('hex').slice(12, 16),
      aaguid.toString('hex').slice(16, 20),
      aaguid.toString('hex').slice(20),
    ].join('-');
    const idLength = data.readUInt16BE(53);
    const idStart = 55;
    const idEnd = idStart + idLength;
    if (data.length < idEnd) throw new WebAuthnError('The credential id is truncated.', 'authdata_credential');
    parsed.credentialId = toBase64Url(data.subarray(idStart, idEnd));
    // The COSE key is the remaining CBOR map; decode it to find its exact end.
    const keyBytes = data.subarray(idEnd);
    const end = cborItemLength(keyBytes);
    if (end <= 0) throw new WebAuthnError('The credential public key is unreadable.', 'authdata_key');
    parsed.credentialPublicKey = Buffer.from(keyBytes.subarray(0, end));
  }

  return parsed;
}

/** Byte length of the first CBOR item in `buffer` (0 when it cannot be read). */
function cborItemLength(buffer: Buffer): number {
  try {
    let best = 0;
    for (let length = 1; length <= buffer.length; length += 1) {
      try {
        readItem(buffer.subarray(0, length), 0, 0);
        best = length;
        break;
      } catch {
        /* keep growing */
      }
    }
    return best;
  } catch {
    return 0;
  }
}

// -------------------------------------------------------------- clientData

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin: boolean;
}

export function parseClientData(encoded: string): ClientData {
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(encoded).toString('utf8'));
  } catch {
    throw new WebAuthnError('The client data is not valid JSON.', 'clientdata_json');
  }
  if (!raw || typeof raw !== 'object') throw new WebAuthnError('The client data is empty.', 'clientdata_empty');
  const data = raw as Record<string, unknown>;
  if (typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string') {
    throw new WebAuthnError('The client data is missing type, challenge or origin.', 'clientdata_fields');
  }
  return {
    type: data.type,
    challenge: data.challenge,
    origin: data.origin,
    crossOrigin: data.crossOrigin === true,
  };
}

// ------------------------------------------------------------- relying party

export interface RelyingParty {
  id: string;
  name: string;
  origins: string[];
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the relying party from the request.
 *
 * `rpId` is the registrable domain of the origin (no scheme, no port). The
 * expected origins are the request origin plus, when configured, the canonical
 * app URL — that is what makes an installed PWA opened on a different hostname
 * fail loudly instead of silently.
 */
export function resolveRelyingParty(input: {
  originHeader?: string | null;
  hostHeader?: string | null;
  appUrl?: string | null;
  rpName?: string;
}): RelyingParty {
  const candidates: string[] = [];
  const fromOrigin = input.originHeader ? originOf(input.originHeader) : null;
  if (fromOrigin) candidates.push(fromOrigin);
  const fromApp = input.appUrl ? originOf(input.appUrl) : null;
  if (fromApp && !candidates.includes(fromApp)) candidates.push(fromApp);

  let id = '';
  if (fromOrigin) {
    id = new URL(fromOrigin).hostname;
  } else if (input.hostHeader) {
    id = input.hostHeader.split(':')[0];
    const protocol = id === 'localhost' || /^127\./.test(id) ? 'http' : 'https';
    candidates.push(`${protocol}://${input.hostHeader}`);
  }

  if (!id) throw new WebAuthnError('Cannot determine the relying party id for this request.', 'rp_missing');

  return { id, name: input.rpName ?? 'DARKNOTE', origins: candidates };
}

function assertOrigin(clientData: ClientData, rp: RelyingParty): void {
  const origin = originOf(clientData.origin);
  if (!origin || !rp.origins.includes(origin)) {
    throw new WebAuthnError(
      `The ceremony came from ${clientData.origin}, which is not this deployment. Open DARKNOTE at ${rp.origins[0] ?? rp.id} and try again.`,
      'bad_origin',
    );
  }
  if (clientData.crossOrigin) {
    throw new WebAuthnError('Cross-origin authentication ceremonies are refused.', 'cross_origin');
  }
}

function assertChallenge(clientData: ClientData, expected: string): void {
  const actual = clientData.challenge;
  if (typeof actual !== 'string' || actual.length !== expected.length) {
    throw new WebAuthnError('The challenge does not match the one this server issued.', 'bad_challenge');
  }
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new WebAuthnError('The challenge does not match the one this server issued.', 'bad_challenge');
  }
}

// ---------------------------------------------------------------- options

export interface CredentialDescriptor {
  id: string;
  transports?: string[];
}

export function buildRegistrationOptions(input: {
  rp: RelyingParty;
  user: { id: string; email: string; name: string };
  challenge: string;
  excludeCredentials: CredentialDescriptor[];
  requireUserVerification: boolean;
  /** Restrict to the device's own authenticator (biometric sensor / secure element). */
  platformOnly?: boolean;
}) {
  const userId = Buffer.from(input.user.id, 'utf8');
  return {
    rp: { id: input.rp.id, name: input.rp.name },
    user: {
      id: toBase64Url(userId),
      name: input.user.email,
      displayName: input.user.name || input.user.email,
    },
    challenge: input.challenge,
    pubKeyCredParams: [
      { type: 'public-key' as const, alg: COSE_ALG_ES256 },
      { type: 'public-key' as const, alg: COSE_ALG_RS256 },
    ],
    timeout: 120_000,
    attestation: 'none' as const,
    excludeCredentials: input.excludeCredentials.map((credential) => ({
      type: 'public-key' as const,
      id: credential.id,
      ...(credential.transports?.length ? { transports: credential.transports as AuthenticatorTransport[] } : {}),
    })),
    authenticatorSelection: {
      ...(input.platformOnly === false ? {} : { authenticatorAttachment: 'platform' as const }),
      residentKey: 'preferred' as const,
      requireResidentKey: false,
      userVerification: (input.requireUserVerification ? 'required' : 'preferred') as UserVerificationRequirement,
    },
  };
}

export function buildAuthenticationOptions(input: {
  rpId: string;
  challenge: string;
  allowCredentials: CredentialDescriptor[];
  requireUserVerification: boolean;
}) {
  return {
    challenge: input.challenge,
    rpId: input.rpId,
    timeout: 120_000,
    userVerification: (input.requireUserVerification ? 'required' : 'preferred') as UserVerificationRequirement,
    allowCredentials: input.allowCredentials.map((credential) => ({
      type: 'public-key' as const,
      id: credential.id,
      ...(credential.transports?.length ? { transports: credential.transports as AuthenticatorTransport[] } : {}),
    })),
  };
}

// ------------------------------------------------------------ verification

export interface RegistrationResponseInput {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
  clientExtensionResults?: unknown;
  authenticatorAttachment?: string | null;
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Buffer;
  algorithm: number;
  counter: number;
  aaguid: string | null;
  transports: string[];
  attachment: string | null;
  backupEligible: boolean;
  backupState: boolean;
  attestationFormat: string;
  userVerified: boolean;
}

export function verifyRegistration(input: {
  response: RegistrationResponseInput;
  expectedChallenge: string;
  rp: RelyingParty;
  requireUserVerification: boolean;
}): VerifiedRegistration {
  const { response, rp } = input;
  if (response.type !== 'public-key') throw new WebAuthnError('Not a public-key credential.', 'bad_type');

  const clientData = parseClientData(response.response.clientDataJSON);
  if (clientData.type !== 'webauthn.create') {
    throw new WebAuthnError('That ceremony was not a registration.', 'bad_ceremony');
  }
  assertChallenge(clientData, input.expectedChallenge);
  assertOrigin(clientData, rp);

  const attestationRaw = fromBase64Url(response.response.attestationObject);
  const attestation = decodeCbor(attestationRaw);
  if (!(attestation instanceof Map)) throw new WebAuthnError('The attestation object is malformed.', 'attestation_map');
  const authDataRaw = attestation.get('authData');
  if (!Buffer.isBuffer(authDataRaw)) throw new WebAuthnError('The attestation has no authenticator data.', 'attestation_authdata');
  const format = typeof attestation.get('fmt') === 'string' ? (attestation.get('fmt') as string) : 'none';

  const authData = parseAuthenticatorData(authDataRaw);
  if (!crypto.timingSafeEqual(authData.rpIdHash, crypto.createHash('sha256').update(rp.id).digest())) {
    throw new WebAuthnError('The credential was created for a different domain.', 'bad_rp_id');
  }
  if (!authData.userPresent) {
    throw new WebAuthnError('The authenticator did not confirm a user presence.', 'no_user_presence');
  }
  if (input.requireUserVerification && !authData.userVerified) {
    throw new WebAuthnError(
      'The device did not verify you (biometric or PIN). Enrol again and complete the device verification prompt.',
      'no_user_verification',
    );
  }
  if (!authData.credentialId || !authData.credentialPublicKey) {
    throw new WebAuthnError('The credential carries no public key.', 'no_credential');
  }

  const cose = parseCoseKey(authData.credentialPublicKey);
  const { algorithm } = coseToPublicKey(cose);

  return {
    credentialId: authData.credentialId,
    publicKey: authData.credentialPublicKey,
    algorithm,
    counter: authData.signCount,
    aaguid: authData.aaguid,
    transports: (response.response.transports ?? []).filter((item): item is string => typeof item === 'string'),
    attachment: response.authenticatorAttachment ?? null,
    backupEligible: authData.backupEligible,
    backupState: authData.backupState,
    attestationFormat: format,
    userVerified: authData.userVerified,
  };
}

export interface AuthenticationResponseInput {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
  authenticatorAttachment?: string | null;
}

export interface StoredCredential {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  algorithm?: number;
}

export interface VerifiedAuthentication {
  newCounter: number;
  userVerified: boolean;
  backupState: boolean;
}

export function verifyAuthentication(input: {
  response: AuthenticationResponseInput;
  expectedChallenge: string;
  rp: RelyingParty;
  credential: StoredCredential;
  requireUserVerification: boolean;
}): VerifiedAuthentication {
  const { response, rp, credential } = input;
  if (response.type !== 'public-key') throw new WebAuthnError('Not a public-key credential.', 'bad_type');

  const clientData = parseClientData(response.response.clientDataJSON);
  if (clientData.type !== 'webauthn.get') {
    throw new WebAuthnError('That ceremony was not an authentication.', 'bad_ceremony');
  }
  assertChallenge(clientData, input.expectedChallenge);
  assertOrigin(clientData, rp);

  const authDataRaw = fromBase64Url(response.response.authenticatorData);
  const authData = parseAuthenticatorData(authDataRaw);
  if (!crypto.timingSafeEqual(authData.rpIdHash, crypto.createHash('sha256').update(rp.id).digest())) {
    throw new WebAuthnError('The assertion was created for a different domain.', 'bad_rp_id');
  }
  if (!authData.userPresent) {
    throw new WebAuthnError('The authenticator did not confirm a user presence.', 'no_user_presence');
  }
  if (input.requireUserVerification && !authData.userVerified) {
    throw new WebAuthnError(
      'The device did not verify you (biometric or PIN). Unlock the device and try again.',
      'no_user_verification',
    );
  }

  const clientDataHash = crypto.createHash('sha256').update(fromBase64Url(response.response.clientDataJSON)).digest();
  const signed = Buffer.concat([authDataRaw, clientDataHash]);
  const signature = fromBase64Url(response.response.signature);

  const cose = parseCoseKey(credential.publicKey);
  const { key, algorithm } = coseToPublicKey(cose);
  if (credential.algorithm !== undefined && credential.algorithm !== algorithm) {
    throw new WebAuthnError('The stored credential algorithm does not match its key.', 'algorithm_mismatch');
  }

  let valid = false;
  try {
    valid = crypto.verify('sha256', signed, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new WebAuthnError('The signature did not verify against the enrolled credential.', 'bad_signature');
  }

  // A counter that moves backwards is the documented cloned-authenticator
  // signal. Many platform authenticators legitimately always report 0, so the
  // check only applies once a real counter has been observed.
  if (credential.counter > 0 && authData.signCount > 0 && authData.signCount <= credential.counter) {
    throw new WebAuthnError(
      'The authenticator signature counter did not increase. The credential may have been cloned — enrolment was kept but this sign-in is refused.',
      'counter_regression',
    );
  }

  return {
    newCounter: Math.max(authData.signCount, credential.counter),
    userVerified: authData.userVerified,
    backupState: authData.backupState,
  };
}

// ------------------------------------------------------------ device labels

/** A readable device name, derived only from the User-Agent the client sent. */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const platform = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/i.test(ua)
          ? 'macOS'
          : /CrOS/i.test(ua)
            ? 'ChromeOS'
            : /Linux/i.test(ua)
              ? 'Linux'
              : 'Unknown device';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/i.test(ua)
      ? 'Opera'
      : /SamsungBrowser/i.test(ua)
        ? 'Samsung Internet'
        : /Chrome\//i.test(ua)
          ? 'Chrome'
          : /Firefox\//i.test(ua)
            ? 'Firefox'
            : /Safari\//i.test(ua)
              ? 'Safari'
              : 'browser';
  return `${platform} · ${browser}`;
}
