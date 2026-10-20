import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface StoredClientKey {
  id: string;
  name: string;
  hash: string;
  identifier: string;
  createdAt: string;
  revokedAt?: string;
}

export interface PublicClientKey {
  id: string;
  name: string;
  identifier: string;
  createdAt: string;
  revokedAt?: string;
}

export interface GeneratedClientKey {
  key: string;
  clientKey: PublicClientKey;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isStoredClientKey(value: unknown): value is StoredClientKey {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.hash === 'string'
    && /^[a-f0-9]{64}$/.test(record.hash)
    && typeof record.identifier === 'string'
    && typeof record.createdAt === 'string'
    && (record.revokedAt === undefined || typeof record.revokedAt === 'string');
}

export class ClientKeyStore {
  private records: StoredClientKey[] = [];
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed) || !parsed.every(isStoredClientKey)) {
        throw new Error('Client key store has an invalid format.');
      }
      this.records = parsed;
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist([]);
    }
    this.initialized = true;
  }

  async list(): Promise<PublicClientKey[]> {
    await this.initialize();
    return this.records.map(({ id, name, identifier, createdAt, revokedAt }) => ({
      id, name, identifier, createdAt, ...(revokedAt ? { revokedAt } : {}),
    }));
  }

  async countActive(): Promise<number> {
    await this.initialize();
    return this.records.filter((record) => !record.revokedAt).length;
  }

  async create(name: string): Promise<GeneratedClientKey> {
    await this.initialize();
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80) throw new Error('Client key name must be between 1 and 80 characters.');

    return this.mutate(async () => {
      const key = `ksr_live_${randomBytes(32).toString('base64url')}`;
      const record: StoredClientKey = {
        id: randomUUID(),
        name: cleanName,
        hash: digest(key).toString('hex'),
        identifier: `${key.slice(0, 13)}…${key.slice(-4)}`,
        createdAt: new Date().toISOString(),
      };
      const next = [...this.records, record];
      await this.persist(next);
      this.records = next;
      const { hash: _hash, ...clientKey } = record;
      return { key, clientKey };
    });
  }

  async revoke(id: string): Promise<boolean> {
    await this.initialize();
    return this.mutate(async () => {
      const existing = this.records.find((record) => record.id === id);
      if (!existing || existing.revokedAt) return false;
      const next = this.records.map((record) => record.id === id
        ? { ...record, revokedAt: new Date().toISOString() }
        : record);
      await this.persist(next);
      this.records = next;
      return true;
    });
  }

  async authenticate(key: string): Promise<boolean> {
    await this.initialize();
    if (!/^ksr_live_[A-Za-z0-9_-]{43}$/.test(key)) return false;
    const supplied = digest(key);
    return this.records.some((record) => {
      if (record.revokedAt) return false;
      return timingSafeEqual(supplied, Buffer.from(record.hash, 'hex'));
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(records: StoredClientKey[]): Promise<void> {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      const { unlink } = await import('node:fs/promises');
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
