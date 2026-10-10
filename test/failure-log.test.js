// A failed job's log (src/recorder/failure-log.js, src/util/command-log.js): the job, the agent, the error, what it
// logged, and its last commands with what they said; never over the limit (the oldest lines go first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOST_BYTES, failureLog } from '../src/recorder/failure-log.js';
import { commandsSince, noteCommand } from '../src/util/command-log.js';

test('a failed job’s log', () => {
  const since = Date.now();
  noteCommand('/usr/bin/ffmpeg', ['-i', 'a b.ts', 'out.ts'], {
    code: 0,
    output: 'Output file is empty, nothing was encoded'
  });
  for (let index = 0; index < 20; index += 1) noteCommand('ffprobe', [String(index)], { code: 1, output: 'x' });
  const commands = commandsSince(since);
  assert.equal(commands.length, 12, 'the last 12 only');
  const text = failureLog({
    job: {
      id: 'video-1',
      type: 'video',
      title: 'Video: a meeting',
      items: [{}, {}],
      startedAt: '2026-10-09T22:27:38Z'
    },
    error: new Error('ffmpeg on this agent made an empty piece of video'),
    lines: ['2026-10-09T22:27:40Z  Fetching from Mac'],
    commands: [
      {
        at: new Date().toISOString(),
        seconds: 1.2,
        command: 'ffmpeg -i "a b.ts" out.ts',
        code: 0,
        output: 'Output file is empty'
      }
    ],
    agent: { id: 'pi5-01', name: 'Easy-Peasy-Pi', version: '1.0.0+abc1234' },
    ffmpeg: '6.1.1-3ubuntu5'
  });
  for (const expected of [
    'Video: a meeting (video, video-1)',
    '2 clips',
    'Easy-Peasy-Pi (pi5-01), version 1.0.0+abc1234',
    'ffmpeg 6.1.1',
    'empty piece of video',
    'Fetching from Mac',
    '$ ffmpeg -i "a b.ts" out.ts',
    'Output file is empty'
  ])
    assert.ok(text.includes(expected), expected);

  const huge = failureLog({
    job: { id: 'j', type: 'clip' },
    error: new Error('x'),
    lines: Array.from({ length: 20000 }, (_, index) => `line ${index} ${'.'.repeat(40)}`)
  });
  assert.ok(Buffer.byteLength(huge) <= MOST_BYTES);
  assert.ok(huge.includes('line 19999'), 'the latest lines kept');
  assert.ok(huge.includes('(earlier lines left out)'));
});
