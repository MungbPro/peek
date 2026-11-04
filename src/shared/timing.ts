// One interaction budget, measured from Answer after listening has started.
export const FAST_LIMITS = {
  turnMs: 10_000,
  transcriptMs: 3_000,
  captureMs: 800,
  audioChunkMs: 2_000,
} as const;
