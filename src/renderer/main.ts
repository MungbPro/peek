import { RollingAudio } from './audio';
import type { Bootstrap, LibraryStatus, PeekEvent, SourcePassage } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element as T;
};

const elements = {
  interaction: $('interaction'), notice: $('notice'), languageToggle: $<HTMLButtonElement>('language-toggle'),
  audioToggle: $<HTMLButtonElement>('audio-toggle'), audioLabel: $('audio-label'), audioState: $('audio-state'), audioMessage: $('audio-message'), devices: $('devices'),
  libraryPanel: $<HTMLDetailsElement>('library-panel'), libraryLabel: $('library-label'), scopeLabel: $('scope-label'), libraryCount: $('library-count'),
  chooseLibrary: $<HTMLButtonElement>('choose-library'), reloadLibrary: $<HTMLButtonElement>('reload-library'),
  section: $<HTMLSelectElement>('section'), articleSearch: $<HTMLInputElement>('article-search'), focusArticle: $<HTMLSelectElement>('focus-article'),
  emptyState: $('empty-state'), emptyTitle: $('empty-title'), responseArea: $('response-area'), answer: $('answer'),
  sourcesPanel: $<HTMLDetailsElement>('sources-panel'), sources: $('sources'), sourcesLabel: $('sources-label'),
  audioInputLabel: $('audio-input-label'),
  intent: $<HTMLTextAreaElement>('intent'), requestState: $('request-state'), ask: $<HTMLButtonElement>('ask'), followUp: $<HTMLButtonElement>('follow-up'), cancel: $<HTMLButtonElement>('cancel'),
  askKey: $('ask-key'), holdHint: $('hold-hint'),
};

let bootstrap: Bootstrap | undefined;
let library: LibraryStatus = { root: null, documents: [], sections: [], chunks: 0, warnings: [] };
let focusedDocumentId = '';
let requestId: string | null = null;
let busy = false;
let hasThread = false;
let loadingLibrary = false;
let language: 'zh' | 'en' = 'zh';
let interactive = false;
let audioState: 'idle' | 'recording' | 'error' = 'idle';
let latestSources: SourcePassage[] = [];

const labels = {
  zh: {
    pass: '穿透', interactive: '操作中', startAudio: '开启音频', pauseAudio: '暂停音频', audioOff: '音频关闭', audioError: '音频异常', listening: '收音中 · 5秒',
    library: '文库', disconnected: '未连接', entireLibrary: '全部文库', focus: '选择当前文章', searchArticle: '查找文章…', openVault: '打开文库', reload: '刷新',
    ready: '随时提问。', answer: '回答', incomplete: '未完成', stopped: '已停止', connections: '关联', audioContext: '音频上下文', audioInput: '音频输入',
    placeholder: '输入问题，或直接提问…', ask: '提问 ↗', asking: '思考中…', followUp: '追问', stop: '停止', reading: '读取中…',
    noKey: '请在 .env 中填写 API 密钥并重启 Peek。', noAudioKey: '请在 .env 中填写转录 API 密钥并重启 Peek。',
    openSource: '打开原文', setupError: '启动失败：', audioFailed: '音频异常。', noDevices: '开启音频后显示设备。', unnamed: '未命名输入',
  },
  en: {
    pass: 'Click-through', interactive: 'Interactive', startAudio: 'Start audio', pauseAudio: 'Pause audio', audioOff: 'Audio off', audioError: 'Audio error', listening: 'Listening · 5s',
    library: 'Library', disconnected: 'Not connected', entireLibrary: 'Entire library', focus: 'Choose an article', searchArticle: 'Find article…', openVault: 'Open vault', reload: 'Reload',
    ready: 'Ready when you are.', answer: 'Answer', incomplete: 'Incomplete', stopped: 'Stopped', connections: 'Connections', audioContext: 'Audio context', audioInput: 'Audio input',
    placeholder: 'Ask a question, or ask from context…', ask: 'Ask ↗', asking: 'Thinking…', followUp: 'Follow up', stop: 'Stop', reading: 'Reading…',
    noKey: 'Add the API key to .env and restart Peek.', noAudioKey: 'Add the transcription API key to .env and restart Peek.',
    openSource: 'Open source', setupError: 'Could not start: ', audioFailed: 'Audio failed.', noDevices: 'Start audio to list inputs.', unnamed: 'Unnamed input',
  },
} as const;
const t = (key: keyof typeof labels.zh): string => labels[language][key];

function updateAudioLabels(): void {
  elements.audioToggle.setAttribute('aria-pressed', String(audioState === 'recording'));
  elements.audioLabel.textContent = t(audioState === 'recording' ? 'pauseAudio' : 'startAudio');
  elements.audioState.textContent = t(audioState === 'recording' ? 'listening' : audioState === 'error' ? 'audioError' : 'audioOff');
}

function updateLanguage(): void {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  elements.languageToggle.textContent = language === 'zh' ? '中 / EN' : 'EN / 中';
  elements.languageToggle.setAttribute('aria-label', language === 'zh' ? 'Switch to English' : '切换为中文');
  elements.interaction.textContent = t(interactive ? 'interactive' : 'pass');
  elements.emptyTitle.textContent = t('ready');
  elements.chooseLibrary.textContent = t('openVault');
  elements.reloadLibrary.textContent = t('reload');
  elements.intent.placeholder = t('placeholder');
  elements.articleSearch.placeholder = t('searchArticle');
  elements.articleSearch.setAttribute('aria-label', t('searchArticle'));
  elements.focusArticle.setAttribute('aria-label', t('focus'));
  elements.section.setAttribute('aria-label', t('entireLibrary'));
  elements.audioInputLabel.textContent = t('audioInput');
  elements.followUp.textContent = t('followUp');
  elements.cancel.textContent = t('stop');
  if (bootstrap) {
    const modifiers = bootstrap.config.interactionModifiers.map(displayShortcut).join(' + ');
    elements.holdHint.textContent = language === 'zh' ? `按住 ${modifiers} 操作` : `Hold ${modifiers} to interact`;
    elements.ask.title = displayShortcut(bootstrap.config.hotkeys.ask);
    elements.followUp.title = displayShortcut(bootstrap.config.hotkeys.followUp);
  }
  updateAudioLabels();
  updateLibrary(library);
  renderSources(latestSources);
  updateActions();
}

function showNotice(message: string): void {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function displayShortcut(shortcut: string): string {
  return shortcut.replace(/CommandOrControl|Command|Cmd/g, navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace(/Shift/g, '⇧').replace(/Alt|Option/g, navigator.platform.includes('Mac') ? '⌥' : 'Alt').replace(/Control/g, 'Ctrl').replace(/\+/g, ' ');
}

function updateActions(): void {
  elements.ask.disabled = !bootstrap?.chatReady || busy || loadingLibrary;
  elements.followUp.disabled = !bootstrap?.chatReady || !hasThread || busy || loadingLibrary;
  elements.cancel.hidden = !busy;
  elements.ask.textContent = t(busy ? 'asking' : 'ask');
  elements.answer.classList.toggle('streaming', busy && requestId !== null);
  elements.requestState.textContent = '';
}

function updateScopeLabel(): void {
  const doc = library.documents.find((item) => item.id === focusedDocumentId);
  elements.scopeLabel.textContent = elements.section.value || (library.root ? `${library.documents.length} ${language === 'zh' ? '篇' : 'articles'}` : t('disconnected'));
  elements.scopeLabel.title = doc ? doc.relativePath : elements.scopeLabel.textContent;
}

function updateArticles(): void {
  const filter = elements.articleSearch.value.trim().toLocaleLowerCase();
  const section = elements.section.value;
  const selected = library.documents.find((doc) => doc.id === focusedDocumentId);
  if (selected && section && selected.section !== section) focusedDocumentId = '';
  const docs = library.documents.filter((doc) => (!section || doc.section === section) && (!filter || `${doc.title} ${doc.relativePath}`.toLocaleLowerCase().includes(filter) || doc.id === focusedDocumentId));
  const options = [new Option(t('focus'), '')];
  for (const doc of docs) {
    const option = new Option(doc.title, doc.id);
    option.title = doc.relativePath;
    options.push(option);
  }
  elements.focusArticle.replaceChildren(...options);
  elements.focusArticle.value = focusedDocumentId;
  updateScopeLabel();
}

function updateLibrary(next: LibraryStatus): void {
  library = next;
  if (!library.documents.some((doc) => doc.id === focusedDocumentId)) focusedDocumentId = '';
  const previousSection = elements.section.value;
  elements.section.replaceChildren(new Option(t('entireLibrary'), ''), ...library.sections.map((section) => new Option(section, section)));
  if (library.sections.includes(previousSection)) elements.section.value = previousSection;
  elements.libraryLabel.textContent = t('library');
  elements.libraryCount.textContent = library.root ? `${library.documents.length} ${language === 'zh' ? '篇' : 'articles'} · ${library.chunks.toLocaleString()} ${language === 'zh' ? '段' : 'passages'}` : 'Markdown / TXT';
  elements.libraryCount.title = library.root || '';
  elements.reloadLibrary.disabled = !library.root || loadingLibrary;
  updateArticles();
  if (library.warnings.length) showNotice(library.warnings.join(' '));
}

function renderSources(sources: SourcePassage[]): void {
  latestSources = sources;
  elements.sources.replaceChildren();
  elements.sourcesPanel.hidden = sources.length === 0;
  elements.sourcesLabel.textContent = `${t('connections')} · ${sources.length}`;
  for (const source of sources) {
    const card = document.createElement('div');
    card.className = 'source';
    const open = document.createElement('button');
    open.className = 'source-open';
    open.type = 'button';
    open.textContent = `[${source.id}] ${source.title}`;
    open.title = t('openSource');
    open.addEventListener('click', () => { void window.peek.openSource(source.documentId).catch((error: unknown) => showNotice(errorText(error))); });
    const location = document.createElement('span');
    location.className = 'source-location';
    location.textContent = `${source.relativePath} · L${source.startLine}–${source.endLine}`;
    const excerpt = document.createElement('p');
    excerpt.textContent = source.text;
    card.append(open, location, excerpt);
    elements.sources.append(card);
  }
}

function clearThreadView(): void {
  hasThread = false;
  busy = false;
  requestId = null;
  elements.answer.textContent = '';
  elements.emptyState.hidden = false;
  renderSources([]);
  updateActions();
}

function onEvent(event: PeekEvent): void {
  switch (event.type) {
    case 'interaction':
      interactive = event.active;
      elements.interaction.textContent = t(event.active ? 'interactive' : 'pass');
      elements.interaction.classList.toggle('active', event.active);
      break;
    case 'trigger':
      void ask(event.followUp);
      break;
    case 'answer-start':
      requestId = event.requestId;
      busy = true;
      elements.emptyState.hidden = true;
      elements.answer.textContent = '';
      renderSources(event.sources);
      elements.responseArea.scrollTop = 0;
      updateActions();
      break;
    case 'answer-delta': {
      if (event.requestId !== requestId) break;
      const follow = elements.responseArea.scrollHeight - elements.responseArea.scrollTop - elements.responseArea.clientHeight < 70;
      elements.answer.append(document.createTextNode(event.delta));
      if (follow) elements.responseArea.scrollTop = elements.responseArea.scrollHeight;
      break;
    }
    case 'answer-done':
      if (event.requestId !== requestId) break;
      busy = false;
      hasThread = elements.answer.textContent!.length > 0 || hasThread;
      updateActions();
      break;
    case 'answer-error':
      if (requestId !== null && event.requestId !== requestId) break;
      busy = false;
      showNotice(event.message);
      updateActions();
      break;
    case 'warning': showNotice(event.message); break;
    case 'library': clearThreadView(); updateLibrary(event.library); break;
  }
}

async function ask(followUp: boolean): Promise<void> {
  if (!bootstrap?.chatReady) {
    showNotice(t('noKey'));
    return;
  }
  if (busy || loadingLibrary) return;
  busy = true;
  requestId = null;
  if (!followUp) hasThread = false;
  showNotice('');
  updateActions();
  elements.libraryPanel.open = false;
  try {
    await window.peek.ask({
      intent: elements.intent.value.trim(), followUp, language,
      ...(focusedDocumentId ? { focusDocumentId: focusedDocumentId } : {}),
      ...(elements.section.value ? { section: elements.section.value } : {}),
    });
  } catch (error) {
    busy = false;
    showNotice(errorText(error));
    updateActions();
  }
}

const audio = new RollingAudio({
  transcribe: (chunk) => window.peek.transcribe(chunk),
  status: (state, message) => {
    audioState = state;
    updateAudioLabels();
    elements.audioMessage.textContent = message || '';
    if (state === 'error') showNotice(message || t('audioFailed'));
    void window.peek.audioStatus({ state, message }).catch((error: unknown) => showNotice(errorText(error)));
  },
  devices: (devices) => {
    elements.devices.replaceChildren();
    for (const device of devices) {
      const row = document.createElement('div');
      row.className = 'device';
      const name = document.createElement('span');
      name.textContent = device.label || t('unnamed');
      const id = document.createElement('code');
      id.textContent = device.deviceId;
      row.append(name, id);
      elements.devices.append(row);
    }
  },
});

elements.ask.addEventListener('click', () => { void ask(false); });
elements.followUp.addEventListener('click', () => { void ask(true); });
elements.cancel.addEventListener('click', () => {
  void window.peek.cancel().then(() => {
    busy = false;
    showNotice(t('stopped'));
    updateActions();
  }).catch((error: unknown) => showNotice(errorText(error)));
});
elements.audioToggle.addEventListener('click', () => {
  if (audio.active) audio.stop();
  else if (!bootstrap?.transcriptionReady) showNotice(t('noAudioKey'));
  else void audio.start(bootstrap.config.inputDeviceId);
});
elements.articleSearch.addEventListener('input', updateArticles);
elements.focusArticle.addEventListener('change', () => { focusedDocumentId = elements.focusArticle.value; updateScopeLabel(); });
elements.section.addEventListener('change', updateArticles);

async function loadLibrary(choose: boolean): Promise<void> {
  if (loadingLibrary) return;
  loadingLibrary = true;
  elements.chooseLibrary.disabled = true;
  elements.reloadLibrary.disabled = true;
  elements.libraryCount.textContent = t('reading');
  updateActions();
  try {
    const next = choose ? await window.peek.chooseLibrary() : await window.peek.reloadLibrary();
    if (next) { clearThreadView(); updateLibrary(next); }
  } catch (error) {
    showNotice(errorText(error));
  } finally {
    loadingLibrary = false;
    elements.chooseLibrary.disabled = false;
    updateLibrary(library);
    updateActions();
  }
}
elements.chooseLibrary.addEventListener('click', () => { void loadLibrary(true); });
elements.reloadLibrary.addEventListener('click', () => { void loadLibrary(false); });
elements.languageToggle.addEventListener('click', () => { language = language === 'zh' ? 'en' : 'zh'; updateLanguage(); });

window.addEventListener('beforeunload', () => { audio.stop(); });
const unsubscribe = window.peek.onEvent(onEvent);
window.addEventListener('beforeunload', unsubscribe);

async function init(): Promise<void> {
  updateActions();
  try {
    bootstrap = await window.peek.bootstrap();
    language = bootstrap.config.language;
    updateLibrary(bootstrap.library);
    elements.askKey.textContent = displayShortcut(bootstrap.config.hotkeys.ask);
    updateLanguage();
    showNotice([...bootstrap.warnings, ...bootstrap.library.warnings].join(' '));
    if (!bootstrap.chatReady && !elements.notice.textContent) showNotice(t('noKey'));
    updateActions();
    if (bootstrap.transcriptionReady) await audio.start(bootstrap.config.inputDeviceId);
  } catch (error) {
    showNotice(`${t('setupError')}${errorText(error)}`);
  }
}

void init();
