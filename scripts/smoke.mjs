import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'peek-smoke-'));
let app;
try {
  const vault = join(temporary, 'vault');
  await mkdir(join(vault, '文学'), { recursive: true });
  await writeFile(join(vault, '文学', 'memory.md'), '# 记忆与叙事\n\nMemory links literature and identity.\n');
  await writeFile(join(temporary, 'config.json'), JSON.stringify({ libraryPath: vault, chat: { apiKeyEnv: 'PEEK_SMOKE_NO_KEY' }, transcription: { apiKeyEnv: 'PEEK_SMOKE_NO_KEY' } }));
  app = await electron.launch({ args: ['.', '--smoke-test', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env: { ...process.env, PEEK_TEST_USER_DATA: temporary, PEEK_SMOKE_NO_KEY: '', PEEK_DEV_URL: '' } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#focus-article')?.textContent?.includes('记忆与叙事'));
  const info = await app.evaluate(({ BrowserWindow, app }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const prefs = win.webContents.getLastWebPreferences();
    return { name: app.getName(), bounds: win.getBounds(), alwaysOnTop: win.isAlwaysOnTop(), frame: prefs.nodeIntegration, sandbox: prefs.sandbox, isolation: prefs.contextIsolation };
  });
  assert.equal(info.name, 'Peek');
  assert.equal(info.bounds.width, 420); assert.equal(info.bounds.height, 520);
  assert.equal(info.alwaysOnTop, true); assert.equal(info.frame, false);
  assert.equal(info.sandbox, true); assert.equal(info.isolation, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  const boot = await page.evaluate(() => window.peek.bootstrap());
  assert.equal(boot.config.language, 'zh'); assert.equal(boot.library.documents.length, 1);
  assert.equal(boot.chatReady, false); assert.equal(boot.transcriptionReady, false);
  assert.equal('chat' in boot.config, false);
  assert.equal(await page.locator('#ask').isDisabled(), true);
  await page.locator('#language-toggle').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('#focus-article').selectOption(boot.library.documents[0].id);
  await assert.rejects(() => page.evaluate(() => window.peek.openSource('../../etc/passwd')), /Invalid|moved|Source/);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: resolve('artifacts/peek-smoke-en.png') });
  await page.locator('#language-toggle').click();
  await page.screenshot({ path: resolve('artifacts/peek-smoke-zh.png') });
  // Exercise real main/preload/renderer wiring with synthetic capture and model
  // responses. No actual desktop image or audio leaves this process.
  await app.evaluate(({ desktopCapturer, nativeImage }) => {
    process.env.PEEK_SMOKE_NO_KEY = 'synthetic-test-key';
    globalThis.__peekTestRequests = [];
    desktopCapturer.getSources = async () => [{ id: 'screen:test', name: 'Synthetic', display_id: '', appIcon: null, thumbnail: nativeImage.createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 }) }];
    globalThis.fetch = async (_url, init) => {
      globalThis.__peekTestRequests.push(JSON.parse(init.body));
      const text = 'data: {"choices":[{"delta":{"content":"记忆连接叙事与身份。"}}]}\n\ndata: {"choices":[{"delta":{"content":"[1]"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }));
    };
  });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
  await page.locator('#focus-article').selectOption(boot.library.documents[0].id);
  await page.locator('#intent').fill('记忆与叙事如何关联？');
  await page.locator('#ask').click();
  await page.waitForFunction(() => document.querySelector('#answer').textContent.includes('[1]') && !document.querySelector('#follow-up').disabled, null, { timeout: 10000 }).catch(async error => { throw new Error(error.message + ' UI: ' + await page.locator('body').innerText()); });
  assert.match(await page.locator('#sources').textContent(), /\[1\].*记忆与叙事/);
  await page.locator('#intent').fill('Give another connection.');
  await page.locator('#follow-up').click();
  await page.waitForFunction(() => !document.querySelector('#ask').disabled);
  const requests = await app.evaluate(() => globalThis.__peekTestRequests);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.at(-1).content[1].type, 'image_url');
  assert.match(requests[0].messages.at(-1).content[0].text, /Memory links literature/);
  assert.equal(requests[1].messages.filter(m => m.role === 'assistant').length, 1);
  assert.match(requests[1].messages.find(m => m.role === 'assistant').content, /memory.md/);
  // A real Chromium MediaRecorder gets a fake browser microphone, not hardware.
  const media = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const sizes = [];
    for (let i = 0; i < 2; i++) {
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      const blob = await new Promise(resolve => {
        recorder.ondataavailable = event => resolve(event.data);
        recorder.start(); setTimeout(() => recorder.stop(), 150);
      });
      const prefix = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      sizes.push({ size: blob.size, header: [...prefix] });
    }
    stream.getTracks().forEach(track => track.stop());
    return sizes;
  });
  for (const chunk of media) { assert.ok(chunk.size > 100); assert.deepEqual(chunk.header, [0x1a, 0x45, 0xdf, 0xa3]); }
  await page.screenshot({ path: resolve('artifacts/peek-smoke-answer.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: actual Electron overlay, preload isolation, bilingual UI, vault loading, IPC validation, mocked screenshot-to-stream answer/follow-up, and complete Chromium WebM files.');
  console.log('Not exercised: paid APIs, real microphone, Screen Recording, share exclusion, Intel hardware.');
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
