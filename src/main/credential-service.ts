import type { Config, EndpointConfig } from './config';
import { CredentialStore, validateApiKey } from './credentials';
import type { CredentialBootstrap, CredentialResult, CredentialTarget } from '../shared/types';

/** Tests authentication against the selected provider without sending any context. */
export async function verifyCredential(endpoint: EndpointConfig, key: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<CredentialResult['code']> {
  try {
    const response = await fetcher(`${endpoint.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${key}` }, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (signal.aborted) return 'cancelled';
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) return 'unauthorized';
      if (response.status === 403) return 'forbidden';
      if (response.status === 429) return 'quota';
      if (response.status === 404 || response.status === 405) return 'unsupported';
      return 'network';
    }
    if (!response.body) return 'unsupported';
    const reader = response.body.getReader();
    let body = '';
    let length = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 512_000) return 'unsupported';
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      if (signal.aborted) return 'cancelled';
      try {
        const parsed: unknown = JSON.parse(body);
        return parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data) ? 'verified' : 'unsupported';
      } catch { return 'unsupported'; }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch { return signal.aborted ? 'cancelled' : 'network'; }
}

export class CredentialService {
  private operation: AbortController | undefined;
  constructor(
    private readonly config: Config,
    private readonly store: CredentialStore,
    private readonly changed: () => void,
    private readonly enabled = () => true,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  resolve(endpoint: EndpointConfig): string | undefined {
    if (this.store.isDisabled(endpoint)) return undefined;
    return this.store.get(endpoint) || this.environment[endpoint.apiKeyEnv]?.trim() || undefined;
  }

  private endpoints(): Array<{ id: 'chat' | 'transcription'; endpoint: EndpointConfig; label: string }> {
    const same = this.config.chat.baseUrl === this.config.transcription.baseUrl && this.config.chat.apiKeyEnv === this.config.transcription.apiKeyEnv;
    const zh = this.config.language === 'zh';
    return [
      { id: 'chat', endpoint: this.config.chat, label: same ? (zh ? '问答与转写' : 'Answers & audio') : (zh ? '问答' : 'Answers') },
      ...(!same ? [{ id: 'transcription' as const, endpoint: this.config.transcription, label: zh ? '转写' : 'Audio' }] : []),
    ];
  }

  state(): CredentialBootstrap {
    const targets: CredentialTarget[] = this.endpoints().map(({ id, label, endpoint }) => {
      const stored = this.store.hasStored(endpoint);
      const disabled = this.store.isDisabled(endpoint);
      return { id, label, baseUrl: endpoint.baseUrl, stored, disabled, source: disabled ? 'none' : stored ? 'secure' : this.resolve(endpoint) ? 'environment' : 'none' };
    });
    return {
      language: this.config.language, secureStorageAvailable: this.enabled() && this.store.available(), targets,
      ...(!this.enabled() ? { storageError: this.config.language === 'zh' ? '请先修复配置文件，然后重启 Peek。' : 'Fix the configuration file and restart Peek.' } : {}),
    };
  }

  cancel(): void { this.operation?.abort(); }

  async save(value: unknown): Promise<CredentialResult> {
    if (this.operation) return { ok: false, code: 'busy' };
    if (!this.enabled() || !this.store.available()) return { ok: false, code: 'unavailable', state: this.state() };
    if (!value || typeof value !== 'object') return { ok: false, code: 'invalid_key' };
    const request = value as { targetId?: unknown; key?: unknown; verify?: unknown };
    const target = this.endpoints().find(item => item.id === request.targetId);
    if (!target) return { ok: false, code: 'invalid_target' };
    if (typeof request.verify !== 'boolean') return { ok: false, code: 'invalid_key' };
    let key: string;
    try { key = validateApiKey(request.key); } catch { return { ok: false, code: 'invalid_key' }; }
    const controller = new AbortController();
    this.operation = controller;
    try {
      if (request.verify) {
        const code = await verifyCredential(target.endpoint, key, controller.signal, this.fetcher);
        if (code !== 'verified') return { ok: false, code };
      }
      if (controller.signal.aborted) return { ok: false, code: 'cancelled' };
      await this.store.set(target.endpoint, key);
      this.changed();
      return { ok: true, code: request.verify ? 'verified' : 'saved', state: this.state() };
    } catch { return { ok: false, code: 'storage', state: this.state() }; }
    finally { key = ''; this.operation = undefined; }
  }

  async remove(id: unknown): Promise<CredentialResult> {
    if (this.operation) return { ok: false, code: 'busy' };
    if (!this.enabled() || !this.store.available()) return { ok: false, code: 'unavailable', state: this.state() };
    const target = this.endpoints().find(item => item.id === id);
    if (!target) return { ok: false, code: 'invalid_target' };
    this.operation = new AbortController();
    try {
      await this.store.remove(target.endpoint);
      this.changed();
      return { ok: true, code: 'removed', state: this.state() };
    } catch { return { ok: false, code: 'storage', state: this.state() }; }
    finally { this.operation = undefined; }
  }
}
