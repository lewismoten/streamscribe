// ffmpeg's loudnorm measurement pass prints a JSON object one key per line to stderr. Capturing it raw made a
// single successful command's output read as many separate, context-free "messages" in a failure log (e.g.
// `"output_tp" : "-1.50",` with no surrounding context) -- compactOutput folds it onto one line instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactOutput } from '../src/util/command-log.js';

test('a loudnorm-style JSON block collapses to one line', () => {
  const raw = `[Parsed_loudnorm_0 @ 0x600001234567] \n{\n\t"input_i" : "-23.00",\n\t"output_tp" : "-1.50",\n\t"normalization_type" : "dynamic"\n}\n`;
  const result = compactOutput(raw);
  assert.ok(!result.includes('\n'), `expected one line, got: ${result}`);
  assert.match(result, /"output_tp":"-1.50"/);
  assert.match(result, /^\[Parsed_loudnorm_0/);
});

test('plain multi-line text without a JSON object is left alone', () => {
  const raw = '[out#0/mpegts @ 0x1] Output file is empty, nothing was encoded\nsecond line of context';
  assert.equal(compactOutput(raw), raw);
});

test('braces that are not a real JSON object are left alone', () => {
  const raw = 'usage: something {a|b|c} more text';
  assert.equal(compactOutput(raw), raw);
});

test('empty output stays empty', () => {
  assert.equal(compactOutput(''), '');
  assert.equal(compactOutput(undefined), '');
});
