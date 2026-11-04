import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { PublicConfig } from '../shared/types';

export interface EndpointConfig { baseUrl: string; apiKeyEnv: string }
export interface Config extends PublicConfig {
  chat: EndpointConfig & { tokenLimitParameter: 'max_completion_tokens' | 'max_tokens' };
  transcription: EndpointConfig & { model: string };
  libraryPath: string;
}

export function defaultConfig(interactionModifiers = ['Shift']): Config {
  return {
    model: 'gpt-6.1-sol', language: 'zh', inputDeviceId: '', transcriptWindowSeconds: 30,
    hotkeys: { ask: 'Control+Enter', toggle: 'Control+Backspace', followUp: '' },
    interactionModifiers,
    chat: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', tokenLimitParameter: 'max_completion_tokens' },
    transcription: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-transcribe' },
    libraryPath: '',
  };
}

/** Apply OpenAI-specific model behavior only to the canonical API endpoint. */
export function isOfficialOpenAIEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.openai.com' && !url.port
      && url.pathname.replace(/\/+$/, '') === '/v1' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function str(value: unknown, fallback: string, label: string, allowEmpty = false): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 4096 || (!allowEmpty && !value.trim())) throw new Error(`${label} must be a ${allowEmpty ? '' : 'nonempty '}string.`);
  return value.trim();
}
function hotkeyIdentity(value: string): string {
  const aliases: Record<string, string> = {
    ctrl: 'control', cmd: 'command', option: 'alt', return: 'enter',
    commandorcontrol: process.platform === 'darwin' ? 'command' : 'control',
    cmdorctrl: process.platform === 'darwin' ? 'command' : 'control',
  };
  return value.toLowerCase().split('+').map(part => aliases[part] ?? part).sort().join('+');
}
function endpoint(value: unknown, fallback: EndpointConfig, label: string): EndpointConfig {
  const raw = value === undefined ? {} : object(value, label);
  const baseUrl = str(raw.baseUrl, fallback.baseUrl, `${label}.baseUrl`).replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${label}.baseUrl must be HTTPS with no credentials, query, or fragment.`);
  const apiKeyEnv = str(raw.apiKeyEnv, fallback.apiKeyEnv, `${label}.apiKeyEnv`);
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(apiKeyEnv) || apiKeyEnv.startsWith('VITE_') || apiKeyEnv.startsWith('PEEK_PUBLIC_')) throw new Error(`${label}.apiKeyEnv must name a private uppercase environment variable.`);
  return { baseUrl, apiKeyEnv };
}
export function parseConfig(value: unknown, defaults = defaultConfig()): Config {
  const raw = object(value, 'Config');
  const hotkeys = raw.hotkeys === undefined ? {} : object(raw.hotkeys, 'hotkeys');
  const seconds = raw.transcriptWindowSeconds ?? defaults.transcriptWindowSeconds;
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 5 || seconds > 60) throw new Error('transcriptWindowSeconds must be an integer from 5 to 60.');
  const modifiers = raw.interactionModifiers ?? defaults.interactionModifiers;
  if (!Array.isArray(modifiers) || modifiers.length < 1 || modifiers.length > 4 || modifiers.some(x => typeof x !== 'string' || !/^(command|cmd|control|ctrl|alt|option|shift|super|meta|commandorcontrol|cmdorctrl)$/i.test(x))) throw new Error('interactionModifiers must contain 1–4 supported modifier names.');
  const language = raw.language ?? defaults.language;
  if (language !== 'zh' && language !== 'en') throw new Error('language must be zh or en.');
  const libraryPath = str(raw.libraryPath, defaults.libraryPath, 'libraryPath', true);
  if (libraryPath && !isAbsolute(libraryPath)) throw new Error('libraryPath must be an absolute folder path.');
  const transcription = raw.transcription === undefined ? {} : object(raw.transcription, 'transcription');
  const chat = raw.chat === undefined ? {} : object(raw.chat, 'chat');
  const tokenLimitParameter = chat.tokenLimitParameter ?? defaults.chat.tokenLimitParameter;
  if (tokenLimitParameter !== 'max_completion_tokens' && tokenLimitParameter !== 'max_tokens') throw new Error('chat.tokenLimitParameter must be max_completion_tokens or max_tokens.');
  const result: Config = {
    model: str(raw.model, defaults.model, 'model'), language,
    inputDeviceId: str(raw.inputDeviceId, '', 'inputDeviceId', true), transcriptWindowSeconds: seconds,
    hotkeys: {
      ask: str(hotkeys.ask, defaults.hotkeys.ask, 'hotkeys.ask'),
      toggle: str(hotkeys.toggle, defaults.hotkeys.toggle, 'hotkeys.toggle'),
      // Asking again already follows up in the current thread. A separate
      // global binding is optional, so it need not occupy another app's key.
      followUp: str(hotkeys.followUp, defaults.hotkeys.followUp, 'hotkeys.followUp', true),
    },
    interactionModifiers: modifiers,
    chat: { ...endpoint(raw.chat, defaults.chat, 'chat'), tokenLimitParameter },
    transcription: { ...endpoint(raw.transcription, defaults.transcription, 'transcription'), model: str(transcription.model, defaults.transcription.model, 'transcription.model') },
    libraryPath,
  };
  const enabledHotkeys = Object.values(result.hotkeys).filter(Boolean).map(hotkeyIdentity);
  if (new Set(enabledHotkeys).size !== enabledHotkeys.length) throw new Error('Each hotkey must be different.');
  return result;
}
export async function loadConfig(path: string, defaults: Config): Promise<Config> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const migrated = migrateLegacyModels(migrateLegacyShortcuts(raw, defaults), defaults);
    const config = parseConfig(migrated, defaults);
    if (JSON.stringify(migrated) !== JSON.stringify(raw)) await saveConfig(path, config);
    return config;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await saveConfig(path, defaults);
    return defaults;
  }
}

/** Replace only previously shipped OpenAI model defaults; keep custom providers. */
export function migrateLegacyModels(value: unknown, defaults = defaultConfig()): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const result = { ...raw };
  const usesOpenAI = (endpointValue: unknown, fallback: EndpointConfig): boolean => {
    if (endpointValue === undefined) return isOfficialOpenAIEndpoint(fallback.baseUrl);
    if (!endpointValue || typeof endpointValue !== 'object' || Array.isArray(endpointValue)) return false;
    const baseUrl = (endpointValue as Record<string, unknown>).baseUrl ?? fallback.baseUrl;
    return typeof baseUrl === 'string' && isOfficialOpenAIEndpoint(baseUrl);
  };
  if (raw.model === 'gpt-4.1-mini' && usesOpenAI(raw.chat, defaults.chat)) result.model = defaults.model;
  if (raw.transcription && typeof raw.transcription === 'object' && !Array.isArray(raw.transcription)) {
    const transcription = raw.transcription as Record<string, unknown>;
    if (transcription.model === 'whisper-1' && usesOpenAI(transcription, defaults.transcription)) {
      result.transcription = { ...transcription, model: defaults.transcription.model };
    }
  }
  return result;
}

/** Upgrade exact shipped bindings from v0.1.0/v0.1.1; keep custom choices intact. */
export function migrateLegacyShortcuts(value: unknown, defaults = defaultConfig()): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const result = { ...raw };
  if (raw.hotkeys && typeof raw.hotkeys === 'object' && !Array.isArray(raw.hotkeys)) {
    const original = raw.hotkeys as Record<string, unknown>;
    const hotkeys = { ...original };
    const old = {
      ask: ['CommandOrControl+Shift+Space', 'Alt+Space'],
      toggle: ['CommandOrControl+Shift+H', 'Alt+H'],
      followUp: ['CommandOrControl+Shift+Enter', 'Alt+Enter'],
    };
    for (const key of ['ask', 'toggle', 'followUp'] as const) {
      if (old[key].includes(hotkeys[key] as string)) hotkeys[key] = defaults.hotkeys[key];
    }
    // A retained custom binding owns its key. Do not invalidate the whole
    // configuration by moving a historical default onto that key during upgrade.
    for (const key of ['ask', 'toggle', 'followUp'] as const) {
      const target = hotkeys[key];
      if (target === original[key] || typeof target !== 'string' || !target) continue;
      if (Object.entries(hotkeys).some(([other, value]) => other !== key && typeof value === 'string' && value && hotkeyIdentity(value) === hotkeyIdentity(target))) {
        hotkeys[key] = original[key];
      }
    }
    result.hotkeys = hotkeys;
  }
  if (['["Command","Alt"]', '["Control","Alt"]', '["Alt"]'].includes(JSON.stringify(raw.interactionModifiers))) {
    result.interactionModifiers = defaults.interactionModifiers;
  }
  return result;
}
export async function saveConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
export function publicConfig(config: Config): PublicConfig {
  const { model, language, inputDeviceId, transcriptWindowSeconds, hotkeys, interactionModifiers } = config;
  return { model, language, inputDeviceId, transcriptWindowSeconds, hotkeys, interactionModifiers };
}
