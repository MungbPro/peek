import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface EncryptionBackend {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface CredentialEndpoint { baseUrl: string; apiKeyEnv: string }
type Entry = { key: string } | { disabled: true };
type State = 'unloaded' | 'ready' | 'failed';
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 16;
const STORAGE_ERROR = 'Secure credential storage is unavailable. Unlock the system key store and try again. Existing credentials have not been replaced.';

/** Return a validated copy without ever including the supplied value in errors. */
export function validateApiKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter an API key.');
  const key = value.trim();
  if (key.length < 16 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error('The API key must contain 16–512 characters without spaces or line breaks.');
  }
  return key;
}

function endpointId(endpoint: CredentialEndpoint): string {
  try {
    const url = new URL(endpoint.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[A-Z][A-Z0-9_]{0,99}$/.test(endpoint.apiKeyEnv)) {
      throw new Error();
    }
    // URL canonicalizes the host/default port, while paths remain case-sensitive.
    // Credentials for a different provider URL or variable name never match.
    const baseUrl = url.href.replace(/\/+$/, '');
    return createHash('sha256').update(JSON.stringify([baseUrl, endpoint.apiKeyEnv])).digest('hex');
  } catch { throw new Error('Invalid credential destination.'); }
}

function decodeEntries(plain: string): Map<string, Entry> {
  if (Buffer.byteLength(plain, 'utf8') > MAX_BYTES) throw new Error(STORAGE_ERROR);
  const envelope: unknown = JSON.parse(plain);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error(STORAGE_ERROR);
  const raw = envelope as Record<string, unknown>;
  if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw new Error(STORAGE_ERROR);
  const entries = Object.entries(raw.entries);
  if (entries.length > MAX_ENTRIES) throw new Error(STORAGE_ERROR);
  const result = new Map<string, Entry>();
  for (const [id, value] of entries) {
    if (!/^[a-f0-9]{64}$/.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(STORAGE_ERROR);
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 1) throw new Error(STORAGE_ERROR);
    if (record.disabled === true) result.set(id, { disabled: true });
    else if (typeof record.key === 'string' && validateApiKey(record.key) === record.key) result.set(id, { key: record.key });
    else throw new Error(STORAGE_ERROR);
  }
  return result;
}

/**
 * Main-process-only store. The injected system backend encrypts the entire
 * envelope; neither API keys nor endpoint metadata are written as plaintext.
 * Removal persists a tombstone so an old .env key cannot silently reactivate.
 */
export class CredentialStore {
  private entries = new Map<string, Entry>();
  private state: State = 'unloaded';
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly backend: EncryptionBackend) {}

  private serial(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => {});
    return result;
  }

  available(): boolean {
    if (this.state !== 'ready') return false;
    try { return this.backend.isEncryptionAvailable(); } catch { return false; }
  }

  load(): Promise<void> {
    return this.serial(async () => {
      try {
        let info;
        try { info = await lstat(this.filePath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          this.entries = new Map();
          this.state = 'ready';
          return;
        }
        if (!info.isFile() || info.size > MAX_BYTES || !this.backend.isEncryptionAvailable()) throw new Error(STORAGE_ERROR);
        const file = await open(this.filePath, 'r');
        let encrypted: Buffer;
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error(STORAGE_ERROR);
          // Bound the read even if another process grows the file after lstat.
          const buffer = Buffer.alloc(MAX_BYTES + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (!length || length > MAX_BYTES) throw new Error(STORAGE_ERROR);
          encrypted = buffer.subarray(0, length);
        } finally { await file.close(); }
        const next = decodeEntries(this.backend.decryptString(encrypted));
        this.entries = next;
        this.state = 'ready';
      } catch {
        this.entries = new Map();
        this.state = 'failed';
        throw new Error(STORAGE_ERROR);
      }
    });
  }

  get(endpoint: CredentialEndpoint): string | undefined {
    if (this.state !== 'ready') return undefined;
    const entry = this.entries.get(endpointId(endpoint));
    return entry && 'key' in entry ? entry.key : undefined;
  }

  hasStored(endpoint: CredentialEndpoint): boolean { return this.get(endpoint) !== undefined; }

  isDisabled(endpoint: CredentialEndpoint): boolean {
    // Do not fall through to environment credentials when encrypted state could
    // not be read: it might contain a deletion or a deliberate replacement.
    if (this.state !== 'ready') return true;
    const entry = this.entries.get(endpointId(endpoint));
    return entry !== undefined && 'disabled' in entry;
  }

  set(endpoint: CredentialEndpoint, value: string): Promise<void> {
    // Reject before queueing, without putting invalid content in error messages.
    let key: string;
    let id: string;
    try { key = validateApiKey(value); id = endpointId(endpoint); }
    catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      const next = new Map(this.entries);
      next.set(id, { key });
      await this.persist(next);
      this.entries = next;
    });
  }

  remove(endpoint: CredentialEndpoint): Promise<void> {
    let id: string;
    try { id = endpointId(endpoint); } catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      const next = new Map(this.entries);
      next.set(id, { disabled: true });
      await this.persist(next);
      this.entries = next;
    });
  }

  private async persist(next: Map<string, Entry>): Promise<void> {
    if (!this.available()) throw new Error(STORAGE_ERROR);
    if (next.size > MAX_ENTRIES) throw new Error('Too many stored credential destinations.');
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const plain = JSON.stringify({ version: 1, entries: Object.fromEntries(next) });
      const encrypted = this.backend.encryptString(plain);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_BYTES) throw new Error(STORAGE_ERROR);
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await file.chmod(0o600);
        await file.writeFile(encrypted);
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.filePath);
      // No fallible work after the commit: a rejected mutation must leave the
      // previous in-memory state and previous ciphertext in agreement.
      created = false;
    } catch { throw new Error(STORAGE_ERROR); }
    finally { if (created) await unlink(temporary).catch(() => {}); }
  }
}
