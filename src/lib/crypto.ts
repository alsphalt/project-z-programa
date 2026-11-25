import crypto from 'node:crypto';
import { appSecret } from './env';

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Session tokens are stored hashed so a DB dump cannot be replayed. */
export function hashSessionToken(token: string): string {
  return crypto.createHmac('sha256', appSecret()).update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function keyBytes(): Buffer {
  return crypto.scryptSync(appSecret(), 'darknote-control-center/credentials/v1', 32);
}

/** AES-256-GCM envelope used for Pterodactyl API keys at rest. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`;
}

export function decryptSecret(envelope: string): string {
  const [version, ivB64, tagB64, dataB64] = envelope.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Stored credential is not readable (unexpected envelope format)');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Never expose more than the last 4 characters of a credential. */
export function hintSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `••••••••${tail}`;
}
