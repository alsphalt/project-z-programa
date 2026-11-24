import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, ensureDataDirs } from '../env';

/**
 * Private backup store. Files live outside `public/`, are written with 0600
 * permissions and are only ever read back through authenticated API routes.
 *
 * The interface is intentionally small so it can be swapped for S3/R2 object
 * storage without touching the rest of the application.
 */
export interface StorageStat {
  key: string;
  bytes: number;
  modifiedAt: string;
}

export interface BackupStorage {
  readonly kind: string;
  put(key: string, data: Buffer): Promise<StorageStat>;
  get(key: string): Promise<Buffer>;
  stat(key: string): Promise<StorageStat | null>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<StorageStat[]>;
}

export function safeKey(key: string): string {
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.includes('\0')) {
    throw new Error('Invalid storage key');
  }
  return normalized;
}

class LocalStorage implements BackupStorage {
  readonly kind = 'local';
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  private resolve(key: string): string {
    const target = path.join(this.root, safeKey(key));
    const relative = path.relative(this.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Storage key escapes the backup directory');
    }
    return target;
  }

  async put(key: string, data: Buffer): Promise<StorageStat> {
    ensureDataDirs();
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, target);
    return { key, bytes: data.byteLength, modifiedAt: new Date().toISOString() };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async stat(key: string): Promise<StorageStat | null> {
    try {
      const s = await fs.stat(this.resolve(key));
      if (!s.isFile()) return null;
      return { key, bytes: s.size, modifiedAt: s.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async list(prefix: string): Promise<StorageStat[]> {
    const out: StorageStat[] = [];
    const walk = async (dir: string, relative: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (childRel.startsWith(prefix)) {
          const s = await fs.stat(path.join(dir, entry.name)).catch(() => null);
          if (s) out.push({ key: childRel, bytes: s.size, modifiedAt: s.mtime.toISOString() });
        }
      }
    };
    await walk(this.root, '');
    return out;
  }
}

let storage: BackupStorage | null = null;

export function backupStorage(): BackupStorage {
  if (storage) return storage;
  ensureDataDirs();
  storage = new LocalStorage(env.backupDir);
  return storage;
}

export function backupKey(serverId: string, remotePath: string, hash: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const cleaned = remotePath.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._/-]/g, '_');
  return `${serverId}/${day}/${hash.slice(0, 12)}-${cleaned}`;
}
