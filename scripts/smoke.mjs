import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'peek-smoke-'));
const syntheticKey = 'peek-synthetic-credential-for-smoke-only';
let app;
async function ensureListening(page) {
  if (await page.locator('#audio-toggle').getAttribute('aria-pressed') !== 'true') {
    await page.locator('#ask').click();
    await page.waitForFunction(() => document.querySelector('#audio-toggle').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 });
  }
}
async function taskTurnCount(page, id) {
  return page.evaluate(async taskId => (await window.peek.listTasks()).find(task => task.id === taskId)?.turnCount, id);
}
async function waitForTaskTurns(page, id, count) {
  await page.waitForFunction(async ({ taskId, expected }) => (await window.peek.listTasks()).find(task => task.id === taskId)?.turnCount === expected, { taskId: id, expected: count }, { timeout: 5000 });
}
try {
  const vault = join(temporary, 'vault');
  await mkdir(join(vault, '文学'), { recursive: true });
  await writeFile(join(vault, '文学', 'memory.md'), '# 记忆与叙事\n\nMemory links literature and identity.\n');
  await writeFile(join(temporary, 'config.json'), JSON.stringify({ libraryPath: vault, chat: { apiKeyEnv: 'PEEK_SMOKE_NO_KEY' }, transcription: { apiKeyEnv: 'PEEK_SMOKE_NO_KEY' } }));
  const executablePath = process.env.PEEK_SMOKE_EXECUTABLE ? resolve(process.env.PEEK_SMOKE_EXECUTABLE) : undefined;
  app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), '--smoke-test', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env: { ...process.env, PEEK_TEST_USER_DATA: temporary, PEEK_SMOKE_NO_KEY: '', PEEK_DEV_URL: '' } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#new-task') && !document.querySelector('#new-task').disabled, null, { timeout: 10000 });
  const info = await app.evaluate(({ BrowserWindow, app }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const prefs = win.webContents.getLastWebPreferences();
    return { name: app.getName(), bounds: win.getBounds(), top: win.isAlwaysOnTop(), node: prefs.nodeIntegration, sandbox: prefs.sandbox, isolation: prefs.contextIsolation };
  });
  assert.equal(info.name, 'Peek');
  assert.equal(info.bounds.width, 420); assert.equal(info.bounds.height, 520);
  assert.equal(info.top, true); assert.equal(info.node, false); assert.equal(info.sandbox, true); assert.equal(info.isolation, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.peekSetup), 'undefined');
  assert.equal(await page.locator('input, textarea').count(), 0);
  assert.equal(await page.locator('#prepare-panel').isVisible(), false);
  assert.equal(await page.locator('#task-panel').isVisible(), true);
  assert.equal(await page.locator('#new-task').isVisible(), true);
  const boot = await page.evaluate(() => window.peek.bootstrap());
  assert.equal(boot.config.hotkeys.ask, 'Control+Enter');
  assert.equal(boot.config.hotkeys.toggle, 'Control+Backspace');
  assert.equal(boot.config.hotkeys.followUp, '');
  assert.deepEqual(boot.config.interactionModifiers, ['Shift']);
  assert.equal(boot.config.model, 'gpt-6.1-sol');
  assert.equal(boot.modelSelectionAvailable, true);
  assert.deepEqual(boot.shortcutWarnings, []);
  assert.equal(boot.chatReady, false); assert.equal(boot.transcriptionReady, false);
  assert.equal('chat' in boot.config, false);
  assert.equal(boot.activeTask, null);
  assert.deepEqual(boot.tasks, []);
  assert.match(await page.locator('#ask-key').textContent(), /Ctrl.*回车/);
  assert.match(await page.locator('#toggle-key').textContent(), /Ctrl.*⌫/);
  assert.match(await page.locator('#toggle-key-label').textContent(), /隐藏.*回来/);
  assert.match(await page.locator('#return-route').textContent(), /Peek.*显示/);
  await page.locator('#hide-window').click();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await page.evaluate(() => window.peek.setVisible(true));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await assert.rejects(() => page.evaluate(() => window.peek.openSource('../../etc/passwd')), /Invalid|moved|Source/);

  // Only OS encryption, captures, and remote APIs are mocked. UI, IPC, storage
  // and speech sequencing run through the actual Electron application.
  await app.evaluate(({ desktopCapturer, nativeImage, safeStorage, systemPreferences }) => {
    safeStorage.isEncryptionAvailable = () => true;
    // Deliberately reversible test double, never used by production code.
    safeStorage.encryptString = plain => Buffer.from(Buffer.from(plain, 'utf8').map(byte => byte ^ 0xa5));
    safeStorage.decryptString = encrypted => Buffer.from(encrypted.map(byte => byte ^ 0xa5)).toString('utf8');
    globalThis.__peekTestRequests = []; globalThis.__peekAudioHeaders = []; globalThis.__peekVerificationCalls = 0;
    globalThis.__peekCaptureMode = 'success'; globalThis.__peekCaptureCalls = 0; globalThis.__peekScreenPermission = 'granted'; globalThis.__peekModelStatus = 200;
    globalThis.__peekModelMode = 'success'; globalThis.__peekTranscriptionStatus = 200; globalThis.__peekTranscriptionCalls = 0; globalThis.__peekNextTranscriptionDelay = 0;
    globalThis.__peekAudioModels = []; globalThis.__peekSlowCapturesFinished = 0; globalThis.__peekStallAborted = false; globalThis.__peekSlowResponseAborted = false; globalThis.__peekResponseDelay = 11_000;
    globalThis.__peekTranscript = '记忆与叙事有什么关联？ Memory and identity.';
    systemPreferences.getMediaAccessStatus = () => globalThis.__peekScreenPermission;
    desktopCapturer.getSources = async () => {
      globalThis.__peekCaptureCalls++;
      // Electron 30's native _onerror rejects a string, not an Error.
      if (globalThis.__peekCaptureMode === 'reject') throw 'Failed to get sources.';
      if (globalThis.__peekCaptureMode === 'delayed-rejection') {
        await new Promise(resolve => setTimeout(resolve, 300));
        throw 'Failed to get sources.';
      }
      if (globalThis.__peekCaptureMode === 'slow') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        globalThis.__peekSlowCapturesFinished++;
      }
      return [{ id: 'screen:test', name: 'Synthetic', display_id: '', appIcon: null, thumbnail: nativeImage.createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 }) }];
    };
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/models')) { globalThis.__peekVerificationCalls++; return Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }, { id: 'gpt-transcribe' }] }); }
      if (String(url).endsWith('/audio/transcriptions')) {
        globalThis.__peekTranscriptionCalls++;
        globalThis.__peekAudioModels.push(init.body.get('model'));
        const blob = init.body.get('file');
        globalThis.__peekAudioHeaders.push([...new Uint8Array(await blob.slice(0, 4).arrayBuffer())]);
        if (globalThis.__peekTranscriptionStatus !== 200) return new Response('private transcription body must not be shown', { status: globalThis.__peekTranscriptionStatus });
        const delay = globalThis.__peekNextTranscriptionDelay;
        globalThis.__peekNextTranscriptionDelay = 0;
        if (delay) await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { init.signal.removeEventListener('abort', abort); resolve(); }, delay);
          const abort = () => { clearTimeout(timer); reject(init.signal.reason); };
          if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
        });
        return Response.json({ text: globalThis.__peekTranscript });
      }
      if (!String(url).endsWith('/chat/completions')) throw new Error('Unexpected test request');
      globalThis.__peekTestRequests.push(JSON.parse(init.body));
      if (globalThis.__peekModelStatus !== 200) return new Response('private provider body must not be shown', { status: globalThis.__peekModelStatus });
      if (globalThis.__peekModelMode === 'network') throw new TypeError('fetch failed');
      if (globalThis.__peekModelMode === 'stall') return await new Promise((_resolve, reject) => {
        const abort = () => { globalThis.__peekStallAborted = true; reject(init.signal.reason); };
        if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
      });
      if (globalThis.__peekModelMode === 'slow-response') await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { init.signal.removeEventListener('abort', abort); resolve(); }, globalThis.__peekResponseDelay);
        const abort = () => { clearTimeout(timer); globalThis.__peekSlowResponseAborted = true; reject(init.signal.reason); };
        if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
      });
      const text = globalThis.__peekModelMode === 'malformed'
        ? 'data: {private-malformed-provider-body}\n\n'
        : globalThis.__peekModelMode === 'abrupt'
          ? 'data: {"choices":[{"delta":{"content":"incomplete-stream-answer"}}]}\n\n'
          : 'data: {"service_tier":"fast","choices":[{"delta":{"content":"记忆连接叙事与身份。"}}]}\n\ndata: {"choices":[{"delta":{"content":"[1]"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }));
    };
  });

  let setupPromise = app.waitForEvent('window');
  await page.locator('#manage-key').click();
  let setup = await setupPromise;
  setup.on('pageerror', error => errors.push(error.message));
  await setup.waitForFunction(() => !document.querySelector('#api-key').disabled);
  assert.equal(await setup.evaluate(() => typeof window.peek), 'undefined');
  assert.equal(await setup.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await setup.locator('#api-key').getAttribute('type'), 'password');
  await setup.locator('#api-key').fill(syntheticKey);
  await setup.locator('#save-key').click();
  await setup.waitForFunction(() => document.querySelector('#setup-status').textContent.includes('连接成功'), null, {timeout: 5000}).catch(async () => { throw new Error('Setup failed: ' + await setup.locator('#setup-status').textContent()); });
  assert.equal(await setup.locator('#api-key').inputValue(), '');
  const publicCredentials = await setup.evaluate(() => window.peekSetup.bootstrap());
  assert.equal(publicCredentials.targets[0].source, 'secure');
  assert.equal(JSON.stringify(publicCredentials).includes(syntheticKey), false);
  assert.equal((await readFile(join(temporary, 'credentials.enc'))).includes(Buffer.from(syntheticKey)), false);
  assert.equal((await readFile(join(temporary, 'config.json'), 'utf8')).includes(syntheticKey), false);
  assert.equal(await app.evaluate(() => globalThis.__peekVerificationCalls), 1);
  assert.equal((await page.evaluate(() => window.peek.bootstrap())).transcriptionReady, false);
  await mkdir('artifacts', { recursive: true });
  await setup.screenshot({ path: resolve('artifacts/peek-key-setup.png') });
  await setup.locator('#done').click();
  await page.waitForFunction(() => !document.querySelector('#new-task').disabled);
  assert.equal(await page.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');

  await page.locator('#new-task').click();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, vault);
  await page.locator('#choose-library').click();
  await page.waitForFunction(() => document.querySelector('#focus-article')?.textContent?.includes('记忆与叙事') && !document.querySelector('#prepare-done').disabled, null, { timeout: 10000 });
  const selectedDocument = (await page.evaluate(() => window.peek.bootstrap())).library.documents[0];
  await page.locator('#focus-article').selectOption(selectedDocument.id);
  await page.locator('#prepare-done').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden, null, { timeout: 5000 });
  const firstTask = (await page.evaluate(() => window.peek.bootstrap())).activeTask;
  assert.ok(firstTask?.id);
  assert.equal(firstTask.context.focusDocumentId, selectedDocument.id);
  assert.equal(firstTask.context.libraryPath, await realpath(vault));
  assert.equal(firstTask.turns.length, 0);
  assert.equal(await page.locator('#task-panel').isVisible(), false);
  await page.locator('#ask').click();
  await page.waitForFunction(() => document.querySelector('#audio-toggle').getAttribute('aria-pressed') === 'true');
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), 0);
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => document.querySelector('#answer').textContent.includes('[1]') && !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden, null, { timeout: 12000 }).catch(async error => { throw new Error(error.message + ' UI: ' + await page.locator('body').innerText()); });
  assert.match(await page.locator('#sources').textContent(), /\[1\].*记忆与叙事/);
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden);
  let requests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.at(-1).content[1].type, 'image_url');
  assert.equal(requests[0].model, 'gpt-6.1-sol');
  assert.equal(requests[0].reasoning_effort, 'low');
  assert.equal(requests[0].service_tier, 'fast');
  assert.equal(requests[0].max_completion_tokens, 4096);
  assert.deepEqual([...new Set(await app.evaluate(() => globalThis.__peekAudioModels))], ['gpt-transcribe']);
  const fastTiming = await page.locator('#request-state').evaluate(element => ({ ...element.dataset }));
  assert.equal(fastTiming.serviceTier, 'fast');
  assert.ok(Number(fastTiming.firstTokenMs) >= 0 && Number(fastTiming.firstTokenMs) <= Number(fastTiming.totalMs));
  assert.ok(Number(fastTiming.totalMs) > 0 && Number(fastTiming.totalMs) < 10_000);
  assert.match(requests[0].messages.at(-1).content[0].text, /Memory links literature/);
  assert.match(requests[0].messages.at(-1).content[0].text, /记忆与叙事有什么关联/);
  assert.equal(requests[1].messages.filter(m => m.role === 'assistant').length, 1);
  await waitForTaskTurns(page, firstTask.id, 2);
  const savedInitial = JSON.parse(await readFile(join(temporary, 'tasks', `${firstTask.id}.json`), 'utf8'));
  assert.equal(savedInitial.turns.length, 2);
  assert.match(savedInitial.turns[0].question, /记忆与叙事有什么关联/);
  assert.match(savedInitial.turns[0].answer, /记忆连接叙事/);
  assert.equal(JSON.stringify(savedInitial).includes(syntheticKey), false);
  assert.equal(JSON.stringify(savedInitial).includes('data:image'), false);
  await page.locator('#new-topic').click();
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden);
  requests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages.filter(m => m.role === 'assistant').length, 0);
  const audioHeaders = await app.evaluate(() => globalThis.__peekAudioHeaders);
  assert.ok(audioHeaders.length >= 3);
  for (const header of audioHeaders) assert.deepEqual(header, [0x1a, 0x45, 0xdf, 0xa3]);

  // Reproduce the native rejected-string failure. The spoken question still
  // answers, with no image sent and a visible disclosure beside the answer.
  await app.evaluate(() => { globalThis.__peekCaptureMode = 'reject'; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden);
  requests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].messages.at(-1).content.map(part => part.type), ['text']);
  assert.match(requests[3].messages.at(-1).content[0].text, /SCREENSHOT: unavailable/);
  assert.match(await page.locator('#capture-warning').textContent(), /仅使用语音和文章.*屏幕录制权限/);
  assert.equal(await page.locator('#capture-warning').isVisible(), true);
  assert.doesNotMatch(await page.locator('body').innerText(), /unexpected error/i);
  await page.screenshot({ path: resolve('artifacts/peek-capture-fallback.png') });

  // Known permission denial skips the native capture, but can still answer.
  const callsBeforeDenial = await app.evaluate(() => { globalThis.__peekScreenPermission = 'denied'; return globalThis.__peekCaptureCalls; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden);
  assert.equal(await app.evaluate(() => globalThis.__peekCaptureCalls), callsBeforeDenial);
  requests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[4].messages.at(-1).content.map(part => part.type), ['text']);

  // A later successful capture restores images and clears the old disclosure.
  await app.evaluate(() => { globalThis.__peekCaptureMode = 'success'; globalThis.__peekScreenPermission = 'granted'; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden);
  requests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(requests.length, 6);
  assert.equal(requests[5].messages.at(-1).content[1].type, 'image_url');
  assert.equal(await page.locator('#capture-warning').isVisible(), false);

  // Model choice persists with the task, retaining its saved conversation.
  await page.locator('#prepare-toggle').click();
  await page.locator('#model').selectOption('gpt-6-astra');
  await page.waitForFunction(() => !document.querySelector('#model').disabled, null, { timeout: 5000 });
  assert.equal(JSON.parse(await readFile(join(temporary, 'config.json'), 'utf8')).model, 'gpt-6-astra');
  await page.locator('#prepare-done').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden, null, { timeout: 5000 });
  await ensureListening(page);
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
  const astraRequest = await app.evaluate(() => globalThis.__peekTestRequests.at(-1));
  assert.equal(astraRequest.model, 'gpt-6-astra');
  assert.equal(astraRequest.reasoning_effort, 'low');
  assert.equal(astraRequest.service_tier, 'fast');
  assert.equal(astraRequest.max_completion_tokens, 4096);
  assert.equal(astraRequest.messages.some(message => message.role === 'assistant'), true, 'Saved task context remains available after a model change');
  assert.equal(await page.locator('#request-state').getAttribute('data-service-tier'), 'fast');
  await page.locator('#prepare-toggle').click();
  await page.locator('#model').selectOption('gpt-6.1-sol');
  await page.waitForFunction(() => !document.querySelector('#model').disabled, null, { timeout: 5000 });
  assert.equal(JSON.parse(await readFile(join(temporary, 'config.json'), 'utf8')).model, 'gpt-6.1-sol');
  await page.locator('#prepare-done').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden, null, { timeout: 5000 });
  await ensureListening(page);

  // Native capture may finish late; its 800ms budget must return the overlay
  // and let speech answer before that 1500ms native operation has completed.
  const beforeSlowCapture = await app.evaluate(() => { globalThis.__peekCaptureMode = 'slow'; return globalThis.__peekTestRequests.length; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 5000 });
  const slowCaptureState = await app.evaluate(({ BrowserWindow }) => ({ finished: globalThis.__peekSlowCapturesFinished, visible: BrowserWindow.getAllWindows()[0].isVisible(), requests: globalThis.__peekTestRequests }));
  assert.equal(slowCaptureState.finished, 0, 'Answer should not wait for the late native capture');
  assert.equal(slowCaptureState.visible, true, 'Capture timeout must restore the overlay');
  assert.equal(slowCaptureState.requests.length, beforeSlowCapture + 1);
  assert.deepEqual(slowCaptureState.requests.at(-1).messages.at(-1).content.map(part => part.type), ['text']);
  assert.match(await page.locator('#capture-warning').textContent(), /仅使用语音和文章.*截图.*(?:超时|超过时限)/);
  await app.evaluate(() => { globalThis.__peekCaptureMode = 'success'; });
  await page.waitForTimeout(900);

  await app.evaluate(() => { globalThis.__peekModelStatus = 429; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden);
  assert.match(await page.locator('#notice').textContent(), /回答失败.*API 429/);
  assert.doesNotMatch(await page.locator('body').innerText(), /private provider body/);
  await app.evaluate(() => { globalThis.__peekModelStatus = 200; });

  // Authentication, rejected fetches, malformed JSON, and an abruptly ended
  // stream all release the UI and give safe feedback, then allow a clean retry.
  const failureCases = [
    { status: 401, mode: 'success', notice: /回答失败.*API 401.*密钥/ },
    { status: 200, mode: 'network', notice: /回答未能连接 API.*网络/ },
    { status: 200, mode: 'malformed', notice: /回答失败.*重试/ },
    { status: 200, mode: 'abrupt', notice: /回答传输中断.*重试/ },
  ];
  for (const failure of failureCases) {
    const savedBeforeFailure = await taskTurnCount(page, firstTask.id);
    const before = await app.evaluate((_electron, { status, mode }) => {
      globalThis.__peekModelStatus = status; globalThis.__peekModelMode = mode;
      return globalThis.__peekTestRequests.length;
    }, { status: failure.status, mode: failure.mode });
    await page.waitForTimeout(350);
    await page.locator('#ask').click();
    await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#notice').textContent.length > 0, null, { timeout: 12000 });
    assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), before + 1, failure.mode);
    assert.match(await page.locator('#notice').textContent(), failure.notice);
    assert.doesNotMatch(await page.locator('body').innerText(), /private provider body|private-malformed-provider-body|unexpected error/i);
    assert.equal(await taskTurnCount(page, firstTask.id), savedBeforeFailure, 'Failed answers must never be saved as completed Q&A');
    await app.evaluate(() => { globalThis.__peekModelStatus = 200; globalThis.__peekModelMode = 'success'; });
    await page.waitForTimeout(350);
    await page.locator('#ask').click();
    await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
    const afterRetry = await app.evaluate(() => globalThis.__peekTestRequests);
    assert.equal(afterRetry.length, before + 2);
    assert.equal(await page.locator('#notice').isVisible(), false);
    assert.equal(await page.locator('#answer').textContent(), '记忆连接叙事与身份。[1]');
    assert.equal(afterRetry.at(-1).messages.some(message => message.role === 'assistant' && String(message.content).includes('incomplete-stream-answer')), false, 'Failed partial answers must not enter conversation history');
    await waitForTaskTurns(page, firstTask.id, savedBeforeFailure + 1);
  }

  // A failed final speech chunk must not submit the previous transcript as a
  // new question. The visible notice must explain the actual failure.
  const beforeSpeechFailure = await app.evaluate(() => {
    globalThis.__peekTranscriptionStatus = 401;
    return { models: globalThis.__peekTestRequests.length, speech: globalThis.__peekTranscriptionCalls };
  });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#notice').textContent.length > 0, null, { timeout: 12000 });
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeSpeechFailure.models, 'Never answer from stale speech after the new chunk failed');
  assert.ok(await app.evaluate(() => globalThis.__peekTranscriptionCalls) > beforeSpeechFailure.speech);
  assert.match(await page.locator('#notice').textContent(), /语音转写失败.*API 401.*密钥/);
  assert.equal(await page.locator('#notice').isVisible(), true);
  assert.doesNotMatch(await page.locator('body').innerText(), /private transcription body/);
  await app.evaluate(() => {
    globalThis.__peekTranscriptionStatus = 200;
    globalThis.__peekTranscript = '恢复后的新问题 fresh-transcript-after-retry';
  });
  if (await page.locator('#audio-toggle').getAttribute('aria-pressed') !== 'true') {
    await page.locator('#ask').click();
    await page.waitForFunction(() => document.querySelector('#audio-toggle').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 });
  }
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
  const speechRetryRequests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(speechRetryRequests.length, beforeSpeechFailure.models + 1);
  assert.match(speechRetryRequests.at(-1).messages.at(-1).content[0].text, /fresh-transcript-after-retry/);
  assert.equal(await page.locator('#notice').isVisible(), false);

  // Cancellation during a failed capture must not accidentally start the
  // fallback API request after the user pressed Stop.
  const beforeCancel = await app.evaluate(() => { globalThis.__peekCaptureMode = 'delayed-rejection'; return { requests: globalThis.__peekTestRequests.length, captures: globalThis.__peekCaptureCalls }; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  const captureDeadline = Date.now() + 10_000;
  while (await app.evaluate(() => globalThis.__peekCaptureCalls) === beforeCancel.captures && Date.now() < captureDeadline) await page.waitForTimeout(20);
  assert.ok(await app.evaluate(() => globalThis.__peekCaptureCalls) > beforeCancel.captures, 'Capture did not start within 10 seconds');
  await page.locator('#cancel').click();
  await page.waitForTimeout(450);
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeCancel.requests);
  await app.evaluate(() => { globalThis.__peekCaptureMode = 'success'; });
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden);
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeCancel.requests + 1);

  // A slower final speech upload is still awaited; the old three-second flush
  // deadline must not turn a valid question into a retry or stale-context call.
  const beforeSlowSpeech = await app.evaluate(() => {
    globalThis.__peekNextTranscriptionDelay = 4000;
    globalThis.__peekTranscript = '慢速转写的新问题 slow-transcription-current-question';
    return globalThis.__peekTestRequests.length;
  });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForTimeout(1000);
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeSlowSpeech, 'Await current speech instead of submitting an older transcript');
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 8000 });
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeSlowSpeech + 1);
  const slowSpeechRequest = await app.evaluate(() => globalThis.__peekTestRequests.at(-1));
  assert.match(slowSpeechRequest.messages.at(-1).content[0].text, /slow-transcription-current-question/);
  assert.ok(Number(await page.locator('#request-state').getAttribute('data-total-ms')) > 3000);
  assert.equal(await page.locator('#notice').isVisible(), false);

  // Ten seconds is a speed target, not a cancellation deadline. A provider
  // whose first token arrives after eleven seconds still completes and saves.
  const beforeSlowAnswer = await taskTurnCount(page, firstTask.id);
  await app.evaluate(() => { globalThis.__peekModelMode = 'slow-response'; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => Number(document.querySelector('#request-state').dataset.totalMs) > 10_000, null, { timeout: 12000 });
  assert.equal(await page.locator('#ask').isEnabled(), true, 'Next question stays available while a slow answer continues');
  assert.equal(await page.locator('#cancel').isVisible(), true);
  assert.match(await page.locator('#request-state').textContent(), /继续|仍在|生成|等待/);
  assert.doesNotMatch(await page.locator('#notice').textContent(), /时限|未完成|请重试/);
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 5000 });
  const slowAnswerTiming = await page.locator('#request-state').evaluate(element => ({ ...element.dataset }));
  assert.ok(Number(slowAnswerTiming.firstTokenMs) > 10_000);
  assert.ok(Number(slowAnswerTiming.totalMs) >= Number(slowAnswerTiming.firstTokenMs));
  assert.equal(await app.evaluate(() => globalThis.__peekSlowResponseAborted), false);
  await waitForTaskTurns(page, firstTask.id, beforeSlowAnswer + 1);
  assert.equal(await page.locator('#notice').isVisible(), false);

  // Only an explicit Stop cancels a stalled request. Late events must not
  // revive that answer or contaminate history, and the next request can work.
  await page.evaluate(() => {
    window.__peekLastRequestId = '';
    window.peek.onEvent(event => { if (event.type === 'answer-start') window.__peekLastRequestId = event.requestId; });
  });
  const beforeStall = await app.evaluate(() => { globalThis.__peekModelMode = 'stall'; return globalThis.__peekTestRequests.length; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  const stallStartDeadline = Date.now() + 5000;
  while (await app.evaluate(() => globalThis.__peekTestRequests.length) === beforeStall && Date.now() < stallStartDeadline) await page.waitForTimeout(20);
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeStall + 1);
  assert.equal(await page.locator('#cancel').isVisible(), true);
  await page.locator('#cancel').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#notice').textContent.includes('已停止'), null, { timeout: 3000 });
  const abortDeadline = Date.now() + 1000;
  while (!await app.evaluate(() => globalThis.__peekStallAborted) && Date.now() < abortDeadline) await page.waitForTimeout(20);
  assert.equal(await app.evaluate(() => globalThis.__peekStallAborted), true);
  const staleId = await page.evaluate(() => window.__peekLastRequestId);
  assert.ok(staleId);
  await app.evaluate(({ BrowserWindow }, requestId) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    for (const event of [
      { type: 'answer-start', requestId, sources: [], transcript: '' },
      { type: 'answer-delta', requestId, delta: 'stale-stopped-answer' },
      { type: 'answer-warning', requestId, message: 'stale-stopped-warning' },
      { type: 'answer-metadata', requestId, serviceTier: 'stale' },
      { type: 'answer-done', requestId },
    ]) contents.send('peek:event', event);
  }, staleId);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#ask').isEnabled(), true);
  assert.match(await page.locator('#notice').textContent(), /已停止/);
  assert.doesNotMatch(await page.locator('body').innerText(), /stale-stopped/);
  assert.equal(await taskTurnCount(page, firstTask.id), beforeSlowAnswer + 1);
  await app.evaluate(() => { globalThis.__peekModelMode = 'success'; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
  const afterStall = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(afterStall.length, beforeStall + 2);
  assert.deepEqual(afterStall.at(-1).messages.slice(0, -1), afterStall.at(-2).messages.slice(0, -1), 'Stopped request must not enter history');
  assert.equal(await page.locator('#notice').isVisible(), false);

  // A new question can replace an unfinished answer without turning off the
  // microphone or repeating the previous spoken question in the new context.
  const savedBeforeNext = await taskTurnCount(page, firstTask.id);
  const beforeNext = await app.evaluate(() => {
    globalThis.__peekTranscript = '待替换的旧问题 interrupted-old-question';
    globalThis.__peekModelMode = 'stall'; globalThis.__peekStallAborted = false;
    return globalThis.__peekTestRequests.length;
  });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  const oldQuestionDeadline = Date.now() + 5000;
  while (await app.evaluate(() => globalThis.__peekTestRequests.length) === beforeNext && Date.now() < oldQuestionDeadline) await page.waitForTimeout(20);
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeNext + 1);
  assert.match((await app.evaluate(() => globalThis.__peekTestRequests.at(-1))).messages.at(-1).content[0].text, /interrupted-old-question/);
  const interruptedId = await page.evaluate(() => window.__peekLastRequestId);
  assert.ok(interruptedId);
  assert.equal(await page.locator('#ask').isEnabled(), true);
  assert.match(await page.locator('#ask').textContent(), /下一题|Next question/);
  assert.equal(await page.locator('#audio-toggle').getAttribute('aria-pressed'), 'true');
  await app.evaluate(() => {
    globalThis.__peekTranscript = '立即回答这个新问题 rapid-next-question';
    globalThis.__peekModelMode = 'slow-response'; globalThis.__peekResponseDelay = 500;
  });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  const nextQuestionDeadline = Date.now() + 5000;
  while (await app.evaluate(() => globalThis.__peekTestRequests.length) < beforeNext + 2 && Date.now() < nextQuestionDeadline) await page.waitForTimeout(20);
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeNext + 2);
  assert.equal(await app.evaluate(() => globalThis.__peekStallAborted), true);
  await app.evaluate(({ BrowserWindow }, requestId) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('peek:event', { type: 'answer-delta', requestId, delta: 'discarded-old-answer' });
    contents.send('peek:event', { type: 'answer-done', requestId });
  }, interruptedId);
  await page.waitForFunction(() => document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 5000 });
  assert.equal(await page.locator('#audio-toggle').getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(await page.locator('#answer').textContent(), /discarded-old-answer/);
  const nextQuestionRequest = await app.evaluate(() => globalThis.__peekTestRequests.at(-1));
  assert.match(nextQuestionRequest.messages.at(-1).content[0].text, /rapid-next-question/);
  assert.doesNotMatch(JSON.stringify(nextQuestionRequest.messages), /interrupted-old-question|discarded-old-answer/);
  assert.equal(nextQuestionRequest.messages.some(message => message.role === 'assistant'), false, 'Next question starts without the interrupted thread');
  await waitForTaskTurns(page, firstTask.id, savedBeforeNext + 1);
  await app.evaluate(() => { globalThis.__peekModelMode = 'success'; globalThis.__peekResponseDelay = 11_000; });

  // Task switching saves completed Q&A, clears live audio, and never leaks the
  // previous task's conversation into a new task or another resumed task.
  const firstTaskCount = await taskTurnCount(page, firstTask.id);
  assert.ok(firstTaskCount > 2);
  const savedFirst = JSON.parse(await readFile(join(temporary, 'tasks', `${firstTask.id}.json`), 'utf8'));
  assert.equal(savedFirst.turns.length, firstTaskCount);
  assert.equal(savedFirst.turns.some(turn => /incomplete-stream-answer|stale-stopped-answer/.test(turn.answer)), false);
  await page.locator('#tasks-toggle').click();
  await page.waitForFunction(() => !document.querySelector('#task-panel').hidden, null, { timeout: 5000 });
  assert.equal(await page.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');
  await page.screenshot({ path: resolve('artifacts/peek-task-chooser.png') });
  await page.locator('#new-task').click();
  await page.locator('#prepare-done').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden, null, { timeout: 5000 });
  const secondTask = (await page.evaluate(() => window.peek.bootstrap())).activeTask;
  assert.ok(secondTask?.id && secondTask.id !== firstTask.id);
  assert.equal(secondTask.turns.length, 0);
  await app.evaluate(() => { globalThis.__peekTranscript = '第二任务 isolation-new-task'; });
  await ensureListening(page);
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
  const isolatedRequest = await app.evaluate(() => globalThis.__peekTestRequests.at(-1));
  assert.equal(isolatedRequest.messages.some(message => message.role === 'assistant'), false);
  assert.match(isolatedRequest.messages.at(-1).content[0].text, /isolation-new-task/);
  await waitForTaskTurns(page, secondTask.id, 1);
  assert.equal(await taskTurnCount(page, firstTask.id), firstTaskCount);

  await page.locator('#tasks-toggle').click();
  await page.locator(`.task-card[data-task-id="${firstTask.id}"]`).click();
  await page.waitForFunction(() => !document.querySelector('#response-area').hidden && !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden, null, { timeout: 5000 });
  assert.equal(await page.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#answer').textContent(), savedFirst.turns.at(-1).answer);
  assert.equal(await page.locator('#task-history .history-entry').count(), firstTaskCount);
  await page.locator('#history-label').click();
  assert.match(await page.locator('#task-history').innerText(), /记忆与叙事有什么关联/);
  assert.doesNotMatch(await page.locator('#task-history').innerText(), /isolation-new-task/);
  await page.screenshot({ path: resolve('artifacts/peek-task-history.png') });
  await page.locator('#history-label').click();
  await app.evaluate(() => { globalThis.__peekTranscript = '继续第一任务 resume-first-task'; });
  await ensureListening(page);
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#cancel').hidden && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
  const resumedRequest = await app.evaluate(() => globalThis.__peekTestRequests.at(-1));
  assert.equal(resumedRequest.messages.some(message => message.role === 'assistant'), true);
  assert.doesNotMatch(JSON.stringify(resumedRequest.messages), /isolation-new-task/);
  await waitForTaskTurns(page, firstTask.id, firstTaskCount + 1);
  await page.screenshot({ path: resolve('artifacts/peek-smoke-zh.png') });
  await page.locator('#language-toggle').click();
  await page.screenshot({ path: resolve('artifacts/peek-smoke-en.png') });

  await app.evaluate(() => { process.env.PEEK_SMOKE_NO_KEY = 'legacy-environment-test-credential'; });
  setupPromise = app.waitForEvent('window');
  await page.locator('#manage-key').click();
  setup = await setupPromise;
  await setup.waitForFunction(() => !document.querySelector('#remove-key').hidden);
  assert.equal(await setup.locator('#api-key').inputValue(), '');
  assert.equal(await page.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal((await page.evaluate(() => window.peek.bootstrap())).chatReady, false);
  await setup.locator('#remove-key').click();
  await setup.locator('#remove-key').click();
  await setup.waitForFunction(() => document.querySelector('#setup-status').textContent.includes('此连接已停用'));
  await setup.locator('#done').click();
  assert.equal((await page.evaluate(() => window.peek.bootstrap())).chatReady, false);
  assert.deepEqual(errors, []);

  // A fresh process lists saved tasks but requires an explicit choice. It must
  // not resume recording or a conversation solely because config was saved.
  await app.close(); app = undefined;
  app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), '--smoke-test', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env: { ...process.env, PEEK_TEST_USER_DATA: temporary, PEEK_SMOKE_NO_KEY: '', PEEK_DEV_URL: '' } });
  const restartedPage = await app.firstWindow();
  restartedPage.on('pageerror', error => errors.push(error.message));
  await restartedPage.waitForFunction(() => document.querySelectorAll('.task-card').length === 2, null, { timeout: 10000 });
  const restartedBoot = await restartedPage.evaluate(() => window.peek.bootstrap());
  assert.equal(restartedBoot.activeTask, null);
  assert.equal(restartedBoot.tasks.length, 2);
  assert.equal(await restartedPage.locator('#task-panel').isVisible(), true);
  assert.equal(await restartedPage.locator('#response-area').isVisible(), false);
  assert.equal(await restartedPage.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');
  await restartedPage.locator(`.task-card[data-task-id="${firstTask.id}"]`).click();
  await restartedPage.waitForFunction(() => !document.querySelector('#response-area').hidden, null, { timeout: 5000 });
  assert.equal(await restartedPage.locator('#task-history .history-entry').count(), firstTaskCount + 1);
  assert.match(await restartedPage.locator('#task-history').textContent(), /resume-first-task/);
  assert.equal(await restartedPage.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');

  // Losing access to a library must not lose saved Q&A or silently replace its
  // original path. Resume opens preparation while retaining the old history.
  await restartedPage.locator('#tasks-toggle').click();
  await rename(vault, `${vault}-moved`);
  await restartedPage.locator(`.task-card[data-task-id="${firstTask.id}"]`).click();
  await restartedPage.waitForFunction(() => !document.querySelector('#prepare-panel').hidden && !document.querySelector('#response-area').hidden, null, { timeout: 5000 });
  assert.equal(await restartedPage.locator('#task-history .history-entry').count(), firstTaskCount + 1);
  assert.match(await restartedPage.locator('#task-history').textContent(), /resume-first-task/);
  assert.equal(await restartedPage.locator('#notice').isVisible(), true);
  assert.ok((await restartedPage.locator('#notice').textContent()).length > 0);
  assert.equal(await restartedPage.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await restartedPage.locator('#ask').isEnabled(), false);
  const missingVaultBoot = await restartedPage.evaluate(() => window.peek.bootstrap());
  assert.equal(missingVaultBoot.library.documents.length, 0);
  const savedMissing = JSON.parse(await readFile(join(temporary, 'tasks', `${firstTask.id}.json`), 'utf8'));
  assert.equal(savedMissing.context.libraryPath, savedFirst.context.libraryPath);
  await restartedPage.screenshot({ path: resolve('artifacts/peek-task-missing-vault.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: new/continue tasks, saved Q&A and restart isolation, missing-vault history recovery, visible hide/return, Sol/Astra Fast metadata, bounded capture, error recovery, answers completing after ten seconds, manual Stop, and stale-event rejection.');
  console.log('Mocked: OS encryption primitive, capture and API. Real Keychain/DPAPI permissions, paid services, hardware audio and share exclusion need manual verification.');
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
