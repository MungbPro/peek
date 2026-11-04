import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { defaultConfig, loadConfig, publicConfig, saveConfig, type Config } from './config';
import { configureApplication, configureOverlay, getConfigDirectory, platformDefaults, startModifierMonitor } from './platform';
import { KnowledgeLibrary } from './library';
import { TranscriptBuffer } from './transcript';
import { contextText, hasKey, streamAnswer, systemPrompt, transcribeAudio, type ChatMessage } from './provider';
import type { AskRequest, AudioChunk, AudioStatus, PeekEvent } from '../shared/types';

app.setName('Peek');
if (process.env.PEEK_TEST_USER_DATA) app.setPath('userData', process.env.PEEK_TEST_USER_DATA);
const devUrl = process.env.PEEK_DEV_URL;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('PEEK_DEV_URL must be the local Vite server.');
const smoke = process.argv.includes('--smoke-test');
let win: BrowserWindow;
let tray: Tray;
let config: Config;
let configPath = '';
let configValid = true;
let stopMonitor: (() => void) | undefined;
let transcriptTimer: ReturnType<typeof setInterval> | undefined;
let desiredVisible = true;
let capturing = false;
let audioRecording = false;
let audioGeneration = 0;
let audioController: AbortController | undefined;
let activeRequest: { id: string; controller: AbortController } | undefined;
let history: ChatMessage[] = [];
let lastIntent = '';
let loadingLibrary = false;
const warnings: string[] = [];
const library = new KnowledgeLibrary();
const transcripts = new TranscriptBuffer();
const protectionWarning = 'Peek: screen-share exclusion is BEST EFFORT. setContentProtection(true) cannot guarantee invisibility. Verify manually with the exact recording/sharing software before presenting.';

function send(event: PeekEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('peek:event', event);
}
function warn(message: string): void { warnings.push(message); console.warn(message); send({ type: 'warning', message }); }
function message(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'Request stopped or timed out. Retry when the connection is ready.';
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}
function restoreVisibility(): void {
  if (win.isDestroyed()) return;
  if (desiredVisible && !capturing) win.showInactive(); else win.hide();
}
function stopAudio(): void {
  audioRecording = false;
  ++audioGeneration;
  audioController?.abort();
  audioController = undefined;
  transcripts.clear();
}
function cancelAnswer(): void {
  activeRequest?.controller.abort();
  activeRequest = undefined;
}

function trusted(event: Electron.IpcMainInvokeEvent): void {
  const expected = devUrl ? `${devUrl}/` : pathToFileURL(join(__dirname, 'renderer/index.html')).href;
  if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== expected) throw new Error('Untrusted IPC sender.');
}
function handle<T>(channel: string, fn: (arg: T) => unknown): void {
  ipcMain.handle(channel, (event, arg: T) => { trusted(event); return fn(arg); });
}
function validateAsk(value: unknown): AskRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid question.');
  const r = value as AskRequest;
  if (typeof r.intent !== 'string' || r.intent.length > 4000 || typeof r.followUp !== 'boolean') throw new Error('Question must be text, up to 4,000 characters.');
  if (r.language !== undefined && r.language !== 'zh' && r.language !== 'en') throw new Error('Invalid answer language.');
  if (r.focusDocumentId !== undefined && (typeof r.focusDocumentId !== 'string' || !library.resolveDocument(r.focusDocumentId))) throw new Error('Choose an article from the current library.');
  if (r.section !== undefined && (typeof r.section !== 'string' || !library.status().sections.includes(r.section))) throw new Error('Choose a valid library section.');
  return r;
}
function validateAudio(value: unknown): AudioChunk {
  if (!value || typeof value !== 'object') throw new Error('Invalid audio chunk.');
  const r = value as AudioChunk;
  const now = Date.now();
  if (!(r.data instanceof ArrayBuffer) || r.data.byteLength < 100 || r.data.byteLength > 2_000_000 || !/^audio\/(webm|mp4)(;codecs=[\w-]+)?$/.test(r.mimeType)) throw new Error('Invalid audio format or chunk size.');
  if (!Number.isFinite(r.startedAt) || !Number.isFinite(r.endedAt) || r.startedAt > r.endedAt || r.endedAt > now + 1000 || r.startedAt < now - 60_000 || r.endedAt - r.startedAt > 15_000) throw new Error('Audio chunk is stale or too long.');
  return r;
}

async function captureDisplay(): Promise<string> {
  // "Active display" is explicitly the display containing the pointer at ask time.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(1600, Math.round(display.size.width * display.scaleFactor));
  const height = Math.round(width * display.size.height / display.size.width);
  capturing = true;
  win.hide();
  try {
    // Let the compositor remove Peek so it cannot read its own answer.
    await new Promise(resolve => setTimeout(resolve, 140));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false });
    const source = sources.find(item => item.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) throw new Error('Screen capture unavailable. Allow Screen Recording for Peek/Electron in System Settings, then restart.');
    const image = source.thumbnail.getSize().width > 1600 ? source.thumbnail.resize({ width: 1600 }) : source.thumbnail;
    return `data:image/png;base64,${image.toPNG().toString('base64')}`;
  } finally { capturing = false; restoreVisibility(); }
}

async function ask(request: AskRequest): Promise<void> {
  if (!configValid) throw new Error('Fix config.json from the tray menu and restart Peek before asking.');
  if (loadingLibrary) throw new Error('Wait for the library to finish loading.');
  if (capturing) throw new Error('The previous screen capture is still finishing. Try again in a moment.');
  if (activeRequest) throw new Error('Stop the current answer before asking again.');
  if (!hasKey(config.chat)) throw new Error(`Add ${config.chat.apiKeyEnv} to .env and restart Peek.`);
  if (request.followUp && !history.length) throw new Error('Ask a first question before following up.');
  if (!request.followUp) { history = []; lastIntent = ''; }
  const id = randomUUID();
  const controller = new AbortController();
  activeRequest = { id, controller };
  const transcript = transcripts.recent(config.transcriptWindowSeconds);
  const focus = library.status().documents.find(doc => doc.id === request.focusDocumentId);
  const query = [request.intent, request.followUp ? lastIntent : '', transcript, focus?.title].filter(Boolean).join('\n');
  const sources = library.search(query, { focusDocumentId: request.focusDocumentId, section: request.section, limit: 6, maxChars: 12000 })
    .map((source, index) => ({ ...source, id: String(index + 1) }));
  // Raw transcript stays in main; do not leave a stale copy in renderer history.
  send({ type: 'answer-start', requestId: id, sources, transcript: '' });
  try {
    const screenshot = await captureDisplay();
    controller.signal.throwIfAborted();
    const context = contextText(request.intent, transcript, sources, focus?.title);
    const answer = await streamAnswer(config, [
      { role: 'system', content: systemPrompt(request.language ?? config.language) },
      ...history,
      { role: 'user', content: [{ type: 'text', text: context }, { type: 'image_url', image_url: { url: screenshot } }] },
    ], controller.signal, delta => {
      if (activeRequest?.id === id) send({ type: 'answer-delta', requestId: id, delta });
    });
    if (activeRequest?.id !== id) return;
    // Keep intent + answers only: old raw audio, screenshots and retrieved chunks
    // are not accumulated in the follow-up thread.
    const intent = request.intent || `Context question${focus ? ` about ${focus.title}` : ''}`;
    const attributedAnswer = answer.replace(/\[(\d+)\]/g, (citation, number: string) => {
      const source = sources[Number(number) - 1];
      return source ? `(${source.relativePath}:${source.startLine}-${source.endLine})` : citation;
    });
    history.push({ role: 'user', content: intent }, { role: 'assistant', content: attributedAnswer });
    history = history.slice(-16);
    lastIntent = intent;
    send({ type: 'answer-done', requestId: id });
  } catch (error) {
    if (activeRequest?.id === id) send({ type: 'answer-error', requestId: id, message: message(error) });
  } finally { if (activeRequest?.id === id) activeRequest = undefined; }
}

async function reloadLibrary(path = config.libraryPath): Promise<ReturnType<KnowledgeLibrary['status']>> {
  if (loadingLibrary || activeRequest) throw new Error('Wait for the current operation to finish.');
  if (!path) return library.status();
  loadingLibrary = true;
  try {
    const status = await library.load(path);
    history = []; lastIntent = '';
    send({ type: 'library', library: status });
    return status;
  } finally { loadingLibrary = false; }
}

function registerIpc(): void {
  handle('peek:bootstrap', () => ({ config: publicConfig(config), library: library.status(), chatReady: configValid && hasKey(config.chat), transcriptionReady: configValid && !smoke && hasKey(config.transcription), warnings }));
  handle('peek:ask', async value => { await ask(validateAsk(value)); });
  handle('peek:cancel', () => {
    const id = activeRequest?.id;
    cancelAnswer();
    if (id) send({ type: 'answer-error', requestId: id, message: config.language === 'zh' ? '已停止。' : 'Stopped.' });
  });
  handle('peek:audio-status', (value: AudioStatus) => {
    if (!value || !['idle', 'recording', 'error'].includes(value.state)) throw new Error('Invalid audio state.');
    if (value.state === 'recording') {
      if (!configValid) throw new Error('Fix config.json from the tray menu and restart Peek before recording.');
      audioRecording = true;
    } else stopAudio();
  });
  handle('peek:transcribe', async value => {
    if (!configValid) throw new Error('Fix config.json from the tray menu and restart Peek before transcribing.');
    const chunk = validateAudio(value);
    if (!audioRecording || smoke) throw new Error('Audio is paused.');
    if (audioController) throw new Error('Transcription is busy; skip this chunk.');
    const generation = audioGeneration;
    const controller = new AbortController();
    audioController = controller;
    try {
      const text = await transcribeAudio(config, chunk, controller.signal);
      if (generation !== audioGeneration || !audioRecording) return { text: '' };
      transcripts.add({ startedAt: chunk.startedAt, endedAt: chunk.endedAt, text });
      return { text }; // renderer does not store this text
    } finally { if (audioController === controller) audioController = undefined; }
  });
  handle('peek:choose-library', async () => {
    if (!configValid) throw new Error('Fix config.json and restart before choosing a vault.');
    if (loadingLibrary || activeRequest) throw new Error('Wait for the current operation to finish.');
    const selected = await dialog.showOpenDialog(win, { title: 'Obsidian / Markdown', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const status = await reloadLibrary(selected.filePaths[0]);
    config.libraryPath = status.root || selected.filePaths[0];
    await saveConfig(configPath, config);
    return status;
  });
  handle('peek:reload-library', () => reloadLibrary());
  handle('peek:open-source', async (id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid source.');
    const path = library.resolveDocument(id);
    if (!path || await realpath(path) !== path) throw new Error('Source moved or was replaced. Reload the vault.');
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
}

function trayImage(): Electron.NativeImage {
  // Tiny procedural monochrome eye: no external fonts or image downloads.
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - 15.5, dy = y - 15.5;
    const ellipse = dx * dx / 169 + dy * dy / 64;
    if ((ellipse < 1 && ellipse > 0.55) || dx * dx + dy * dy < 15) pixels[(y * size + x) * 4 + 3] = 255;
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  icon.setTemplateImage(true);
  return icon;
}

async function start(): Promise<void> {
  configureApplication(app);
  Menu.setApplicationMenu(null);
  console.warn(protectionWarning);
  const directory = getConfigDirectory(app);
  configPath = join(directory, 'config.json');
  if (!app.isPackaged) loadEnv({ path: join(app.getAppPath(), '.env') });
  loadEnv({ path: join(directory, '.env') });
  const defaults = defaultConfig(platformDefaults().interactionModifiers);
  try { config = await loadConfig(configPath, defaults); }
  catch (error) { config = defaults; configValid = false; warnings.push(`Config not loaded: ${message(error)} Fix it in the tray menu and restart. The file has not been overwritten.`); }
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 420, height: 520, x: x + Math.max(0, width - 436), y: y + Math.min(16, Math.max(0, height - 520)),
    frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
    resizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    show: false, skipTaskbar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'peek-memory' },
  });
  configureOverlay(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape' && input.type === 'keyDown') { event.preventDefault(); win.blur(); }
  });
  const allowedUrl = devUrl ? `${devUrl}/` : pathToFileURL(join(__dirname, 'renderer/index.html')).href;
  win.webContents.session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    webContents === win.webContents && permission === 'media' && details.mediaType === 'audio' && details.requestingUrl === allowedUrl);
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes ?? [] : [];
    callback(webContents === win.webContents && permission === 'media' && details.requestingUrl === allowedUrl && mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio'));
  });
  registerIpc();
  if (config.libraryPath) {
    try { await reloadLibrary(); } catch (error) { warnings.push(`Library: ${message(error)}`); }
  }
  try { stopMonitor = startModifierMonitor(win, config.interactionModifiers, active => send({ type: 'interaction', active })); }
  catch (error) { warnings.push(message(error)); }
  tray = new Tray(trayImage());
  tray.setToolTip('Peek');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Peek', enabled: false },
    { label: 'Config / 配置…', click: () => { void shell.openPath(configPath).then(error => { if (error) warn(error); }); } },
    { type: 'separator' },
    { label: 'Quit / 退出', click: () => app.quit() },
  ]));
  for (const [name, accelerator] of Object.entries(config.hotkeys)) {
    try {
      if (!globalShortcut.register(accelerator, () => {
        if (name === 'toggle') { desiredVisible = !desiredVisible; restoreVisibility(); }
        else { desiredVisible = true; restoreVisibility(); send({ type: 'trigger', followUp: name === 'followUp' }); }
      })) warnings.push(`Hotkey unavailable: ${accelerator}. Change it in config.json and restart.`);
    } catch { warnings.push(`Invalid hotkey: ${accelerator}. Change it in config.json and restart.`); }
  }
  transcriptTimer = setInterval(() => transcripts.prune(), 1000);
  transcriptTimer.unref();
  win.webContents.on('render-process-gone', () => { stopAudio(); cancelAnswer(); });
  win.webContents.on('did-start-loading', () => { stopAudio(); cancelAnswer(); history = []; lastIntent = ''; });
  win.once('ready-to-show', () => restoreVisibility());
  if (devUrl) await win.loadURL(`${devUrl}/`); else await win.loadFile(join(__dirname, 'renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { desiredVisible = true; restoreVisibility(); } });
  app.whenReady().then(start).catch(error => { console.error(`Peek startup failed: ${message(error)}`); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    globalShortcut.unregisterAll(); stopMonitor?.(); clearInterval(transcriptTimer);
    stopAudio(); cancelAnswer(); history = []; tray?.destroy();
  });
}
