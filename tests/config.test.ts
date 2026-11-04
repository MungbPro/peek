import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, parseConfig, publicConfig, loadConfig, migrateLegacyShortcuts, migrateLegacyModels, isOfficialOpenAIEndpoint } from '../src/main/config';

test('config validates recording windows, endpoints, hotkeys, and secret names', () => {
  assert.equal(parseConfig({}).transcriptWindowSeconds, 30);
  assert.throws(() => parseConfig({ transcriptWindowSeconds: 61 }), /5 to 60/);
  assert.throws(() => parseConfig({ chat: { baseUrl: 'http://example.com' } }), /HTTPS/);
  assert.throws(() => parseConfig({ chat: { baseUrl: 'https://user:key@example.com' } }), /credentials/);
  assert.throws(() => parseConfig({ chat: { apiKeyEnv: 'VITE_API_KEY' } }), /private/);
  assert.throws(() => parseConfig({ hotkeys: { ask: 'Ctrl+H', toggle: 'Ctrl+H' } }), /different/);
  assert.throws(() => parseConfig({ hotkeys: { ask: 'Control+Enter', toggle: 'Ctrl+Return' } }), /different/);
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
    assert.equal((await loadConfig(file, defaultConfig())).model, 'gpt-6.1-sol');
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
  assert.equal(next.hotkeys.ask, 'Control+Enter');
  assert.equal(next.hotkeys.followUp, '');
  assert.equal(next.hotkeys.toggle, 'F9');
  assert.deepEqual(next.interactionModifiers, ['Shift']);
  assert.deepEqual(parseConfig(migrateLegacyShortcuts({ interactionModifiers: ['Control'] })).interactionModifiers, ['Control']);
});

test('Option defaults migrate to two-key controls and persist without altering other settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peek-config-upgrade-'));
  try {
    const file = join(dir, 'config.json');
    const previous = {
      ...defaultConfig(), inputDeviceId: 'test-microphone', model: 'test-model',
      hotkeys: { ask: 'Alt+Space', toggle: 'Alt+H', followUp: 'Alt+Enter' },
      interactionModifiers: ['Alt'],
    };
    await writeFile(file, JSON.stringify(previous));
    const next = await loadConfig(file, defaultConfig());
    assert.deepEqual(next.hotkeys, { ask: 'Control+Enter', toggle: 'Control+Backspace', followUp: '' });
    assert.deepEqual(next.interactionModifiers, ['Shift']);
    assert.equal(next.inputDeviceId, previous.inputDeviceId);
    assert.equal(next.model, previous.model);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), next);
    assert.deepEqual(await loadConfig(file, defaultConfig()), next);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('custom shortcuts and optional disabled follow-up survive upgrades', () => {
  const custom = {
    hotkeys: { ask: 'F8', toggle: 'F9', followUp: 'F10' },
    interactionModifiers: ['Control'],
  };
  assert.deepEqual(migrateLegacyShortcuts(custom), custom);
  assert.equal(parseConfig({ hotkeys: { followUp: '' } }).hotkeys.followUp, '');
  assert.throws(() => parseConfig({ hotkeys: { ask: '' } }), /nonempty/);
  assert.throws(() => parseConfig({ hotkeys: { followUp: 'Control+Enter' } }), /different/);
});

test('migration does not move an old default onto a retained custom shortcut', () => {
  const next = parseConfig(migrateLegacyShortcuts({
    hotkeys: { ask: 'Alt+Space', toggle: 'Ctrl+Return', followUp: 'Alt+Enter' },
    interactionModifiers: ['Alt'],
  }));
  assert.deepEqual(next.hotkeys, { ask: 'Alt+Space', toggle: 'Ctrl+Return', followUp: '' });
  assert.deepEqual(next.interactionModifiers, ['Shift']);
});

test('OpenAI shipped models migrate and persist while endpoints and keys remain unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peek-model-upgrade-'));
  try {
    const path = join(dir, 'config.json');
    const previous = {
      ...defaultConfig(), model: 'gpt-4.1-mini',
      transcription: { baseUrl: 'https://api.openai.com/v1/', apiKeyEnv: 'CUSTOM_TRANSCRIPTION_KEY', model: 'whisper-1' },
    };
    await writeFile(path, JSON.stringify(previous));
    const next = await loadConfig(path, defaultConfig());
    assert.equal(next.model, 'gpt-6.1-sol');
    assert.equal(next.transcription.model, 'gpt-transcribe');
    assert.equal(next.transcription.apiKeyEnv, 'CUSTOM_TRANSCRIPTION_KEY');
    assert.equal(next.transcription.baseUrl, 'https://api.openai.com/v1');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), next);
    assert.deepEqual(await loadConfig(path, defaultConfig()), next);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model migration preserves custom endpoints and explicit alternative models', () => {
  const custom = {
    model: 'gpt-4.1-mini', chat: { baseUrl: 'https://example.com/v1' },
    transcription: { baseUrl: 'https://example.com/v1', model: 'whisper-1' },
  };
  assert.deepEqual(migrateLegacyModels(custom), custom);
  const pinned = { model: 'gpt-6-astra', transcription: { model: 'pinned-transcription' } };
  assert.deepEqual(migrateLegacyModels(pinned), pinned);
  const independent = parseConfig(migrateLegacyModels({
    model: 'gpt-4.1-mini', chat: { baseUrl: 'https://example.com/v1' }, transcription: { model: 'whisper-1' },
  }));
  assert.equal(independent.model, 'gpt-4.1-mini');
  assert.equal(independent.transcription.model, 'gpt-transcribe');
  assert.equal(isOfficialOpenAIEndpoint('https://api.openai.com/v1/'), true);
  for (const url of ['https://api.openai.com.example/v1', 'https://api.openai.com/custom', 'https://example.com/v1', 'https://user@api.openai.com/v1']) {
    assert.equal(isOfficialOpenAIEndpoint(url), false);
  }
});
