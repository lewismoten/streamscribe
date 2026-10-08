import fs from 'fs';
import path from 'path';
import { mkdirChecked as mkdir } from '../config/ensure-mounted-volume.js';
import { SOURCES } from '../config/runtime-config.js';
import { readFile, rename } from 'fs/promises';
import { fileExists, loadJson, writeJsonAtomically } from '../util/fs-utils.js';
import { downloadTrailingSegments } from './backfill.js';
import { silenceThresholdDb, colorBarLookbackSegments, resumeRecentCaptureMs } from './constants.js';
import { initializeCaptureMetrics, formatSnapshotTimestamp, formatDuration, formatEasternTime } from './progress.js';
import {
  restoreCurrentStreamMetrics,
  parseStreamIdentity,
  restoreStreamIdentityLog,
  writeStreamIdentityLog
} from './stream-identity.js';

// Capture sessions: one folder per meeting with its segments, resumed after a restart, and handed over to a new
// folder when a new meeting starts (or, if configured, at each stream identifier change).

export async function restoreRecentCaptureSessions(source, state, liveEntries) {
  for (const entry of liveEntries) {
    const key = String(entry.id);
    if (state.captures?.[key] && state.captures[key].status !== 'complete') {
      continue;
    }

    const recovered = await loadRecentCaptureSession(source, entry);
    if (!recovered) {
      continue;
    }

    state.captures[key] = recovered;
    console.log(
      `[live ${entry.id}] resuming stream ${recovered.currentStream?.identifier || 'unknown'}` +
        ` | cap ${formatDuration(recovered.currentStream?.capturedDurationSeconds)}` +
        ` | miss ${formatDuration(recovered.currentStream?.lostDurationSeconds)}` +
        ` | pos ${formatDuration(recovered.currentStream?.videoPositionSeconds)}` +
        ` | first capture ${formatEasternTime(recovered.currentStream?.startedAt)}` +
        ` | last capture ${formatEasternTime(recovered.currentStream?.lastSegmentAt)}` +
        ` | now ${formatEasternTime(new Date().toISOString())}`
    );
  }
}

export async function loadRecentCaptureSession(source, liveEntry) {
  const videoRoot = path.join(source.liveStorageDir, String(liveEntry.id));
  let entries = [];
  try {
    entries = await fs.promises.readdir(videoRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessionDir = path.join(videoRoot, entry.name);
    const sessionPath = path.join(sessionDir, 'session.json');
    const segmentsPath = path.join(sessionDir, 'segments.jsonl');
    const session = await loadJson(sessionPath, null);
    if (!session || session.status === 'complete' || !(await fileExists(segmentsPath))) {
      continue;
    }
    if (!sameLiveVideo(session, liveEntry)) {
      continue;
    }
    const activityAt = Date.parse(String(session.lastSegmentAt || session.lastSeenLiveAt || session.firstSeenAt || ''));
    if (!Number.isFinite(activityAt) || Date.now() - activityAt > resumeRecentCaptureMs) {
      continue;
    }
    candidates.push({ session, sessionDir, segmentsPath, activityAt });
  }

  candidates.sort((left, right) => right.activityAt - left.activityAt);
  const candidate = candidates[0];
  if (!candidate) {
    return null;
  }

  const manifest = await loadSegmentManifest(candidate.segmentsPath);
  if (manifest.length === 0) {
    return null;
  }

  const recovered = {
    ...candidate.session,
    id: liveEntry.id,
    title: liveEntry.title || candidate.session.title || '',
    duration: liveEntry.duration || candidate.session.duration || '',
    pageUrl: liveEntry.pageUrl,
    livePageUrl: liveEntry.livePageUrl,
    status: 'recording',
    lastSeenLiveAt: new Date().toISOString(),
    sessionDir: candidate.sessionDir,
    downloadedSegmentKeys: manifest.map((item) => item.key).filter(Boolean),
    discardedSegmentKeys: await loadDiscardedSegmentKeys(candidate.sessionDir),
    segmentCount: manifest.length,
    bytesCaptured: manifest.reduce((total, item) => total + Number(item.bytes || 0), 0),
    capturedDurationSeconds: manifest.reduce((total, item) => total + Number(item.durationSeconds || 0), 0),
    lostDurationSeconds: calculateMissingDuration(manifest),
    lastSegmentSequence: manifest.at(-1)?.sequence ?? null,
    lastSegmentAt: manifest.at(-1)?.capturedAt || candidate.session.lastSegmentAt || '',
    lastProgressOutputAt: '',
    lastErrorOutputAt: '',
    recentSegments: manifest.slice(-(colorBarLookbackSegments + 1)).map((item) => ({
      sequence: item.sequence,
      durationSeconds: item.durationSeconds,
      fileName: item.fileName,
      capturedAt: item.capturedAt
    }))
  };
  recovered.lastObservedSegmentSequence = Math.max(
    Number(manifest.at(-1)?.sequence ?? -1),
    ...recovered.discardedSegmentKeys.map((key) => Number(String(key).split('|')[0])).filter(Number.isFinite)
  );
  recovered.videoPositionSeconds = recovered.capturedDurationSeconds + recovered.lostDurationSeconds;
  restoreStreamIdentityLog(recovered, manifest);
  restoreCurrentStreamMetrics(recovered, manifest);
  return recovered;
}

export function sameLiveVideo(session, liveEntry) {
  if (String(session?.id || '') === String(liveEntry.id || '')) {
    return true;
  }
  const sessionId = Number.parseInt(String(session?.id || ''), 10);
  if (sessionId === Number(liveEntry.id)) {
    return true;
  }
  return String(session?.pageUrl || '').includes(`/videos/${liveEntry.id}`);
}

export async function loadSegmentManifest(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  } catch {
    return [];
  }
}

export async function loadDiscardedSegmentKeys(sessionDir) {
  try {
    const raw = await readFile(path.join(sessionDir, 'discarded-segments.jsonl'), 'utf8');
    return raw.split(/\r?\n/).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry?.key ? [String(entry.key)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function calculateMissingDuration(segments) {
  let missing = 0;
  let previousSequence = null;
  for (const segment of segments) {
    const sequence = Number(segment.sequence);
    const duration = Number(segment.durationSeconds || 0);
    if (Number.isFinite(sequence) && previousSequence === null && sequence > 0) {
      missing += sequence * duration;
    }
    if (Number.isFinite(sequence) && Number.isFinite(previousSequence) && sequence > previousSequence + 1) {
      missing += (sequence - previousSequence - 1) * duration;
    }
    if (Number.isFinite(sequence)) {
      previousSequence = sequence;
    }
  }
  return missing;
}

export async function ensureCaptureSession(source, state, liveEntry, context) {
  const key = String(liveEntry.id);
  const existing = state.captures[key];
  const now = new Date().toISOString();

  if (existing?.status === 'complete') {
    return existing;
  }

  if (existing && existing.status !== 'complete') {
    initializeCaptureMetrics(existing);
    existing.title = liveEntry.title || existing.title || '';
    existing.duration = liveEntry.duration || existing.duration || '';
    existing.pageUrl = liveEntry.pageUrl;
    existing.livePageUrl = liveEntry.livePageUrl;
    existing.hlsUrl = liveEntry.hlsUrl || existing.hlsUrl || '';
    existing.lastSeenLiveAt = now;
    if (existing.status !== 'recording') {
      existing.status = 'recording';
      console.log(`[live ${liveEntry.id}] resumed live detection`);
    }
    return existing;
  }

  const sessionDir = await createSessionDir(source.liveStorageDir, liveEntry.id);
  const capture = buildCaptureRecord(
    {
      id: liveEntry.id,
      title: liveEntry.title || '',
      duration: liveEntry.duration || '',
      pageUrl: liveEntry.pageUrl,
      livePageUrl: liveEntry.livePageUrl,
      hlsUrl: liveEntry.hlsUrl || '',
      sourceKey: source.key
    },
    sessionDir,
    now
  );

  state.captures[key] = capture;
  await writeJsonAtomically(path.join(sessionDir, 'session.json'), capture);
  console.log(`[live ${liveEntry.id}] started ${liveEntry.title || 'live stream'}`);
  context.setCurrentLabel?.(`[live ${liveEntry.id}] started`);
  return capture;
}

export async function createSessionDir(liveStorageDir, captureId) {
  const sessionDir = path.join(liveStorageDir, String(captureId), formatSnapshotTimestamp(new Date()));
  await mkdir(path.join(sessionDir, 'segments'), { recursive: true });
  await mkdir(path.join(sessionDir, 'playlists'), { recursive: true });
  return sessionDir;
}

// A fresh session record. `base` carries what stays the same across sessions of one live stream.
export function buildCaptureRecord(base, sessionDir, now) {
  return {
    ...base,
    status: 'recording',
    firstSeenAt: now,
    lastSeenLiveAt: now,
    lastSegmentAt: '',
    lastObservedAt: '',
    lastVideoPageFetchAt: '',
    lastPlaylistFetchAt: '',
    lastErrorAt: '',
    completedAt: '',
    sessionDir,
    segmentCount: 0,
    bytesCaptured: 0,
    capturedDurationSeconds: 0,
    lostDurationSeconds: 0,
    videoPositionSeconds: 0,
    lastSegmentSequence: null,
    lastProgressOutputAt: '',
    lastErrorOutputAt: '',
    initialBackfillCompleted: false,
    silenceLog: {
      thresholdDb: silenceThresholdDb,
      periods: [],
      activePeriod: null
    },
    colorBarLog: {
      events: []
    },
    currentStream: null,
    slideShow: {
      active: false,
      startedAt: '',
      startSequence: null,
      discardedSegmentCount: 0,
      discardedDurationSeconds: 0
    },
    discardedSegmentKeys: [],
    discardedSegmentCount: 0,
    discardedDurationSeconds: 0,
    lastObservedSegmentSequence: null,
    streamIdentityLog: {
      events: [],
      current: null
    },
    recentSegments: [],
    downloadedSegmentKeys: [],
    masterPlaylistUrl: base.masterPlaylistUrl || '',
    mediaPlaylistUrl: base.mediaPlaylistUrl || '',
    endListSeen: false
  };
}

// Providers whose segment names carry a stream identifier: Swagit renews it (media-<id>_<n>.ts) about hourly and skips one sequence number
// when it does. The server serves any segment number under any identifier, so the skipped number is still
// recoverable (the gap backfill fetches it). Because the renewal runs on a timer, it says nothing about the meeting:
// by default the change is only logged (stream-identity-transitions.json) and the session carries on. With
// sources[].splitOnStreamIdentifierChange, each identifier is recorded as its own session instead.
export async function rotateSessionOnIdentityChange(segment, capture, context) {
  const incoming = parseStreamIdentity(segment.url, capture);
  const current = capture.streamIdentityLog?.current;
  if (
    !incoming ||
    !current?.identifier ||
    incoming.identifier === current.identifier ||
    !(segment.sequence > Number(capture.lastObservedSegmentSequence))
  ) {
    return false;
  }
  const source = SOURCES.find((item) => item.key === capture.sourceKey);
  if (!source?.splitOnStreamIdentifierChange) {
    return false;
  }

  // Finish the old stream: segments after the last one captured may still be served under the old identifier.
  await downloadTrailingSegments(segment, current, capture, context);
  const transition = {
    from: current.identifier,
    fromLastSequence: current.lastSequence,
    to: incoming.identifier,
    toFirstSequence: segment.sequence,
    detectedAt: new Date().toISOString()
  };
  const sessionDir = await startNextSession(
    capture,
    `Stream identifier changed (${transition.from} -> ${transition.to})`,
    { transition }
  );
  capture.lastObservedSegmentSequence = segment.sequence - 1;
  console.log(`[live ${capture.id}] new session for stream ${transition.to} | ${sessionDir}`);
  return true;
}

// A new meeting: the stream comes back from the provider's standby slide after at least
// sources[].newSessionAfterStandbyMinutes (10 by default; a recess shows the meeting's own title card, which is kept,
// not the standby slide). The session that recorded the last meeting is finished and this segment starts the next
// one, so each meeting gets its own folder, and none is made for standby alone. Returns the segment's new path.
export async function startSessionAfterStandby(segment, download, capture) {
  const slideShow = capture.slideShow;
  const source = SOURCES.find((item) => item.key === capture.sourceKey);
  const minutes =
    slideShow?.active && slideShow.startedAt
      ? (Date.parse(download.capturedAt) - Date.parse(slideShow.startedAt)) / 60000
      : 0;
  if (!(capture.segmentCount > 0) || !(minutes >= Number(source?.newSessionAfterStandbyMinutes ?? 10))) {
    return null;
  }
  const oldPath = path.join(capture.sessionDir, 'segments', download.fileName);
  const sessionDir = await startNextSession(
    capture,
    `Standby slide for ${Math.round(minutes)} minutes: the meeting ended`,
    {
      standby: {
        startedAt: slideShow.startedAt,
        endedAt: download.capturedAt,
        discardedSegmentCount: slideShow.discardedSegmentCount
      }
    }
  );
  capture.lastObservedSegmentSequence = segment.sequence - 1;
  const newPath = path.join(sessionDir, 'segments', download.fileName);
  await rename(oldPath, newPath);
  console.log(`[live ${capture.id}] new meeting after ${Math.round(minutes)} minutes of standby | ${sessionDir}`);
  return newPath;
}

// Finishes the current session and continues in a new session folder beside it. The capture record is reset in
// place, so every caller holding it continues in the new session. `link` says why (a stream transition or standby).
export async function startNextSession(capture, reason, link) {
  const previousSessionDir = capture.sessionDir;
  const sessionDir = await createSessionDir(path.dirname(path.dirname(capture.sessionDir)), capture.id);
  capture.nextSessionDir = sessionDir;
  if (link.transition) capture.endedByTransition = link.transition;
  if (link.standby) capture.endedByStandby = link.standby;
  await completeCapture(capture, reason);

  const base = {
    id: capture.id,
    title: capture.title,
    duration: capture.duration,
    pageUrl: capture.pageUrl,
    livePageUrl: capture.livePageUrl,
    hlsUrl: capture.hlsUrl,
    sourceKey: capture.sourceKey,
    masterPlaylistUrl: capture.masterPlaylistUrl,
    mediaPlaylistUrl: capture.mediaPlaylistUrl,
    previousSessionDir,
    ...(link.transition ? { startedByTransition: link.transition } : {}),
    ...(link.standby ? { startedAfterStandby: link.standby } : {})
  };
  for (const key of Object.keys(capture)) {
    delete capture[key];
  }
  Object.assign(capture, buildCaptureRecord(base, sessionDir, new Date().toISOString()));
  await writeJsonAtomically(path.join(sessionDir, 'session.json'), capture);
  // The old session already holds everything it could recover up to here, so the new one starts right here without
  // backfill (walking back would only re-download the old session's video, or the standby slide).
  capture.initialBackfillCompleted = true;
  return sessionDir;
}

export async function completeCapture(capture, reason) {
  if (capture.status === 'complete') {
    return;
  }

  capture.status = 'complete';
  capture.completedAt = new Date().toISOString();
  capture.completionReason = reason;
  if (capture.streamIdentityLog?.current || capture.streamIdentityLog?.events?.length) {
    await writeStreamIdentityLog(capture);
  }
  await writeJsonAtomically(path.join(capture.sessionDir, 'session.json'), capture);
  console.log(`[live ${capture.id}] complete | ${reason}`);
}
