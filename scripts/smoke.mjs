import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'peek-smoke-'));
const syntheticKey = 'peek-synthetic-credential-for-smoke-only';
let app;
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
  await page.waitForFunction(() => document.querySelector('#focus-article')?.textContent?.includes('记忆与叙事'));
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
    globalThis.__peekModelMode = 'success'; globalThis.__peekTranscriptionStatus = 200; globalThis.__peekTranscriptionCalls = 0;
    globalThis.__peekAudioModels = []; globalThis.__peekSlowCapturesFinished = 0; globalThis.__peekStallAborted = false;
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
      const text = globalThis.__peekModelMode === 'malformed'
        ? 'data: {private-malformed-provider-body}\n\n'
        : globalThis.__peekModelMode === 'abrupt'
          ? 'data: {"choices":[{"delta":{"content":"incomplete-stream-answer"}}]}\n\n'
          : 'data: {"service_tier":"fast","choices":[{"delta":{"content":"记忆连接叙事与身份。"}}]}\n\ndata: {"choices":[{"delta":{"content":"[1]"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }));
    };
  });

  let setupPromise = app.waitForEvent('window');
  await page.locator('#connect-key').click();
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
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
  assert.equal(await page.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');

  await page.locator('#prepare-toggle').click();
  await page.locator('#focus-article').selectOption(boot.library.documents[0].id);
  await page.locator('#prepare-done').click();
  await page.locator('#ask').click();
  await page.waitForFunction(() => document.querySelector('#audio-toggle').getAttribute('aria-pressed') === 'true');
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), 0);
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => document.querySelector('#answer').textContent.includes('[1]') && !document.querySelector('#ask').disabled, null, { timeout: 12000 }).catch(async error => { throw new Error(error.message + ' UI: ' + await page.locator('body').innerText()); });
  assert.match(await page.locator('#sources').textContent(), /\[1\].*记忆与叙事/);
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
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
  await page.locator('#new-topic').click();
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
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
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
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
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
  assert.equal(await app.evaluate(() => globalThis.__peekCaptureCalls), callsBeforeDenial);
  requests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[4].messages.at(-1).content.map(part => part.type), ['text']);

  // A later successful capture restores images and clears the old disclosure.
  await app.evaluate(() => { globalThis.__peekCaptureMode = 'success'; globalThis.__peekScreenPermission = 'granted'; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
  requests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(requests.length, 6);
  assert.equal(requests[5].messages.at(-1).content[1].type, 'image_url');
  assert.equal(await page.locator('#capture-warning').isVisible(), false);

  // Model choice takes effect immediately, persists, and starts a new thread.
  await page.locator('#prepare-toggle').click();
  await page.locator('#model').selectOption('gpt-6-astra');
  await page.waitForFunction(() => !document.querySelector('#model').disabled, null, { timeout: 5000 });
  assert.equal(JSON.parse(await readFile(join(temporary, 'config.json'), 'utf8')).model, 'gpt-6-astra');
  await page.locator('#prepare-done').click();
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
  const astraRequest = await app.evaluate(() => globalThis.__peekTestRequests.at(-1));
  assert.equal(astraRequest.model, 'gpt-6-astra');
  assert.equal(astraRequest.reasoning_effort, 'low');
  assert.equal(astraRequest.service_tier, 'fast');
  assert.equal(astraRequest.max_completion_tokens, 4096);
  assert.equal(astraRequest.messages.some(message => message.role === 'assistant'), false);
  assert.equal(await page.locator('#request-state').getAttribute('data-service-tier'), 'fast');
  await page.locator('#prepare-toggle').click();
  await page.locator('#model').selectOption('gpt-6.1-sol');
  await page.waitForFunction(() => !document.querySelector('#model').disabled, null, { timeout: 5000 });
  assert.equal(JSON.parse(await readFile(join(temporary, 'config.json'), 'utf8')).model, 'gpt-6.1-sol');
  await page.locator('#prepare-done').click();

  // Native capture may finish late; its 800ms budget must return the overlay
  // and let speech answer before that 1500ms native operation has completed.
  const beforeSlowCapture = await app.evaluate(() => { globalThis.__peekCaptureMode = 'slow'; return globalThis.__peekTestRequests.length; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 5000 });
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
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
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
    const before = await app.evaluate((_electron, { status, mode }) => {
      globalThis.__peekModelStatus = status; globalThis.__peekModelMode = mode;
      return globalThis.__peekTestRequests.length;
    }, { status: failure.status, mode: failure.mode });
    await page.waitForTimeout(350);
    await page.locator('#ask').click();
    await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#notice').textContent.length > 0, null, { timeout: 12000 });
    assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), before + 1, failure.mode);
    assert.match(await page.locator('#notice').textContent(), failure.notice);
    assert.doesNotMatch(await page.locator('body').innerText(), /private provider body|private-malformed-provider-body|unexpected error/i);
    await app.evaluate(() => { globalThis.__peekModelStatus = 200; globalThis.__peekModelMode = 'success'; });
    await page.waitForTimeout(350);
    await page.locator('#ask').click();
    await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
    const afterRetry = await app.evaluate(() => globalThis.__peekTestRequests);
    assert.equal(afterRetry.length, before + 2);
    assert.equal(await page.locator('#notice').isVisible(), false);
    assert.equal(await page.locator('#answer').textContent(), '记忆连接叙事与身份。[1]');
    assert.equal(afterRetry.at(-1).messages.some(message => message.role === 'assistant' && String(message.content).includes('incomplete-stream-answer')), false, 'Failed partial answers must not enter conversation history');
  }

  // A failed final speech chunk must not submit the previous transcript as a
  // new question. The visible notice must explain the actual failure.
  const beforeSpeechFailure = await app.evaluate(() => {
    globalThis.__peekTranscriptionStatus = 401;
    return { models: globalThis.__peekTestRequests.length, speech: globalThis.__peekTranscriptionCalls };
  });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#notice').textContent.length > 0, null, { timeout: 12000 });
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
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
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
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeCancel.requests + 1);

  // The entire turn, including speech flush, stops at ten seconds. An aborted
  // fetch and delayed events must not revive the answer or contaminate history.
  await page.evaluate(() => {
    window.__peekLastRequestId = '';
    window.peek.onEvent(event => { if (event.type === 'answer-start') window.__peekLastRequestId = event.requestId; });
  });
  const beforeStall = await app.evaluate(() => { globalThis.__peekModelMode = 'stall'; return globalThis.__peekTestRequests.length; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#notice').textContent.includes('10 秒'), null, { timeout: 12000 });
  const deadlineTiming = Number(await page.locator('#request-state').getAttribute('data-total-ms'));
  assert.ok(deadlineTiming >= 9900 && deadlineTiming < 10_750, `Interaction deadline was ${deadlineTiming}ms`);
  assert.equal(await app.evaluate(() => globalThis.__peekTestRequests.length), beforeStall + 1);
  const abortDeadline = Date.now() + 1000;
  while (!await app.evaluate(() => globalThis.__peekStallAborted) && Date.now() < abortDeadline) await page.waitForTimeout(20);
  assert.equal(await app.evaluate(() => globalThis.__peekStallAborted), true);
  const staleId = await page.evaluate(() => window.__peekLastRequestId);
  assert.ok(staleId);
  await app.evaluate(({ BrowserWindow }, requestId) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    for (const event of [
      { type: 'answer-start', requestId, sources: [], transcript: '' },
      { type: 'answer-delta', requestId, delta: 'stale-timeout-answer' },
      { type: 'answer-warning', requestId, message: 'stale-timeout-warning' },
      { type: 'answer-metadata', requestId, serviceTier: 'stale' },
      { type: 'answer-done', requestId },
    ]) contents.send('peek:event', event);
  }, staleId);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#ask').isEnabled(), true);
  assert.match(await page.locator('#notice').textContent(), /10 秒/);
  assert.doesNotMatch(await page.locator('body').innerText(), /stale-timeout/);
  await app.evaluate(() => { globalThis.__peekModelMode = 'success'; });
  await page.waitForTimeout(350);
  await page.locator('#ask').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled && document.querySelector('#answer').textContent.includes('[1]'), null, { timeout: 12000 });
  const afterStall = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(afterStall.length, beforeStall + 2);
  assert.deepEqual(afterStall.at(-1).messages.slice(0, -1), afterStall.at(-2).messages.slice(0, -1), 'Timed-out request must not enter history');
  assert.equal(await page.locator('#notice').isVisible(), false);
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
  console.log('PASS: key setup, Sol/Astra selection and Fast metadata, gpt-transcribe, standalone WebM, bounded capture fallback, API/network/stream/transcription failures and recovery, cancel, ten-second deadline, and stale-event rejection.');
  console.log('Mocked: OS encryption primitive, capture and API. Real Keychain/DPAPI permissions, paid services, hardware audio and share exclusion need manual verification.');
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
