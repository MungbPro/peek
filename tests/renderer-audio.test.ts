import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingAudio } from '../src/renderer/audio';

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
