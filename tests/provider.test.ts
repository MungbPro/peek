import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { defaultConfig } from '../src/main/config';
import { sseData, streamAnswer, transcribeAudio, contextText, systemPrompt } from '../src/main/provider';

class ManualTimers {
  private now = 0;
  private nextId = 0;
  private pending = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = ++this.nextId;
    this.pending.set(id, { at: this.now + milliseconds, callback });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.pending.delete(handle as number); };
  get count(): number { return this.pending.size; }
  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.now = next[1].at;
      this.pending.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}
const drainMicrotasks = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

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

test('chat continues beyond 60 seconds while keepalives, fragmented events, and tokens arrive', async () => {
  const timers = new ManualTimers();
  const caller = new AbortController();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let requestSignal!: AbortSignal;
  const response = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const pending = streamAnswer(config, [], caller.signal, () => {}, async (_url, init) => {
    requestSignal = init!.signal!;
    return new Response(response);
  }, undefined, { timers });
  await drainMicrotasks();
  const send = async (text: string): Promise<void> => {
    body.enqueue(new TextEncoder().encode(text));
    await drainMicrotasks();
  };
  timers.advance(59_000);
  await send(': keepalive\n\n');
  timers.advance(59_000);
  await send('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
  timers.advance(59_000);
  await send('data: {"choices":');
  timers.advance(59_000);
  assert.equal(requestSignal.aborted, false);
  await send('[{"delta":{"content":"B"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  assert.equal(await pending, 'AB');
  assert.equal(timers.count, 0);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  caller.abort();
  assert.equal(requestSignal.aborted, false, 'the completed request must no longer listen to its caller');
});

test('inactivity watchdog aborts a request that never receives response headers', async () => {
  const timers = new ManualTimers();
  const caller = new AbortController();
  let requestSignal!: AbortSignal;
  const pending = streamAnswer(config, [], caller.signal, () => {}, async (_url, init) => {
    requestSignal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    });
  }, undefined, { timers });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  timers.advance(59_999);
  assert.equal(requestSignal.aborted, false);
  timers.advance(1);
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(timers.count, 0);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('inactivity is measured from the latest body bytes and cancels a stalled reader', async () => {
  const timers = new ManualTimers();
  const caller = new AbortController();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let requestSignal!: AbortSignal;
  let cancelled = false;
  const deltas: string[] = [];
  const response = new ReadableStream<Uint8Array>({
    start(controller) { body = controller; }, cancel() { cancelled = true; },
  });
  const pending = streamAnswer(config, [], caller.signal, delta => deltas.push(delta), async (_url, init) => {
    requestSignal = init!.signal!;
    return new Response(response);
  }, undefined, { timers });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await drainMicrotasks();
  timers.advance(59_000);
  body.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
  await drainMicrotasks();
  timers.advance(59_999);
  assert.equal(requestSignal.aborted, false);
  timers.advance(1);
  await rejected;
  assert.equal(cancelled, true);
  assert.deepEqual(deltas, ['partial']);
  assert.equal(timers.count, 0);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('manual stop reaches pending fetch and response reader, and releases the watchdog', async () => {
  for (const stage of ['headers', 'body']) {
    const timers = new ManualTimers();
    const caller = new AbortController();
    let requestSignal!: AbortSignal;
    let cancelled = false;
    const pending = streamAnswer(config, [], caller.signal, () => {}, async (_url, init) => {
      requestSignal = init!.signal!;
      if (stage === 'headers') return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
    }, undefined, { timers });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await drainMicrotasks();
    caller.abort();
    await rejected;
    assert.equal(requestSignal.aborted, true);
    if (stage === 'body') assert.equal(cancelled, true);
    assert.equal(timers.count, 0);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  }
});

test('API errors and malformed streams leave no watchdog or caller abort listener', async () => {
  for (const response of [new Response('private provider body', { status: 401 }), new Response(streamed('data: invalid-json\n\n'))]) {
    const timers = new ManualTimers();
    const caller = new AbortController();
    await assert.rejects(() => streamAnswer(config, [], caller.signal, () => {}, async () => response, undefined, { timers }));
    assert.equal(timers.count, 0);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  }
});
