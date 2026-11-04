import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptBuffer } from '../src/main/transcript';

test('rolling transcript uses capture time, expires silence, and rejects late old results', () => {
  let now = 100_000;
  const buffer = new TranscriptBuffer(() => now);
  buffer.add({ startedAt: 50_000, endedAt: 55_000, text: 'older context' });
  buffer.add({ startedAt: 90_000, endedAt: 95_000, text: '当前问题' });
  assert.equal(buffer.recent(30), '当前问题');
  assert.equal(buffer.recent(60), 'older context\n当前问题');
  now = 120_000;
  buffer.add({ startedAt: 50_000, endedAt: 55_000, text: 'late API result' });
  assert.equal(buffer.recent(60), '当前问题');
  now = 156_000;
  buffer.prune();
  assert.equal(buffer.recent(60), '');
});

test('out-of-order transcripts sort chronologically; clear removes all context', () => {
  const buffer = new TranscriptBuffer(() => 100_000);
  buffer.add({ startedAt: 94_000, endedAt: 99_000, text: 'second' });
  buffer.add({ startedAt: 89_000, endedAt: 94_000, text: 'first' });
  assert.equal(buffer.recent(), 'first\nsecond');
  buffer.clear();
  assert.equal(buffer.recent(), '');
});

test('next question excludes prior and boundary-crossing clips without clearing the rolling recording', () => {
  const buffer = new TranscriptBuffer(() => 100_000);
  buffer.add({ startedAt: 80_000, endedAt: 84_000, text: 'abandoned question' });
  buffer.add({ startedAt: 89_000, endedAt: 91_000, text: 'old question tail' });
  buffer.add({ startedAt: 91_000, endedAt: 93_000, text: '下一题的新问题' });
  assert.equal(buffer.recent(30, 90_000), '下一题的新问题');
  buffer.add({ startedAt: 85_000, endedAt: 88_000, text: 'late old transcription' });
  assert.equal(buffer.recent(30, 90_000), '下一题的新问题');
  assert.match(buffer.recent(30), /abandoned question/);
});
