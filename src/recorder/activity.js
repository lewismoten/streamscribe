import fs from 'fs';
import path from 'path';

// What a source's capture has written: its session folders and, from their segment lists, when the last kept segment
// arrived and whether the standby slide has been showing since (discarded segments after it).

const listDirs = (root) => {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
};
export const readLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

// Session folders of a source with segments kept (or discarded) since sinceMs, oldest first.
export function sessionsSince(source, sinceMs) {
  const found = [];
  for (const streamDir of listDirs(source.liveStorageDir)) {
    for (const sessionDir of listDirs(streamDir)) {
      const kept = readLines(path.join(sessionDir, 'segments.jsonl')).filter((item) => Date.parse(item.capturedAt) >= sinceMs);
      if (kept.length) found.push({ dir: sessionDir, first: Date.parse(kept[0].capturedAt), kept });
    }
  }
  return found.sort((left, right) => left.first - right.first);
}

// Since sinceMs: the newest kept segment's arrival, and how many segments were discarded (the standby slide) after it.
export function activitySince(source, sinceMs) {
  let lastKeptAt = null;
  let lastDiscardedAt = null;
  let discardedAfterKept = 0;
  let keptSeconds = 0;
  const discarded = [];
  for (const streamDir of listDirs(source.liveStorageDir)) {
    for (const sessionDir of listDirs(streamDir)) {
      for (const item of readLines(path.join(sessionDir, 'segments.jsonl'))) {
        const at = Date.parse(item.capturedAt);
        if (at < sinceMs) continue;
        keptSeconds += Number(item.durationSeconds) || 0;
        if (lastKeptAt === null || at > lastKeptAt) lastKeptAt = at;
      }
      for (const item of readLines(path.join(sessionDir, 'discarded-segments.jsonl'))) {
        const at = Date.parse(item.capturedAt);
        if (at >= sinceMs) discarded.push(at);
      }
    }
  }
  for (const at of discarded) {
    if (lastDiscardedAt === null || at > lastDiscardedAt) lastDiscardedAt = at;
    if (lastKeptAt === null || at > lastKeptAt) discardedAfterKept += 1;
  }
  return { lastKeptAt, lastDiscardedAt, discardedAfterKept, keptSeconds };
}

// The newest kept segment file of a source since sinceMs (for a live picture).
export function newestSegmentFile(source, sinceMs) {
  const sessions = sessionsSince(source, sinceMs);
  const last = sessions.at(-1);
  const item = last?.kept.at(-1);
  return item ? path.join(last.dir, 'segments', item.fileName) : null;
}
