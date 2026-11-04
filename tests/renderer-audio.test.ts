import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingAudio, type AudioOptions } from '../src/renderer/audio';

test('audio uses complete recordings, bounds its queue, and drops in-flight results after pause', async () => {
  const descriptors = ['navigator', 'MediaRecorder', 'setTimeout', 'clearTimeout'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const realNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let stoppedTracks = 0;
  const recorders: FakeRecorder[] = [];
  const track = new EventTarget() as EventTarget & { label: string; stop(): void };
  track.label = 'Test input';
  track.stop = () => { stoppedTracks++; };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

  class FakeRecorder extends EventTarget {
    static isTypeSupported(type: string): boolean { return type === 'audio/webm;codecs=opus'; }
    readonly index = recorders.length;
    readonly mimeType = 'audio/webm;codecs=opus';
    state = 'inactive';
    constructor() { super(); recorders.push(this); }
    start(timeslice?: number): void {
      assert.equal(timeslice, undefined, 'each chunk must be a recorder lifetime, not a timeslice');
      this.state = 'recording';
    }
    stop(): void {
      this.state = 'inactive';
      const data = new Event('dataavailable') as Event & { data: Blob };
      data.data = new Blob([`WEBM-HEADER-${this.index}:` + 'sample '.repeat(30)], { type: this.mimeType });
      this.dispatchEvent(data);
      this.dispatchEvent(new Event('stop'));
    }
  }

  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
    assert.deepEqual((constraints.audio as MediaTrackConstraints).deviceId, { exact: 'test-device' });
    return stream;
  }, enumerateDevices: async () => [] } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeRecorder });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void, duration: number) => {
    assert.equal(duration, 5000);
    timers.set(++timerId, callback);
    return timerId;
  } });
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: (id: number) => { timers.delete(id); } });

  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const tick = async () => {
    const [id, callback] = timers.entries().next().value!;
    timers.delete(id);
    now += 5000;
    callback();
    await flush();
  };
  const requests: string[] = [];
  const pending: Array<() => void> = [];
  const statuses: Array<{ state: string; message?: string }> = [];
  const audio = new RollingAudio({
    transcribe: async (chunk) => {
      assert.equal(chunk.endedAt - chunk.startedAt, 5000);
      requests.push(new TextDecoder().decode(chunk.data));
      await new Promise<void>((resolve) => pending.push(resolve));
      return { text: 'test' };
    },
    status: (state, message) => { statuses.push({ state, message }); },
    devices: () => {},
  });

  try {
    await audio.start('test-device');
    assert.equal(audio.active, true);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(recorders.length, 6, 'the next independent recorder starts immediately');
    assert.equal(requests.length, 1, 'uploads are serial');
    assert.match(requests[0], /^WEBM-HEADER-0:/);
    assert.ok(statuses.some((status) => status.message?.includes('oldest queued audio was skipped')));
    pending.shift()!();
    await flush();
    assert.equal(requests.length, 2);
    assert.match(requests[1], /^WEBM-HEADER-3:/, 'only the two latest waiting recordings survive');
    audio.stop();
    assert.equal(audio.active, false);
    assert.equal(stoppedTracks, 1);
    assert.equal(timers.size, 0);
    pending.shift()!();
    await flush();
    assert.equal(requests.length, 2, 'pause clears queued audio');
    assert.equal(statuses.at(-1)?.state, 'idle', 'stale transcription does not change paused state');
  } finally {
    if (audio.active) audio.stop();
    Date.now = realNow;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('pausing while microphone permission is pending releases the eventual stream', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let grant!: (stream: unknown) => void;
  let released = 0;
  const statuses: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) },
  } });
  const audio = new RollingAudio({
    transcribe: async () => { throw new Error('No recording should start'); },
    status: (state) => { statuses.push(state); },
    devices: () => {},
  });
  try {
    const starting = audio.start('');
    audio.stop();
    grant({ getTracks: () => [{ stop: () => { released++; } }] });
    await starting;
    assert.equal(audio.active, false);
    assert.equal(released, 1);
    assert.deepEqual(statuses, ['idle']);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

interface FlushHarness {
  audio: RollingAudio;
  calls: Array<{ duration: number; header: string }>;
  advance(milliseconds: number): Promise<void>;
  settleRequest(success?: boolean, message?: string): Promise<void>;
  recorderCount(): number;
}

async function withFlushHarness(run: (harness: FlushHarness) => Promise<void>, options: AudioOptions = {}): Promise<void> {
  const names = ['navigator', 'MediaRecorder', 'setTimeout', 'clearTimeout'];
  const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const originalNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: FlushHarness['calls'] = [];
  const pending: Array<{ resolve: () => void; reject: (message?: string) => void }> = [];
  let recorderCount = 0;
  const track = new EventTarget() as EventTarget & { label: string; stop(): void };
  track.label = 'Synthetic microphone'; track.stop = () => {};
  class Recorder extends EventTarget {
    static isTypeSupported(): boolean { return true; }
    readonly mimeType = 'audio/webm;codecs=opus';
    readonly index = recorderCount++;
    state = 'inactive';
    start(timeslice?: number): void { assert.equal(timeslice, undefined); this.state = 'recording'; }
    stop(): void {
      this.state = 'inactive';
      const event = new Event('dataavailable') as Event & { data: Blob };
      event.data = new Blob([`INDEPENDENT-WEBM-${this.index}:` + 'audio '.repeat(40)]);
      this.dispatchEvent(event); this.dispatchEvent(new Event('stop'));
    }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }), enumerateDevices: async () => [],
  } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void, milliseconds: number) => {
    const id = ++nextTimer; timers.set(id, { at: now + milliseconds, callback }); return id;
  } });
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: (id: number) => timers.delete(id) });
  const microtasks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  const audio = new RollingAudio({
    transcribe: async chunk => {
      calls.push({ duration: chunk.endedAt - chunk.startedAt, header: new TextDecoder().decode(chunk.data) });
      await new Promise<void>((resolve, reject) => pending.push({ resolve, reject: message => reject(new Error(message ?? 'Synthetic network failure')) }));
      return { text: 'spoken question' };
    }, status: () => {}, devices: () => {},
  }, options);
  try {
    await run({
      audio, calls, recorderCount: () => recorderCount,
      advance: async milliseconds => {
        const target = now + milliseconds;
        while (true) {
          const candidate = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
          if (!candidate) break;
          const [id, timer] = candidate; now = timer.at; timers.delete(id); timer.callback(); await microtasks();
        }
        now = target; await microtasks();
      },
      settleRequest: async (success = true, message?: string) => {
        const request = pending.shift(); assert.ok(request, 'a transcription request must be in flight');
        if (success) request.resolve(); else request.reject(message);
        await microtasks();
      },
    });
  } finally {
    audio.stop();
    for (const request of pending) request.resolve();
    await microtasks();
    Date.now = originalNow;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test('flush captures the newest partial recording and waits for its transcription', async () => {
  await withFlushHarness(async ({ audio, advance, calls, settleRequest, recorderCount }) => {
    await audio.start('');
    await advance(800);
    let finished = false;
    const flushing = audio.flush().then(value => { finished = true; return value; });
    await advance(0);
    assert.equal(finished, false);
    assert.equal(calls[0]?.duration, 800);
    assert.match(calls[0]?.header, /^INDEPENDENT-WEBM-0:/);
    assert.equal(recorderCount(), 2, 'recording continues immediately in a new complete file');
    await settleRequest();
    assert.equal(await flushing, true);
    assert.equal(audio.active, true);
  });
});

test('flush enforces a minimum fragment and returns false after seven seconds of network delay', async () => {
  await withFlushHarness(async ({ audio, advance, calls }) => {
    await audio.start('');
    const flushing = audio.flush();
    await advance(249);
    assert.equal(calls.length, 0);
    await advance(1);
    assert.equal(calls[0]?.duration, 250);
    await advance(6750);
    assert.equal(await flushing, false);
    assert.equal(audio.active, true, 'a slow transcription does not stop capture');
  });
});

test('stop and failed transcription resolve flush as false without waiting for its deadline', async () => {
  await withFlushHarness(async ({ audio, advance, settleRequest }) => {
    await audio.start('');
    await advance(400);
    const failed = audio.flush(); await advance(0);
    await settleRequest(false);
    assert.equal(await failed, false);
    await advance(400);
    const stopped = audio.flush(); await advance(0);
    audio.stop();
    assert.equal(await stopped, false);
    await settleRequest();
    assert.equal(audio.active, false);
  });
});

test('latest transcription failure stays actionable until success, pause, or restart', async () => {
  await withFlushHarness(async ({ audio, advance, settleRequest }) => {
    await audio.start('');
    assert.equal(audio.lastError, null);
    await advance(400);
    const failed = audio.flush(); await advance(0);
    await settleRequest(false, "Error invoking remote method 'peek:transcribe': Error: 语音转写失败（API 401）。请检查密钥。");
    assert.equal(await failed, false);
    assert.equal(audio.lastError, '语音转写失败（API 401）。请检查密钥。');
    assert.equal(audio.active, true);

    await advance(400);
    const recovered = audio.flush(); await advance(0);
    await settleRequest();
    assert.equal(await recovered, true);
    assert.equal(audio.lastError, null);

    for (let i = 0; i < 3; i++) {
      await advance(400);
      const failing = audio.flush(); await advance(0);
      await settleRequest(false);
      assert.equal(await failing, false);
      assert.match(audio.lastError!, /Synthetic network failure/);
    }
    assert.equal(audio.active, false, 'three consecutive errors pause recording');
    await audio.start('');
    assert.equal(audio.lastError, null, 'a fresh start clears the prior failure');
    await advance(400);
    const failedAgain = audio.flush(); await advance(0);
    await settleRequest(false);
    assert.equal(await failedAgain, false);
    audio.stop();
    assert.equal(audio.lastError, null, 'explicit pause clears the prior failure');
  });
});

test('fast audio uses complete two-second chunks and bounds a fresh flush to three seconds', async () => {
  await withFlushHarness(async ({ audio, advance, calls, settleRequest, recorderCount }) => {
    await audio.start('');
    await advance(1999);
    assert.equal(calls.length, 0);
    await advance(1);
    assert.equal(calls[0]?.duration, 2000);
    assert.equal(recorderCount(), 2);
    await settleRequest();

    await advance(500);
    let settled: boolean | undefined;
    const pending = audio.flush().then(value => { settled = value; return value; });
    await advance(0);
    assert.equal(calls[1]?.duration, 500);
    await advance(2999);
    assert.equal(settled, undefined, 'a previous completed transcript must not satisfy this flush');
    await advance(1);
    assert.equal(await pending, false);
    assert.equal(audio.active, true);
    await settleRequest();
    assert.equal(settled, false, 'a late transcription cannot change the already timed-out result');
  }, { chunkMilliseconds: 2000, flushTimeoutMilliseconds: 3000 });
});
