import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { TOOLS } from '../../config/runtime-config.js';

// Whether captured segments are Swagit's standby slide: digital silence plus the slide's picture, judged in blocks of
// neighboring segments.

export const execFileAsync = promisify(execFileCallback);

export const digitalSilenceThresholdDb = -90;

export const progressIntervalMs = 15000;

export const inferenceBlockSize = 11;

export async function analyzeWorkItems(workItems, report, concurrency) {
  if (workItems.length === 0) {
    console.error('No matching live segments found to scan.');
    return;
  }
  const startedAt = Date.now();
  workItems.forEach((item, index) => {
    item.index = index;
  });
  report.findings = Array(workItems.length);
  report.inspectedSegmentCount = 0;
  report.inferredSegmentCount = 0;
  const blocks = groupInferenceBlocks(workItems);
  let nextBlockIndex = 0;
  const writeProgress = (message, final = false) => {
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${message.padEnd(64)}${final ? '\n' : ''}`);
    } else {
      console.error(message);
    }
  };
  const progress = (final = false) => {
    const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
    const classified = report.inspectedSegmentCount + report.inferredSegmentCount;
    const rate = classified / elapsedSeconds;
    const remainingSeconds = rate > 0 ? (workItems.length - classified) / rate : 0;
    const dropped = report.findings.filter((finding) => finding?.candidate).length;
    writeProgress(
      `[scan] ${classified.toLocaleString('en-US')}/${workItems.length.toLocaleString('en-US')}` +
        ` | drop ${dropped.toLocaleString('en-US')}` +
        ` | checked ${report.inspectedSegmentCount.toLocaleString('en-US')}` +
        ` | ETA ${Math.ceil(remainingSeconds / 60)}m`,
      final
    );
  };
  writeProgress(
    `[scan] ${workItems.length.toLocaleString('en-US')} segments | ${concurrency} workers | blocks of ${inferenceBlockSize}`
  );
  const interval = setInterval(progress, progressIntervalMs);
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, blocks.length) }, async () => {
        while (nextBlockIndex < blocks.length) {
          const block = blocks[nextBlockIndex];
          nextBlockIndex += 1;
          await classifyInferenceBlock(block, report);
        }
      })
    );
  } finally {
    clearInterval(interval);
    progress(true);
  }
}

export function groupInferenceBlocks(workItems) {
  const blocks = [];
  const sessions = new Map();
  for (const item of workItems) {
    const key = item.session.sessionDir;
    const entries = sessions.get(key) || [];
    entries.push(item);
    sessions.set(key, entries);
  }
  for (const entries of sessions.values()) {
    entries.sort((left, right) => Number(left.entry.sequence || 0) - Number(right.entry.sequence || 0));
    let runStart = 0;
    for (let index = 1; index <= entries.length; index += 1) {
      const previousSequence = Number(entries[index - 1]?.entry.sequence);
      const nextSequence = Number(entries[index]?.entry.sequence);
      if (index < entries.length && nextSequence === previousSequence + 1) continue;
      for (let blockStart = runStart; blockStart < index; blockStart += inferenceBlockSize) {
        blocks.push(entries.slice(blockStart, Math.min(index, blockStart + inferenceBlockSize)));
      }
      runStart = index;
    }
  }
  return blocks;
}

export async function classifyInferenceBlock(items, report) {
  const inspect = async (index) => {
    const item = items[index];
    const existing = report.findings[item.index];
    if (existing) return existing;
    const result = await analyzeSegment(item.segmentPath, item.entry);
    const finding = {
      sourceKey: item.source.key,
      captureId: item.session.captureId,
      sessionDir: item.session.sessionDir,
      inferred: false,
      ...result
    };
    report.findings[item.index] = finding;
    report.inspectedSegmentCount += 1;
    return finding;
  };
  const infer = (index, endpoint) => {
    const item = items[index];
    if (report.findings[item.index]) return;
    report.findings[item.index] = {
      sourceKey: item.source.key,
      captureId: item.session.captureId,
      sessionDir: item.session.sessionDir,
      fileName: item.entry.fileName,
      sequence: item.entry.sequence,
      capturedAt: item.entry.capturedAt,
      candidate: endpoint.candidate,
      inferred: true,
      reason: 'inferred-from-matching-block-endpoints',
      inferredFromFileName: endpoint.fileName
    };
    report.inferredSegmentCount += 1;
  };
  const classifyRange = async (firstIndex, lastIndex) => {
    const first = await inspect(firstIndex);
    const last = await inspect(lastIndex);
    if (first.candidate === last.candidate) {
      for (let index = firstIndex; index <= lastIndex; index += 1) infer(index, first);
      return;
    }
    if (lastIndex - firstIndex <= 1) return;
    const middleIndex = Math.floor((firstIndex + lastIndex) / 2);
    await inspect(middleIndex);
    await classifyRange(firstIndex, middleIndex);
    await classifyRange(middleIndex, lastIndex);
  };
  await classifyRange(0, items.length - 1);
}

export async function analyzeSegment(segmentPath, entry) {
  const base = {
    fileName: entry.fileName,
    sequence: entry.sequence,
    capturedAt: entry.capturedAt
  };
  const maxVolumeDb = await readMaxVolumeDb(segmentPath);
  if (!Number.isFinite(maxVolumeDb) || maxVolumeDb > digitalSilenceThresholdDb) {
    return { ...base, candidate: false, reason: 'audible-or-unreadable-audio', maxVolumeDb };
  }

  const slide = await analyzeSlideSignature(segmentPath, entry.durationSeconds);
  if (!slide.allSamplesMatch) {
    return { ...base, candidate: false, reason: 'no-persistent-slide-signature', maxVolumeDb, ...slide };
  }

  return {
    ...base,
    candidate: true,
    reason: 'silent-persistent-slide-signature',
    maxVolumeDb,
    ...slide
  };
}

export async function readMaxVolumeDb(filePath) {
  try {
    const { stderr } = await execFileAsync(
      TOOLS.ffmpeg,
      ['-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
      { maxBuffer: 1024 * 1024 }
    );
    const match = String(stderr || '').match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?)|inf)\s*dB/i);
    if (!match) return null;
    return /^-?inf$/i.test(match[1]) ? -Infinity : Number(match[1]);
  } catch {
    return null;
  }
}

export async function analyzeSlideSignature(filePath, durationSeconds) {
  // All points are proportions of the frame, so this works across HLS resolutions.
  // Rail points avoid the clock, weather and seal; the outer points establish that
  // the seal is inside the black rail rather than merely beside one.
  const railPoints = [
    [0.02, 0.02],
    [0.2, 0.02],
    [0.02, 0.98],
    [0.2, 0.98]
  ];
  const outsideSealPoints = [
    [0.015, 0.5],
    [0.215, 0.5],
    [0.12, 0.3],
    [0.12, 0.7]
  ];
  const insideSealPoints = [
    [0.12, 0.45],
    [0.12, 0.55],
    [0.075, 0.5],
    [0.165, 0.5]
  ];
  const blackThreshold = 60;
  const sealThreshold = 65;
  const width = 320;
  const height = 180;
  const frameSize = width * height * 3;
  try {
    const duration = Math.max(1, Number(durationSeconds || 10));
    const { stdout } = await execFileAsync(
      TOOLS.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-vf',
        `fps=3/${duration},scale=${width}:${height}:flags=area,format=rgb24`,
        '-f',
        'rawvideo',
        '-'
      ],
      { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }
    );
    const data = Buffer.from(stdout || '');
    const samples = [];
    for (let offset = 0; offset + frameSize <= data.length && samples.length < 3; offset += frameSize) {
      const luminance = ([xRatio, yRatio]) => {
        const x = Math.min(width - 1, Math.max(0, Math.round(xRatio * (width - 1))));
        const y = Math.min(height - 1, Math.max(0, Math.round(yRatio * (height - 1))));
        const pixel = offset + (y * width + x) * 3;
        return Math.round((data[pixel] + data[pixel + 1] + data[pixel + 2]) / 3);
      };
      const blackValues = [...railPoints, ...outsideSealPoints].map(luminance);
      const sealValues = insideSealPoints.map(luminance);
      samples.push({
        sample: ['start', 'middle', 'end'][samples.length],
        blackPointValues: blackValues,
        sealPointValues: sealValues,
        blackPointCount: blackValues.filter((value) => value < blackThreshold).length,
        nonBlackSealPointCount: sealValues.filter((value) => value >= sealThreshold).length,
        matches:
          blackValues.every((value) => value < blackThreshold) && sealValues.every((value) => value >= sealThreshold)
      });
    }
    return { samples, allSamplesMatch: samples.length === 3 && samples.every((sample) => sample.matches) };
  } catch {
    return { samples: [], allSamplesMatch: false };
  }
}
