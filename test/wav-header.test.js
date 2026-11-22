// A single corrupted segment duration used to crash joinExactly deep inside Buffer internals with a cryptic
// RangeError (2026-10-21, see test/segment-duration-sanity.test.js for the session.js-level guard). This exercises
// wavHeader's own guard directly: it should fail with a clear, specific message instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wavHeader } from '../src/media/segment-audio.js';

test('wavHeader writes a normal header for a reasonable size', () => {
  const header = wavHeader(88200); // 1 second of mono 16-bit 44.1kHz
  assert.equal(header.readUInt32LE(40), 88200, 'data chunk size');
  assert.equal(header.readUInt32LE(4), 88200 + 36, 'RIFF chunk size');
});

test('wavHeader rejects a size a 32-bit WAV header cannot address', () => {
  assert.throws(() => wavHeader(26_772_480_024), /exceeds what a standard WAV header can address/);
});

test('wavHeader rejects a negative size', () => {
  assert.throws(() => wavHeader(-1), /exceeds what a standard WAV header can address/);
});
