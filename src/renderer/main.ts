import { RollingAudio } from './audio';
import type { Bootstrap, LibraryStatus, PeekEvent, SavedTask, SourcePassage, TaskContext, TaskSummary } from '../shared/types';
import { FAST_LIMITS } from '../shared/timing';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element as T;
};

const elements = {
  interaction: $('interaction'), notice: $('notice'), shortcutWarning: $('shortcut-warning'), captureWarning: $('capture-warning'), languageToggle: $<HTMLButtonElement>('language-toggle'),
  audioToggle: $<HTMLButtonElement>('audio-toggle'), audioLabel: $('audio-label'), audioState: $('audio-state'), audioMessage: $('audio-message'), devices: $('devices'),
  preparePanel: $('prepare-panel'), prepareToggle: $<HTMLButtonElement>('prepare-toggle'), prepareDone: $<HTMLButtonElement>('prepare-done'), focusedTitle: $('focused-title'), libraryCount: $('library-count'),
  chooseLibrary: $<HTMLButtonElement>('choose-library'), reloadLibrary: $<HTMLButtonElement>('reload-library'),
  section: $<HTMLSelectElement>('section'), focusArticle: $<HTMLSelectElement>('focus-article'),
  model: $<HTMLSelectElement>('model'),
  emptyState: $('empty-state'), emptyTitle: $('empty-title'), responseArea: $('response-area'), answer: $('answer'),
  sourcesPanel: $<HTMLDetailsElement>('sources-panel'), sources: $('sources'), sourcesLabel: $('sources-label'),
  audioInputLabel: $('audio-input-label'),
  requestState: $('request-state'), ask: $<HTMLButtonElement>('ask'), newTopic: $<HTMLButtonElement>('new-topic'), cancel: $<HTMLButtonElement>('cancel'),
  askKey: $('ask-key'), askKeyHint: $('ask-key-hint'), askKeyLabel: $('ask-key-label'), holdHint: $('hold-hint'),
  toggleKey: $('toggle-key'), toggleKeyHint: $('toggle-key-hint'), toggleKeyLabel: $('toggle-key-label'), hideWindow: $<HTMLButtonElement>('hide-window'), returnRoute: $('return-route'),
  taskPanel: $('task-panel'), taskHeading: $('task-heading'), taskSaveHint: $('task-save-hint'), taskList: $('task-list'), newTask: $<HTMLButtonElement>('new-task'),
  contextToolbar: $('context-toolbar'), tasksToggle: $<HTMLButtonElement>('tasks-toggle'), voiceControls: $('voice-controls'),
  historyPanel: $<HTMLDetailsElement>('history-panel'), historyLabel: $('history-label'), taskHistory: $('task-history'),
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
let changingModel = false;
let changingTask = false;
let switchingQuestion = false;
let lastQuestionAt = 0;
let taskStage: 'choose' | 'new' | 'active' = 'choose';
let activeTask: SavedTask | null = null;
let tasks: TaskSummary[] = [];
let preparationMode = true;
let askEpoch = 0;
let pendingPhase: 'speech' | 'answer' | null = null;
let turnStartedAt = 0;
let turnEndedAt = 0;
let firstTokenAt = 0;
let serviceTier = '';
let timingTimer: ReturnType<typeof setInterval> | undefined;

function renderTiming(): void {
  const totalMs = turnStartedAt ? Math.max(0, (turnEndedAt || Date.now()) - turnStartedAt) : 0;
  const elapsed = turnStartedAt ? `${(totalMs / 1000).toFixed(1)}s` : '';
  const pastTarget = busy && totalMs >= FAST_LIMITS.targetMs;
  const status = pendingPhase === 'speech' && busy ? t('waitingAudio') : pastTarget ? (language === 'zh' ? '仍在生成' : 'Still generating') : '';
  elements.requestState.textContent = [status, elapsed, serviceTier].filter(Boolean).join(' · ');
  elements.requestState.dataset.pastTarget = String(pastTarget);
  elements.requestState.dataset.totalMs = turnStartedAt ? String(totalMs) : '';
  elements.requestState.dataset.firstTokenMs = firstTokenAt ? String(firstTokenAt - turnStartedAt) : '';
  elements.requestState.dataset.serviceTier = serviceTier;
  elements.requestState.title = firstTokenAt ? `${language === 'zh' ? '首字' : 'First token'}: ${((firstTokenAt - turnStartedAt) / 1000).toFixed(1)}s` : '';
}

function finishTiming(): void {
  clearInterval(timingTimer);
  if (turnStartedAt && !turnEndedAt) turnEndedAt = Date.now();
  renderTiming();
}

const labels = {
  zh: {
    pass: '穿透', interactive: '操作中', startAudio: '开启音频', pauseAudio: '暂停音频', audioOff: '音频关闭', audioError: '音频异常', listening: '收音中 · 2秒',
    library: '文库', disconnected: '未连接', entireLibrary: '全部文库', focus: '选择当前文章', searchArticle: '查找文章…', openVault: '打开文库', reload: '刷新',
    prepare: '准备', prepareDone: '开始', noArticle: '未选文章', newTopic: '新话题', listenFirst: '听完问题后，点击「回答」。', waitingAudio: '正在听取最后一句…', audioPending: '最后一句还没转写完成，请稍后再按一次。', startListening: '开始收音',
    ready: '听完问题，按一下。', answer: '回答', incomplete: '未完成', stopped: '已停止', connections: '关联', audioContext: '音频上下文', audioInput: '音频输入',
    placeholder: '', ask: '回答', asking: '思考中…', followUp: '追问', stop: '停止', reading: '读取中…',
    noKey: '点击「连接 OpenAI」设置密钥。', noAudioKey: '请在密钥窗口连接语音转写服务。',
    connectTitle: '连接后即可提问。', connectKey: '连接 OpenAI', manageKey: '密钥',
    openSource: '打开原文', setupError: '启动失败：', audioFailed: '音频异常。', noDevices: '开启音频后显示设备。', unnamed: '未命名输入',
    taskHeading: '开始任务', newTask: '新任务', continueTask: '继续', tasks: '任务', taskSaveHint: '问答保存在本机。', noTasks: '还没有任务。点击「新任务」开始。', history: '历史', startTask: '开始任务', saveContext: '完成', noShortcut: '菜单栏 Peek', hide: '隐藏', hideReturn: '隐藏/回来', returnRoute: '菜单栏 Peek → 显示', directClick: '可直接点击', chooseTask: '请先新建或继续任务。', finishPreparation: '请先点击「完成」保存准备内容。',
  },
  en: {
    pass: 'Click-through', interactive: 'Interactive', startAudio: 'Start audio', pauseAudio: 'Pause audio', audioOff: 'Audio off', audioError: 'Audio error', listening: 'Listening · 2s',
    library: 'Library', disconnected: 'Not connected', entireLibrary: 'Entire library', focus: 'Choose an article', searchArticle: 'Find article…', openVault: 'Open vault', reload: 'Reload',
    prepare: 'Prepare', prepareDone: 'Ready', noArticle: 'No article selected', newTopic: 'New topic', listenFirst: 'After the question, click Answer.', waitingAudio: 'Finishing the last sentence…', audioPending: 'The last sentence is still transcribing. Press again shortly.', startListening: 'Start listening',
    ready: 'Hear the question. Press once.', answer: 'Answer', incomplete: 'Incomplete', stopped: 'Stopped', connections: 'Connections', audioContext: 'Audio context', audioInput: 'Audio input',
    placeholder: '', ask: 'Answer', asking: 'Thinking…', followUp: 'Follow up', stop: 'Stop', reading: 'Reading…',
    noKey: 'Click Connect OpenAI to set up your key.', noAudioKey: 'Connect transcription in the API key window.',
    connectTitle: 'Connect to start asking.', connectKey: 'Connect OpenAI', manageKey: 'API key',
    openSource: 'Open source', setupError: 'Could not start: ', audioFailed: 'Audio failed.', noDevices: 'Start audio to list inputs.', unnamed: 'Unnamed input',
    taskHeading: 'Start a task', newTask: 'New task', continueTask: 'Continue', tasks: 'Tasks', taskSaveHint: 'Questions and answers stay on this computer.', noTasks: 'No tasks yet. Choose New task to begin.', history: 'History', startTask: 'Start task', saveContext: 'Done', noShortcut: 'Peek menu', hide: 'Hide', hideReturn: 'Hide / return', returnRoute: 'Menu bar Peek → Show', directClick: 'Click to prepare', chooseTask: 'Create or continue a task first.', finishPreparation: 'Choose Done to save your preparation first.',
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
  elements.taskHeading.textContent = t('taskHeading');
  elements.taskSaveHint.textContent = t('taskSaveHint');
  elements.newTask.textContent = t('newTask');
  elements.tasksToggle.textContent = t('tasks');
  elements.askKeyLabel.textContent = t('answer');
  elements.toggleKeyLabel.textContent = t('hideReturn');
  elements.hideWindow.textContent = t('hide');
  elements.returnRoute.textContent = bootstrap?.config.hotkeys.toggle
    ? language === 'zh' ? '隐藏后再按同一快捷键回来；也可点菜单栏 Peek → 显示 Peek。' : 'Press the same shortcut to return, or choose menu bar Peek → Show Peek.'
    : language === 'zh' ? '隐藏后，点菜单栏 Peek → 显示 Peek 回来。' : 'To return after hiding, choose menu bar Peek → Show Peek.';
  if (bootstrap) {
    const modifiers = bootstrap.config.interactionModifiers.map(displayShortcut).join(' + ');
    elements.holdHint.textContent = language === 'zh' ? `按住 ${modifiers} 操作` : `Hold ${modifiers} to interact`;
    elements.ask.title = displayShortcut(bootstrap.config.hotkeys.ask);
    elements.askKey.textContent = displayShortcut(bootstrap.config.hotkeys.ask) || t('noShortcut');
    elements.toggleKey.textContent = displayShortcut(bootstrap.config.hotkeys.toggle) || t('noShortcut');
  }
  updateAudioLabels();
  updateLibrary(library);
  renderSources(latestSources);
  renderTaskList();
  renderHistory();
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
  return shortcut.replace(/CommandOrControl|Command|Cmd/g, navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace(/Control|Ctrl/g, 'Ctrl').replace(/Alt|Option/g, navigator.platform.includes('Mac') ? 'Option' : 'Alt').replace(/Enter/g, language === 'zh' ? '回车' : 'Enter').replace(/Backspace/g, navigator.platform.includes('Mac') ? '⌫' : 'Backspace').replace(/\+/g, ' + ');
}

function updateActions(): void {
  const live = taskStage === 'active' && Boolean(activeTask);
  const preparing = !elements.preparePanel.hidden;
  elements.taskPanel.hidden = taskStage !== 'choose';
  elements.contextToolbar.hidden = taskStage === 'choose';
  elements.responseArea.hidden = !live;
  elements.voiceControls.hidden = !live;
  elements.ask.disabled = !live || preparing || !bootstrap?.chatReady || switchingQuestion || loadingLibrary || changingModel || changingTask;
  elements.audioToggle.disabled = !live || preparing || changingTask;
  elements.newTopic.disabled = !live || busy || loadingLibrary || changingTask;
  elements.prepareToggle.disabled = busy || changingTask || taskStage === 'new';
  elements.tasksToggle.disabled = busy || loadingLibrary || changingTask;
  elements.newTask.disabled = !bootstrap || changingTask || loadingLibrary;
  elements.prepareDone.disabled = !bootstrap || busy || loadingLibrary || changingModel || changingTask;
  elements.prepareDone.textContent = t(taskStage === 'new' ? 'startTask' : 'saveContext');
  elements.focusArticle.disabled = busy || loadingLibrary || changingTask;
  elements.section.disabled = busy || loadingLibrary || changingTask;
  elements.model.disabled = !bootstrap?.modelSelectionAvailable || busy || loadingLibrary || openingCredentials || changingModel || changingTask;
  elements.cancel.hidden = !busy;
  elements.ask.textContent = busy ? (language === 'zh' ? '下一题' : 'Next question') : t(audio.active ? 'ask' : 'startListening');
  elements.answer.classList.toggle('streaming', busy && requestId !== null);
  renderTiming();
  elements.emptyTitle.textContent = t(bootstrap?.chatReady ? 'ready' : 'connectTitle');
  elements.connectKey.hidden = Boolean(bootstrap?.chatReady);
  elements.askKeyHint.hidden = false;
  elements.connectKey.disabled = openingCredentials;
  elements.manageKey.disabled = openingCredentials;
  if (bootstrap) {
    const modifiers = bootstrap.config.interactionModifiers.map(displayShortcut).join(' + ');
    elements.holdHint.textContent = preparationMode ? t('directClick') : language === 'zh' ? `按住 ${modifiers} 操作` : `Hold ${modifiers} to interact`;
  }
}

function renderTaskList(): void {
  elements.taskList.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement('p'); empty.className = 'task-empty'; empty.textContent = t('noTasks');
    elements.taskList.append(empty); return;
  }
  for (const task of [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'task-card'; button.dataset.taskId = task.id;
    button.disabled = changingTask;
    const title = document.createElement('span'); title.className = 'task-title'; title.textContent = task.name;
    const meta = document.createElement('span'); meta.className = 'task-meta';
    meta.textContent = `${formatTaskTime(task.updatedAt)} · ${task.turnCount} ${language === 'zh' ? '次问答' : 'Q&A'}`;
    const resume = document.createElement('span'); resume.className = 'task-resume'; resume.textContent = t('continueTask');
    button.append(title, meta, resume);
    button.addEventListener('click', () => { void continueTask(task.id); });
    elements.taskList.append(button);
  }
}

function formatTaskTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-AU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderHistory(): void {
  const turns = activeTask?.turns ?? [];
  elements.historyPanel.hidden = turns.length === 0;
  elements.historyLabel.textContent = `${t('history')} · ${turns.length}`;
  elements.taskHistory.replaceChildren();
  for (const turn of [...turns].reverse()) {
    const entry = document.createElement('article'); entry.className = 'history-entry';
    const time = document.createElement('span'); time.className = 'history-time'; time.textContent = `${formatTaskTime(turn.createdAt)} · ${turn.model}`;
    const question = document.createElement('p'); question.className = 'history-question'; question.textContent = turn.question;
    const answer = document.createElement('p'); answer.className = 'history-answer'; answer.textContent = turn.answer;
    entry.append(time, question, answer);
    if (turn.sources.length) {
      const citations = document.createElement('p'); citations.className = 'history-time';
      citations.textContent = turn.sources.map(source => `${source.relativePath}:${source.startLine}–${source.endLine}`).join(' · ');
      entry.append(citations);
    }
    elements.taskHistory.append(entry);
  }
}

function rememberTask(task: SavedTask): void {
  const summary: TaskSummary = { id: task.id, name: task.name, createdAt: task.createdAt, updatedAt: task.updatedAt, turnCount: task.turns.length, context: task.context };
  tasks = [summary, ...tasks.filter(item => item.id !== task.id)];
  renderTaskList();
}

function contextForTask(): TaskContext {
  const focused = library.documents.find(doc => doc.id === focusedDocumentId);
  return {
    libraryPath: library.root || '', model: bootstrap!.config.model,
    ...(focused ? { focusDocumentId: focused.id, focusRelativePath: focused.relativePath, focusTitle: focused.title } : {}),
    ...(elements.section.value ? { section: elements.section.value } : {}),
  };
}

function showSavedTask(task: SavedTask): void {
  lastQuestionAt = 0;
  activeTask = task; taskStage = 'active';
  rememberTask(task);
  clearThreadView();
  const latest = task.turns.at(-1);
  if (latest) {
    elements.answer.textContent = latest.answer;
    elements.emptyState.hidden = Boolean(latest.answer);
    hasThread = true;
  }
  renderHistory();
  updateScopeLabel();
  updateActions();
}

async function chooseTask(): Promise<void> {
  if (busy || changingTask || loadingLibrary) return;
  audio.stop(); clearThreadView(); taskStage = 'choose';
  setPreparation(false);
  updateActions();
  try { tasks = await window.peek.listTasks(); renderTaskList(); }
  catch (error) { showNotice(errorText(error)); }
}

function newTask(): void {
  if (busy || changingTask || !bootstrap) return;
  audio.stop(); activeTask = null; taskStage = 'new';
  clearThreadView(); renderHistory(); showNotice('');
  setPreparation(true);
  updateActions();
}

async function continueTask(id: string): Promise<void> {
  if (changingTask || busy) return;
  changingTask = true; audio.stop(); updateActions(); renderTaskList();
  try {
    const result = await window.peek.selectTask(id);
    bootstrap!.config.model = result.task.context.model;
    if (![...elements.model.options].some(option => option.value === result.task.context.model)) elements.model.add(new Option(result.task.context.model, result.task.context.model));
    elements.model.value = result.task.context.model;
    updateLibrary(result.library);
    elements.section.value = result.task.context.section && result.library.sections.includes(result.task.context.section) ? result.task.context.section : '';
    focusedDocumentId = result.library.documents.find(doc => doc.id === result.task.context.focusDocumentId || doc.relativePath === result.task.context.focusRelativePath)?.id || '';
    updateArticles();
    showSavedTask(result.task);
    await setPreparation(result.needsPreparation);
    showNotice(result.warning);
  } catch (error) { showNotice(errorText(error)); }
  finally { changingTask = false; updateActions(); renderTaskList(); }
}

async function startTask(): Promise<void> {
  if (!bootstrap || changingTask || busy || loadingLibrary || changingModel) return;
  changingTask = true; updateActions();
  try {
    const task = taskStage === 'new' || !activeTask ? await window.peek.createTask(contextForTask()) : await window.peek.updateTask(contextForTask());
    activeTask = task; taskStage = 'active'; hasThread = task.turns.length > 0; rememberTask(task); renderHistory();
    updateScopeLabel();
    await setPreparation(false);
    showNotice('');
  } catch (error) { showNotice(errorText(error)); }
  finally { changingTask = false; updateActions(); }
}

function updateScopeLabel(): void {
  const doc = library.documents.find((item) => item.id === focusedDocumentId);
  elements.focusedTitle.textContent = doc?.title || activeTask?.name || t('noArticle');
  elements.focusedTitle.title = doc?.relativePath || activeTask?.name || '';
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
  elements.libraryCount.textContent = library.root ? `${library.documents.length} ${language === 'zh' ? '篇' : 'articles'} · ${library.chunks.toLocaleString()} ${language === 'zh' ? '段' : 'passages'}${library.indexDurationMs === undefined ? '' : ` · ${(library.indexDurationMs / 1000).toFixed(1)}s`}` : 'Markdown / TXT';
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
  finishTiming();
  turnStartedAt = 0; turnEndedAt = 0; firstTokenAt = 0; serviceTier = '';
  ++askEpoch;
  pendingPhase = null;
  hasThread = false;
  busy = false;
  requestId = null;
  elements.answer.textContent = '';
  elements.captureWarning.textContent = '';
  elements.captureWarning.hidden = true;
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
      if (!busy || event.requestId !== requestId) break;
      pendingPhase = 'answer';
      busy = true;
      elements.emptyState.hidden = true;
      elements.answer.textContent = '';
      elements.captureWarning.textContent = '';
      elements.captureWarning.hidden = true;
      renderSources(event.sources);
      elements.responseArea.scrollTop = 0;
      updateActions();
      break;
    case 'answer-warning':
      if (!busy || event.requestId !== requestId) break;
      elements.captureWarning.textContent = event.message;
      elements.captureWarning.hidden = false;
      break;
    case 'answer-metadata':
      if (event.requestId !== requestId || !busy) break;
      serviceTier = event.serviceTier;
      renderTiming();
      break;
    case 'answer-delta': {
      if (event.requestId !== requestId || !busy) break;
      if (!firstTokenAt) firstTokenAt = Date.now();
      const follow = elements.responseArea.scrollHeight - elements.responseArea.scrollTop - elements.responseArea.clientHeight < 70;
      elements.answer.append(document.createTextNode(event.delta));
      if (follow) elements.responseArea.scrollTop = elements.responseArea.scrollHeight;
      break;
    }
    case 'answer-done':
      if (!busy || event.requestId !== requestId) break;
      busy = false;
      pendingPhase = null;
      hasThread = elements.answer.textContent!.length > 0 || hasThread;
      finishTiming();
      updateActions();
      break;
    case 'answer-error':
      if (!busy || event.requestId !== requestId) break;
      busy = false;
      pendingPhase = null;
      showNotice(event.message);
      finishTiming();
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
    case 'task-saved':
      rememberTask(event.task);
      if (activeTask?.id === event.task.id) { activeTask = event.task; renderHistory(); }
      break;
    case 'library-progress':
      elements.libraryCount.textContent = language === 'zh'
        ? `${event.progress.phase === 'scan' ? '查找文章' : '建立索引'} ${event.progress.completed}/${event.progress.total}`
        : `${event.progress.phase === 'scan' ? 'Finding articles' : 'Indexing'} ${event.progress.completed}/${event.progress.total}`;
      break;
  }
}

async function setPreparation(open: boolean): Promise<void> {
  elements.preparePanel.hidden = !open;
  elements.prepareToggle.setAttribute('aria-expanded', String(open));
  const nextMode = open || taskStage !== 'active';
  if (nextMode && !preparationMode) audio.stop();
  if (nextMode !== preparationMode) {
    try { await window.peek.setPreparationMode(nextMode); preparationMode = nextMode; }
    catch (error) {
      elements.preparePanel.hidden = false;
      elements.prepareToggle.setAttribute('aria-expanded', 'true');
      preparationMode = true;
      showNotice(errorText(error));
    }
  }
  updateActions();
}

async function ask(): Promise<void> {
  if (taskStage !== 'active' || !activeTask) { showNotice(t('chooseTask')); return; }
  if (!elements.preparePanel.hidden) { showNotice(t('finishPreparation')); return; }
  if (!bootstrap?.chatReady) { showNotice(t('noKey')); void openCredentials(); return; }
  if (switchingQuestion || loadingLibrary || changingModel || changingTask) return;
  if (busy) { await nextQuestion(true); return; }
  if (!audio.active) {
    if (!bootstrap.transcriptionReady) { showNotice(t('noAudioKey')); void openCredentials(); return; }
    await audio.start(bootstrap.config.inputDeviceId);
    if (audio.active) {
      const shortcut = displayShortcut(bootstrap.config.hotkeys.ask);
      showNotice(`${t('listenFirst')}${shortcut ? ` (${shortcut})` : ''}`);
    }
    updateActions();
    return;
  }
  const epoch = ++askEpoch;
  lastQuestionAt = Date.now();
  turnStartedAt = Date.now(); turnEndedAt = 0; firstTokenAt = 0; serviceTier = '';
  busy = true;
  pendingPhase = 'speech';
  requestId = crypto.randomUUID();
  showNotice('');
  setPreparation(false);
  updateActions();
  timingTimer = setInterval(renderTiming, 100);
  try {
    const fresh = await audio.flush();
    if (epoch !== askEpoch) return;
    if (!fresh || !audio.active) {
      busy = false; pendingPhase = null;
      finishTiming();
      showNotice(audio.lastError || t('audioPending')); updateActions();
      return;
    }
    pendingPhase = 'answer';
    updateActions();
    await window.peek.ask({
      requestId: requestId!, intent: '', followUp: hasThread, language,
      ...(focusedDocumentId ? { focusDocumentId: focusedDocumentId } : {}),
      ...(elements.section.value ? { section: elements.section.value } : {}),
    });
  } catch (error) {
    if (epoch !== askEpoch) return;
    busy = false; pendingPhase = null;
    finishTiming();
    showNotice(errorText(error)); updateActions();
  }
}

async function nextQuestion(answerNow: boolean): Promise<void> {
  if (switchingQuestion || taskStage !== 'active' || !activeTask) return;
  switchingQuestion = true;
  ++askEpoch; busy = false; pendingPhase = null; requestId = null;
  finishTiming(); updateActions();
  try {
    audio.discardQueuedBefore(lastQuestionAt);
    await window.peek.nextQuestion(lastQuestionAt);
    clearThreadView(); showNotice('');
  } catch (error) { showNotice(errorText(error)); return; }
  finally { switchingQuestion = false; updateActions(); }
  if (answerNow) await ask();
}

const audio = new RollingAudio({
  transcribe: (chunk) => window.peek.transcribe(chunk),
  status: (state, message) => {
    audioState = state;
    updateAudioLabels();
    if (state !== 'recording' && pendingPhase === 'speech') { ++askEpoch; busy = false; pendingPhase = null; finishTiming(); }
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
}, { chunkMilliseconds: FAST_LIMITS.audioChunkMs, flushTimeoutMilliseconds: FAST_LIMITS.transcriptMs });

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
elements.newTask.addEventListener('click', newTask);
elements.tasksToggle.addEventListener('click', () => { void chooseTask(); });
elements.hideWindow.addEventListener('click', () => { void window.peek.setVisible(false).catch((error: unknown) => showNotice(errorText(error))); });
elements.newTopic.addEventListener('click', () => { void nextQuestion(false); });
elements.prepareToggle.addEventListener('click', () => { if (elements.preparePanel.hidden) void setPreparation(true); else void startTask(); });
elements.prepareDone.addEventListener('click', () => { void startTask(); });
elements.cancel.addEventListener('click', () => {
  const epoch = ++askEpoch; pendingPhase = null; busy = false; requestId = null;
  finishTiming();
  updateActions();
  void window.peek.cancel().then(() => {
    if (epoch !== askEpoch) return;
    busy = false;
    showNotice(t('stopped'));
    updateActions();
  }).catch((error: unknown) => { if (epoch === askEpoch) showNotice(errorText(error)); });
});
elements.audioToggle.addEventListener('click', () => {
  if (taskStage !== 'active' || !activeTask) return;
  if (audio.active) audio.stop();
  else if (!bootstrap?.transcriptionReady) { showNotice(t('noAudioKey')); void openCredentials(); }
  else void audio.start(bootstrap.config.inputDeviceId);
});
elements.focusArticle.addEventListener('change', () => { focusedDocumentId = elements.focusArticle.value; clearThreadView(); updateScopeLabel(); });
elements.section.addEventListener('change', () => { clearThreadView(); updateArticles(); });
elements.model.addEventListener('change', () => {
  if (!bootstrap) return;
  const previous = bootstrap.config.model;
  changingModel = true; updateActions();
  void window.peek.setModel(elements.model.value).then(model => {
    bootstrap!.config.model = model;
    clearThreadView(); showNotice('');
  }).catch((error: unknown) => {
    elements.model.value = previous;
    showNotice(errorText(error));
  }).finally(() => { changingModel = false; updateActions(); });
});

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

window.addEventListener('beforeunload', () => { finishTiming(); audio.stop(); });
const unsubscribe = window.peek.onEvent(onEvent);
window.addEventListener('beforeunload', unsubscribe);

async function init(): Promise<void> {
  updateActions();
  try {
    bootstrap = await window.peek.bootstrap();
    tasks = bootstrap.tasks;
    if (![...elements.model.options].some(option => option.value === bootstrap!.config.model)) {
      elements.model.add(new Option(bootstrap.config.model, bootstrap.config.model));
    }
    elements.model.value = bootstrap.config.model;
    language = bootstrap.config.language;
    updateLibrary(bootstrap.library);
    elements.askKey.textContent = displayShortcut(bootstrap.config.hotkeys.ask);
    updateLanguage();
    if (bootstrap.activeTask) {
      showSavedTask(bootstrap.activeTask);
      await setPreparation(false);
    } else {
      taskStage = 'choose';
      await window.peek.setPreparationMode(true);
      renderTaskList();
    }
    elements.shortcutWarning.textContent = bootstrap.shortcutWarnings.join(' ');
    elements.shortcutWarning.hidden = bootstrap.shortcutWarnings.length === 0;
    showNotice([...bootstrap.warnings, ...bootstrap.library.warnings].join(' '));
    updateActions();
    // Recording begins only after an explicit audio/answer action.
  } catch (error) {
    showNotice(`${t('setupError')}${errorText(error)}`);
  }
}

void init();
