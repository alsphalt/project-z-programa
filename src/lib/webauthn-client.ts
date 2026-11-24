"use client";

import { apiDelete, apiGet, apiPost } from "./client";

/**
 * Browser side of passkey / biometric authentication.
 *
 * The server issues the challenge and verifies the signature; this module only
 * marshals the WebAuthn JSON to and from the binary structures the browser API
 * expects. Nothing secret is handled here: the private key belongs to the
 * authenticator (Secure Enclave, Android Keystore, TPM) and never leaves it.
 *
 * Native APK note: an Android WebView supports exactly this path when the host
 * enables WebViewFeature.WEB_AUTHENTICATION; the OS (BiometricPrompt / Keystore)
 * performs the fingerprint or face check and the page receives an assertion.
 * There is no second biometric system to build, and no biometric data ever
 * reaches DARKNOTE.
 */

export interface CredentialSummary {
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

interface CreationOptionsJSON {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  excludeCredentials?: Array<{ type: "public-key"; id: string; transports?: string[] }>;
  authenticatorSelection?: {
    authenticatorAttachment?: AuthenticatorAttachment;
    residentKey?: ResidentKeyRequirement;
    requireResidentKey?: boolean;
    userVerification?: UserVerificationRequirement;
  };
}

interface RequestOptionsJSON {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: Array<{ type: "public-key"; id: string; transports?: string[] }>;
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer as ArrayBuffer;
}

function encodeBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True when this browser can use platform authenticators at all. */
export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function"
  );
}

/** True when the device offers a built-in authenticator (biometric/PIN). */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    const fn = (window.PublicKeyCredential as unknown as {
      isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    }).isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof fn !== "function") return false;
    return await fn.call(window.PublicKeyCredential);
  } catch {
    return false;
  }
}

/** A short, honest description of the device — never a fingerprint or face data point. */
export function deviceHint(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const platform = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "This device";
  return `${platform} biometrics`;
}

export async function registerPasskey(label?: string): Promise<CredentialSummary> {
  if (!isWebAuthnSupported()) {
    throw new Error(
      "This browser cannot use passkeys. Use the installed app or a current browser over HTTPS, and sign in with your password instead.",
    );
  }

  const start = await apiPost<{ options: CreationOptionsJSON }>("/api/auth/webauthn/register/options", {});
  const options = start.options;

  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: options.rp,
    user: {
      id: decodeBase64Url(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    challenge: decodeBase64Url(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout ?? 120_000,
    attestation: options.attestation ?? "none",
    excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
      type: "public-key" as const,
      id: decodeBase64Url(credential.id),
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: options.authenticatorSelection,
  };

  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({ publicKey });
  } catch (error) {
    throw new Error(describeCredentialError(error));
  }
  if (!credential) throw new Error("The device did not return a credential.");
  const attestation = credential as PublicKeyCredential;
  const response = attestation.response as AuthenticatorAttestationResponse;

  const payload = {
    label: label ?? deviceHint(),
    response: {
      id: attestation.id,
      rawId: encodeBase64Url(attestation.rawId),
      type: attestation.type,
      response: {
        clientDataJSON: encodeBase64Url(response.clientDataJSON),
        attestationObject: encodeBase64Url(response.attestationObject),
        transports: typeof response.getTransports === "function" ? response.getTransports() : [],
      },
      authenticatorAttachment: attestation.authenticatorAttachment ?? null,
      clientExtensionResults: attestation.getClientExtensionResults?.() ?? {},
    },
  };

  const result = await apiPost<{ credential: CredentialSummary }>("/api/auth/webauthn/register/verify", payload);
  return result.credential;
}

export async function authenticateWithPasskey(email?: string): Promise<{ device: string }> {
  if (!isWebAuthnSupported()) {
    throw new Error("This browser does not support biometric sign-in. Use your password.");
  }

  const start = await apiPost<{ options: RequestOptionsJSON }>("/api/auth/webauthn/login/options", {
    email: email?.trim() || undefined,
  });
  const options = start.options;

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: decodeBase64Url(options.challenge),
    rpId: options.rpId,
    timeout: options.timeout ?? 120_000,
    userVerification: options.userVerification ?? "required",
    allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
      type: "public-key" as const,
      id: decodeBase64Url(credential.id),
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    })),
  };

  let assertion: Credential | null;
  try {
    assertion = await navigator.credentials.get({ publicKey });
  } catch (error) {
    throw new Error(describeCredentialError(error));
  }
  if (!assertion) throw new Error("The device did not return an assertion.");
  const credential = assertion as PublicKeyCredential;
  const response = credential.response as AuthenticatorAssertionResponse;

  const result = await apiPost<{ device: string }>("/api/auth/webauthn/login/verify", {
    response: {
      id: credential.id,
      rawId: encodeBase64Url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: encodeBase64Url(response.clientDataJSON),
        authenticatorData: encodeBase64Url(response.authenticatorData),
        signature: encodeBase64Url(response.signature),
        userHandle: response.userHandle ? encodeBase64Url(response.userHandle) : null,
      },
      authenticatorAttachment: credential.authenticatorAttachment ?? null,
      clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    },
  });

  return { device: result.device };
}

export async function listPasskeys(): Promise<{
  credentials: CredentialSummary[];
  policy: { passkeysEnabled: boolean; biometricLoginEnabled: boolean; requireUserVerification: boolean };
}> {
  return apiGet("/api/auth/webauthn/credentials");
}

export async function removePasskey(id: string): Promise<CredentialSummary[]> {
  const result = await apiDelete<{ credentials: CredentialSummary[] }>(
    `/api/auth/webauthn/credentials?id=${encodeURIComponent(id)}`,
  );
  return result.credentials;
}

/** Turns a DOMException from WebAuthn into a sentence a person can act on. */
function describeCredentialError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") {
    return "The biometric prompt was cancelled, timed out, or the device refused. Nothing was enrolled — try again or use your password.";
  }
  if (name === "InvalidStateError") {
    return "This device is already enrolled for this account. Sign in with it, or remove it from the device list first.";
  }
  if (name === "NotSupportedError") {
    return "This device has no compatible biometric authenticator. Password sign-in still works.";
  }
  if (name === "SecurityError") {
    return "The browser refused the ceremony for this origin. Passkeys require HTTPS (or localhost) and the same hostname you registered on.";
  }
  return error instanceof Error ? error.message : "Biometric authentication failed.";
}
