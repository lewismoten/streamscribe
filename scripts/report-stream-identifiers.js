import fs from 'fs';
import path from 'path';
import { readFile, writeFile } from 'fs/promises';
import { LOCALE, SOURCES } from './lib/runtime-config.js';
import { selectConfiguredSources } from './lib/cli.js';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sources = selectConfiguredSources(SOURCES, options.sources, 'sources');
  const report = {
    generatedAt: new Date().toISOString(),
    sources: []
  };

  for (const source of sources) {
    const sessions = await findSessions(source.liveStorageDir);
    const sourceReport = {
      key: source.key,
      liveStorageDir: source.liveStorageDir,
      sessions: []
    };

    for (const session of sessions) {
      const records = (await loadManifest(session.manifestPath))
        .map((record) => ({ ...record, ...parseSegmentUrl(record.sourceUrl) }))
        .filter((record) => record.streamIdentifier)
        .sort(compareCapturedRecords);
      if (records.length === 0) {
        continue;
      }

      sourceReport.sessions.push({
        captureId: session.captureId,
        sessionDir: session.sessionDir,
        streamIdentifiers: summarizeIdentifiers(records),
        runs: buildRuns(records)
      });
    }

    if (sourceReport.sessions.length > 0) {
      report.sources.push(sourceReport);
    }
  }

  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote ${options.outputPath}`);
  }
  if (!options.jsonOnly) {
    printReport(report);
  } else if (!options.outputPath) {
    console.log(JSON.stringify(report, null, 2));
  }
}

function parseArgs(args) {
  const options = { sources: [], outputPath: '', jsonOnly: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '').trim();
    if (arg === '--source') {
      const key = String(args[index + 1] || '').trim();
      if (!key) throw new Error('Missing value for --source');
      options.sources.push(key);
      index += 1;
    } else if (arg === '--output') {
      const outputPath = String(args[index + 1] || '').trim();
      if (!outputPath) throw new Error('Missing value for --output');
      options.outputPath = path.resolve(outputPath);
      index += 1;
    } else if (arg === '--json') {
      options.jsonOnly = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function findSessions(rootDir) {
  const sessions = [];
  let captureDirectories = [];
  try {
    captureDirectories = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const captureDirectory of captureDirectories) {
    if (!captureDirectory.isDirectory()) continue;
    const captureDir = path.join(rootDir, captureDirectory.name);
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
      try {
        await fs.promises.access(manifestPath);
        sessions.push({ captureId: captureDirectory.name, sessionDir, manifestPath });
      } catch {
        // Not a capture session.
      }
    }
  }
  return sessions.sort((left, right) => left.sessionDir.localeCompare(right.sessionDir));
}

async function loadManifest(manifestPath) {
  try {
    return (await readFile(manifestPath, 'utf8')).split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function parseSegmentUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const match = url.pathname.match(/\/(media-([^_/?]+))_(\d+)\.ts$/i);
    if (!match) return {};
    return {
      streamFilePrefix: match[1],
      streamIdentifier: match[2],
      sequenceFromUrl: Number(match[3]),
      queryT: url.searchParams.get('t') || ''
    };
  } catch {
    return {};
  }
}

function compareCapturedRecords(left, right) {
  const timeDifference = Date.parse(left.capturedAt || '') - Date.parse(right.capturedAt || '');
  return Number.isFinite(timeDifference) && timeDifference !== 0
    ? timeDifference
    : Number(left.sequence || 0) - Number(right.sequence || 0);
}

function summarizeIdentifiers(records) {
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.streamIdentifier) || {
      streamIdentifier: record.streamIdentifier,
      streamFilePrefix: record.streamFilePrefix,
      firstCapturedAt: record.capturedAt,
      lastCapturedAt: record.capturedAt,
      firstSequence: record.sequence,
      lastSequence: record.sequence,
      segmentCount: 0,
      queryTValues: new Set()
    };
    group.lastCapturedAt = record.capturedAt;
    group.lastSequence = record.sequence;
    group.segmentCount += 1;
    if (record.queryT) group.queryTValues.add(record.queryT);
    groups.set(record.streamIdentifier, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    queryTValues: [...group.queryTValues]
  }));
}

function buildRuns(records) {
  const runs = [];
  for (const record of records) {
    const current = runs.at(-1);
    const sequence = Number(record.sequence ?? record.sequenceFromUrl);
    const previousSequence = Number(current?.lastSequence);
    const sameIdentifier = current?.streamIdentifier === record.streamIdentifier;
    if (!current || !sameIdentifier || sequence !== previousSequence + 1) {
      runs.push({
        streamIdentifier: record.streamIdentifier,
        streamFilePrefix: record.streamFilePrefix,
        firstCapturedAt: record.capturedAt,
        lastCapturedAt: record.capturedAt,
        firstSequence: sequence,
        lastSequence: sequence,
        segmentCount: 1,
        queryTValues: record.queryT ? [record.queryT] : []
      });
      continue;
    }
    current.lastCapturedAt = record.capturedAt;
    current.lastSequence = sequence;
    current.segmentCount += 1;
    if (record.queryT && !current.queryTValues.includes(record.queryT)) current.queryTValues.push(record.queryT);
  }
  return runs;
}

function printReport(report) {
  let sessionCount = 0;
  for (const source of report.sources) {
    console.log(`Source ${source.key}`);
    for (const session of source.sessions) {
      sessionCount += 1;
      console.log(`  ${session.captureId} ${path.basename(session.sessionDir)}`);
      for (const identifier of session.streamIdentifiers) {
        console.log(
          `    ${identifier.streamFilePrefix} | ${formatTime(identifier.firstCapturedAt)} to ${formatTime(identifier.lastCapturedAt)}`
            + ` | seq ${identifier.firstSequence}-${identifier.lastSequence} | ${identifier.segmentCount} segments`
            + formatQueryValues(identifier.queryTValues)
        );
      }
      for (const run of session.runs) {
        if (session.runs.length > 1) {
          console.log(`      run ${run.streamFilePrefix} | ${formatTime(run.firstCapturedAt)} to ${formatTime(run.lastCapturedAt)} | seq ${run.firstSequence}-${run.lastSequence}`);
        }
      }
    }
  }
  console.log(`Scanned ${sessionCount} capture session${sessionCount === 1 ? '' : 's'}.`);
}

function formatQueryValues(values) {
  return values.length > 0 ? ` | t=${values.join(',')}` : '';
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LOCALE.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
