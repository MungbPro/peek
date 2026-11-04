import type { PublicConfig } from '../shared/types';

export type ShortcutName = keyof PublicConfig['hotkeys'];
export interface ShortcutFailure {
  name: ShortcutName;
  accelerator: string;
  reason: 'unavailable' | 'invalid';
}
export interface ShortcutRegistration {
  activeHotkeys: PublicConfig['hotkeys'];
  failures: ShortcutFailure[];
}

/** Only advertise bindings the OS accepted. Never silently choose another key. */
export function registerShortcuts(
  hotkeys: PublicConfig['hotkeys'],
  register: (accelerator: string, callback: () => void) => boolean,
  onTrigger: (name: ShortcutName) => void,
): ShortcutRegistration {
  const activeHotkeys = { ask: '', toggle: '', followUp: '' };
  const failures: ShortcutFailure[] = [];
  for (const name of ['ask', 'toggle', 'followUp'] as const) {
    const accelerator = hotkeys[name];
    if (!accelerator) continue;
    try {
      if (register(accelerator, () => onTrigger(name))) activeHotkeys[name] = accelerator;
      else failures.push({ name, accelerator, reason: 'unavailable' });
    } catch {
      failures.push({ name, accelerator, reason: 'invalid' });
    }
  }
  return { activeHotkeys, failures };
}
