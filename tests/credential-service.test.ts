import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type Config } from '../src/main/config';
import { CredentialService, verifyCredential } from '../src/main/credential-service';
import { CredentialStore, type EncryptionBackend } from '../src/main/credentials';

const oldKey = 'old-test-only-api-key-0123456789';
const newKey = 'new-test-only-api-key-0123456789';
const envKey = 'environment-test-only-key-0123456789';

function backend(): EncryptionBackend {
  const encryptionKey = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

async function fixture(options: { config?: Config; fetcher?: typeof fetch; enabled?: () => boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'peek-credential-service-'));
  const path = join(dir, 'credentials.enc');
  const crypto = backend();
  const store = new CredentialStore(path, crypto);
  await store.load();
  const config = options.config ?? defaultConfig();
  const environment = { OPENAI_API_KEY: envKey, OTHER_API_KEY: 'other-environment-key-0123456789' };
  let changes = 0;
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    return options.fetcher ? options.fetcher(url, init) : Response.json({ data: [{ id: 'test-model' }] });
  };
  const service = new CredentialService(config, store, () => changes++, options.enabled, environment, fetcher);
  return { dir, path, crypto, store, config, environment, service, calls: () => calls, changes: () => changes };
}

function containsSecret(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return [oldKey, newKey, envKey].some(key => serialized.includes(key));
}

test('credential verification uses only the configured models endpoint and never sends context', async () => {
  const endpoint = { baseUrl: 'https://api.openai.com/v1/', apiKeyEnv: 'OPENAI_API_KEY' };
  const result = await verifyCredential(endpoint, newKey, new AbortController().signal, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(init?.body, undefined);
    assert.deepEqual(init?.headers, { Authorization: `Bearer ${newKey}` });
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ data: [{ id: 'model' }], secret: newKey });
  });
  assert.equal(result, 'verified');
});

test('verification maps HTTP statuses and discards provider error bodies', async () => {
  const codes = [[401, 'unauthorized'], [403, 'forbidden'], [429, 'quota'], [404, 'unsupported'], [405, 'unsupported'], [500, 'network']] as const;
  for (const [status, expected] of codes) {
    let cancelled = false;
    const result = await verifyCredential(defaultConfig().chat, newKey, new AbortController().signal, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`Echoed secret ${newKey}`)); },
      cancel() { cancelled = true; },
    }), { status }));
    assert.equal(result, expected);
    assert.equal(cancelled, true);
    assert.equal(containsSecret(result), false);
  }
});

test('successful responses with malformed, unsupported, or oversized data are not verified', async () => {
  for (const body of ['not JSON', 'null', '{}', '{"data":{}}']) {
    assert.equal(await verifyCredential(defaultConfig().chat, newKey, new AbortController().signal, async () => new Response(body)), 'unsupported');
  }
  assert.equal(await verifyCredential(defaultConfig().chat, newKey, new AbortController().signal, async () => new Response(null)), 'unsupported');
  assert.equal(await verifyCredential(defaultConfig().chat, newKey, new AbortController().signal, async () => new Response('x'.repeat(512_001))), 'unsupported');
});

test('verification reports cancellation both before fetch and during body consumption', async () => {
  const before = new AbortController();
  before.abort();
  assert.equal(await verifyCredential(defaultConfig().chat, newKey, before.signal, async (_url, init) => {
    init?.signal?.throwIfAborted();
    return Response.json({ data: [] });
  }), 'cancelled');
  const during = new AbortController();
  assert.equal(await verifyCredential(defaultConfig().chat, newKey, during.signal, async () => new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('{"data":[]}'));
        during.abort();
        controller.close();
      }, 0);
    },
  }))), 'cancelled');
});

test('secure storage overrides environment keys without exposing any secret in public state', async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.resolve(f.config.chat), envKey);
    assert.equal(f.service.state().targets.length, 1);
    assert.equal(f.service.state().targets[0]?.source, 'environment');
    const saved = await f.service.save({ targetId: 'chat', key: newKey, verify: false });
    assert.equal(saved.ok, true);
    assert.equal(saved.code, 'saved');
    assert.equal(f.calls(), 0);
    assert.equal(f.changes(), 1);
    assert.equal(f.service.resolve(f.config.chat), newKey);
    assert.equal(f.service.resolve(f.config.transcription), newKey);
    assert.equal(f.service.state().targets[0]?.source, 'secure');
    assert.equal(containsSecret(saved), false);
    assert.equal(containsSecret(f.service.state()), false);
    assert.equal((await readFile(f.path)).includes(Buffer.from(newKey)), false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('failed verification preserves the previous credential and ciphertext', async () => {
  const f = await fixture({ fetcher: async () => new Response(`Do not reflect ${newKey}`, { status: 401 }) });
  try {
    await f.store.set(f.config.chat, oldKey);
    const original = await readFile(f.path);
    const result = await f.service.save({ targetId: 'chat', key: newKey, verify: true });
    assert.deepEqual(result, { ok: false, code: 'unauthorized' });
    assert.equal(f.service.resolve(f.config.chat), oldKey);
    assert.deepEqual(await readFile(f.path), original);
    assert.equal(f.calls(), 1);
    assert.equal(f.changes(), 0);
    assert.equal(containsSecret(result), false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('invalid keys, targets, and requests never issue a network request', async () => {
  const f = await fixture();
  try {
    for (const invalid of [null, '', 'short', 'inside whitespace invalid key', 'x'.repeat(513), 'bad-中文-api-key-0123456789']) {
      assert.equal((await f.service.save({ targetId: 'chat', key: invalid, verify: true })).code, 'invalid_key');
    }
    assert.equal((await f.service.save(null)).code, 'invalid_key');
    assert.equal((await f.service.save({ targetId: 'https://attacker.example', key: newKey, verify: true })).code, 'invalid_target');
    assert.equal((await f.service.save({ targetId: 'chat', key: newKey })).code, 'invalid_key');
    assert.equal((await f.service.remove('transcription')).code, 'invalid_target');
    assert.equal(f.calls(), 0);
    assert.equal(f.changes(), 0);
    assert.equal(f.service.resolve(f.config.chat), envKey);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('removal remains disabled across restart despite a still-present environment key', async () => {
  const f = await fixture();
  try {
    await f.service.save({ targetId: 'chat', key: newKey, verify: false });
    const removed = await f.service.remove('chat');
    assert.equal(removed.code, 'removed');
    assert.equal(f.service.resolve(f.config.chat), undefined);
    assert.equal(containsSecret(removed), false);
    const store = new CredentialStore(f.path, f.crypto);
    await store.load();
    const restarted = new CredentialService(f.config, store, () => {}, () => true, f.environment);
    assert.equal(restarted.resolve(f.config.chat), undefined);
    assert.deepEqual(restarted.state().targets.map(t => ({ source: t.source, disabled: t.disabled, stored: t.stored })), [{ source: 'none', disabled: true, stored: false }]);
    assert.equal((await restarted.save({ targetId: 'chat', key: oldKey, verify: false })).ok, true);
    assert.equal(restarted.resolve(f.config.chat), oldKey);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('custom chat and transcription destinations remain separate and payload URLs are ignored', async () => {
  const config = defaultConfig();
  config.chat = { ...config.chat, baseUrl: 'https://vision.example/compatible-mode/v1', apiKeyEnv: 'OTHER_API_KEY' };
  const requests: string[] = [];
  const f = await fixture({ config, fetcher: async url => { requests.push(String(url)); return Response.json({ data: [] }); } });
  try {
    assert.equal(f.service.state().targets.length, 2);
    assert.equal((await f.service.save({ targetId: 'chat', key: newKey, verify: true, baseUrl: 'https://attacker.example' })).code, 'verified');
    assert.deepEqual(requests, ['https://vision.example/compatible-mode/v1/models']);
    assert.equal(f.service.resolve(config.chat), newKey);
    assert.equal(f.service.resolve(config.transcription), envKey);
    assert.equal(f.store.get({ ...config.chat, baseUrl: 'https://different.example/v1' }), undefined);
    assert.equal((await f.service.remove('transcription')).code, 'removed');
    assert.equal(f.service.resolve(config.transcription), undefined);
    assert.equal(f.service.resolve(config.chat), newKey);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('a pending verification blocks concurrent mutations and cancellation preserves the old key', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    entered();
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  try {
    await f.store.set(f.config.chat, oldKey);
    const pending = f.service.save({ targetId: 'chat', key: newKey, verify: true });
    await started;
    assert.deepEqual(await f.service.save({ targetId: 'chat', key: newKey, verify: false }), { ok: false, code: 'busy' });
    assert.deepEqual(await f.service.remove('chat'), { ok: false, code: 'busy' });
    f.service.cancel();
    assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
    assert.equal(f.service.resolve(f.config.chat), oldKey);
    assert.equal(f.changes(), 0);
    assert.equal((await f.service.save({ targetId: 'chat', key: newKey, verify: false })).ok, true);
    assert.equal(f.service.resolve(f.config.chat), newKey);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('invalid application configuration prevents verification and all credential mutations', async () => {
  const f = await fixture({ enabled: () => false });
  try {
    assert.equal(f.service.state().secureStorageAvailable, false);
    assert.ok(f.service.state().storageError);
    assert.equal((await f.service.save({ targetId: 'chat', key: newKey, verify: true })).code, 'unavailable');
    assert.equal((await f.service.remove('chat')).code, 'unavailable');
    assert.equal(f.calls(), 0);
    assert.equal(f.changes(), 0);
    assert.equal(containsSecret(f.service.state()), false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
