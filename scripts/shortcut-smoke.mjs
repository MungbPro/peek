import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Run serially with other Electron smoke tests: global shortcuts belong to the
// desktop session, even when applications have independent userData folders.
const temporary = await mkdtemp(join(tmpdir(), 'peek-shortcut-smoke-'));
const peekData = join(temporary, 'peek');
const fixtureData = join(temporary, 'blocker');
const fixtureMain = join(temporary, 'shortcut-blocker.cjs');
const refusalData = join(temporary, 'simulated-refusal');
const refusalMain = join(temporary, 'simulated-refusal.cjs');
const executablePath = process.env.PEEK_SMOKE_EXECUTABLE ? resolve(process.env.PEEK_SMOKE_EXECUTABLE) : undefined;
const environment = {
  ...process.env,
  PEEK_TEST_USER_DATA: peekData,
  PEEK_SHORTCUT_SMOKE_NO_KEY: '',
  PEEK_DEV_URL: '',
};
delete environment.ELECTRON_RUN_AS_NODE;
let blocker;
let peek;

async function closeOwnedApplication(application) {
  if (!application) return;
  const child = application.process();
  let timeout;
  try {
    await Promise.race([
      application.close(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Electron close timed out')), 5000); }),
    ]);
  } catch {
    // Only terminate the process launched by this test, never another app.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } finally {
    clearTimeout(timeout);
  }
}

async function launchPeek({ simulateRefusal = false } = {}) {
  const application = await electron.launch({
    executablePath: simulateRefusal ? undefined : executablePath,
    args: [...(simulateRefusal ? [refusalMain] : executablePath ? [] : ['.']), '--smoke-test'],
    env: { ...environment, PEEK_TEST_USER_DATA: simulateRefusal ? refusalData : peekData },
    timeout: 20000,
  });
  // Assign immediately so failures while opening the page still clean up.
  peek = application;
  const page = await application.firstWindow();
  await page.waitForFunction(() => typeof window.peek?.bootstrap === 'function');
  await page.waitForFunction(() => document.querySelector('#connect-key')?.textContent === 'Connect OpenAI');
  return { application, page, boot: await page.evaluate(() => window.peek.bootstrap()) };
}

async function nativeBindings(application) {
  return application.evaluate(({ globalShortcut }) => Object.fromEntries([
    'Control+Enter', 'Control+Backspace', 'Alt+Space', 'Alt+H', 'Alt+Enter',
  ].map(accelerator => [accelerator, globalShortcut.isRegistered(accelerator)])));
}

async function assertRefusalVisible({ application, page, boot }) {
  assert.equal(boot.config.hotkeys.ask, '');
  assert.equal(boot.shortcutWarnings.length, 1);
  assert.match(boot.shortcutWarnings[0], /Control\+Enter.*unavailable/);
  assert.match(boot.shortcutWarnings[0], /Peek menu/);
  const warning = page.locator('#shortcut-warning');
  assert.equal(await warning.isVisible(), true);
  const warningText = await warning.textContent();
  assert.match(warningText, /Control\+Enter.*unavailable/);
  assert.equal(await page.locator('#ask-key').textContent(), '');
  // An unrelated notice and a UI language change must not erase the conflict.
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('peek:event', {
      type: 'warning', message: 'Synthetic ordinary notice for shortcut smoke.',
    });
  });
  await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('Synthetic ordinary notice'));
  await page.locator('#language-toggle').click();
  assert.equal(await warning.isVisible(), true);
  assert.equal(await warning.textContent(), warningText);
}

try {
  await mkdir(peekData);
  await mkdir(fixtureData);
  await mkdir(refusalData);
  const legacyConfig = JSON.stringify({
    language: 'en',
    hotkeys: { ask: 'Alt+Space', toggle: 'Alt+H', followUp: 'Alt+Enter' },
    interactionModifiers: ['Alt'],
    chat: { apiKeyEnv: 'PEEK_SHORTCUT_SMOKE_NO_KEY' },
    transcription: { apiKeyEnv: 'PEEK_SHORTCUT_SMOKE_NO_KEY' },
  });
  await writeFile(join(peekData, 'config.json'), legacyConfig);
  await writeFile(join(refusalData, 'config.json'), legacyConfig);
  await writeFile(fixtureMain, `
    const { app, BrowserWindow, globalShortcut } = require('electron');
    app.setName('Peek shortcut smoke blocker');
    app.setPath('userData', ${JSON.stringify(fixtureData)});
    app.whenReady().then(() => {
      app.dock?.hide();
      globalThis.__peekFixtureRegistered = globalShortcut.register('Control+Enter', () => {});
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      window.loadURL('about:blank');
    });
    app.on('before-quit', () => globalShortcut.unregisterAll());
    app.on('window-all-closed', () => app.quit());
  `);
  await writeFile(refusalMain, `
    const { globalShortcut } = require('electron');
    const nativeRegister = globalShortcut.register.bind(globalShortcut);
    globalShortcut.register = (accelerator, callback) => accelerator === 'Control+Enter'
      ? false : nativeRegister(accelerator, callback);
    require(${JSON.stringify(resolve('dist/main.cjs'))});
  `);

  // Always use the development Electron binary for this independent fixture;
  // PEEK_SMOKE_EXECUTABLE selects only the Peek build being tested.
  blocker = await electron.launch({ args: [fixtureMain], env: environment, timeout: 20000 });
  await blocker.firstWindow();
  assert.equal(await blocker.evaluate(() => globalThis.__peekFixtureRegistered), true,
    'The fixture could not reserve Control+Enter. Quit other Peek instances or conflicting apps before this test.');

  const blocked = await launchPeek();
  assert.equal(blocked.boot.chatReady, false);
  assert.equal(blocked.boot.transcriptionReady, false);
  const conflictWasReported = blocked.boot.config.hotkeys.ask === '';
  assert.equal(blocked.boot.config.hotkeys.toggle, 'Control+Backspace');
  assert.equal(blocked.boot.config.hotkeys.followUp, '');
  assert.deepEqual(blocked.boot.config.interactionModifiers, ['Shift']);
  if (conflictWasReported) {
    await assertRefusalVisible(blocked);
    console.log('Native cross-process registration was refused and its warning is visible.');
  } else {
    // Carbon's non-exclusive registration may accept the same shortcut in
    // multiple processes. A successful registration does not prove exclusivity.
    assert.equal(blocked.boot.config.hotkeys.ask, 'Control+Enter');
    assert.deepEqual(blocked.boot.shortcutWarnings, []);
    assert.equal(await blocker.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Enter')), true);
    console.log('OBSERVED LIMITATION: native Electron accepted Control+Enter in both processes; registration success does not establish absence of conflicts.');
  }
  assert.deepEqual(await nativeBindings(blocked.application), {
    'Control+Enter': !conflictWasReported, 'Control+Backspace': true,
    'Alt+Space': false, 'Alt+H': false, 'Alt+Enter': false,
  });

  const saved = JSON.parse(await readFile(join(peekData, 'config.json'), 'utf8'));
  assert.deepEqual(saved.hotkeys, { ask: 'Control+Enter', toggle: 'Control+Backspace', followUp: '' });
  assert.deepEqual(saved.interactionModifiers, ['Shift']);

  assert.equal(await blocked.page.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');
  await closeOwnedApplication(peek);
  peek = undefined;

  await blocker.evaluate(({ globalShortcut }) => globalShortcut.unregisterAll());
  assert.equal(await blocker.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Enter')), false);
  await closeOwnedApplication(blocker);
  blocker = undefined;

  const available = await launchPeek();
  assert.equal(available.boot.config.hotkeys.ask, 'Control+Enter');
  assert.deepEqual(available.boot.shortcutWarnings, []);
  assert.equal(await available.page.locator('#shortcut-warning').isVisible(), false);
  assert.match(await available.page.locator('#ask-key').textContent(), /Control.*Enter/);
  assert.deepEqual(await nativeBindings(available.application), {
    'Control+Enter': true, 'Control+Backspace': true,
    'Alt+Space': false, 'Alt+H': false, 'Alt+Enter': false,
  });
  assert.equal(available.boot.chatReady, false);
  assert.equal(available.boot.transcriptionReady, false);
  assert.equal(await available.page.locator('#audio-toggle').getAttribute('aria-pressed'), 'false');
  await closeOwnedApplication(peek);
  peek = undefined;

  // This separate phase uses the actual built main/renderer/IPC, but injects a
  // register() refusal before startup. It verifies failure UI deterministically
  // even on platforms that permit duplicate registrations. Packaged target
  // registration checks above remain native; this phase runs dev Electron.
  const simulated = await launchPeek({ simulateRefusal: true });
  await assertRefusalVisible(simulated);
  assert.deepEqual(await nativeBindings(simulated.application), {
    'Control+Enter': false, 'Control+Backspace': true,
    'Alt+Space': false, 'Alt+H': false, 'Alt+Enter': false,
  });
  assert.deepEqual(JSON.parse(await readFile(join(refusalData, 'config.json'), 'utf8')).hotkeys,
    { ask: 'Control+Enter', toggle: 'Control+Backspace', followUp: '' });
  console.log('PASS: native registration checks, saved legacy migration, no Option bindings, and successful registration after releasing the fixture.');
  console.log('PASS (SIMULATED register refusal): disabled shortcut hint and persistent failure warning in the actual built main/renderer.');
  console.log('No system key events, API calls, audio recording, or screen captures were requested.');
} finally {
  await closeOwnedApplication(peek);
  await closeOwnedApplication(blocker);
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
