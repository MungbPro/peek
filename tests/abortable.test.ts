import test from 'node:test';
import assert from 'node:assert/strict';
import { abortable } from '../src/main/abortable';

test('deadline releases a wait for an unresponsive native capture', async () => {
  const controller = new AbortController();
  const pending = abortable(new Promise<string>(() => {}), controller.signal);
  controller.abort(new DOMException('deadline', 'TimeoutError'));
  await assert.rejects(pending, { name: 'TimeoutError' });
});

test('late native rejections remain observed after cancellation', async () => {
  const controller = new AbortController();
  let reject!: (reason: unknown) => void;
  const operation = new Promise<string>((_, no) => { reject = no; });
  const pending = abortable(operation, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  reject('native capture failed after the answer was cancelled');
  await new Promise(resolve => setImmediate(resolve));
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(abortable(Promise.reject(new Error('already rejected')), stopped.signal), { name: 'AbortError' });
});
