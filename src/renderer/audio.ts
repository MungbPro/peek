type AudioChunk = { data: ArrayBuffer; mimeType: string; startedAt: number; endedAt: number };
type AudioState = 'idle' | 'recording' | 'error';
interface Clip {
  generation: number;
  startedAt: number;
  done: Promise<boolean>;
  settle: (processed: boolean) => void;
}

export interface AudioCallbacks {
  transcribe: (chunk: AudioChunk) => Promise<{ text: string }>;
  status: (state: AudioState, message?: string) => void;
  devices: (devices: MediaDeviceInfo[]) => void;
}
export interface AudioOptions {
  chunkMilliseconds?: number;
  flushTimeoutMilliseconds?: number;
}

/** Each recorder lifetime produces one complete, independently decodable WebM file. */
export class RollingAudio {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private wanted = false;
  private queue: Array<{ chunk: AudioChunk; clip: Clip }> = [];
  private currentClip: Clip | null = null;
  private pendingClips = new Set<Clip>();
  private processing = false;
  private failures = 0;
  private latestError: string | null = null;
  private readonly chunkMilliseconds: number;
  private readonly flushTimeoutMilliseconds: number;

  constructor(private readonly callbacks: AudioCallbacks, options: AudioOptions = {}) {
    this.chunkMilliseconds = options.chunkMilliseconds ?? 5000;
    this.flushTimeoutMilliseconds = options.flushTimeoutMilliseconds ?? 7000;
    if (!Number.isInteger(this.chunkMilliseconds) || this.chunkMilliseconds < 250 || this.chunkMilliseconds > 15_000) throw new Error('Audio chunks must be between 250 and 15,000 milliseconds.');
    if (!Number.isInteger(this.flushTimeoutMilliseconds) || this.flushTimeoutMilliseconds < 1 || this.flushTimeoutMilliseconds > 60_000) throw new Error('Audio flush timeout must be between 1 and 60,000 milliseconds.');
  }

  get active(): boolean { return this.wanted; }
  get lastError(): string | null { return this.latestError; }

  async start(deviceId: string): Promise<void> {
    if (this.wanted) return;
    this.wanted = true;
    const generation = ++this.generation;
    this.failures = 0;
    this.latestError = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      if (!this.wanted || generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (this.wanted && generation === this.generation) this.fail('The audio input disconnected. Reconnect it and start audio again.');
        });
      });
      this.callbacks.status('recording', stream.getAudioTracks()[0]?.label || 'Listening');
      this.record(generation);
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        if (generation === this.generation) this.callbacks.devices(devices.filter((device) => device.kind === 'audioinput'));
      }).catch(() => {});
    } catch (error) {
      if (generation !== this.generation) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.fail(`Audio unavailable: ${detail}`);
    }
  }

  stop(): void {
    this.cleanup();
    this.latestError = null;
    this.callbacks.status('idle', 'Audio paused. The rolling transcript has been cleared.');
  }

  /** Forget waiting clips that ended at or before the next question's boundary.
   * A clip spanning the boundary stays intact. The current recorder, stream,
   * generation and in-flight transcription are deliberately left untouched.
   */
  discardQueuedBefore(cutoff: number): number {
    if (!Number.isFinite(cutoff)) return 0;
    const retained: typeof this.queue = [];
    let discarded = 0;
    for (const item of this.queue) {
      if (item.chunk.endedAt <= cutoff) {
        item.clip.settle(false);
        ++discarded;
      } else retained.push(item);
    }
    this.queue = retained;
    return discarded;
  }

  /** Finish the spoken question now; never wait indefinitely for the network. */
  async flush(): Promise<boolean> {
    const clip = this.currentClip;
    const recorder = this.recorder;
    if (!this.wanted || !this.stream || !clip || !recorder) return false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let minimum: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = async (): Promise<boolean> => {
        // A very short fragment can be rejected by speech services. Keep each
        // complete recorder lifetime at least 250 ms, including hotkey presses.
        const remaining = Math.max(0, 250 - (Date.now() - clip.startedAt));
        if (remaining) await Promise.race([
          new Promise<void>(resolve => { minimum = setTimeout(resolve, remaining); }),
          clip.done,
        ]);
        if (!this.wanted || clip.generation !== this.generation) return false;
        if (recorder.state === 'recording') {
          if (this.recorder === recorder && this.timer) clearTimeout(this.timer);
          recorder.stop();
        }
        return clip.done;
      };
      return await Promise.race([
        ready(),
        new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), this.flushTimeoutMilliseconds); }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (minimum) clearTimeout(minimum);
    }
  }

  private cleanup(): void {
    this.wanted = false;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
    for (const clip of this.pendingClips) clip.settle(false);
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    this.currentClip = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private fail(message: string): void {
    this.cleanup();
    this.latestError = message;
    this.callbacks.status('error', message);
  }

  private record(generation: number): void {
    if (!this.wanted || generation !== this.generation || !this.stream) return;
    try {
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This Chromium build does not support WebM audio recording.');
      const recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 64000 });
      this.recorder = recorder;
      const parts: Blob[] = [];
      const startedAt = Date.now();
      let finish!: (processed: boolean) => void;
      const done = new Promise<boolean>(resolve => { finish = resolve; });
      const clip: Clip = { generation, startedAt, done, settle: processed => {
        this.pendingClips.delete(clip);
        finish(processed);
      } };
      this.pendingClips.add(clip);
      this.currentClip = clip;
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) parts.push(event.data); });
      recorder.addEventListener('error', () => {
        if (generation === this.generation) this.fail('Audio recording failed. Check the input device and try again.');
      });
      recorder.addEventListener('stop', () => {
        if (!this.wanted || generation !== this.generation) { clip.settle(false); return; }
        if (this.recorder === recorder) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = undefined;
          this.recorder = null;
          this.currentClip = null;
        }
        const endedAt = Date.now();
        this.record(generation);
        const blob = new Blob(parts, { type: recorder.mimeType });
        if (blob.size < 100 || endedAt - startedAt < 250) { clip.settle(false); return; }
        void blob.arrayBuffer().then((data) => {
          if (!this.wanted || generation !== this.generation) { clip.settle(false); return; }
          if (this.queue.length >= 2) {
            this.queue.shift()?.clip.settle(false);
            this.callbacks.status('recording', 'Transcription is falling behind; the oldest queued audio was skipped.');
          }
          this.queue.push({ chunk: { data, mimeType: recorder.mimeType, startedAt, endedAt }, clip });
          void this.drain();
        }).catch((error: unknown) => {
          clip.settle(false);
          if (generation === this.generation) this.fail(`Could not read the recorded audio: ${String(error)}`);
        });
      });
      // Do not use start(timeslice): later blobs can lack WebM headers.
      recorder.start();
      this.timer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, this.chunkMilliseconds);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        if (item.clip.generation !== this.generation || !this.wanted) { item.clip.settle(false); continue; }
        try {
          await this.callbacks.transcribe(item.chunk);
          if (item.clip.generation === this.generation && this.wanted) {
            this.failures = 0;
            this.latestError = null;
            this.callbacks.status('recording', this.stream?.getAudioTracks()[0]?.label || 'Listening');
            item.clip.settle(true);
          } else {
            item.clip.settle(false);
          }
        } catch (error) {
          item.clip.settle(false);
          if (item.clip.generation !== this.generation || !this.wanted) continue;
          ++this.failures;
          const detail = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
          this.latestError = detail;
          if (this.failures >= 3) this.fail(`Transcription paused after three failures: ${detail}`);
          else this.callbacks.status('recording', `Transcription failed; retrying with the next chunk. ${detail}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
