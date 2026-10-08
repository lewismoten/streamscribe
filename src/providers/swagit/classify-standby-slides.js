import fs from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { SOURCES } from '../../config/runtime-config.js';
import { fileExists } from '../../util/fs-utils.js';
import { selectConfiguredSources } from '../../util/cli.js';
import { digitalSilenceThresholdDb, inferenceBlockSize, analyzeWorkItems } from './standby-analysis.js';
import { findSessions, loadManifest } from './standby-sessions.js';

const defaultConcurrency = 2;

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
      slideSignature:
        'eight relative rail/outside-seal points are black and four relative inside-seal points are non-black',
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
  report.findings = report.findings
    .filter(Boolean)
    .sort((left, right) => String(left.capturedAt || '').localeCompare(String(right.capturedAt || '')));
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
    `Classified ${report.scannedSegmentCount.toLocaleString('en-US')} segments; found ${report.candidates.length.toLocaleString('en-US')} discard candidates.` +
      ` | inspected ${report.inspectedSegmentCount.toLocaleString('en-US')}, inferred ${report.inferredSegmentCount.toLocaleString('en-US')}` +
      (options.discard ? ` | deleted ${report.discarded.deletedCount}` : '')
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
      await fs.promises.appendFile(
        path.join(candidate.sessionDir, 'discarded-segments.jsonl'),
        `${JSON.stringify({
          capturedAt: candidate.capturedAt,
          sequence: candidate.sequence,
          key: candidate.key || '',
          fileName: candidate.fileName,
          reason: candidate.reason || 'silent-persistent-slide-signature',
          discardedAt: new Date().toISOString(),
          discardedBy: 'classify-swagit-standby'
        })}\n`
      );
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
  const options = {
    sources: [],
    fileNames: new Set(),
    outputPath: '',
    jsonOnly: false,
    discard: false,
    concurrency: defaultConcurrency
  };
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

function printFindingRanges(findings) {
  const groups = [];
  for (const finding of findings) {
    const current = groups.at(-1);
    const sequence = Number(finding.sequence);
    if (
      !current ||
      current.candidate !== finding.candidate ||
      current.captureId !== finding.captureId ||
      sequence !== Number(current.lastSequence) + 1
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
    const files =
      group.firstFileName === group.lastFileName
        ? group.firstFileName
        : `${group.firstFileName.replace(/\.ts$/i, '')}-${group.lastFileName}`;
    console.log(
      `${files} ${group.candidate ? 'drop' : 'keep'}` +
        ` ${formatFindingTime(group.firstCapturedAt)}-${formatFindingTime(group.lastCapturedAt, true)}`
    );
  }
}

function formatFindingTime(value, omitDate = false) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (!match) return 'unknown';
  return omitDate ? `${match[2]}Z` : `${match[1]} ${match[2]}Z`;
}

// Started by bin/classify-swagit-standby.js.
export const run = () =>
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
