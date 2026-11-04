// Ten seconds is a responsiveness target, never an answer cancellation timer.
export const FAST_LIMITS = {
  targetMs: 10_000,
  transcriptMs: 22_000,
  captureMs: 800,
  audioChunkMs: 2_000,
} as const;
