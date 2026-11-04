import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/main/config';
import { sseData, streamAnswer, transcribeAudio, contextText, systemPrompt } from '../src/main/provider';

function streamed(text: string, size = 3): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } });
}
const config = defaultConfig();
config.chat.apiKeyEnv = config.transcription.apiKeyEnv = 'PEEK_TEST_API_KEY';
process.env.PEEK_TEST_API_KEY = 'test-only-not-a-secret';

test('SSE supports fragmented UTF-8, CRLF, comments, and multi-line data', async () => {
  const values: string[] = [];
  for await (const item of sseData(streamed(': ping\r\ndata: 文学\r\ndata: history\r\n\r\ndata: [DONE]\r\n\r\n', 1))) values.push(item);
  assert.deepEqual(values, ['文学\nhistory', '[DONE]']);
});

test('chat sends multimodal payload in main, streams deltas, and requires a clean finish', async () => {
  let payload: Record<string, unknown> = {};
  const mock: typeof fetch = async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-only-not-a-secret');
    assert.equal(init?.redirect, 'error');
    payload = JSON.parse(String(init?.body));
    return new Response(streamed('data: {"choices":[{"delta":{"content":"关联"}}]}\n\ndata: {"choices":[{"delta":{"content":"[1]"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  };
  const deltas: string[] = [];
  const answer = await streamAnswer(config, [{ role: 'user', content: [{ type: 'text', text: '问题' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }], new AbortController().signal, x => deltas.push(x), mock);
  assert.equal(answer, '关联[1]');
  assert.deepEqual(deltas, ['关联', '[1]']);
  assert.equal(payload.stream, true);
  assert.equal((payload.messages as unknown[]).length, 1);
  await assert.rejects(() => streamAnswer(config, [], new AbortController().signal, () => {}, async () => new Response(streamed('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))), /before the answer completed/);
});

test('API errors do not reflect response bodies; cancellation reaches fetch', async () => {
  await assert.rejects(() => streamAnswer(config, [], new AbortController().signal, () => {}, async () => new Response('private data must not escape', { status: 401 })), error => error instanceof Error && error.message.includes('401') && !error.message.includes('private data'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => streamAnswer(config, [], controller.signal, () => {}, async (_url, init) => { init?.signal?.throwIfAborted(); return new Response(); }), /abort/i);
});

test('audio uses an in-memory multipart Blob with the requested whisper model', async () => {
  const text = await transcribeAudio(config, { data: new Uint8Array([1, 2, 3]).buffer, mimeType: 'audio/webm;codecs=opus', startedAt: 0, endedAt: 5000 }, new AbortController().signal, async (url, init) => {
    assert.match(String(url), /audio\/transcriptions$/);
    const body = init?.body as FormData;
    assert.equal(body.get('model'), 'whisper-1');
    assert.ok(body.get('file') instanceof Blob);
    assert.equal((body.get('file') as Blob).size, 3);
    return Response.json({ text: '文学与记忆' });
  });
  assert.equal(text, '文学与记忆');
});

test('context and prompt keep background separate from cited library evidence', () => {
  assert.match(systemPrompt('zh'), /常识/);
  assert.match(systemPrompt('en'), /Background/);
  assert.match(systemPrompt('en'), /untrusted/);
  assert.match(contextText('', '', [], undefined), /no matching passages/);
});

test('Qwen-compatible chat can use max_tokens instead of max_completion_tokens', async () => {
  const alternate = { ...config, chat: { ...config.chat, tokenLimitParameter: 'max_tokens' as const } };
  await streamAnswer(alternate, [], new AbortController().signal, () => {}, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.max_tokens, 400);
    assert.equal('max_completion_tokens' in payload, false);
    return new Response(streamed('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  });
});

test('SSE rejects one oversized event made of many short data lines', async () => {
  await assert.rejects(async () => {
    for await (const _item of sseData(streamed(('data: ' + 'x'.repeat(1000) + '\n').repeat(1001), 2048))) { /* consume */ }
  }, /size limit/);
});
