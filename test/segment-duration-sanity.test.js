// A segment's durationSeconds comes straight off its own metadata line (segments.jsonl), unverified. One
// corrupted line reporting a wildly wrong duration used to poison every position after it (src/sessions/session.js
// accumulates forward), eventually overflowing the 32-bit WAV header (src/media/segment-audio.js) and crashing
// a real "Board of Supervisors Meeting" encode job with a RangeError deep in Buffer internals (2026-10-21). Both
// ends are guarded now: a corrupt segment is clamped to the session's typical duration, and wavHeader fails with
// a clear, specific message if a duration genuinely exceeds what a WAV header can address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSessionSegments } from '../src/sessions/session.js';

function makeSession(lines) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-duration-'));
  fs.mkdirSync(path.join(folder, 'segments'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'segments.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  );
  return folder;
}

test('a single corrupted duration does not inflate the whole session', async () => {
  const folder = makeSession([
    { sequence: 1, fileName: '00001.ts', durationSeconds: 10, capturedAt: new Date().toISOString() },
    // The corrupt line: a real failure saw a durationSeconds in the billions of bytes once converted to
    // samples -- here, a smaller but still absurd value, far past any reasonable segment length.
    { sequence: 2, fileName: '00002.ts', durationSeconds: 303543, capturedAt: new Date().toISOString() },
    { sequence: 3, fileName: '00003.ts', durationSeconds: 10, capturedAt: new Date().toISOString() }
  ]);
  try {
    const session = await loadSessionSegments(folder);
    const last = session.retained.at(-1);
    const totalSeconds = last.videoStart + last.durationSeconds;
    // Without the clamp this would be ~303,563s (over 84 hours); with it, three ~10s segments.
    assert.ok(totalSeconds < 60, `total session duration should stay small, got ${totalSeconds}s`);
    assert.equal(session.retained[1].durationSeconds, 10, 'the corrupt segment is clamped to typicalDuration');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a negative duration is also treated as corrupt', async () => {
  const folder = makeSession([
    { sequence: 1, fileName: '00001.ts', durationSeconds: 10, capturedAt: new Date().toISOString() },
    { sequence: 2, fileName: '00002.ts', durationSeconds: -5, capturedAt: new Date().toISOString() }
  ]);
  try {
    const session = await loadSessionSegments(folder);
    assert.equal(session.retained[1].durationSeconds, 10, 'negative duration is clamped to typicalDuration');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
