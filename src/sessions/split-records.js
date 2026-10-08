import path from 'path';
import { loadJson, writeJsonAtomically } from '../util/fs-utils.js';
import { parseSegmentIdentifier } from './session.js';

// Splitting a session's capture records at a sequence: silence periods, stream identifier log, and session.json.

export async function splitSilenceLog(sessionDir, newDir, splitSequence) {
  const log = await loadJson(path.join(sessionDir, 'silence-boundaries.json'));
  if (!log) {
    return;
  }
  const periods = Array.isArray(log.periods) ? log.periods : [];
  await writeJsonAtomically(path.join(sessionDir, 'silence-boundaries.json'), {
    ...log,
    periods: periods.filter((period) => Number(period.startSequence) < splitSequence),
    activePeriod: null
  });
  await writeJsonAtomically(path.join(newDir, 'silence-boundaries.json'), {
    ...log,
    periods: periods.filter((period) => Number(period.startSequence) >= splitSequence),
    note: `${log.note || ''} Times are relative to the original session ${path.basename(sessionDir)}.`.trim()
  });
}

export async function splitIdentityLog(sessionDir, newDir, splitSequence, before, after) {
  const log = await loadJson(path.join(sessionDir, 'stream-identity-transitions.json'));
  if (!log) {
    return;
  }
  const events = Array.isArray(log.events) ? log.events : [];
  // The identifier in use at the end of `entries`, from the first segment of its unbroken run.
  const describe = (entries) => {
    const last = entries.at(-1);
    const identifier = parseSegmentIdentifier(last.sourceUrl);
    let runStart = entries.length - 1;
    while (runStart > 0 && parseSegmentIdentifier(entries[runStart - 1].sourceUrl) === identifier) {
      runStart -= 1;
    }
    return {
      identifier,
      filePrefix: `media-${identifier}`,
      firstSequence: entries[runStart].sequence,
      firstCapturedAt: entries[runStart].capturedAt,
      lastSequence: last.sequence,
      lastCapturedAt: last.capturedAt
    };
  };
  await writeJsonAtomically(path.join(sessionDir, 'stream-identity-transitions.json'), {
    ...log,
    current: describe(before),
    events: events.filter((event) => Number(event.toFirstSequence) < splitSequence)
  });
  await writeJsonAtomically(path.join(newDir, 'stream-identity-transitions.json'), {
    ...log,
    current: log.current?.firstSequence >= splitSequence ? log.current : describe(after),
    events: events.filter((event) => Number(event.toFirstSequence) > splitSequence)
  });
}

export async function splitSessionRecords(sessionDir, newDir, splitSequence, before, after, discardedAfter) {
  const session = await loadJson(path.join(sessionDir, 'session.json'), {});
  const summarize = (entries) => ({
    segmentCount: entries.length,
    bytesCaptured: entries.reduce((total, item) => total + Number(item.bytes || 0), 0),
    capturedDurationSeconds: entries.reduce((total, item) => total + Number(item.durationSeconds || 0), 0),
    lastSegmentSequence: entries.at(-1).sequence,
    lastObservedSegmentSequence: entries.at(-1).sequence,
    lastSegmentAt: entries.at(-1).capturedAt,
    downloadedSegmentKeys: entries.map((item) => item.key)
  });
  const split = { at: splitSequence, splitAt: new Date().toISOString() };

  const newSession = {
    ...session,
    ...summarize(after),
    sessionDir: newDir,
    firstSeenAt: after[0].capturedAt,
    previousSessionDir: sessionDir,
    splitFrom: split,
    discardedSegmentKeys: discardedAfter.map((entry) => entry.key).filter(Boolean),
    recentSegments: after.slice(-5).map(({ sequence, durationSeconds, fileName, capturedAt }) => ({
      sequence,
      durationSeconds,
      fileName,
      capturedAt
    }))
  };
  delete newSession.nextSessionDir;
  await writeJsonAtomically(path.join(newDir, 'session.json'), newSession);

  await writeJsonAtomically(path.join(sessionDir, 'session.json'), {
    ...session,
    ...summarize(before),
    status: 'complete',
    completedAt: new Date().toISOString(),
    completionReason: `Split at sequence ${splitSequence}`,
    nextSessionDir: newDir,
    splitInto: split,
    discardedSegmentKeys: (session.discardedSegmentKeys || []).filter(
      (key) => Number(String(key).split('|')[0]) < splitSequence
    ),
    recentSegments: before.slice(-5).map(({ sequence, durationSeconds, fileName, capturedAt }) => ({
      sequence,
      durationSeconds,
      fileName,
      capturedAt
    }))
  });
}
