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
  preparePanel: $('prepare-panel'), prepareToggle: $<HTMLButtonElement>('prepare-toggle'), prepareDone: $<HTMLButtonElement>('prepare-done'), focusedTitle: $('focused-title'), libraryCount: $('library-count'),
  chooseLibrary: $<HTMLButtonElement>('choose-library'), reloadLibrary: $<HTMLButtonElement>('reload-library'),
  section: $<HTMLSelectElement>('section'), focusArticle: $<HTMLSelectElement>('focus-article'),
  emptyState: $('empty-state'), emptyTitle: $('empty-title'), responseArea: $('response-area'), answer: $('answer'),
  sourcesPanel: $<HTMLDetailsElement>('sources-panel'), sources: $('sources'), sourcesLabel: $('sources-label'),
  audioInputLabel: $('audio-input-label'),
  requestState: $('request-state'), ask: $<HTMLButtonElement>('ask'), newTopic: $<HTMLButtonElement>('new-topic'), cancel: $<HTMLButtonElement>('cancel'),
  askKey: $('ask-key'), askKeyHint: $('ask-key-hint'), holdHint: $('hold-hint'),
  connectKey: $<HTMLButtonElement>('connect-key'), manageKey: $<HTMLButtonElement>('manage-key'),
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
let openingCredentials = false;
let askEpoch = 0;
let pendingPhase: 'speech' | 'answer' | null = null;

const labels = {
  zh: {
    pass: '穿透', interactive: '操作中', startAudio: '开启音频', pauseAudio: '暂停音频', audioOff: '音频关闭', audioError: '音频异常', listening: '收音中 · 5秒',
    library: '文库', disconnected: '未连接', entireLibrary: '全部文库', focus: '选择当前文章', searchArticle: '查找文章…', openVault: '打开文库', reload: '刷新',
    prepare: '准备', prepareDone: '开始', noArticle: '未选文章', newTopic: '新话题', listenFirst: '听完问题后，按 Option + Space。', waitingAudio: '正在听取最后一句…', audioPending: '最后一句还没转写完成，请稍后再按一次。', startListening: '开始收音',
    ready: '听完问题，按一下。', answer: '回答', incomplete: '未完成', stopped: '已停止', connections: '关联', audioContext: '音频上下文', audioInput: '音频输入',
    placeholder: '', ask: '回答', asking: '思考中…', followUp: '追问', stop: '停止', reading: '读取中…',
    noKey: '点击「连接 OpenAI」设置密钥。', noAudioKey: '请在密钥窗口连接语音转写服务。',
    connectTitle: '连接后即可提问。', connectKey: '连接 OpenAI', manageKey: '密钥',
    openSource: '打开原文', setupError: '启动失败：', audioFailed: '音频异常。', noDevices: '开启音频后显示设备。', unnamed: '未命名输入',
  },
  en: {
    pass: 'Click-through', interactive: 'Interactive', startAudio: 'Start audio', pauseAudio: 'Pause audio', audioOff: 'Audio off', audioError: 'Audio error', listening: 'Listening · 5s',
    library: 'Library', disconnected: 'Not connected', entireLibrary: 'Entire library', focus: 'Choose an article', searchArticle: 'Find article…', openVault: 'Open vault', reload: 'Reload',
    prepare: 'Prepare', prepareDone: 'Ready', noArticle: 'No article selected', newTopic: 'New topic', listenFirst: 'After the question, press Option + Space.', waitingAudio: 'Finishing the last sentence…', audioPending: 'The last sentence is still transcribing. Press again shortly.', startListening: 'Start listening',
    ready: 'Hear the question. Press once.', answer: 'Answer', incomplete: 'Incomplete', stopped: 'Stopped', connections: 'Connections', audioContext: 'Audio context', audioInput: 'Audio input',
    placeholder: '', ask: 'Answer', asking: 'Thinking…', followUp: 'Follow up', stop: 'Stop', reading: 'Reading…',
    noKey: 'Click Connect OpenAI to set up your key.', noAudioKey: 'Connect transcription in the API key window.',
    connectTitle: 'Connect to start asking.', connectKey: 'Connect OpenAI', manageKey: 'API key',
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
  elements.connectKey.textContent = t('connectKey');
  elements.manageKey.textContent = t('manageKey');
  elements.chooseLibrary.textContent = t('openVault');
  elements.reloadLibrary.textContent = t('reload');
  elements.prepareToggle.textContent = t('prepare');
  elements.prepareDone.textContent = t('prepareDone');
  elements.focusArticle.setAttribute('aria-label', t('focus'));
  elements.section.setAttribute('aria-label', t('entireLibrary'));
  elements.audioInputLabel.textContent = t('audioInput');
  elements.newTopic.textContent = t('newTopic');
  elements.cancel.textContent = t('stop');
  if (bootstrap) {
    const modifiers = bootstrap.config.interactionModifiers.map(displayShortcut).join(' + ');
    elements.holdHint.textContent = language === 'zh' ? `按住 ${modifiers} 操作` : `Hold ${modifiers} to interact`;
    elements.ask.title = displayShortcut(bootstrap.config.hotkeys.ask);

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
  return shortcut.replace(/CommandOrControl|Command|Cmd/g, navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace(/Shift/g, '⇧').replace(/Alt|Option/g, navigator.platform.includes('Mac') ? 'Option' : 'Alt').replace(/Control/g, 'Ctrl').replace(/\+/g, ' ');
}

function updateActions(): void {
  elements.ask.disabled = !bootstrap?.chatReady || busy || loadingLibrary;
  elements.newTopic.disabled = busy || loadingLibrary;
  elements.prepareToggle.disabled = busy;
  elements.prepareDone.disabled = busy;
  elements.focusArticle.disabled = busy || loadingLibrary;
  elements.section.disabled = busy || loadingLibrary;
  elements.cancel.hidden = !busy;
  elements.ask.textContent = t(busy ? (pendingPhase === 'speech' ? 'waitingAudio' : 'asking') : audio.active ? 'ask' : 'startListening');
  elements.answer.classList.toggle('streaming', busy && requestId !== null);
  elements.requestState.textContent = pendingPhase === 'speech' && busy ? t('waitingAudio') : '';
  elements.emptyTitle.textContent = t(bootstrap?.chatReady ? 'ready' : 'connectTitle');
  elements.connectKey.hidden = Boolean(bootstrap?.chatReady);
  elements.askKeyHint.hidden = !bootstrap?.chatReady;
  elements.connectKey.disabled = openingCredentials;
  elements.manageKey.disabled = openingCredentials;
}

function updateScopeLabel(): void {
  const doc = library.documents.find((item) => item.id === focusedDocumentId);
  elements.focusedTitle.textContent = doc?.title || t('noArticle');
  elements.focusedTitle.title = doc?.relativePath || '';
}

function updateArticles(): void {
  const section = elements.section.value;
  const selected = library.documents.find((doc) => doc.id === focusedDocumentId);
  if (selected && section && selected.section !== section) focusedDocumentId = '';
  const docs = library.documents.filter((doc) => (!section || doc.section === section));
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
  ++askEpoch;
  pendingPhase = null;
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
      void ask();
      break;
    case 'answer-start':
      requestId = event.requestId;
      pendingPhase = 'answer';
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
      pendingPhase = null;
      hasThread = elements.answer.textContent!.length > 0 || hasThread;
      updateActions();
      break;
    case 'answer-error':
      if (requestId !== null && event.requestId !== requestId) break;
      busy = false;
      pendingPhase = null;
      showNotice(event.message);
      updateActions();
      break;
    case 'warning': showNotice(event.message); break;
    case 'credentials-changed':
      audio.stop();
      if (bootstrap) {
        bootstrap.chatReady = event.chatReady;
        bootstrap.transcriptionReady = event.transcriptionReady;
      }
      clearThreadView();
      showNotice('');
      updateActions();
      break;
    case 'library': clearThreadView(); updateLibrary(event.library); break;
  }
}

function setPreparation(open: boolean): void {
  elements.preparePanel.hidden = !open;
  elements.prepareToggle.setAttribute('aria-expanded', String(open));
}

async function ask(): Promise<void> {
  if (!bootstrap?.chatReady) { showNotice(t('noKey')); void openCredentials(); return; }
  if (busy || loadingLibrary) return;
  if (!audio.active) {
    if (!bootstrap.transcriptionReady) { showNotice(t('noAudioKey')); void openCredentials(); return; }
    await audio.start(bootstrap.config.inputDeviceId);
    if (audio.active) showNotice(t('listenFirst'));
    updateActions();
    return;
  }
  const epoch = ++askEpoch;
  busy = true;
  pendingPhase = 'speech';
  requestId = null;
  showNotice('');
  setPreparation(false);
  updateActions();
  try {
    const fresh = await audio.flush();
    if (epoch !== askEpoch) return;
    if (!fresh || !audio.active) {
      busy = false; pendingPhase = null;
      showNotice(t('audioPending')); updateActions();
      return;
    }
    pendingPhase = 'answer';
    updateActions();
    await window.peek.ask({
      intent: '', followUp: hasThread, language,
      ...(focusedDocumentId ? { focusDocumentId: focusedDocumentId } : {}),
      ...(elements.section.value ? { section: elements.section.value } : {}),
    });
  } catch (error) {
    if (epoch !== askEpoch) return;
    busy = false; pendingPhase = null;
    showNotice(errorText(error)); updateActions();
  }
}

const audio = new RollingAudio({
  transcribe: (chunk) => window.peek.transcribe(chunk),
  status: (state, message) => {
    audioState = state;
    updateAudioLabels();
    if (state !== 'recording' && pendingPhase === 'speech') { ++askEpoch; busy = false; pendingPhase = null; }
    updateActions();
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

async function openCredentials(): Promise<void> {
  if (openingCredentials) return;
  openingCredentials = true;
  updateActions();
  try { await window.peek.openCredentials(); }
  catch (error) { showNotice(errorText(error)); }
  finally { openingCredentials = false; updateActions(); }
}

elements.connectKey.addEventListener('click', () => { void openCredentials(); });
elements.manageKey.addEventListener('click', () => { void openCredentials(); });

elements.ask.addEventListener('click', () => { void ask(); });
elements.newTopic.addEventListener('click', () => { clearThreadView(); showNotice(''); });
elements.prepareToggle.addEventListener('click', () => setPreparation(elements.preparePanel.hidden));
elements.prepareDone.addEventListener('click', () => setPreparation(false));
elements.cancel.addEventListener('click', () => {
  ++askEpoch; pendingPhase = null; busy = false;
  updateActions();
  void window.peek.cancel().then(() => {
    busy = false;
    showNotice(t('stopped'));
    updateActions();
  }).catch((error: unknown) => showNotice(errorText(error)));
});
elements.audioToggle.addEventListener('click', () => {
  if (audio.active) audio.stop();
  else if (!bootstrap?.transcriptionReady) { showNotice(t('noAudioKey')); void openCredentials(); }
  else void audio.start(bootstrap.config.inputDeviceId);
});
elements.focusArticle.addEventListener('change', () => { focusedDocumentId = elements.focusArticle.value; clearThreadView(); updateScopeLabel(); });
elements.section.addEventListener('change', () => { clearThreadView(); updateArticles(); });

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
    updateActions();
    // Recording begins only after an explicit audio/answer action.
  } catch (error) {
    showNotice(`${t('setupError')}${errorText(error)}`);
  }
}

void init();
