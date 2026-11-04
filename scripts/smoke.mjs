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
  assert.equal(boot.config.hotkeys.ask, 'Alt+Space');
  assert.equal(boot.chatReady, false); assert.equal(boot.transcriptionReady, false);
  assert.equal('chat' in boot.config, false);
  await assert.rejects(() => page.evaluate(() => window.peek.openSource('../../etc/passwd')), /Invalid|moved|Source/);

  // Only OS encryption, captures, and remote APIs are mocked. UI, IPC, storage
  // and speech sequencing run through the actual Electron application.
  await app.evaluate(({ desktopCapturer, nativeImage, safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => true;
    // Deliberately reversible test double, never used by production code.
    safeStorage.encryptString = plain => Buffer.from(Buffer.from(plain, 'utf8').map(byte => byte ^ 0xa5));
    safeStorage.decryptString = encrypted => Buffer.from(encrypted.map(byte => byte ^ 0xa5)).toString('utf8');
    globalThis.__peekTestRequests = []; globalThis.__peekAudioHeaders = []; globalThis.__peekVerificationCalls = 0;
    desktopCapturer.getSources = async () => [{ id: 'screen:test', name: 'Synthetic', display_id: '', appIcon: null, thumbnail: nativeImage.createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 }) }];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/models')) { globalThis.__peekVerificationCalls++; return Response.json({ data: [{ id: 'gpt-4.1-mini' }] }); }
      if (String(url).endsWith('/audio/transcriptions')) {
        const blob = init.body.get('file');
        globalThis.__peekAudioHeaders.push([...new Uint8Array(await blob.slice(0, 4).arrayBuffer())]);
        return Response.json({ text: '记忆与叙事有什么关联？ Memory and identity.' });
      }
      if (!String(url).endsWith('/chat/completions')) throw new Error('Unexpected test request');
      globalThis.__peekTestRequests.push(JSON.parse(init.body));
      const text = 'data: {"choices":[{"delta":{"content":"记忆连接叙事与身份。"}}]}\n\ndata: {"choices":[{"delta":{"content":"[1]"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
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
  console.log('PASS: sandboxed key setup, encrypted persistence, no key readback, removal, live readiness, voice-first answers/follow-ups/new-topic, and standalone WebM audio.');
  console.log('Mocked: OS encryption primitive, capture and API. Real Keychain/DPAPI permissions, paid services, hardware audio and share exclusion need manual verification.');
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
