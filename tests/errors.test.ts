import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { operationError } from '../src/main/errors';

test('Electron native string capture rejection gives an actionable screen message', async () => {
  // Electron 30 desktop-capturer.ts calls reject(error: string) from _onerror.
  let message = '';
  try { await Promise.reject('Failed to get sources.'); }
  catch (error) { message = operationError(error, 'capture', 'zh'); }
  assert.match(message, /未能截取屏幕/);
  assert.match(message, /检查.*屏幕录制权限/);
  assert.match(message, /完全退出/);
  assert.doesNotMatch(message, /unexpected|权限已拒绝|permission denied/i);
});

test('cross-realm and serialized errors retain useful status without arbitrary details', () => {
  const foreign = vm.runInNewContext('new Error("API 401. private-provider-body")') as unknown;
  assert.equal(foreign instanceof Error, false);
  for (const error of [foreign, { message: 'API 401. private-provider-body' }, 'API 401. private-provider-body']) {
    const message = operationError(error, 'answer', 'zh');
    assert.match(message, /回答失败（API 401）/);
    assert.match(message, /密钥/);
    assert.doesNotMatch(message, /private-provider-body/);
  }
});

test('transcription and answer API failures identify the operation and remedy', () => {
  assert.match(operationError(new Error('API 429. untrusted'), 'transcription', 'zh'), /语音转写失败.*API 429.*余额/);
  assert.match(operationError(new Error('API 400. untrusted'), 'transcription', 'en'), /Transcription failed.*audio format/);
  assert.match(operationError(new Error('API 400. untrusted'), 'answer', 'en'), /Answer failed.*images/);
  assert.match(operationError(new Error('API 503. untrusted'), 'answer', 'zh'), /暂时不可用/);
  assert.match(operationError(new Error('API 404. untrusted'), 'answer', 'zh'), /API 地址和模型名称/);
});

test('cancellation, timeout, and interrupted streams are not reported as generic errors', () => {
  assert.equal(operationError({ name: 'AbortError' }, 'capture', 'zh'), '截图已停止。');
  assert.match(operationError({ name: 'TimeoutError' }, 'answer', 'en'), /Answer timed out/);
  assert.match(operationError({ code: 'ENOTFOUND' }, 'transcription', 'zh'), /语音转写未能连接 API/);
  assert.match(operationError(new Error('The connection ended before the answer completed. Please retry.'), 'answer', 'zh'), /回答传输中断/);
});

test('unknown failures never echo secrets, paths, submitted context, or hostile getters', () => {
  const privateText = 'sk-test-secret /Users/private/article.md private-transcript';
  const hostile = Object.defineProperty({}, 'message', { get() { throw new Error(privateText); } });
  const failures: unknown[] = [privateText, new Error(privateText), { message: privateText }, null, undefined, 42, hostile];
  for (const failure of failures) {
    for (const stage of ['capture', 'answer', 'transcription'] as const) {
      const message = operationError(failure, stage, 'en');
      assert.ok(message.length > 0);
      assert.doesNotMatch(message, /sk-test-secret|Users|article\.md|private-transcript/);
    }
  }
});
