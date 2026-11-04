import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, parseConfig, publicConfig, loadConfig, migrateLegacyShortcuts } from '../src/main/config';

test('config validates recording windows, endpoints, hotkeys, and secret names', () => {
  assert.equal(parseConfig({}).transcriptWindowSeconds, 30);
  assert.throws(() => parseConfig({ transcriptWindowSeconds: 61 }), /5 to 60/);
  assert.throws(() => parseConfig({ chat: { baseUrl: 'http://example.com' } }), /HTTPS/);
  assert.throws(() => parseConfig({ chat: { baseUrl: 'https://user:key@example.com' } }), /credentials/);
  assert.throws(() => parseConfig({ chat: { apiKeyEnv: 'VITE_API_KEY' } }), /private/);
  assert.throws(() => parseConfig({ hotkeys: { ask: 'Ctrl+H', toggle: 'Ctrl+H' } }), /different/);
  assert.throws(() => parseConfig({ interactionModifiers: ['Escape'] }), /modifier/);
  assert.throws(() => parseConfig({ chat: { tokenLimitParameter: 'unknown' } }), /tokenLimitParameter/);
  assert.equal(parseConfig({ chat: { tokenLimitParameter: 'max_tokens' } }).chat.tokenLimitParameter, 'max_tokens');
  const publicPart = publicConfig(defaultConfig());
  assert.equal('chat' in publicPart, false);
  assert.equal('transcription' in publicPart, false);
  assert.equal('libraryPath' in publicPart, false);
});

test('bad existing config is never overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peek-config-test-'));
  try {
    const file = join(dir, 'config.json');
    assert.equal((await loadConfig(file, defaultConfig())).model, 'gpt-4.1-mini');
    await writeFile(file, '{broken');
    await assert.rejects(() => loadConfig(file, defaultConfig()));
    assert.equal(await readFile(file, 'utf8'), '{broken');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy three-key shortcuts migrate while custom bindings remain intact', () => {
  const next = parseConfig(migrateLegacyShortcuts({
    hotkeys: { ask: 'CommandOrControl+Shift+Space', toggle: 'F9', followUp: 'CommandOrControl+Shift+Enter' },
    interactionModifiers: ['Command', 'Alt'],
  }));
  assert.equal(next.hotkeys.ask, 'Alt+Space');
  assert.equal(next.hotkeys.followUp, 'Alt+Enter');
  assert.equal(next.hotkeys.toggle, 'F9');
  assert.deepEqual(next.interactionModifiers, ['Alt']);
  assert.deepEqual(parseConfig(migrateLegacyShortcuts({ interactionModifiers: ['Control'] })).interactionModifiers, ['Control']);
});
