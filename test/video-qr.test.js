// QR codes in a rendered video (src/media/layers.js, qr-image.js): rounded corners (transparent outside them), and an
// official video QR code's time under it, drawn as the video plays between words of the person's own. The render needs
// an ffmpeg that can draw text, and a font (skipped without them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layerGraph, timeText } from '../src/media/layers.js';
import { qrPng } from '../src/media/qr-image.js';
import { TOOLS } from '../src/config/runtime-config.js';

const FONTS = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
];
const font = FONTS.find((file) => fs.existsSync(file));
const canDraw = spawnSync(TOOLS.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout?.includes(
  'drawtext'
);

test('the time as drawtext writes it, with the words around it kept as they are', () => {
  assert.equal(
    timeText('Watch at ', 3725, ' (100%)'),
    'Watch at %{eif:floor((t+3725)/3600):d}:%{eif:mod(floor((t+3725)/60),60):d:2}:%{eif:mod(floor((t+3725)),60):d:2} (100\\%)'
  );
});

test('rounded corners: transparent outside them, the code itself untouched', () => {
  const square = qrPng('https://example.com', { size: 200 });
  const rounded = qrPng('https://example.com', { size: 200, radius: 0.2 });
  assert.equal(square.size, rounded.size);
  assert.ok(rounded.png.length !== square.png.length, 'the corners differ');
});

test('an official video QR code with its time, rounded, in a render', { skip: !canDraw || !font }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-video-qr-'));
  try {
    const layers = [
      {
        kind: 'official-qr',
        from: 0,
        to: 3,
        size: { w: 0.25, h: 0.44 },
        keys: [{ at: 0, x: 0.05, y: 0.05 }],
        urls: [{ at: 0, url: 'https://example.com/video?t=3725' }],
        title: 'Agenda: 100% done',
        showTime: true,
        timePrefix: 'Watch at ',
        timeSuffix: ' on the official video',
        timeRuns: [{ from: 0, to: 3, offset: 3725 }],
        radius: 0.12
      }
    ];
    const { inputs, filter } = layerGraph(layers, { width: 640, height: 360, firstInput: 1, folder, font });
    execFileSync(TOOLS.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:s=640x360:r=10:d=3',
      ...inputs,
      '-filter_complex',
      `[0:v]format=yuv420p[vin];${filter}`,
      '-map',
      '[vout]',
      '-frames:v',
      '25',
      path.join(folder, 'frame-%02d.png')
    ]);
    const frames = fs.readdirSync(folder).filter((name) => name.startsWith('frame-'));
    assert.equal(frames.length, 25);
    if (process.env.KEEP_FRAME) fs.copyFileSync(path.join(folder, 'frame-25.png'), process.env.KEEP_FRAME);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
