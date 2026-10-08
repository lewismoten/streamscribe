import fs from 'fs';
import { spawn } from 'child_process';
import { TOOLS } from '../../config/runtime-config.js';

// Single frames from captured segments, and comparing pictures.

// The retained segment containing a video position, or null when that moment was missed or discarded.
export function findSegment(retained, position) {
  let low = 0;
  let high = retained.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (retained[middle].videoStart <= position) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const segment = retained[low];
  return position >= segment.videoStart && position < segment.videoStart + segment.durationSeconds ? segment : null;
}

// Input seeking (-ss before -i) without accurate seek lands on the keyframe at or before the offset, so only
// one frame is decoded; `accurate` decodes on to the exact frame (for camera cuts, which fall between keyframes).
// Returns false when the segment can't be read (for example, a missing file).
export function extractThumbnail(segmentPath, offsetSeconds, outputPath, width, accurate = false) {
  return new Promise((resolve) => {
    const child = spawn(TOOLS.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      // Exact: decode the (10-second) segment from its start up to the moment; seeking ahead of decoding can find no
      // frames near the end of a piece cut from the archive, which keeps its original timestamps.
      ...(accurate
        ? ['-i', segmentPath, '-ss', Math.max(0, offsetSeconds).toFixed(3)]
        : ['-noaccurate_seek', '-ss', Math.max(0, offsetSeconds).toFixed(3), '-i', segmentPath]),
      '-frames:v', '1', '-an', '-vf', `scale=${width}:-2:flags=fast_bilinear`, '-q:v', '5',
      outputPath
    ], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outputPath)));
  });
}

// 16x16 difference hash of an image file.
export async function imageFingerprint(imagePath) {
  const pixels = await new Promise((resolve, reject) => {
    const child = spawn(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', imagePath, '-vf', 'scale=17:16:flags=area,format=gray', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
  });
  let bits = '';
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      bits += pixels[(row * 17) + column] > pixels[(row * 17) + column + 1] ? '1' : '0';
    }
  }
  return bits;
}

export function hamming(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) distance += left[index] === right[index] ? 0 : 1;
  return distance;
}

export async function runPool(jobs, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await worker(job);
    }
  });
  await Promise.all(runners);
}
