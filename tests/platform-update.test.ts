/**
 * Platform update: settings, appearance, path mapping and WebAuthn verification.
 *
 * The WebAuthn tests build a real authenticator response with a real P-256 key:
 * CBOR-encoded COSE public key, authenticator data, client data JSON and a DER
 * signature. They prove the server side accepts a genuine assertion and rejects
 * a tampered one, a wrong origin, a wrong challenge and a ceremony without user
 * verification — which is exactly what has to be true before biometric sign-in
 * is safe to ship.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  DEFAULT_REGISTRATION,
  DEFAULT_SECURITY,
  mergePlatformSettings,
  publicPolicy,
  resolveAppearance,
  resolveRegistration,
  resolveSecurity,
  resolvePlatformSettings,
} from '../src/lib/settings/platform';
import { mergePrefs, normalizeMode, parseStored, serializePrefs } from '../src/components/christmas/prefs';
import {
  GitHubPathError,
  isInsidePrefix,
  normalizeRepoPrefix,
  repoPathToServerPath,
  serverPathToRepoPath,
} from '../src/lib/github/paths';
import {
  COSE_ALG_ES256,
  WebAuthnError,
  buildAuthenticationOptions,
  buildRegistrationOptions,
  decodeCbor,
  describeDevice,
  fromBase64Url,
  parseAuthenticatorData,
  toBase64Url,
  verifyAuthentication,
  verifyRegistration,
} from '../src/lib/auth/webauthn';

// ----------------------------------------------------------------- mini CBOR

function cborLength(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) {
    const buffer = Buffer.alloc(3);
    buffer[0] = (major << 5) | 25;
    buffer.writeUInt16BE(length, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = (major << 5) | 26;
  buffer.writeUInt32BE(length, 1);
  return buffer;
}

type Encodable = number | string | Buffer | Map<number | string, Encodable> | Encodable[];

function cborEncode(value: Encodable): Buffer {
  if (typeof value === 'number') {
    if (value >= 0) return cborLength(0, value);
    return cborLength(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborLength(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborLength(2, value.length), value]);
  if (Array.isArray(value)) {
    return Buffer.concat([cborLength(4, value.length), ...value.map(cborEncode)]);
  }
  const entries = [...value.entries()];
  return Buffer.concat([cborLength(5, entries.length), ...entries.flatMap(([key, item]) => [cborEncode(key), cborEncode(item)])]);
}

// --------------------------------------------------------------- settings

test('appearance defaults keep the Christmas edition on and never force motion', () => {
  const appearance = resolveAppearance(undefined);
  assert.equal(appearance.christmasEffects, 'on');
  assert.equal(appearance.animatedIntro, true);
  assert.equal(appearance.snow, true);

  const reduced = resolveAppearance({ christmasEffects: 'reduced', snow: true });
  assert.equal(reduced.christmasEffects, 'reduced');
  // Reduced motion wins over a stored `snow: true`.
  assert.equal(reduced.snow, false);

  assert.equal(resolveAppearance({ christmasEffects: 'nonsense' }).christmasEffects, 'on');
});

test('biometric sign-in cannot report enabled while passkeys are disabled', () => {
  const off = resolveSecurity({ passkeysEnabled: false, biometricLoginEnabled: true });
  assert.equal(off.passkeysEnabled, false);
  assert.equal(off.biometricLoginEnabled, false);
  assert.equal(DEFAULT_SECURITY.passkeysEnabled, true);
});

test('registration is enabled by default and normalises its role', () => {
  const registration = resolveRegistration({});
  assert.equal(registration.enabled, true);
  assert.equal(registration.defaultRole, DEFAULT_REGISTRATION.defaultRole);
  assert.equal(resolveRegistration({ defaultRole: 'operator' }).defaultRole, 'operator');
  assert.equal(resolveRegistration({ defaultRole: 'root' }).defaultRole, 'viewer');
});

test('platform merge ignores unknown keys and re-normalises every field', () => {
  const current = resolvePlatformSettings({ appearance: { christmasEffects: 'on' as const } });
  const next = mergePlatformSettings(current, {
    appearance: { animatedIntro: false },
    registration: { enabled: false },
    // @ts-expect-error deliberately hostile payload
    security: { passkeysEnabled: 'yes', extra: 'ignored' },
  });
  assert.equal(next.appearance.christmasEffects, 'on');
  assert.equal(next.appearance.animatedIntro, false);
  assert.equal(next.registration.enabled, false);
  assert.equal(next.security.passkeysEnabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(next.security, 'extra'), false);
});

test('public policy exposes the switches a signed-out visitor needs and nothing else', () => {
  const policy = publicPolicy(resolvePlatformSettings({}));
  assert.deepEqual(Object.keys(policy).sort(), [
    'appearance',
    'biometricLoginEnabled',
    'branding',
    'passkeysEnabled',
    'registrationEnabled',
    'requireUserVerification',
  ]);
  assert.equal(policy.branding.product, 'DARKNOTE');
  assert.equal(policy.branding.credit, 'POWERED BY JIMMY M, TECH');
});

// ------------------------------------------------------------- christmas

test('christmas preferences: device choice wins, reduced motion disables snow', () => {
  const prefs = mergePrefs(
    { christmasEffects: 'on', animatedIntro: true, snow: true },
    { mode: 'reduced', snow: true, introSeen: true },
  );
  assert.equal(prefs.mode, 'reduced');
  assert.equal(prefs.snow, false);
  assert.equal(prefs.introSeen, true);
  assert.equal(prefs.intro, true);

  const off = mergePrefs({ christmasEffects: 'on', animatedIntro: true, snow: true }, { mode: 'off' });
  assert.equal(off.mode, 'off');
  assert.equal(off.snow, true);
});

test('christmas preference parsing survives garbage and round-trips', () => {
  assert.deepEqual(parseStored(null), {});
  assert.deepEqual(parseStored('not json'), {});
  assert.deepEqual(parseStored('[1,2]'), {});
  assert.equal(normalizeMode('off'), 'off');
  assert.equal(normalizeMode('purple'), 'on');
  assert.equal(normalizeMode(undefined, 'reduced'), 'reduced');

  const prefs = mergePrefs(
    { christmasEffects: 'on', animatedIntro: true, snow: true },
    { mode: 'off', intro: false, introSeen: true },
  );
  assert.deepEqual(parseStored(serializePrefs(prefs)), {
    mode: 'off',
    intro: false,
    snow: true,
    introSeen: true,
  });
});

// ----------------------------------------------------------------- paths

test('panel paths map to repository paths and back', () => {
  assert.equal(
    serverPathToRepoPath({ prefix: 'bot', projectRoot: '/home/container', serverPath: '/home/container/plugins/menu.js' }),
    'bot/plugins/menu.js',
  );
  assert.equal(
    serverPathToRepoPath({ prefix: '', projectRoot: '/home/container', serverPath: '/home/container/index.js' }),
    'index.js',
  );
  assert.equal(
    repoPathToServerPath({ prefix: 'bot', projectRoot: '/home/container', repoPath: 'bot/index.js' }),
    '/home/container/index.js',
  );
  assert.equal(isInsidePrefix('bot', 'bot/plugins/a.js'), true);
  assert.equal(isInsidePrefix('bot', 'bots/a.js'), false);
  assert.equal(normalizeRepoPrefix(' /bot//sub/ '), 'bot/sub');
});

test('path mapping refuses traversal, escapes and empty results', () => {
  assert.throws(() => normalizeRepoPrefix('bot/../../etc'), GitHubPathError);
  assert.throws(
    () => serverPathToRepoPath({ prefix: '', projectRoot: '/home/container', serverPath: '/etc/passwd' }),
    GitHubPathError,
  );
  assert.throws(
    () => serverPathToRepoPath({ prefix: '', projectRoot: '/home/container', serverPath: '/home/container' }),
    GitHubPathError,
  );
  assert.throws(
    () => repoPathToServerPath({ prefix: 'bot', projectRoot: '/home/container', repoPath: 'other/index.js' }),
    GitHubPathError,
  );
  assert.throws(
    () => serverPathToRepoPath({ prefix: '', projectRoot: '/home/container', serverPath: '/home/container/a\u0000b' }),
    GitHubPathError,
  );
});

// --------------------------------------------------------------- webauthn

interface TestAuthenticator {
  credentialId: Buffer;
  coseKey: Buffer;
  privateKey: crypto.KeyObject;
}

function createAuthenticator(rpId: string): TestAuthenticator {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
  const cose = cborEncode(
    new Map<number, Encodable>([
      [1, 2],
      [3, COSE_ALG_ES256],
      [-1, 1],
      [-2, fromBase64Url(jwk.x ?? '')],
      [-3, fromBase64Url(jwk.y ?? '')],
    ]),
  );
  assert.ok(crypto.createHash('sha256').update(rpId).digest().length === 32);
  return { credentialId: crypto.randomBytes(16), coseKey: cose, privateKey };
}

function clientData(type: string, challenge: string, origin: string): { json: string; bytes: Buffer } {
  const json = JSON.stringify({ type, challenge, origin, crossOrigin: false });
  const bytes = Buffer.from(json, 'utf8');
  return { json: toBase64Url(bytes), bytes };
}

function registrationResponse(input: {
  authenticator: TestAuthenticator;
  rpId: string;
  challenge: string;
  origin: string;
  flags?: number;
}) {
  const rpIdHash = crypto.createHash('sha256').update(input.rpId).digest();
  const flags = input.flags ?? 0x45; // UP | UV | AT
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(0, 0);
  const aaguid = Buffer.alloc(16, 7);
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(input.authenticator.credentialId.length, 0);
  const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), counter, aaguid, idLength, input.authenticator.credentialId, input.authenticator.coseKey]);

  const attestation = cborEncode(
    new Map<number | string, Encodable>([
      ['fmt', 'none'],
      ['attStmt', new Map<number | string, Encodable>()],
      ['authData', authData],
    ]),
  );
  const data = clientData('webauthn.create', input.challenge, input.origin);

  return {
    id: toBase64Url(input.authenticator.credentialId),
    rawId: toBase64Url(input.authenticator.credentialId),
    type: 'public-key' as const,
    response: {
      clientDataJSON: data.json,
      attestationObject: toBase64Url(attestation),
      transports: ['internal'],
    },
    authenticatorAttachment: 'platform',
  };
}

function authenticationResponse(input: {
  authenticator: TestAuthenticator;
  rpId: string;
  challenge: string;
  origin: string;
  counter: number;
  flags?: number;
  tamper?: boolean;
}) {
  const rpIdHash = crypto.createHash('sha256').update(input.rpId).digest();
  const flags = input.flags ?? 0x05; // UP | UV
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(input.counter, 0);
  const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
  const data = clientData('webauthn.get', input.challenge, input.origin);
  const clientDataHash = crypto.createHash('sha256').update(data.bytes).digest();
  let signature = crypto.sign('sha256', Buffer.concat([authData, clientDataHash]), input.authenticator.privateKey);
  if (input.tamper) {
    signature = Buffer.from(signature);
    signature[signature.length - 1] ^= 0xff;
  }

  return {
    id: toBase64Url(input.authenticator.credentialId),
    rawId: toBase64Url(input.authenticator.credentialId),
    type: 'public-key' as const,
    response: {
      clientDataJSON: data.json,
      authenticatorData: toBase64Url(authData),
      signature: toBase64Url(signature),
      userHandle: null,
    },
    authenticatorAttachment: 'platform',
  };
}

const RP = { id: 'darknote.example', name: 'DARKNOTE', origins: ['https://darknote.example'] };

test('CBOR decoding reads the numbers, byte strings and maps WebAuthn emits', () => {
  const encoded = cborEncode(
    new Map<number | string, Encodable>([
      ['fmt', 'none'],
      [1, 2],
      [3, -7],
      ['bytes', Buffer.from([1, 2, 3])],
      ['list', [1, 'two'] as unknown as Encodable[]],
    ]),
  );
  const decoded = decodeCbor(encoded);
  assert.ok(decoded instanceof Map);
  assert.equal(decoded.get('fmt'), 'none');
  assert.equal(decoded.get(3), -7);
  assert.deepEqual(decoded.get('bytes'), Buffer.from([1, 2, 3]));
});

test('authenticator data parses flags, counter, aaguid and the embedded public key', () => {
  const authenticator = createAuthenticator(RP.id);
  const rpIdHash = crypto.createHash('sha256').update(RP.id).digest();
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([0x45]),
    Buffer.from([0, 0, 0, 9]),
    Buffer.alloc(16, 1),
    Buffer.from([0, 4]),
    authenticator.credentialId.subarray(0, 4),
    authenticator.coseKey,
  ]);
  const parsed = parseAuthenticatorData(authData);
  assert.equal(parsed.userPresent, true);
  assert.equal(parsed.userVerified, true);
  assert.equal(parsed.signCount, 9);
  assert.ok(parsed.credentialPublicKey);
  assert.deepEqual(parsed.credentialPublicKey, authenticator.coseKey);
});

test('a genuine registration verifies and yields the ES256 public key', () => {
  const authenticator = createAuthenticator(RP.id);
  const challenge = toBase64Url(crypto.randomBytes(32));
  const verified = verifyRegistration({
    response: registrationResponse({ authenticator, rpId: RP.id, challenge, origin: RP.origins[0] }),
    expectedChallenge: challenge,
    rp: RP,
    requireUserVerification: true,
  });
  assert.equal(verified.credentialId, toBase64Url(authenticator.credentialId));
  assert.equal(verified.algorithm, COSE_ALG_ES256);
  assert.equal(verified.attestationFormat, 'none');
  assert.equal(verified.attachment, 'platform');
  assert.equal(verified.userVerified, true);
  assert.deepEqual(verified.transports, ['internal']);
});

test('registration refuses a wrong challenge, a wrong origin and missing user verification', () => {
  const authenticator = createAuthenticator(RP.id);
  const challenge = toBase64Url(crypto.randomBytes(32));

  assert.throws(
    () =>
      verifyRegistration({
        response: registrationResponse({ authenticator, rpId: RP.id, challenge, origin: RP.origins[0] }),
        expectedChallenge: toBase64Url(crypto.randomBytes(32)),
        rp: RP,
        requireUserVerification: true,
      }),
    (error: unknown) => error instanceof WebAuthnError && error.code === 'bad_challenge',
  );

  assert.throws(
    () =>
      verifyRegistration({
        response: registrationResponse({ authenticator, rpId: RP.id, challenge, origin: 'https://evil.example' }),
        expectedChallenge: challenge,
        rp: RP,
        requireUserVerification: true,
      }),
    (error: unknown) => error instanceof WebAuthnError && error.code === 'bad_origin',
  );

  assert.throws(
    () =>
      verifyRegistration({
        response: registrationResponse({ authenticator, rpId: RP.id, challenge, origin: RP.origins[0], flags: 0x41 }),
        expectedChallenge: challenge,
        rp: RP,
        requireUserVerification: true,
      }),
    (error: unknown) => error instanceof WebAuthnError && error.code === 'no_user_verification',
  );
});

test('a genuine assertion verifies, and a tampered one does not', () => {
  const authenticator = createAuthenticator(RP.id);
  const registrationChallenge = toBase64Url(crypto.randomBytes(32));
  const registered = verifyRegistration({
    response: registrationResponse({ authenticator, rpId: RP.id, challenge: registrationChallenge, origin: RP.origins[0] }),
    expectedChallenge: registrationChallenge,
    rp: RP,
    requireUserVerification: true,
  });

  const challenge = toBase64Url(crypto.randomBytes(32));
  const verified = verifyAuthentication({
    response: authenticationResponse({
      authenticator,
      rpId: RP.id,
      challenge,
      origin: RP.origins[0],
      counter: 1,
    }),
    expectedChallenge: challenge,
    rp: RP,
    credential: { credentialId: registered.credentialId, publicKey: registered.publicKey, counter: 0 },
    requireUserVerification: true,
  });
  assert.equal(verified.newCounter, 1);

  assert.throws(
    () =>
      verifyAuthentication({
        response: authenticationResponse({
          authenticator,
          rpId: RP.id,
          challenge,
          origin: RP.origins[0],
          counter: 2,
          tamper: true,
        }),
        expectedChallenge: challenge,
        rp: RP,
        credential: { credentialId: registered.credentialId, publicKey: registered.publicKey, counter: 1 },
        requireUserVerification: true,
      }),
    (error: unknown) => error instanceof WebAuthnError && error.code === 'bad_signature',
  );

  // A counter that goes backwards is the cloned-authenticator signal.
  assert.throws(
    () =>
      verifyAuthentication({
        response: authenticationResponse({
          authenticator,
          rpId: RP.id,
          challenge,
          origin: RP.origins[0],
          counter: 1,
        }),
        expectedChallenge: challenge,
        rp: RP,
        credential: { credentialId: registered.credentialId, publicKey: registered.publicKey, counter: 5 },
        requireUserVerification: true,
      }),
    (error: unknown) => error instanceof WebAuthnError && error.code === 'counter_regression',
  );
});

test('an assertion for another relying party is refused', () => {
  const authenticator = createAuthenticator(RP.id);
  const challenge = toBase64Url(crypto.randomBytes(32));
  const registered = verifyRegistration({
    response: registrationResponse({ authenticator, rpId: RP.id, challenge, origin: RP.origins[0] }),
    expectedChallenge: challenge,
    rp: RP,
    requireUserVerification: true,
  });

  const challenge2 = toBase64Url(crypto.randomBytes(32));
  assert.throws(
    () =>
      verifyAuthentication({
        response: authenticationResponse({
          authenticator,
          rpId: 'other.example',
          challenge: challenge2,
          origin: RP.origins[0],
          counter: 1,
        }),
        expectedChallenge: challenge2,
        rp: RP,
        credential: { credentialId: registered.credentialId, publicKey: registered.publicKey, counter: 0 },
        requireUserVerification: true,
      }),
    (error: unknown) => error instanceof WebAuthnError && error.code === 'bad_rp_id',
  );
});

test('credential options describe a platform biometric ceremony', () => {
  const options = buildRegistrationOptions({
    rp: RP,
    user: { id: 'user-1', email: 'admin@example.com', name: 'Admin' },
    challenge: 'abc',
    excludeCredentials: [{ id: 'existing', transports: ['internal'] }],
    requireUserVerification: true,
  });
  assert.equal(options.rp.id, RP.id);
  assert.equal(options.authenticatorSelection?.authenticatorAttachment, 'platform');
  assert.equal(options.authenticatorSelection?.userVerification, 'required');
  assert.deepEqual(options.pubKeyCredParams.map((param) => param.alg), [COSE_ALG_ES256, -257]);
  assert.deepEqual(options.excludeCredentials?.[0].transports, ['internal']);

  const request = buildAuthenticationOptions({
    rpId: RP.id,
    challenge: 'abc',
    allowCredentials: [],
    requireUserVerification: false,
  });
  assert.equal(request.rpId, RP.id);
  assert.equal(request.userVerification, 'preferred');
});

test('device labels come from the user agent and never from biometric data', () => {
  assert.equal(
    describeDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36'),
    'Android · Chrome',
  );
  assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/605.1'), 'iOS · Safari');
  assert.equal(describeDevice(''), 'Unknown device · browser');
});
