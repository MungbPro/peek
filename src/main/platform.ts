import type { App, BrowserWindow } from 'electron';
import { safeStorage } from 'electron';
import type { EncryptionBackend } from './credentials';

/** Refuse unsupported/plaintext backends; never downgrade credential storage. */
export function credentialEncryptionBackend(): EncryptionBackend {
  return {
    isEncryptionAvailable: () => (process.platform === 'darwin' || process.platform === 'win32') && safeStorage.isEncryptionAvailable(),
    encryptString: value => safeStorage.encryptString(value),
    decryptString: value => safeStorage.decryptString(value),
  };
}

export function platformDefaults(): { interactionModifiers: string[]; primaryShortcutModifier: string } {
  return process.platform === 'darwin'
    ? { interactionModifiers: ['Alt'], primaryShortcutModifier: 'Command' }
    : { interactionModifiers: ['Alt'], primaryShortcutModifier: 'Control' };
}

export function getPlatformPermissionHelp(): string {
  return process.platform === 'darwin'
    ? 'In System Settings → Privacy & Security, allow Microphone and Screen Recording for Electron/Peek, then restart Peek. Input Monitoring may be needed if your macOS configuration blocks modifier detection.'
    : 'Allow microphone access for desktop apps in Windows Privacy & security settings. Check that your selected recording device is enabled.';
}

/** Keep native library names and platform-specific window behavior here. */
export function configureApplication(app: App): void {
  app.setName('Peek');
  if (process.platform === 'darwin') app.dock?.hide();
}

export function getConfigDirectory(app: App): string {
  return app.getPath('userData');
}

export function configureOverlay(win: BrowserWindow): void {
  win.setAlwaysOnTop(true, 'floating');
  win.setSkipTaskbar(true);
  win.setMenuBarVisibility(false);
  win.setIgnoreMouseEvents(true, { forward: true });

  // Electron 30 calls SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on
  // Windows. A second FFI invocation would only duplicate that native call.
  // On macOS this is NSWindowSharingNone; ScreenCaptureKit can still capture it.
  win.setContentProtection(true);
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
}

type Modifier = 'command' | 'control' | 'alt' | 'shift';

function normalizeModifier(value: string): Modifier {
  const normalized = value.toLowerCase().replace(/\s/g, '');
  switch (normalized) {
    case 'cmd':
    case 'command':
    case 'super':
    case 'meta': return 'command';
    case 'cmdorctrl':
    case 'commandorcontrol': return process.platform === 'darwin' ? 'command' : 'control';
    case 'ctrl':
    case 'control': return 'control';
    case 'option':
    case 'alt': return 'alt';
    case 'shift': return 'shift';
    default: throw new Error(`Unsupported interaction modifier: ${value}. Use Command, Control, Alt, or Shift.`);
  }
}

function makeModifierReader(modifiers: Modifier[]): () => boolean {
  // Lazy load so a missing/wrong-architecture addon produces an actionable
  // startup warning through the caller instead of preventing the app opening.
  const koffi: typeof import('koffi') = require('koffi');
  if (process.platform === 'darwin') {
    const coreGraphics = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const flagsState = coreGraphics.func('uint64_t CGEventSourceFlagsState(int stateID)');
    const masks: Record<Modifier, number> = {
      shift: 1 << 17,
      control: 1 << 18,
      alt: 1 << 19,
      command: 1 << 20,
    };
    const wanted = modifiers.reduce((mask, modifier) => mask | masks[modifier], 0);
    // Poll only modifier flags from the combined session, never key events or text.
    return () => (Number(flagsState(0)) & wanted) === wanted;
  }

  if (process.platform === 'win32') {
    const user32 = koffi.load('user32.dll');
    const asyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    const keys: Record<Modifier, number[]> = {
      shift: [0x10], control: [0x11], alt: [0x12], command: [0x5b, 0x5c],
    };
    return () => modifiers.every((modifier) => keys[modifier].some((key) => (Number(asyncKeyState(key)) & 0x8000) !== 0));
  }

  throw new Error('Hold-to-interact is supported on macOS and Windows only.');
}

/**
 * Mouse passthrough returns immediately after modifiers are released. Keyboard
 * focus is deliberately retained if the user clicked a text field: they can
 * release the modifiers and type normally. The caller should blur on Escape.
 * No focus is stolen merely because modifiers were pressed in another app.
 */
export function startModifierMonitor(
  win: BrowserWindow,
  modifiers: string[],
  onChange: (active: boolean) => void,
): () => void {
  if (modifiers.length === 0) throw new Error('Configure at least one interaction modifier.');
  win.setIgnoreMouseEvents(true, { forward: true });

  let readModifiers: () => boolean;
  try {
    readModifiers = makeModifierReader([...new Set(modifiers.map(normalizeModifier))]);
    readModifiers(); // Fail during startup, not in an unhandled timer callback.
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Hold-to-interact could not start: ${message}. Reinstall dependencies for this machine's architecture.`);
  }

  let active = false;
  let stopped = false;
  const tick = (): void => {
    if (stopped || win.isDestroyed()) return;
    const held = readModifiers();
    if (held === active) return;
    active = held;
    win.setIgnoreMouseEvents(!active, { forward: true });
    onChange(active);
  };
  const timer = setInterval(() => {
    try {
      tick();
    } catch (error) {
      // If native state becomes unavailable, fail closed to mouse passthrough.
      clearInterval(timer);
      stopped = true;
      if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
      if (active) onChange(false);
      console.warn('Peek modifier monitoring stopped. Restart Peek to retry.', error instanceof Error ? error.message : String(error));
    }
  }, 60);
  timer.unref();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
    if (active) onChange(false);
  };
}
