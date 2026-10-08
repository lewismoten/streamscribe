import path from 'path';
import { spawn } from 'child_process';
import { TOOLS } from '../config/runtime-config.js';
import { runCommand } from '../util/process.js';

// Frames of a session as slides: where a moment is in the segments, picture fingerprints (whole and center), and
// whether two frames show the same slide.

// A two-part fingerprint. Slide templates usually repeat the same header, footer, and side bands, so the
// border says little about which slide it is:
//   whole: the full frame on a coarse 16x16 grid (256 comparisons)
//   center: the area inside the border (20% trimmed from each edge by default) on a dense 24x24 grid (576)
// Each grid is a difference hash: whether each point is brighter than the one to its right.
export const wholeGridSize = 16;

export const centerGridSize = 24;

// Joined-video seconds -> { segmentPath, offset } within that segment's own file. Offsets stay a little before
// the segment's end, since seeking past its last keyframe returns no frame.
export function locateFrame(sessionDir, retained, seconds) {
  let low = 0;
  let high = retained.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (retained[middle].audioStart <= seconds) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const segment = retained[low];
  const offset = Math.min(Math.max(0, seconds - segment.audioStart), Math.max(0, segment.durationSeconds - 1.2));
  return { segmentPath: path.join(sessionDir, 'segments', segment.fileName), offset };
}

export async function fingerprintFrame(frame, border) {
  const keep = 1 - 2 * border;
  return {
    whole: await differenceHash(frame, '', wholeGridSize),
    center: await differenceHash(frame, `crop=iw*${keep.toFixed(4)}:ih*${keep.toFixed(4)},`, centerGridSize)
  };
}

export async function differenceHash(frame, cropFilter, size) {
  const width = size + 1;
  const pixels = await runCommandBuffer(TOOLS.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-noaccurate_seek',
    '-ss',
    frame.offset.toFixed(3),
    '-i',
    frame.segmentPath,
    '-frames:v',
    '1',
    '-vf',
    `${cropFilter}scale=${width}:${size}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-'
  ]);
  let bits = '';
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      bits += pixels[row * width + column] > pixels[row * width + column + 1] ? '1' : '0';
    }
  }
  return bits;
}

// Same slide only when both the whole frame and the center match within their thresholds.
export function sameSlide(left, right, options) {
  return (
    hammingDistance(left.whole, right.whole) <= options.matchDistance &&
    hammingDistance(left.center, right.center) <= options.centerMatchDistance
  );
}

export function hammingDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += left[index] === right[index] ? 0 : 1;
  }
  return distance;
}

export async function extractFrame(frame, outputPath) {
  await runCommand(TOOLS.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-noaccurate_seek',
    '-ss',
    frame.offset.toFixed(3),
    '-i',
    frame.segmentPath,
    '-frames:v',
    '1',
    outputPath
  ]);
}

export function runCommandBuffer(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(stderr.trim() || `${command} exited with code ${code}`))
    );
  });
}
