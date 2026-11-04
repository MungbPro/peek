import type { CredentialBootstrap, CredentialResult, CredentialTarget } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing setup element: ${id}`);
  return element as T;
};
const ui = {
  language: $<HTMLButtonElement>('setup-language'), title: $('setup-title'), storage: $('storage-note'),
  targetRow: $('target-row'), targetLabel: $('target-label'), target: $<HTMLSelectElement>('key-target'),
  providerLabel: $('provider-label'), provider: $('provider-host'), stored: $('stored-state'),
  form: $<HTMLFormElement>('key-form'), keyLabel: $('key-label'), key: $<HTMLInputElement>('api-key'),
  show: $<HTMLButtonElement>('show-key'), open: $<HTMLButtonElement>('open-key-page'),
  remove: $<HTMLButtonElement>('remove-key'), status: $('setup-status'),
  save: $<HTMLButtonElement>('save-key'), saveOnly: $<HTMLButtonElement>('save-only'),
  validation: $('validation-note'), done: $<HTMLButtonElement>('done'),
};
let state: CredentialBootstrap | undefined;
let language: 'zh' | 'en' = 'zh';
let busy = false;
let confirmingRemove = false;
let statusKey = '';
let statusKind: 'pending' | 'error' | 'success' = 'success';

const words = {
  zh: {
    title: '连接你的 AI', storageNote: '密钥加密保存在本机，由系统保护。', target: '用途', destination: '连接到',
    key: 'API 密钥', placeholder: '粘贴你的 API 密钥', replacement: '粘贴新密钥以更换', show: '显示', hide: '隐藏',
    open: '获取 OpenAI 密钥 ↗', remove: '删除密钥', confirmRemove: '确认删除', save: '验证并保存', saveOnly: '仅保存',
    validation: '验证连接，不验证余额或语音权限。', done: '完成', later: '稍后设置',
    secure: '已加密保存。输入新密钥可更换。', environment: '正在使用已有配置的密钥。可在这里更换。', disabled: '此连接的密钥已停用。', none: '尚未设置密钥。',
    verifyPending: '正在验证连接…', savePending: '正在安全保存…', removePending: '正在删除…',
    removeQuestion: '再次点击确认删除。已有 .env 文件不会被修改。',
    saved: '已安全保存。尚未验证连接。', verified: '连接成功，密钥已安全保存。', removed: '密钥已删除，此连接已停用。',
    invalid_key: '请粘贴完整密钥，不要包含空格或换行。', unauthorized: '密钥无效或已撤销，请重新创建。',
    forbidden: '密钥没有验证接口权限。可选择仅保存，再尝试问答。', quota: '服务暂时限流，或账户额度不足。请检查后重试。',
    network: '连接未成功。检查网络，或选择仅保存。', unavailable: '系统安全存储不可用，暂时无法保存密钥。',
    storage: '无法访问安全存储。请检查系统授权后重试。', cancelled: '操作已取消。', busy: '上一个操作尚未完成。',
    invalid_target: '连接配置已改变，请关闭后重新打开。', unsupported: '此服务不支持连接验证，可选择仅保存。',
    unknown: '操作未完成，请重试。', bootstrapError: '无法载入密钥设置，请关闭后重新打开。', linkError: '无法打开浏览器，请稍后重试。',
    chat: '截图与问答', transcription: '语音转写', both: '问答与语音',
  },
  en: {
    title: 'Connect your AI', storageNote: 'Your key is encrypted locally with system protection.', target: 'Use', destination: 'Connects to',
    key: 'API key', placeholder: 'Paste your API key', replacement: 'Paste a new key to replace it', show: 'Show', hide: 'Hide',
    open: 'Get an OpenAI key ↗', remove: 'Remove key', confirmRemove: 'Confirm removal', save: 'Verify & save', saveOnly: 'Save only',
    validation: 'Verifies the connection, not billing or audio access.', done: 'Done', later: 'Set up later',
    secure: 'Saved securely. Enter a new key to replace it.', environment: 'Using a key from existing configuration. You can replace it here.', disabled: 'The key for this connection is disabled.', none: 'No key saved yet.',
    verifyPending: 'Checking the connection…', savePending: 'Saving securely…', removePending: 'Removing…',
    removeQuestion: 'Click again to confirm. Existing .env files stay unchanged.',
    saved: 'Saved securely. Connection not yet verified.', verified: 'Connected. Your key is saved securely.', removed: 'Key removed. This connection is now disabled.',
    invalid_key: 'Paste a complete key without spaces or line breaks.', unauthorized: 'This key is invalid or revoked. Create a new one.',
    forbidden: 'This key cannot access the verification endpoint. Save only, then try a question.', quota: 'The service is rate-limited or the account has insufficient quota. Check and retry.',
    network: 'Could not connect. Check your network, or choose Save only.', unavailable: 'System secure storage is unavailable. Your key cannot be saved.',
    storage: 'Could not access secure storage. Check system permission and retry.', cancelled: 'Cancelled.', busy: 'The previous operation is still running.',
    invalid_target: 'The connection changed. Close and reopen this window.', unsupported: 'This service does not support connection verification. Choose Save only.',
    unknown: 'The operation did not finish. Please retry.', bootstrapError: 'Could not load key settings. Close and reopen this window.', linkError: 'Could not open the browser. Please retry later.',
    chat: 'Screen & answers', transcription: 'Transcription', both: 'Answers & audio',
  },
} as const;
type TextKey = keyof typeof words.zh;
function text(key: string): string { return words[language][key as TextKey] || words[language].unknown; }
function target(): CredentialTarget | undefined { return state?.targets.find(item => item.id === ui.target.value); }
function status(key: string, kind: typeof statusKind = 'success'): void {
  statusKey = key; statusKind = kind;
  ui.status.textContent = key ? text(key) : '';
  ui.status.dataset.state = kind;
}
function clearKey(): void { ui.key.value = ''; ui.key.type = 'password'; ui.show.setAttribute('aria-pressed', 'false'); }
function render(): void {
  const current = target();
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = language === 'zh' ? 'Peek · API 密钥' : 'Peek · API key';
  ui.language.textContent = language === 'zh' ? '中 / EN' : 'EN / 中';
  ui.language.setAttribute('aria-label', language === 'zh' ? 'Switch to English' : '切换为中文');
  ui.title.textContent = text('title'); ui.storage.textContent = text('storageNote');
  ui.targetLabel.textContent = text('target'); ui.providerLabel.textContent = text('destination');
  ui.keyLabel.textContent = text('key'); ui.key.placeholder = text(current?.source && current.source !== 'none' ? 'replacement' : 'placeholder');
  ui.show.textContent = text(ui.key.type === 'password' ? 'show' : 'hide');
  ui.show.setAttribute('aria-label', ui.show.textContent);
  ui.open.textContent = text('open'); ui.remove.textContent = text(confirmingRemove ? 'confirmRemove' : 'remove');
  ui.save.textContent = text('save'); ui.saveOnly.textContent = text('saveOnly');
  ui.validation.textContent = text('validation');
  ui.done.textContent = text(state?.targets.some(item => item.source !== 'none') ? 'done' : 'later');
  const selectedId = ui.target.value;
  ui.target.replaceChildren(...(state?.targets || []).map(item => new Option(text(item.id === 'chat' && state?.targets.length === 1 ? 'both' : item.id), item.id)));
  if (selectedId) ui.target.value = selectedId;
  ui.targetRow.hidden = (state?.targets.length || 0) <= 1;
  if (current) {
    try {
      const endpoint = new URL(current.baseUrl);
      ui.provider.textContent = `${endpoint.host}${endpoint.pathname === '/' ? '' : endpoint.pathname}`;
      ui.open.hidden = endpoint.hostname !== 'api.openai.com' && !endpoint.hostname.endsWith('.api.openai.com');
    }
    catch { ui.provider.textContent = current.baseUrl; }
    ui.provider.title = current.baseUrl;
    ui.stored.textContent = text(current.disabled ? 'disabled' : current.source === 'secure' ? 'secure' : current.source === 'environment' ? 'environment' : 'none');
  } else { ui.provider.textContent = ''; ui.stored.textContent = ''; ui.open.hidden = true; }
  const canSave = Boolean(state?.secureStorageAvailable && current && ui.key.value.trim());
  ui.save.disabled = busy || !canSave; ui.saveOnly.disabled = busy || !canSave;
  ui.key.disabled = busy || !state?.secureStorageAvailable;
  ui.show.disabled = busy || ui.key.disabled;
  ui.target.disabled = busy;
  ui.remove.hidden = !current || (current.source === 'none' && !current.stored);
  ui.remove.disabled = busy || !state?.secureStorageAvailable;
  ui.open.disabled = busy;
  ui.done.disabled = busy;
  ui.status.textContent = statusKey ? text(statusKey) : '';
  ui.status.dataset.state = statusKind;
}
function apply(next: CredentialBootstrap): void {
  const previous = ui.target.value;
  state = next;
  ui.target.replaceChildren(...next.targets.map(item => new Option(item.label, item.id)));
  if (next.targets.some(item => item.id === previous)) ui.target.value = previous;
  if (!next.secureStorageAvailable) status(next.storageError ? 'storage' : 'unavailable', 'error');
  render();
}
function finish(result: CredentialResult): void {
  if (result.state) apply(result.state);
  status(result.code, result.ok ? 'success' : 'error');
}
async function save(verify: boolean): Promise<void> {
  if (busy || !target() || !state?.secureStorageAvailable) return;
  const key = ui.key.value.trim();
  if (key.length < 16 || key.length > 512 || /[^\x21-\x7E]/.test(key)) { status('invalid_key', 'error'); return; }
  const targetId = ui.target.value;
  clearKey();
  confirmingRemove = false; busy = true;
  status(verify ? 'verifyPending' : 'savePending', 'pending'); render();
  try { finish(await window.peekSetup.save({ targetId, key, verify })); }
  catch { status('unknown', 'error'); }
  finally { busy = false; render(); }
}
ui.form.addEventListener('submit', event => { event.preventDefault(); void save(true); });
ui.saveOnly.addEventListener('click', () => { void save(false); });
ui.key.addEventListener('input', () => {
  confirmingRemove = false;
  if (state?.secureStorageAvailable) status('');
  render();
});
ui.show.addEventListener('click', () => {
  ui.key.type = ui.key.type === 'password' ? 'text' : 'password';
  ui.show.setAttribute('aria-pressed', String(ui.key.type === 'text')); render();
});
ui.target.addEventListener('change', () => { clearKey(); confirmingRemove = false; status(''); render(); });
ui.language.addEventListener('click', () => { language = language === 'zh' ? 'en' : 'zh'; render(); });
ui.open.addEventListener('click', () => { void window.peekSetup.openKeyPage().catch(() => status('linkError', 'error')); });
ui.remove.addEventListener('click', () => {
  if (busy) return;
  if (!confirmingRemove) { confirmingRemove = true; status('removeQuestion'); render(); return; }
  clearKey(); confirmingRemove = false; busy = true;
  status('removePending', 'pending'); render();
  void window.peekSetup.remove(ui.target.value).then(finish).catch(() => status('unknown', 'error')).finally(() => { busy = false; render(); });
});
ui.done.addEventListener('click', () => { clearKey(); void window.peekSetup.close().catch(() => status('unknown', 'error')); });
window.addEventListener('beforeunload', clearKey);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { clearKey(); if (!busy) void window.peekSetup.close(); }
});
async function init(): Promise<void> {
  render();
  try {
    const next = await window.peekSetup.bootstrap();
    language = next.language;
    apply(next);
    if (next.secureStorageAvailable) ui.key.focus();
  } catch { status('bootstrapError', 'error'); }
}
void init();
