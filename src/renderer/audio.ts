type AudioChunk = { data: ArrayBuffer; mimeType: string; startedAt: number; endedAt: number };
type AudioState = 'idle' | 'recording' | 'error';

export interface AudioCallbacks {
  transcribe: (chunk: AudioChunk) => Promise<{ text: string }>;
  status: (state: AudioState, message?: string) => void;
  devices: (devices: MediaDeviceInfo[]) => void;
}

/** Each recorder lifetime produces one complete, independently decodable WebM file. */
export class RollingAudio {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private wanted = false;
  private queue: Array<{ chunk: AudioChunk; generation: number }> = [];
  private processing = false;
  private failures = 0;

  constructor(private readonly callbacks: AudioCallbacks) {}

  get active(): boolean { return this.wanted; }

  async start(deviceId: string): Promise<void> {
    if (this.wanted) return;
    this.wanted = true;
    const generation = ++this.generation;
    this.failures = 0;
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
    this.callbacks.status('idle', 'Audio paused. The rolling transcript has been cleared.');
  }

  private cleanup(): void {
    this.wanted = false;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private fail(message: string): void {
    this.cleanup();
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
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) parts.push(event.data); });
      recorder.addEventListener('error', () => {
        if (generation === this.generation) this.fail('Audio recording failed. Check the input device and try again.');
      });
      recorder.addEventListener('stop', () => {
        if (!this.wanted || generation !== this.generation) return;
        const endedAt = Date.now();
        this.record(generation);
        const blob = new Blob(parts, { type: recorder.mimeType });
        if (blob.size < 100 || endedAt - startedAt < 1000) return;
        void blob.arrayBuffer().then((data) => {
          if (!this.wanted || generation !== this.generation) return;
          if (this.queue.length >= 2) {
            this.queue.shift();
            this.callbacks.status('recording', 'Transcription is falling behind; the oldest queued audio was skipped.');
          }
          this.queue.push({ chunk: { data, mimeType: recorder.mimeType, startedAt, endedAt }, generation });
          void this.drain();
        }).catch((error: unknown) => {
          if (generation === this.generation) this.fail(`Could not read the recorded audio: ${String(error)}`);
        });
      });
      // Do not use start(5000): later timeslice blobs can lack WebM headers.
      recorder.start();
      this.timer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 5000);
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
        if (item.generation !== this.generation || !this.wanted) continue;
        try {
          await this.callbacks.transcribe(item.chunk);
          if (item.generation === this.generation) {
            this.failures = 0;
            this.callbacks.status('recording', this.stream?.getAudioTracks()[0]?.label || 'Listening');
          }
        } catch (error) {
          if (item.generation !== this.generation || !this.wanted) continue;
          ++this.failures;
          const detail = error instanceof Error ? error.message : String(error);
          if (this.failures >= 3) this.fail(`Transcription paused after three failures: ${detail}`);
          else this.callbacks.status('recording', `Transcription failed; retrying with the next chunk. ${detail}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
