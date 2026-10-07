import { execFile as execFileCallback } from 'child_process';
import fs from 'fs';
import path from 'path';
import { readFile, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { SOURCES, TOOLS } from '../../lib/runtime-config.js';
import { fileExists, loadJson } from '../../lib/fs-utils.js';
import { selectConfiguredSources } from '../../lib/cli.js';

const execFileAsync = promisify(execFileCallback);
const digitalSilenceThresholdDb = -90;
const defaultConcurrency = 2;
const progressIntervalMs = 15000;
const inferenceBlockSize = 11;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sources = selectConfiguredSources(SOURCES, options.sources, 'sources');
  const report = {
    generatedAt: new Date().toISOString(),
    criteria: {
      silentAudio: `ffmpeg volumedetect reports at or below ${digitalSilenceThresholdDb} dB`,
      blackRailLuminanceBelow: 60,
      sealLuminanceAtLeast: 65,
      slideSignatureFrames: ['start', 'middle', 'end'],
      slideSignature: 'eight relative rail/outside-seal points are black and four relative inside-seal points are non-black',
      inferenceBlockSize
    },
    candidates: [],
    findings: [],
    scannedSegmentCount: 0
  };

  const workItems = [];
  for (const source of sources) {
    const sessions = await findSessions(source);
    for (const session of sessions) {
      const entries = await loadManifest(session.manifestPath);
      for (const entry of entries) {
        if (options.fileNames.size > 0 && !options.fileNames.has(String(entry.fileName || ''))) {
          continue;
        }
        const segmentPath = path.join(session.sessionDir, 'segments', String(entry.fileName || ''));
        if (!(await fileExists(segmentPath))) {
          continue;
        }
        workItems.push({ source, session, entry, segmentPath });
      }
    }
  }
  report.scannedSegmentCount = workItems.length;
  await analyzeWorkItems(workItems, report, options.concurrency);
  report.findings = report.findings.filter(Boolean).sort((left, right) => String(left.capturedAt || '').localeCompare(String(right.capturedAt || '')));
  report.candidates = report.findings.filter((finding) => finding.candidate);
  if (options.discard) {
    report.discarded = await discardCandidateFiles(report.candidates);
  }

  const outputPath = options.outputPath || defaultOutputPath(sources);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`Wrote ${outputPath}`);
  if (options.jsonOnly) {
    if (!options.outputPath) console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `Classified ${report.scannedSegmentCount.toLocaleString('en-US')} segments; found ${report.candidates.length.toLocaleString('en-US')} discard candidates.`
      + ` | inspected ${report.inspectedSegmentCount.toLocaleString('en-US')}, inferred ${report.inferredSegmentCount.toLocaleString('en-US')}`
      + (options.discard ? ` | deleted ${report.discarded.deletedCount}` : '')
  );
  printFindingRanges(report.findings);
}

function defaultOutputPath(sources) {
  if (sources.length === 1 && sources[0].liveStorageDir) {
    return path.join(sources[0].liveStorageDir, 'slide-classification-findings.json');
  }
  return path.resolve('slide-classification-findings.json');
}

async function discardCandidateFiles(candidates) {
  let deletedCount = 0;
  let missingCount = 0;
  for (const candidate of candidates) {
    const filePath = path.join(candidate.sessionDir, 'segments', String(candidate.fileName || ''));
    try {
      await fs.promises.unlink(filePath);
      await fs.promises.appendFile(path.join(candidate.sessionDir, 'discarded-segments.jsonl'), `${JSON.stringify({
        capturedAt: candidate.capturedAt,
        sequence: candidate.sequence,
        key: candidate.key || '',
        fileName: candidate.fileName,
        reason: candidate.reason || 'silent-persistent-slide-signature',
        discardedAt: new Date().toISOString(),
        discardedBy: 'classify-swagit-standby'
      })}\n`);
      deletedCount += 1;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        missingCount += 1;
        continue;
      }
      throw error;
    }
  }
  return { deletedCount, missingCount, deletedAt: new Date().toISOString() };
}

function parseArgs(args) {
  const options = { sources: [], fileNames: new Set(), outputPath: '', jsonOnly: false, discard: false, concurrency: defaultConcurrency };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '').trim();
    if (arg === '--source') {
      const value = String(args[index + 1] || '').trim();
      if (!value) throw new Error('Missing value for --source');
      options.sources.push(value);
      index += 1;
    } else if (arg === '--file-name') {
      const value = String(args[index + 1] || '').trim();
      if (!value) throw new Error('Missing value for --file-name');
      options.fileNames.add(value);
      index += 1;
    } else if (arg === '--output') {
      const value = String(args[index + 1] || '').trim();
      if (!value) throw new Error('Missing value for --output');
      options.outputPath = path.resolve(value);
      index += 1;
    } else if (arg === '--concurrency') {
      const value = Number.parseInt(String(args[index + 1] || '').trim(), 10);
      if (!Number.isFinite(value) || value < 1 || value > 8) throw new Error('Concurrency must be between 1 and 8');
      options.concurrency = value;
      index += 1;
    } else if (arg === '--json') {
      options.jsonOnly = true;
    } else if (arg === '--discard') {
      options.discard = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function analyzeWorkItems(workItems, report, concurrency) {
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
      `[scan] ${classified.toLocaleString('en-US')}/${workItems.length.toLocaleString('en-US')}`
        + ` | drop ${dropped.toLocaleString('en-US')}`
        + ` | checked ${report.inspectedSegmentCount.toLocaleString('en-US')}`
        + ` | ETA ${Math.ceil(remainingSeconds / 60)}m`,
      final
    );
  };
  writeProgress(`[scan] ${workItems.length.toLocaleString('en-US')} segments | ${concurrency} workers | blocks of ${inferenceBlockSize}`);
  const interval = setInterval(progress, progressIntervalMs);
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, blocks.length) }, async () => {
      while (nextBlockIndex < blocks.length) {
        const block = blocks[nextBlockIndex];
        nextBlockIndex += 1;
        await classifyInferenceBlock(block, report);
      }
    }));
  } finally {
    clearInterval(interval);
    progress(true);
  }
}

function groupInferenceBlocks(workItems) {
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

async function classifyInferenceBlock(items, report) {
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

function printFindingRanges(findings) {
  const groups = [];
  for (const finding of findings) {
    const current = groups.at(-1);
    const sequence = Number(finding.sequence);
    if (
      !current
      || current.candidate !== finding.candidate
      || current.captureId !== finding.captureId
      || sequence !== Number(current.lastSequence) + 1
    ) {
      groups.push({
        candidate: finding.candidate,
        captureId: finding.captureId,
        firstFileName: finding.fileName,
        lastFileName: finding.fileName,
        firstSequence: finding.sequence,
        lastSequence: finding.sequence,
        firstCapturedAt: finding.capturedAt,
        lastCapturedAt: finding.capturedAt
      });
      continue;
    }
    current.lastFileName = finding.fileName;
    current.lastSequence = finding.sequence;
    current.lastCapturedAt = finding.capturedAt;
  }
  for (const group of groups) {
    const files = group.firstFileName === group.lastFileName
      ? group.firstFileName
      : `${group.firstFileName.replace(/\.ts$/i, '')}-${group.lastFileName}`;
    console.log(
      `${files} ${group.candidate ? 'drop' : 'keep'}`
        + ` ${formatFindingTime(group.firstCapturedAt)}-${formatFindingTime(group.lastCapturedAt, true)}`
    );
  }
}

function formatFindingTime(value, omitDate = false) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (!match) return 'unknown';
  return omitDate ? `${match[2]}Z` : `${match[1]} ${match[2]}Z`;
}

async function findSessions(source) {
  const root = String(source.liveStorageDir || '').trim();
  const sessions = [];
  let captureDirectories = [];
  try {
    captureDirectories = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const captureDirectory of captureDirectories) {
    if (!captureDirectory.isDirectory()) continue;
    const captureDir = path.join(root, captureDirectory.name);
    let sessionDirectories = [];
    try {
      sessionDirectories = await fs.promises.readdir(captureDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDirectory of sessionDirectories) {
      if (!sessionDirectory.isDirectory()) continue;
      const sessionDir = path.join(captureDir, sessionDirectory.name);
      const manifestPath = path.join(sessionDir, 'segments.jsonl');
      const sessionPath = path.join(sessionDir, 'session.json');
      const session = await loadJson(sessionPath);
      if (await fileExists(manifestPath) && /\/live\//i.test(String(session?.hlsUrl || ''))) {
        sessions.push({ captureId: captureDirectory.name, sessionDir, manifestPath });
      }
    }
  }
  return sessions;
}

async function loadManifest(filePath) {
  try {
    return (await readFile(filePath, 'utf8')).split(/\r?\n/).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry && entry.fileName ? [entry] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function analyzeSegment(segmentPath, entry) {
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

async function readMaxVolumeDb(filePath) {
  try {
    const { stderr } = await execFileAsync(TOOLS.ffmpeg, [
      '-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'
    ], { maxBuffer: 1024 * 1024 });
    const match = String(stderr || '').match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?)|inf)\s*dB/i);
    if (!match) return null;
    return /^-?inf$/i.test(match[1]) ? -Infinity : Number(match[1]);
  } catch {
    return null;
  }
}

async function analyzeSlideSignature(filePath, durationSeconds) {
  // All points are proportions of the frame, so this works across HLS resolutions.
  // Rail points avoid the clock, weather and seal; the outer points establish that
  // the seal is inside the black rail rather than merely beside one.
  const railPoints = [
    [0.02, 0.02], [0.20, 0.02], [0.02, 0.98], [0.20, 0.98]
  ];
  const outsideSealPoints = [[0.015, 0.50], [0.215, 0.50], [0.12, 0.30], [0.12, 0.70]];
  const insideSealPoints = [[0.12, 0.45], [0.12, 0.55], [0.075, 0.50], [0.165, 0.50]];
  const blackThreshold = 60;
  const sealThreshold = 65;
  const width = 320;
  const height = 180;
  const frameSize = width * height * 3;
  try {
    const duration = Math.max(1, Number(durationSeconds || 10));
    const { stdout } = await execFileAsync(TOOLS.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-vf', `fps=3/${duration},scale=${width}:${height}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'
    ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
    const data = Buffer.from(stdout || '');
    const samples = [];
    for (let offset = 0; offset + frameSize <= data.length && samples.length < 3; offset += frameSize) {
      const luminance = ([xRatio, yRatio]) => {
        const x = Math.min(width - 1, Math.max(0, Math.round(xRatio * (width - 1))));
        const y = Math.min(height - 1, Math.max(0, Math.round(yRatio * (height - 1))));
        const pixel = offset + ((y * width + x) * 3);
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
        matches: blackValues.every((value) => value < blackThreshold) && sealValues.every((value) => value >= sealThreshold)
      });
    }
    return { samples, allSamplesMatch: samples.length === 3 && samples.every((sample) => sample.matches) };
  } catch {
    return { samples: [], allSamplesMatch: false };
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
