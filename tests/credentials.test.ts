import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore, validateApiKey, type EncryptionBackend } from '../src/main/credentials';

const endpoint = { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' };
const key = 'test-only-credential-0123456789';
const replacement = 'replacement-credential-0123456789';

function backend(): EncryptionBackend & { enabled: boolean; failEncryption: boolean } {
  const secret = randomBytes(32);
  return {
    enabled: true,
    failEncryption: false,
    isEncryptionAvailable() { return this.enabled; },
    encryptString(value) {
      if (this.failEncryption) throw new Error(`Backend accidentally included ${value}`);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

async function fixture(): Promise<{ dir: string; path: string; crypto: ReturnType<typeof backend>; store: CredentialStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'peek-credentials-test-'));
  const path = join(dir, 'credentials.enc');
  const crypto = backend();
  const store = new CredentialStore(path, crypto);
  await store.load();
  return { dir, path, crypto, store };
}

test('credentials encrypt the complete envelope, use private file permissions, and reload', async () => {
  const f = await fixture();
  try {
    await f.store.set(endpoint, ` ${key}\n`);
    assert.equal(f.store.get(endpoint), key);
    assert.equal(f.store.hasStored(endpoint), true);
    const disk = await readFile(f.path);
    assert.equal(disk.includes(Buffer.from(key)), false);
    assert.equal(disk.includes(Buffer.from(endpoint.baseUrl)), false);
    assert.equal(disk.includes(Buffer.from(endpoint.apiKeyEnv)), false);
    if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    const restored = new CredentialStore(f.path, f.crypto);
    await restored.load();
    assert.equal(restored.get(endpoint), key);
    assert.equal(restored.available(), true);
    assert.deepEqual(await readdir(f.dir), ['credentials.enc']);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('stored keys bind to exact destinations and concurrent writes preserve both', async () => {
  const f = await fixture();
  try {
    const other = { ...endpoint, baseUrl: 'https://other.example/v1' };
    await Promise.all([f.store.set(endpoint, key), f.store.set(other, replacement)]);
    assert.equal(f.store.get({ ...endpoint, baseUrl: 'https://API.OPENAI.COM:443/v1/' }), key);
    assert.equal(f.store.get(other), replacement);
    assert.equal(f.store.get({ ...endpoint, baseUrl: 'https://other.example/v2' }), undefined);
    assert.equal(f.store.get({ ...endpoint, apiKeyEnv: 'OTHER_API_KEY' }), undefined);
    await assert.rejects(f.store.set({ ...endpoint, baseUrl: 'https://api.openai.com/v1?secret=bad' }, key), /destination/);
    const restored = new CredentialStore(f.path, f.crypto);
    await restored.load();
    assert.equal(restored.get(other), replacement);
    assert.equal(restored.get(endpoint), key);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('removal persists a disabling tombstone until the user explicitly replaces the key', async () => {
  const f = await fixture();
  try {
    await f.store.set(endpoint, key);
    await f.store.remove(endpoint);
    assert.equal(f.store.get(endpoint), undefined);
    assert.equal(f.store.hasStored(endpoint), false);
    assert.equal(f.store.isDisabled(endpoint), true);
    const restored = new CredentialStore(f.path, f.crypto);
    await restored.load();
    assert.equal(restored.isDisabled(endpoint), true);
    await restored.set(endpoint, replacement);
    assert.equal(restored.isDisabled(endpoint), false);
    assert.equal(restored.get(endpoint), replacement);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('unavailable or corrupt encryption fails closed without overwriting existing bytes', async () => {
  const f = await fixture();
  try {
    f.crypto.enabled = false;
    assert.equal(f.store.available(), false);
    await assert.rejects(f.store.set(endpoint, key), /unavailable/);
    assert.deepEqual(await readdir(f.dir), []);
    f.crypto.enabled = true;
    await f.store.set(endpoint, key);
    const original = await readFile(f.path);
    f.crypto.enabled = false;
    const locked = new CredentialStore(f.path, f.crypto);
    await assert.rejects(locked.load(), /unavailable/);
    assert.equal(locked.get(endpoint), undefined);
    assert.equal(locked.isDisabled(endpoint), true);
    assert.equal(locked.available(), false);
    await assert.rejects(locked.remove(endpoint), /unavailable/);
    assert.deepEqual(await readFile(f.path), original);
    f.crypto.enabled = true;
    await writeFile(f.path, Buffer.from('corrupt ciphertext'));
    await assert.rejects(locked.load(), /unavailable/);
    await assert.rejects(locked.set(endpoint, replacement), /unavailable/);
    assert.equal((await readFile(f.path)).toString(), 'corrupt ciphertext');
    await writeFile(f.path, original);
    await locked.load();
    assert.equal(locked.get(endpoint), key);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('failed encryption and failed rename preserve previous state and clean temporary files', async () => {
  const f = await fixture();
  try {
    await f.store.set(endpoint, key);
    const original = await readFile(f.path);
    f.crypto.failEncryption = true;
    await assert.rejects(f.store.set(endpoint, replacement), error => error instanceof Error && !error.message.includes(replacement) && !error.message.includes(key));
    assert.equal(f.store.get(endpoint), key);
    assert.deepEqual(await readFile(f.path), original);
    f.crypto.failEncryption = false;
    const saved = join(f.dir, 'original.enc');
    await rename(f.path, saved);
    await mkdir(f.path);
    await assert.rejects(f.store.set(endpoint, replacement), /unavailable/);
    assert.equal(f.store.get(endpoint), key);
    assert.deepEqual(await readFile(saved), original);
    assert.deepEqual((await readdir(f.dir)).sort(), ['credentials.enc', 'original.enc']);
    await rm(f.path, { recursive: true });
    await rename(saved, f.path);
    await f.store.set(endpoint, replacement);
    assert.equal(f.store.get(endpoint), replacement);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('key validation and encrypted payload limits reject unsafe input without reflecting it', async () => {
  for (const value of [null, '', 'short', 'space inside valid length secret', 'a'.repeat(513), 'test-key-with-中文-characters']) {
    assert.throws(() => validateApiKey(value));
  }
  assert.equal(validateApiKey(key), key);
  const f = await fixture();
  try {
    await writeFile(f.path, Buffer.alloc(64 * 1024 + 1));
    await assert.rejects(f.store.load(), /unavailable/);
    assert.equal(f.store.isDisabled(endpoint), true);
    await rm(f.path);
    await f.store.load();
    for (let i = 0; i < 16; i++) await f.store.set({ ...endpoint, apiKeyEnv: `KEY_${i}` }, key);
    await assert.rejects(f.store.set({ ...endpoint, apiKeyEnv: 'KEY_16' }, replacement), /Too many/);
    assert.equal(f.store.get({ ...endpoint, apiKeyEnv: 'KEY_16' }), undefined);
    const restored = new CredentialStore(f.path, f.crypto);
    await restored.load();
    assert.equal(restored.get({ ...endpoint, apiKeyEnv: 'KEY_15' }), key);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
