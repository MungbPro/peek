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

test('audio uses an in-memory WebM multipart Blob with gpt-transcribe and JSON output', async () => {
  const text = await transcribeAudio(config, { data: new Uint8Array([1, 2, 3]).buffer, mimeType: 'audio/webm;codecs=opus', startedAt: 0, endedAt: 5000 }, new AbortController().signal, async (url, init) => {
    assert.match(String(url), /audio\/transcriptions$/);
    const body = init?.body as FormData;
    assert.equal(body.get('model'), 'gpt-transcribe');
    assert.equal(body.get('response_format'), 'json');
    assert.ok(body.get('file') instanceof Blob);
    assert.equal((body.get('file') as Blob).size, 3);
    assert.equal((body.get('file') as File).name, 'chunk.webm');
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
  const alternate = { ...config, model: 'qwen3-vl-plus', chat: { ...config.chat, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tokenLimitParameter: 'max_tokens' as const } };
  await streamAnswer(alternate, [], new AbortController().signal, () => {}, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.max_tokens, 400);
    assert.equal('max_completion_tokens' in payload, false);
    assert.equal('service_tier' in payload, false);
    assert.equal('reasoning_effort' in payload, false);
    return new Response(streamed('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  });
});

for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) {
  test(`${model} requests FAST, low reasoning, and a reasoning-capable completion budget`, async () => {
    const selected = { ...config, model };
    await streamAnswer(selected, [{ role: 'user', content: 'How is memory used here?' }], new AbortController().signal, () => {}, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, model);
      assert.equal(body.service_tier, 'fast');
      assert.equal(body.reasoning_effort, 'low');
      assert.equal(body.max_completion_tokens, 4096);
      for (const unsupported of ['temperature', 'top_p', 'top_logprobs', 'logprobs', 'max_tokens', 'tools']) assert.equal(unsupported in body, false);
      return new Response(streamed('data: {"choices":[{"delta":{"content":"Memory connects the two accounts."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    });
  });
}

test('OpenAI profiles are not sent to other providers or older OpenAI models', async () => {
  for (const selected of [
    { ...config, model: 'gpt-4.1-mini' },
    { ...config, chat: { ...config.chat, baseUrl: 'https://example.com/v1' } },
  ]) {
    await streamAnswer(selected, [], new AbortController().signal, () => {}, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_completion_tokens, 400);
      assert.equal('service_tier' in body, false);
      assert.equal('reasoning_effort' in body, false);
      return new Response(streamed('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    });
  }
});

test('stream metadata reports the actual service tier including downgrades, without assuming FAST', async () => {
  const tiers: string[] = [];
  await streamAnswer(config, [], new AbortController().signal, () => {}, async () => new Response(streamed([
    'data: {"service_tier":"fast","choices":[{"delta":{"content":"A"}}]}',
    'data: {"service_tier":"fast","choices":[]}',
    'data: {"service_tier":"default","choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}',
    'data: [DONE]', '',
  ].join('\n\n'))), metadata => tiers.push(metadata.serviceTier));
  assert.deepEqual(tiers, ['fast', 'default']);
  const missing: string[] = [];
  await streamAnswer(config, [], new AbortController().signal, () => {}, async () => new Response(streamed('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')), metadata => missing.push(metadata.serviceTier));
  assert.deepEqual(missing, []);
});

test('expired requests never call fetch and cancellation stops an idle SSE reader', async () => {
  const alreadyStopped = new AbortController();
  alreadyStopped.abort();
  let fetchCalls = 0;
  const fetcher: typeof fetch = async () => { ++fetchCalls; return new Response(); };
  await assert.rejects(() => streamAnswer(config, [], alreadyStopped.signal, () => {}, fetcher), /abort/i);
  await assert.rejects(() => transcribeAudio(config, { data: new ArrayBuffer(0), mimeType: 'audio/webm', startedAt: 0, endedAt: 0 }, alreadyStopped.signal, fetcher), /abort/i);
  assert.equal(fetchCalls, 0);
  const active = new AbortController();
  let cancelled = false;
  const response = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = streamAnswer(config, [], active.signal, () => {}, async () => new Response(response));
  await new Promise(resolve => setImmediate(resolve));
  active.abort();
  await assert.rejects(() => pending, /abort/i);
  assert.equal(cancelled, true);
});

test('SSE rejects one oversized event made of many short data lines', async () => {
  await assert.rejects(async () => {
    for await (const _item of sseData(streamed(('data: ' + 'x'.repeat(1000) + '\n').repeat(1001), 2048))) { /* consume */ }
  }, /size limit/);
});
