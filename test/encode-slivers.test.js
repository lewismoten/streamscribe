// A stretch of video that starts a sliver (2 frames) before a segment ends (src/media/encode.js encodeVideo): x264 into
// MPEG-TS makes nothing of exactly 2 frames, which once failed a whole video; such a sliver now goes into its
// neighbor, and the stretch comes out complete, with every frame in place. Needs ffmpeg (skipped without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSessionSegments } from '../src/sessions/session.js';
import { encodeVideo } from '../src/media/encode.js';
import { TOOLS } from '../src/config/runtime-config.js';

const HAS_FFMPEG = spawnSync(TOOLS.ffmpeg, ['-version']).status === 0;

test('a stretch starting two frames before a segment ends', { skip: !HAS_FFMPEG }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-slivers-'));
  try {
    const session = path.join(folder, 'session');
    fs.mkdirSync(path.join(session, 'segments'), { recursive: true });
    const lines = [];
    for (const sequence of [1, 2]) {
      const name = `00000${sequence}.ts`;
      execFileSync(TOOLS.ffmpeg, [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=s=320x180:r=30:d=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        path.join(session, 'segments', name)
      ]);
      lines.push(
        JSON.stringify({ sequence, fileName: name, durationSeconds: 1, capturedAt: new Date().toISOString() })
      );
    }
    fs.writeFileSync(path.join(session, 'segments.jsonl'), `${lines.join('\n')}\n`);
    const from = 1 - 2 / 30;
    const to = 1.5;
    const output = path.join(folder, 'out.mp4');
    await encodeVideo(session, await loadSessionSegments(session), {
      from,
      to,
      height: 180,
      fps: 30,
      output,
      tempDir: fs.mkdtempSync(path.join(folder, 'work-'))
    });
    const frames = Number(
      execFileSync(
        TOOLS.ffprobe,
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_read_frames',
          '-of',
          'csv=p=0',
          output
        ],
        { encoding: 'utf8' }
      ).trim()
    );
    assert.equal(frames, Math.round((to - from) * 30), 'every frame of the stretch');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
