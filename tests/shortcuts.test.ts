import test from 'node:test';
import assert from 'node:assert/strict';
import { registerShortcuts, type ShortcutName } from '../src/main/shortcuts';

test('disabled follow-up never registers; accepted controls invoke their corresponding action', () => {
  const callbacks = new Map<string, () => void>();
  const triggered: ShortcutName[] = [];
  const result = registerShortcuts(
    { ask: 'Control+Enter', toggle: 'Control+Backspace', followUp: '' },
    (accelerator, callback) => { callbacks.set(accelerator, callback); return true; },
    name => triggered.push(name),
  );
  assert.deepEqual([...callbacks.keys()], ['Control+Enter', 'Control+Backspace']);
  callbacks.get('Control+Enter')!();
  callbacks.get('Control+Backspace')!();
  assert.deepEqual(triggered, ['ask', 'toggle']);
  assert.deepEqual(result.activeHotkeys, { ask: 'Control+Enter', toggle: 'Control+Backspace', followUp: '' });
  assert.deepEqual(result.failures, []);
});

test('OS conflicts and invalid bindings are not advertised as active and do not block other controls', () => {
  const attempted: string[] = [];
  const result = registerShortcuts(
    { ask: 'Control+Enter', toggle: 'InvalidKey', followUp: 'F10' },
    accelerator => {
      attempted.push(accelerator);
      if (accelerator === 'InvalidKey') throw new Error('Invalid accelerator');
      return accelerator === 'F10';
    },
    () => {},
  );
  assert.deepEqual(attempted, ['Control+Enter', 'InvalidKey', 'F10']);
  assert.deepEqual(result.activeHotkeys, { ask: '', toggle: '', followUp: 'F10' });
  assert.deepEqual(result.failures, [
    { name: 'ask', accelerator: 'Control+Enter', reason: 'unavailable' },
    { name: 'toggle', accelerator: 'InvalidKey', reason: 'invalid' },
  ]);
});
