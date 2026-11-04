export interface TranscriptSegment { startedAt: number; endedAt: number; text: string }

/** Raw transcripts have a strict wall-clock TTL even when no question is asked. */
export class TranscriptBuffer {
  private segments: TranscriptSegment[] = [];
  constructor(private readonly clock = Date.now) {}
  add(segment: TranscriptSegment): void {
    this.prune();
    if (segment.endedAt <= this.clock() - 60_000 || segment.startedAt > this.clock() || !segment.text.trim()) return;
    this.segments.push({ ...segment, text: segment.text.trim().slice(0, 8000) });
    this.segments.sort((a, b) => a.endedAt - b.endedAt);
    this.segments = this.segments.slice(-24);
  }
  prune(): void { this.segments = this.segments.filter(s => s.endedAt > this.clock() - 60_000); }
  recent(seconds = 30, since = 0): string {
    this.prune();
    return this.segments.filter(s => s.startedAt >= since && s.endedAt > this.clock() - Math.min(60, Math.max(0, seconds)) * 1000)
      .map(s => s.text).join('\n').slice(-24000);
  }
  clear(): void { this.segments = []; }
}
