import fs from 'fs';
import path from 'path';
import { execFile as execFileCallback } from 'child_process';
import { mkdirChecked as mkdir } from './lib/ensure-mounted-volume.js';
import { fetchWithDefaults, isRobotsDisallowedError } from './lib/fetch.js';
import { LOCALE, STATE_ROOT, SOURCES, TOOLS } from './lib/runtime-config.js';
import { appendFile, readFile, rename, rm, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { parsePositiveIntegerArg, selectConfiguredSources } from './lib/cli.js';
import { fileExists, loadJson, removeStaleDownloadFiles, writeJsonAtomically } from './lib/fs-utils.js';
import { decodeHtmlEntities } from './lib/html.js';
import { endStream, isRedirectResponse, onceDrain, safeUrl } from './lib/http.js';
import { providerFor } from './providers/index.js';

const execFileAsync = promisify(execFileCallback);
// The streaming service's specifics (see scripts/providers): discovery, segment names, and standby slides.
const sourceProvider = (source) => providerFor(source);
const captureProvider = (capture) => providerFor(SOURCES.find((item) => item.key === capture?.sourceKey));

const defaultDiscoveryPollMs = 30000;
const defaultSegmentPollMs = 3000;
const defaultVideoPageRefreshMs = 30000;
const defaultCaptureStaleMs = 180000;
const quietProgressIntervalMs = 5000;
const repeatedQuietProgressIntervalMs = 30000;
const captureProgressIntervalMs = 30000;
const hlsRequestTimeoutMs = 15000;
const hlsSegmentTimeoutMs = 20000;
const hlsFetchRetries = 2;
const hlsRetryDelayMs = 500;
const initialBackfillMaxSegments = 90;
const silenceThresholdDb = -50;
const colorBarScanFps = 10;
const colorBarLookbackSegments = 2;
const visualTransitionScanFps = 30;
const visualTransitionThreshold = 60;
const pageRequestTimeoutMs = 30000;
const pageFetchRetries = 1;
const resumeRecentCaptureMs = 12 * 60 * 60 * 1000;
const maxRedirects = 10;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sources = selectConfiguredSources(SOURCES, options.sources, 'sources')
    .filter((source) => getMonitorUrls(source).length > 0);

  if (sources.length === 0) {
    throw new Error('No sources with liveUrls or discoveryUrls are configured in config.local.js');
  }

  await mkdir(STATE_ROOT, { recursive: true });
  await Promise.all(sources.map((source) => runSource(source, options)));
}

function parseArgs(args) {
  const options = {
    sources: [],
    pollMs: defaultDiscoveryPollMs,
    segmentPollMs: defaultSegmentPollMs,
    videoPageRefreshMs: defaultVideoPageRefreshMs,
    captureStaleMs: defaultCaptureStaleMs
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '').trim();

    if (arg === '--source') {
      const key = String(args[index + 1] || '').trim();
      if (!key) {
        throw new Error('Missing value for --source');
      }
      options.sources.push(key);
      index += 1;
      continue;
    }

    if (arg === '--poll-ms') {
      options.pollMs = parsePositiveIntegerArg(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--segment-poll-ms') {
      options.segmentPollMs = parsePositiveIntegerArg(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--video-page-refresh-ms') {
      options.videoPageRefreshMs = parsePositiveIntegerArg(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--capture-stale-ms') {
      options.captureStaleMs = parsePositiveIntegerArg(arg, args[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function runSource(source, options) {
  const sourceSlug = sanitizeSegment(source.key);
  const statePath = path.join(STATE_ROOT, `capture-${sourceSlug}-state.json`);
  const state = await loadJson(statePath, buildInitialState(source));
  state.sourceKey = source.key;
  state.sourceName = source.name;
  state.liveUrls = Array.isArray(source.liveUrls) ? source.liveUrls.slice() : [];
  state.discoveryUrls = Array.isArray(source.discoveryUrls) ? source.discoveryUrls.slice() : [];
  state.liveStorageDir = source.liveStorageDir;

  await mkdir(source.liveStorageDir, { recursive: true });
  const removedPartialCount = await removeStaleDownloadFiles(source.liveStorageDir);

  console.log(`Monitoring live source ${source.name} (${source.key}, ${source.provider}) into ${source.liveStorageDir}`);
  if (removedPartialCount > 0) {
    console.log(`Removed ${removedPartialCount.toLocaleString('en-US')} stale .download files`);
  }

  let currentLabel = `${source.key} | waiting`;
  let lastVisibleOutputAt = Date.now();
  let lastQuietHeartbeatLabel = '';
  let lastQuietHeartbeatAt = 0;

  const quietTimer = setInterval(() => {
    const now = Date.now();
    if (/\brecording$/.test(currentLabel) || currentLabel.includes('| discover')) {
      return;
    }
    if (now - lastVisibleOutputAt < quietProgressIntervalMs) {
      return;
    }

    if (currentLabel === lastQuietHeartbeatLabel && now - lastQuietHeartbeatAt < repeatedQuietProgressIntervalMs) {
      return;
    }

    console.log(`  Still working on ${currentLabel}`);
    lastVisibleOutputAt = now;
    lastQuietHeartbeatAt = now;
    lastQuietHeartbeatLabel = currentLabel;
  }, quietProgressIntervalMs);

  if (typeof quietTimer.unref === 'function') {
    quietTimer.unref();
  }

  let liveEntries = [];
  let lastDiscoveryAtMs = 0;

  try {
    while (true) {
      const cycleStartedAt = Date.now();
      const hasRecordingAtStart = Object.values(state.captures || {}).some((capture) => capture && capture.status === 'recording');
      const shouldDiscover = liveEntries.length === 0
        || !hasRecordingAtStart
        || Date.now() - lastDiscoveryAtMs >= options.pollMs;

      if (shouldDiscover) {
        try {
          liveEntries = await discoverLiveEntries(source, {
            onVisibleOutput: () => {
              lastVisibleOutputAt = Date.now();
            },
            setCurrentLabel: (value) => {
              currentLabel = value;
            }
          });
        } catch (error) {
          console.warn(`[${source.key}] discovery request failed; retrying | ${error?.message || error}`);
          await sleep(options.pollMs);
          continue;
        }
        lastDiscoveryAtMs = Date.now();
        await restoreRecentCaptureSessions(source, state, liveEntries);

        for (const entry of liveEntries) {
          await ensureCaptureSession(source, state, entry, {
            setCurrentLabel: (value) => {
              currentLabel = value;
            }
          });
        }
      }

      const activeIds = new Set(liveEntries.map((entry) => String(entry.id)));

      const captureIds = Object.keys(state.captures || {}).sort();
      for (const id of captureIds) {
        const capture = state.captures[id];
        if (!capture || capture.status === 'complete') {
          continue;
        }
        if (!activeIds.has(String(capture.id)) && /^\d+$/.test(String(capture.id))) {
          await completeCapture(capture, 'Archived video row is not a live stream');
          continue;
        }

        await pollCaptureSession(source, state, capture, {
          options,
          isListedLive: activeIds.has(String(capture.id)),
          onVisibleOutput: () => {
            lastVisibleOutputAt = Date.now();
          },
          setCurrentLabel: (value) => {
            currentLabel = value;
          }
        });
      }

      if (shouldDiscover) {
        state.scanner.lastDiscoveryAt = new Date(lastDiscoveryAtMs).toISOString();
      }
      state.scanner.lastActiveCount = liveEntries.length;
      state.scanner.updatedAt = state.scanner.lastDiscoveryAt;
      await writeJsonAtomically(statePath, state);

      const hasRecording = Object.values(state.captures || {}).some((capture) => capture && capture.status === 'recording');
      const elapsed = Date.now() - cycleStartedAt;
      const waitMs = hasRecording ? options.segmentPollMs : options.pollMs;
      currentLabel = hasRecording
        ? `${source.key} | ${countRecordingCaptures(state)} recording`
        : `${source.key} | waiting`;
      await sleep(Math.max(250, waitMs - elapsed));
    }
  } finally {
    clearInterval(quietTimer);
  }
}

function buildInitialState(source) {
  return {
    sourceKey: source.key,
    sourceName: source.name,
    liveUrls: Array.isArray(source.liveUrls) ? source.liveUrls.slice() : [],
    discoveryUrls: Array.isArray(source.discoveryUrls) ? source.discoveryUrls.slice() : [],
    liveStorageDir: source.liveStorageDir,
    scanner: {
      updatedAt: '',
      lastDiscoveryAt: '',
      lastActiveCount: 0
    },
    captures: {}
  };
}

function countRecordingCaptures(state) {
  return Object.values(state?.captures || {})
    .filter((capture) => capture && capture.status === 'recording')
    .length;
}

async function discoverLiveEntries(source, context) {
  const directPlaylistEntries = await discoverConfiguredLivePlaylists(source);
  if (directPlaylistEntries.length > 0) {
    return directPlaylistEntries;
  }

  const discovered = new Map();
  const seedUrls = getMonitorUrls(source).filter((url) => !/\.m3u8(?:\?|$)/i.test(url));
  const queue = seedUrls.slice();
  const visited = new Set();

  while (queue.length > 0) {
    const liveUrl = String(queue.shift() || '').trim();
    if (!liveUrl || visited.has(liveUrl)) {
      continue;
    }
    visited.add(liveUrl);
    context.setCurrentLabel?.(`${source.key} | discover ${visited.size}/${Math.max(queue.length + visited.size, seedUrls.length)}`);
    const fetchResult = await fetchWithRedirectCookies(liveUrl, {
      ...pageFetchOptions(),
      headers: {
        accept: 'text/html,*/*'
      }
    });
    const response = fetchResult.response;
    if (!response.ok) {
      throw new Error(`Live page returned ${response.status}: ${liveUrl}`);
    }

    const html = await response.text();
    context.onVisibleOutput?.();
    for (const candidateUrl of sourceProvider(source).candidatePageUrls(html, fetchResult.finalUrl, decodeHtmlEntities)) {
      if (!visited.has(candidateUrl) && !queue.includes(candidateUrl)) {
        queue.push(candidateUrl);
      }
    }
    for (const entry of await discoverEmbeddedLiveStreams(html, fetchResult.finalUrl, source)) {
      discovered.set(String(entry.id), entry);
    }
  }

  return Array.from(discovered.values()).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

async function discoverConfiguredLivePlaylists(source) {
  const entries = [];
  const urls = Array.isArray(source.liveUrls) ? source.liveUrls : [];
  for (const url of urls) {
    const playlistUrl = String(url || '').trim();
    if (!/\.m3u8(?:\?|$)/i.test(playlistUrl)) {
      continue;
    }
    try {
      const fetchResult = await fetchWithRedirectCookies(playlistUrl, {
        ...hlsFetchOptions(),
        headers: {
          accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*'
        }
      });
      if (!fetchResult.response.ok) {
        continue;
      }
      const text = await fetchResult.response.text();
      if (!/^#EXTM3U/m.test(text)) {
        continue;
      }
      entries.push(buildLiveStreamEntry(fetchResult.finalUrl, source));
    } catch {
      // Fall back to the public Watch Live page when the direct endpoint is unavailable.
    }
  }
  return entries;
}

async function discoverEmbeddedLiveStreams(html, baseUrl, source) {
  const entries = [];
  for (const playerUrl of sourceProvider(source).playerPageUrls(html, baseUrl, decodeHtmlEntities)) {
    const fetchResult = await fetchWithRedirectCookies(playerUrl, {
      ...pageFetchOptions(),
      headers: { accept: 'text/html,*/*' }
    });
    if (!fetchResult.response.ok) {
      continue;
    }
    const hlsUrl = extractHlsUrl(await fetchResult.response.text(), fetchResult.finalUrl);
    if (!hlsUrl) {
      continue;
    }
    entries.push(buildLiveStreamEntry(hlsUrl, source, fetchResult.finalUrl, baseUrl));
  }
  return entries;
}

function buildLiveStreamEntry(hlsUrl, source, pageUrl = hlsUrl, livePageUrl = '') {
  const parsed = safeUrl(hlsUrl);
  return {
    id: `live-${sanitizeSegment(`${parsed?.hostname || 'stream'}-${parsed?.pathname || 'live'}`)}`,
    title: 'Live stream',
    duration: '',
    pageUrl,
    livePageUrl: livePageUrl || source.discoveryUrls?.[0] || '',
    hlsUrl
  };
}

function getMonitorUrls(source) {
  return Array.from(new Set([
    ...(Array.isArray(source?.liveUrls) ? source.liveUrls : []),
    ...(Array.isArray(source?.discoveryUrls) ? source.discoveryUrls : [])
  ].map((item) => String(item || '').trim()).filter(Boolean)));
}

async function restoreRecentCaptureSessions(source, state, liveEntries) {
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
      `[live ${entry.id}] resuming stream ${recovered.currentStream?.identifier || 'unknown'}`
        + ` | cap ${formatDuration(recovered.currentStream?.capturedDurationSeconds)}`
        + ` | miss ${formatDuration(recovered.currentStream?.lostDurationSeconds)}`
        + ` | pos ${formatDuration(recovered.currentStream?.videoPositionSeconds)}`
        + ` | first capture ${formatEasternTime(recovered.currentStream?.startedAt)}`
        + ` | last capture ${formatEasternTime(recovered.currentStream?.lastSegmentAt)}`
        + ` | now ${formatEasternTime(new Date().toISOString())}`
    );
  }
}

async function loadRecentCaptureSession(source, liveEntry) {
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

function sameLiveVideo(session, liveEntry) {
  if (String(session?.id || '') === String(liveEntry.id || '')) {
    return true;
  }
  const sessionId = Number.parseInt(String(session?.id || ''), 10);
  if (sessionId === Number(liveEntry.id)) {
    return true;
  }
  return String(session?.pageUrl || '').includes(`/videos/${liveEntry.id}`);
}

async function loadSegmentManifest(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split(/\r?\n/)
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

async function loadDiscardedSegmentKeys(sessionDir) {
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

function calculateMissingDuration(segments) {
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

async function ensureCaptureSession(source, state, liveEntry, context) {
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
  const capture = buildCaptureRecord({
    id: liveEntry.id,
    title: liveEntry.title || '',
    duration: liveEntry.duration || '',
    pageUrl: liveEntry.pageUrl,
    livePageUrl: liveEntry.livePageUrl,
    hlsUrl: liveEntry.hlsUrl || '',
    sourceKey: source.key
  }, sessionDir, now);

  state.captures[key] = capture;
  await writeJsonAtomically(path.join(sessionDir, 'session.json'), capture);
  console.log(`[live ${liveEntry.id}] started ${liveEntry.title || 'live stream'}`);
  context.setCurrentLabel?.(`[live ${liveEntry.id}] started`);
  return capture;
}

async function createSessionDir(liveStorageDir, captureId) {
  const sessionDir = path.join(liveStorageDir, String(captureId), formatSnapshotTimestamp(new Date()));
  await mkdir(path.join(sessionDir, 'segments'), { recursive: true });
  await mkdir(path.join(sessionDir, 'playlists'), { recursive: true });
  return sessionDir;
}

// A fresh session record. `base` carries what stays the same across sessions of one live stream.
function buildCaptureRecord(base, sessionDir, now) {
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

async function pollCaptureSession(source, state, capture, context) {
  initializeCaptureMetrics(capture);
  try {
    await pollCaptureSessionOnce(source, state, capture, context);
  } catch (error) {
    const now = new Date().toISOString();
    capture.lastErrorAt = now;
    capture.lastErrorMessage = String(error?.message || error || 'Unknown capture error');

    // A service can retire a live endpoint when a stream moves to a different host or
    // channel.  Once the listing no longer advertises the capture and no new
    // segments have arrived, finalize it instead of retrying a dead URL forever.
    const staleMs = Number(context.options.captureStaleMs || defaultCaptureStaleMs);
    if (!context.isListedLive && isCaptureStale(capture, staleMs)) {
      await completeCapture(capture, `Live listing disappeared and the stream stopped responding | ${capture.lastErrorMessage}`);
      state.scanner.updatedAt = now;
      return;
    }

    reportCaptureError(capture);
    await writeJsonAtomically(path.join(capture.sessionDir, 'session.json'), capture);
    state.scanner.updatedAt = now;
  }
}

async function pollCaptureSessionOnce(source, state, capture, context) {
  const now = Date.now();
  const staleMs = Number(context.options.captureStaleMs || defaultCaptureStaleMs);
  context.setCurrentLabel?.(`[${capture.id}] decide`);

  const shouldRefreshVideoPage = !capture.lastVideoPageFetchAt
    || now - Date.parse(capture.lastVideoPageFetchAt) >= Number(context.options.videoPageRefreshMs || defaultVideoPageRefreshMs)
    || !capture.mediaPlaylistUrl;
  let videoPageHtml = '';

  if (shouldRefreshVideoPage && !capture.hlsUrl) {
    context.setCurrentLabel?.(`[${capture.id}] fetch video page`);
    const pageData = await fetchLiveVideoPage(capture.pageUrl);
    context.onVisibleOutput?.();
    capture.lastVideoPageFetchAt = new Date().toISOString();
    capture.title = pageData.meetingTitle || capture.title || '';
    capture.hlsUrl = pageData.hlsUrl || capture.hlsUrl || '';
    capture.pageUrl = pageData.finalUrl || capture.pageUrl;
    videoPageHtml = pageData.html;
  }

  if (shouldRefreshVideoPage && capture.hlsUrl) {
    const stream = await resolveHlsStream(capture.hlsUrl);
    capture.lastVideoPageFetchAt = new Date().toISOString();
    capture.masterPlaylistUrl = stream.masterPlaylistUrl || capture.masterPlaylistUrl || '';
    capture.mediaPlaylistUrl = stream.mediaPlaylistUrl || capture.mediaPlaylistUrl || '';
    capture.endListSeen = Boolean(stream.endList);
    if (videoPageHtml) {
      await writeTextAtomically(path.join(capture.sessionDir, 'video-page.html'), videoPageHtml);
    }
    if (stream.masterPlaylistText) {
      await writeTextAtomically(path.join(capture.sessionDir, 'playlists', 'master.m3u8'), stream.masterPlaylistText);
    }
    if (stream.mediaPlaylistText) {
      await writeTextAtomically(path.join(capture.sessionDir, 'playlists', 'latest.m3u8'), stream.mediaPlaylistText);
    }
    if (stream.endList && capture.segmentCount === 0) {
      await completeCapture(capture, 'Playlist was already ended when capture began');
      return;
    }
  }

  if (!capture.mediaPlaylistUrl) {
    if (!context.isListedLive && isCaptureStale(capture, staleMs)) {
      await completeCapture(capture, 'No playlist was exposed before the live listing disappeared');
    }
    await writeJsonAtomically(path.join(capture.sessionDir, 'session.json'), capture);
    return;
  }

  context.setCurrentLabel?.(`[${capture.id}] fetch playlist`);
  const playlistResult = await fetchMediaPlaylist(capture.mediaPlaylistUrl);
  context.onVisibleOutput?.();
  capture.lastPlaylistFetchAt = new Date().toISOString();
  capture.endListSeen = playlistResult.endList;
  await writeTextAtomically(path.join(capture.sessionDir, 'playlists', 'latest.m3u8'), playlistResult.text);

  const knownKeys = new Set([
    ...(Array.isArray(capture.downloadedSegmentKeys) ? capture.downloadedSegmentKeys : []),
    ...(Array.isArray(capture.discardedSegmentKeys) ? capture.discardedSegmentKeys : [])
  ]);
  let newSegments = await captureInitialBackfill(playlistResult.segments, capture, knownKeys, context);

  for (const segment of playlistResult.segments) {
    if (knownKeys.has(segment.key)) {
      continue;
    }

    // A new segment identifier may start a new session; the old one is finished first, up to this segment.
    if (await rotateSessionOnIdentityChange(segment, capture, context)) {
      knownKeys.clear();
    }
    // Fill any hole before this segment (after a restart, a network drop, or a skipped sequence number).
    newSegments += await captureGapBackfill([segment], capture, knownKeys, context);

    context.setCurrentLabel?.(`[${capture.id}] segment ${capture.segmentCount + 1}`);
    const download = await downloadSegment(segment, capture, context);
    const retained = await processDownloadedSegment(segment, download, capture, knownKeys);
    newSegments += retained ? 1 : 0;
  }

  if (!capture.slideShow?.active) {
    reportCaptureProgress(capture, newSegments > 0 ? 'capturing' : 'caught up; awaiting new stream data');
  }

  if (capture.endListSeen) {
    await completeCapture(capture, 'Playlist ended');
  } else if (!context.isListedLive && isCaptureStale(capture, staleMs)) {
    await completeCapture(
      capture,
      'Live listing disappeared and no new segments arrived'
    );
  }

  await writeJsonAtomically(path.join(capture.sessionDir, 'session.json'), capture);
  state.scanner.updatedAt = new Date().toISOString();
}

async function fetchLiveVideoPage(pageUrl) {
  const fetchResult = await fetchWithRedirectCookies(pageUrl, {
    ...pageFetchOptions(),
    headers: {
      accept: 'text/html,*/*'
    }
  });
  const response = fetchResult.response;
  if (!response.ok) {
    throw new Error(`Video page returned ${response.status}`);
  }

  const html = await response.text();
  return {
    html,
    finalUrl: fetchResult.finalUrl,
    hlsUrl: extractHlsUrl(html, fetchResult.finalUrl),
    meetingTitle: extractMeetingTitle(html, pageUrl)
  };
}

function extractHlsUrl(html, baseUrl) {
  const patterns = [
    /\{\s*type:\s*"application\/x-mpegurl"\s*,\s*src:\s*"([^"]+)"/gi,
    /source\s+src="([^"]+\.m3u8[^"]*)"/gi,
    /"([^"]+\.m3u8[^"]*)"/gi
  ];

  for (const pattern of patterns) {
    for (const match of String(html || '').matchAll(pattern)) {
      const candidate = String(match[1] || '').trim().replace(/\\\//g, '/');
      if (!candidate || !/\.m3u8\b/i.test(candidate)) {
        continue;
      }

      try {
        return new URL(candidate, baseUrl).toString();
      } catch {
        continue;
      }
    }
  }

  return '';
}

async function resolveHlsStream(hlsUrl) {
  const fetchResult = await fetchWithRedirectCookies(hlsUrl, {
    ...hlsFetchOptions(),
    headers: {
      accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*'
    }
  });
  const response = fetchResult.response;
  if (!response.ok) {
    throw new Error(`HLS playlist returned ${response.status}`);
  }

  const masterPlaylistText = await response.text();
  const finalUrl = fetchResult.finalUrl;
  if (/#EXT-X-STREAM-INF/i.test(masterPlaylistText)) {
    const variants = parseVariantPlaylist(masterPlaylistText, finalUrl);
    if (variants.length === 0) {
      throw new Error('No variant playlists were found in the HLS master playlist');
    }

    variants.sort((left, right) => right.bandwidth - left.bandwidth);
    const selected = variants[0];
    const media = await fetchMediaPlaylist(selected.url);
    return {
      masterPlaylistUrl: finalUrl,
      masterPlaylistText,
      mediaPlaylistUrl: selected.url,
      mediaPlaylistText: media.text,
      endList: media.endList
    };
  }

  return {
    masterPlaylistUrl: '',
    masterPlaylistText,
    mediaPlaylistUrl: finalUrl,
    mediaPlaylistText: masterPlaylistText,
    endList: /#EXT-X-ENDLIST/i.test(masterPlaylistText)
  };
}

function parseVariantPlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) {
      continue;
    }

    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
    let nextIndex = index + 1;
    while (nextIndex < lines.length && (!lines[nextIndex] || lines[nextIndex].startsWith('#'))) {
      nextIndex += 1;
    }

    if (nextIndex >= lines.length) {
      continue;
    }

    const nextLine = lines[nextIndex].trim();
    try {
      variants.push({
        bandwidth: Number(bandwidthMatch?.[1] || 0),
        url: new URL(nextLine, baseUrl).toString()
      });
    } catch {
      continue;
    }
  }

  return variants;
}

async function fetchMediaPlaylist(url) {
  const fetchResult = await fetchWithRedirectCookies(url, {
    ...hlsFetchOptions(),
    headers: {
      accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*'
    }
  });
  const response = fetchResult.response;
  if (!response.ok) {
    throw new Error(`Media playlist returned ${response.status}`);
  }

  const text = await response.text();
  return {
    url: fetchResult.finalUrl,
    text,
    endList: /#EXT-X-ENDLIST/i.test(text),
    segments: parseMediaPlaylistSegments(text, fetchResult.finalUrl)
  };
}

function parseMediaPlaylistSegments(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const segments = [];
  let nextDuration = 0;
  let mediaSequence = 0;
  let sequenceOffset = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.split(':')[1], 10) || 0;
      sequenceOffset = 0;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      nextDuration = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const absoluteUrl = new URL(line, baseUrl).toString();
    const sequence = mediaSequence + sequenceOffset;
    sequenceOffset += 1;
    segments.push({
      sequence,
      durationSeconds: nextDuration,
      url: absoluteUrl,
      key: `${sequence}|${absoluteUrl}`
    });
    nextDuration = 0;
  }

  return segments;
}

async function downloadSegment(segment, capture, context) {
  const parsed = safeUrl(segment.url);
  const ext = path.extname(parsed?.pathname || '') || '.ts';
  const fileName = `${String(segment.sequence).padStart(6, '0')}${ext}`;
  const destinationPath = path.join(capture.sessionDir, 'segments', fileName);
  const partialPath = `${destinationPath}.download`;

  const retries = Number.isFinite(context.maxRetries) ? context.maxRetries : hlsFetchRetries;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const fetchResult = await fetchWithRedirectCookies(segment.url, {
        ...hlsFetchOptions(hlsSegmentTimeoutMs, 0, context.rateProfile),
        headers: {
          accept: '*/*'
        }
      });
      const response = fetchResult.response;
      if (!response.ok) {
        throw new Error(`Segment returned ${response.status}: ${segment.url}`);
      }

      await rm(partialPath, { force: true });
      const bytes = await streamResponseToFile(response, partialPath, {
        onVisibleOutput: context.onVisibleOutput
      });
      await rename(partialPath, destinationPath);
      return {
        capturedAt: new Date().toISOString(),
        fileName,
        bytes
      };
    } catch (error) {
      await rm(partialPath, { force: true });
      if (attempt >= retries) {
        throw error;
      }
      await sleep(hlsRetryDelayMs * (attempt + 1));
    }
  }

  throw new Error(`Unable to download segment: ${segment.url}`);
}

// The live playlist lists only the newest ~30 seconds, but the server keeps roughly 4 minutes of earlier
// segments (about 23 more, measured October 2026). Segment numbers are sequential, so earlier ones are
// fetched by walking backwards from the playlist's first segment until the server returns 404.

// When a new session starts mid-meeting, recover whatever earlier segments the server still has.
async function captureInitialBackfill(segments, capture, knownKeys, context) {
  if (capture.initialBackfillCompleted || !Array.isArray(segments) || segments.length === 0) {
    return 0;
  }

  capture.initialBackfillCompleted = true;
  return await downloadPriorSegments(segments[0], initialBackfillMaxSegments, capture, knownKeys, context, 'startup backfill');
}

// Recovers the segments between the last one captured and `segments[0]`, as far back as the server still has
// them: after a restart, a network drop, or a sequence number skipped when the stream identifier renews (Swagit).
async function captureGapBackfill(segments, capture, knownKeys, context) {
  const first = Array.isArray(segments) ? segments[0] : null;
  const lastSeen = Number(capture.lastObservedSegmentSequence);
  if (!first || !Number.isFinite(lastSeen) || lastSeen < 0 || first.sequence <= lastSeen + 1) {
    return 0;
  }
  const missingCount = first.sequence - lastSeen - 1;
  return await downloadPriorSegments(first, Math.min(missingCount, initialBackfillMaxSegments), capture, knownKeys, context, `gap backfill (${missingCount} missing)`);
}

// Downloads up to `maxSegments` segments before `first`, newest first, stopping at the first 404, then
// records them oldest first so sequence and lost-time bookkeeping stay in order.
async function downloadPriorSegments(first, maxSegments, capture, knownKeys, context, label) {
  const recovered = [];
  for (const segment of buildPriorSegmentCandidates(first, maxSegments, capture)) {
    if (knownKeys.has(segment.key)) {
      continue;
    }
    try {
      const download = await downloadSegment(segment, capture, {
        ...context,
        maxRetries: 0,
        rateProfile: 'liveBackfill'
      });
      recovered.push({ segment, download });
    } catch (error) {
      if (/Segment returned 404:/i.test(String(error?.message || error))) {
        break;
      }
      throw error;
    }
  }

  recovered.reverse();
  let retainedCount = 0;
  for (const { segment, download } of recovered) {
    if (await processDownloadedSegment(segment, download, capture, knownKeys)) {
      retainedCount += 1;
    }
  }

  if (recovered.length > 0) {
    console.log(`[live ${formatCaptureLabel(capture)}] ${label}: recovered ${recovered.length} segment${recovered.length === 1 ? '' : 's'}`);
  }
  return retainedCount;
}

// Providers whose segment names carry a stream identifier: Swagit renews it (media-<id>_<n>.ts) about hourly and skips one sequence number
// when it does. The server serves any segment number under any identifier, so the skipped number is still
// recoverable (the gap backfill fetches it). With sources[].splitOnStreamIdentifierChange (default on),
// each identifier is recorded as its own session, linked through previousSessionDir / nextSessionDir.
async function rotateSessionOnIdentityChange(segment, capture, context) {
  const incoming = parseStreamIdentity(segment.url, capture);
  const current = capture.streamIdentityLog?.current;
  if (!incoming || !current?.identifier || incoming.identifier === current.identifier
    || !(segment.sequence > Number(capture.lastObservedSegmentSequence))) {
    return false;
  }
  const source = SOURCES.find((item) => item.key === capture.sourceKey);
  if (source && !source.splitOnStreamIdentifierChange) {
    return false;
  }

  // Finish the old stream: segments after the last one captured may still be served under the old identifier.
  await downloadTrailingSegments(segment, current, capture, context);

  const previousSessionDir = capture.sessionDir;
  const sessionDir = await createSessionDir(path.dirname(path.dirname(capture.sessionDir)), capture.id);
  const transition = {
    from: current.identifier,
    fromLastSequence: current.lastSequence,
    to: incoming.identifier,
    toFirstSequence: segment.sequence,
    detectedAt: new Date().toISOString()
  };
  capture.nextSessionDir = sessionDir;
  capture.endedByTransition = transition;
  await completeCapture(capture, `Stream identifier changed (${transition.from} -> ${transition.to})`);

  // Reset the same record in place, so every caller holding it continues in the new session.
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
    startedByTransition: transition
  };
  for (const key of Object.keys(capture)) {
    delete capture[key];
  }
  Object.assign(capture, buildCaptureRecord(base, sessionDir, transition.detectedAt));
  await writeJsonAtomically(path.join(sessionDir, 'session.json'), capture);
  // The old session already holds everything it could recover up to this segment, so the new one starts
  // right here without backfill (walking back would only re-download the old session's video).
  capture.initialBackfillCompleted = true;
  capture.lastObservedSegmentSequence = segment.sequence - 1;
  console.log(`[live ${capture.id}] new session for stream ${transition.to} | ${sessionDir}`);
  return true;
}

// Walks forward from the old stream's last captured segment toward `nextSegment`, under the old identifier.
async function downloadTrailingSegments(nextSegment, current, capture, context) {
  const knownKeys = new Set([...(capture.downloadedSegmentKeys || []), ...(capture.discardedSegmentKeys || [])]);
  let recovered = 0;
  for (let sequence = Number(current.lastSequence) + 1; sequence < nextSegment.sequence; sequence += 1) {
    const url = captureProvider(capture).segmentUrl(nextSegment.url, sequence, current.filePrefix);
    if (!url) break;
    const segment = { sequence, durationSeconds: nextSegment.durationSeconds, url, key: `${sequence}|${url}` };
    if (knownKeys.has(segment.key)) {
      continue;
    }
    try {
      const download = await downloadSegment(segment, capture, { ...context, maxRetries: 0, rateProfile: 'liveBackfill' });
      await processDownloadedSegment(segment, download, capture, knownKeys);
      recovered += 1;
    } catch (error) {
      if (/Segment returned 404:/i.test(String(error?.message || error))) {
        break;
      }
      throw error;
    }
  }
  if (recovered > 0) {
    console.log(`[live ${formatCaptureLabel(capture)}] end of stream ${current.identifier}: recovered ${recovered} trailing segment${recovered === 1 ? '' : 's'}`);
  }
}

// Earlier segments of the same stream, by name (how a name is built depends on the provider).
function buildPriorSegmentCandidates(segment, maxSegments, capture) {
  const provider = captureProvider(capture);
  const sequence = Number(segment?.sequence);
  if (!provider.segmentUrl(segment?.url, sequence) || !Number.isFinite(sequence) || sequence < 1) {
    return [];
  }

  const candidates = [];
  for (let offset = 1; offset <= maxSegments && sequence - offset >= 0; offset += 1) {
    const priorSequence = sequence - offset;
    const url = provider.segmentUrl(segment.url, priorSequence);
    candidates.push({
      sequence: priorSequence,
      durationSeconds: segment.durationSeconds,
      url,
      key: `${priorSequence}|${url}`
    });
  }
  return candidates;
}

async function processDownloadedSegment(segment, download, capture, knownKeys) {
  const segmentPath = path.join(capture.sessionDir, 'segments', download.fileName);
  // Providers can recognize segments not worth keeping (Swagit's silent standby slide).
  const disposition = await captureProvider(capture).classifySegment(segmentPath, segment.durationSeconds, { readMaxVolumeDb: readSegmentMaxVolumeDb });
  if (disposition.discard) {
    await discardCapturedSegment(segment, download, capture, knownKeys, disposition);
    return false;
  }
  await resumeFromSlideShow(capture, download);
  await recordCapturedSegment(segment, download, capture, knownKeys, disposition.maxVolumeDb);
  return true;
}

async function recordCapturedSegment(segment, download, capture, knownKeys, maxVolumeDb = null) {
  knownKeys.add(segment.key);
  capture.downloadedSegmentKeys.push(segment.key);
  capture.segmentCount += 1;
  capture.bytesCaptured += download.bytes;
  capture.capturedDurationSeconds += Number(segment.durationSeconds || 0);
  if (Number.isFinite(capture.lastObservedSegmentSequence) && segment.sequence > capture.lastObservedSegmentSequence + 1) {
    capture.lostDurationSeconds += (segment.sequence - capture.lastObservedSegmentSequence - 1) * Number(segment.durationSeconds || 0);
  }
  capture.lastSegmentSequence = segment.sequence;
  capture.lastObservedSegmentSequence = segment.sequence;
  capture.videoPositionSeconds = capture.capturedDurationSeconds + capture.lostDurationSeconds;
  capture.lastSegmentAt = download.capturedAt;
  capture.lastObservedAt = download.capturedAt;
  await appendJsonLine(path.join(capture.sessionDir, 'segments.jsonl'), {
    capturedAt: download.capturedAt,
    sequence: segment.sequence,
    durationSeconds: segment.durationSeconds,
    key: segment.key,
    sourceUrl: segment.url,
    fileName: download.fileName,
    bytes: download.bytes
  });
  const streamStarted = updateCurrentStreamMetrics(capture, segment, download);
  await updateStreamIdentityLog(segment, download, capture);
  if (streamStarted) {
    console.log(
      `[live ${formatCaptureLabel(capture)}] stream started`
        + ` | first capture ${formatEasternTime(capture.currentStream.startedAt)}`
        + ` | seq ${capture.currentStream.firstSequence}`
    );
  }
  rememberRecentSegment(capture, segment, download);
  await updateSilenceLog(segment, download, capture, maxVolumeDb);
}

async function discardCapturedSegment(segment, download, capture, knownKeys, disposition) {
  knownKeys.add(segment.key);
  capture.discardedSegmentKeys = Array.isArray(capture.discardedSegmentKeys) ? capture.discardedSegmentKeys : [];
  capture.discardedSegmentKeys.push(segment.key);
  capture.discardedSegmentCount = Number(capture.discardedSegmentCount || 0) + 1;
  capture.discardedDurationSeconds = Number(capture.discardedDurationSeconds || 0) + Number(segment.durationSeconds || 0);
  capture.lastObservedSegmentSequence = segment.sequence;
  const slideShow = initializeSlideShow(capture);
  if (!slideShow.active) {
    slideShow.active = true;
    slideShow.startedAt = download.capturedAt;
    slideShow.startSequence = segment.sequence;
    slideShow.discardedSegmentCount = 0;
    slideShow.discardedDurationSeconds = 0;
    capture.currentStream = null;
    capture.lastProgressOutputAt = '';
    console.log(
      `[live ${formatCaptureLabel(capture)}] video appears to have transitioned to a slide show`
      + ` | ${formatEasternTime(download.capturedAt)} | capture metrics reset`
    );
  }
  slideShow.discardedSegmentCount += 1;
  slideShow.discardedDurationSeconds += Number(segment.durationSeconds || 0);
  await appendJsonLine(path.join(capture.sessionDir, 'discarded-segments.jsonl'), {
    capturedAt: download.capturedAt,
    sequence: segment.sequence,
    durationSeconds: segment.durationSeconds,
    key: segment.key,
    sourceUrl: segment.url,
    fileName: download.fileName,
    bytes: download.bytes,
    reason: disposition.reason,
    maxVolumeDb: disposition.maxVolumeDb,
    slideSamples: disposition.samples
  });
  capture.lastObservedAt = download.capturedAt;
  await rm(path.join(capture.sessionDir, 'segments', download.fileName), { force: true });
  return false;
}

async function resumeFromSlideShow(capture, download) {
  const slideShow = initializeSlideShow(capture);
  if (!slideShow.active) return;
  console.log(
    `[live ${formatCaptureLabel(capture)}] video resumed from slide show`
      + ` | discarded ${slideShow.discardedSegmentCount} segments (${formatDuration(slideShow.discardedDurationSeconds)})`
      + ` | ${formatEasternTime(download.capturedAt)} | capture metrics reset`
  );
  slideShow.active = false;
  slideShow.endedAt = download.capturedAt;
  slideShow.endSequence = null;
  capture.currentStream = null;
  capture.lastProgressOutputAt = '';
}

function updateCurrentStreamMetrics(capture, segment, download) {
  const identity = parseStreamIdentity(segment.url, capture);
  const identifier = identity?.identifier || 'unknown';
  const current = capture.currentStream;
  const streamStarted = !current || current.identifier !== identifier;
  if (streamStarted) {
    capture.currentStream = {
      identifier,
      filePrefix: identity?.filePrefix || 'unknown',
      startedAt: download.capturedAt,
      firstSequence: segment.sequence,
      lastSegmentAt: '',
      lastSegmentSequence: null,
      segmentCount: 0,
      bytesCaptured: 0,
      capturedDurationSeconds: 0,
      lostDurationSeconds: 0,
      videoPositionSeconds: 0
    };
  }

  const stream = capture.currentStream;
  stream.segmentCount += 1;
  stream.bytesCaptured += Number(download.bytes || 0);
  stream.capturedDurationSeconds += Number(segment.durationSeconds || 0);
  if (Number.isFinite(stream.lastSegmentSequence) && segment.sequence > stream.lastSegmentSequence + 1) {
    stream.lostDurationSeconds += (segment.sequence - stream.lastSegmentSequence - 1) * Number(segment.durationSeconds || 0);
  }
  stream.lastSegmentSequence = segment.sequence;
  stream.lastSegmentAt = download.capturedAt;
  stream.videoPositionSeconds = stream.capturedDurationSeconds + stream.lostDurationSeconds;
  return streamStarted;
}

function restoreCurrentStreamMetrics(capture, manifest) {
  const last = manifest.at(-1);
  const identity = parseStreamIdentity(last?.sourceUrl, capture);
  if (!identity) {
    return;
  }
  const entries = [];
  for (let index = manifest.length - 1; index >= 0; index -= 1) {
    const entry = manifest[index];
    if (parseStreamIdentity(entry.sourceUrl, capture)?.identifier !== identity.identifier) {
      break;
    }
    entries.unshift(entry);
  }
  capture.currentStream = null;
  for (const entry of entries) {
    updateCurrentStreamMetrics(capture, {
      sequence: entry.sequence,
      durationSeconds: entry.durationSeconds,
      url: entry.sourceUrl
    }, {
      bytes: entry.bytes,
      capturedAt: entry.capturedAt
    });
  }
}

async function updateStreamIdentityLog(segment, download, capture) {
  const identity = parseStreamIdentity(segment.url, capture);
  if (!identity) {
    return;
  }

  const log = initializeStreamIdentityLog(capture);
  const previous = log.current;
  if (previous && previous.identifier !== identity.identifier) {
    const sequenceGap = Math.max(0, Number(segment.sequence) - Number(previous.lastSequence) - 1);
    const event = {
      type: 'stream-identity-change',
      from: previous.identifier,
      fromFilePrefix: previous.filePrefix,
      fromLastSequence: previous.lastSequence,
      fromLastCapturedAt: previous.lastCapturedAt,
      to: identity.identifier,
      toFilePrefix: identity.filePrefix,
      toFirstSequence: segment.sequence,
      toFirstCapturedAt: download.capturedAt,
      missingSequenceCount: sequenceGap,
      wallClockGapSeconds: calculateWallClockGapSeconds(previous.lastCapturedAt, download.capturedAt),
      detectedAt: new Date().toISOString(),
      note: 'A changed media stream identifier is a definite upstream source or encoder transition.'
    };
    log.events.push(event);
    console.log(
      `[live ${formatCaptureLabel(capture)}] stream transition ${event.from} -> ${event.to}`
        + ` | seq ${event.fromLastSequence} -> ${event.toFirstSequence}`
        + ` | ${formatEasternTime(download.capturedAt)}`
    );
  }

  log.current = {
    identifier: identity.identifier,
    filePrefix: identity.filePrefix,
    firstSequence: previous?.identifier === identity.identifier ? previous.firstSequence : segment.sequence,
    firstCapturedAt: previous?.identifier === identity.identifier ? previous.firstCapturedAt : download.capturedAt,
    lastSequence: segment.sequence,
    lastCapturedAt: download.capturedAt
  };
  await writeStreamIdentityLog(capture, log);
}

// The stream identifier in a segment address (for providers whose segment names carry one), or null.
function parseStreamIdentity(value, capture) {
  return captureProvider(capture).segmentIdentity(value);
}

function initializeStreamIdentityLog(capture) {
  if (!capture.streamIdentityLog || typeof capture.streamIdentityLog !== 'object') {
    capture.streamIdentityLog = {};
  }
  capture.streamIdentityLog.events = Array.isArray(capture.streamIdentityLog.events)
    ? capture.streamIdentityLog.events
    : [];
  capture.streamIdentityLog.current = capture.streamIdentityLog.current || null;
  return capture.streamIdentityLog;
}

function restoreStreamIdentityLog(capture, manifest) {
  const log = initializeStreamIdentityLog(capture);
  if (log.current) {
    return;
  }
  const last = [...manifest].reverse().find((item) => parseStreamIdentity(item.sourceUrl, capture));
  const identity = parseStreamIdentity(last?.sourceUrl, capture);
  if (!identity) {
    return;
  }
  log.current = {
    identifier: identity.identifier,
    filePrefix: identity.filePrefix,
    firstSequence: last.sequence,
    firstCapturedAt: last.capturedAt,
    lastSequence: last.sequence,
    lastCapturedAt: last.capturedAt
  };
}

async function writeStreamIdentityLog(capture, log = initializeStreamIdentityLog(capture)) {
  await writeJsonAtomically(path.join(capture.sessionDir, 'stream-identity-transitions.json'), {
    sourceKey: capture.sourceKey || '',
    videoId: capture.id,
    streamUrl: capture.hlsUrl || '',
    current: log.current,
    events: log.events
  });
}

function calculateWallClockGapSeconds(previous, current) {
  const difference = Date.parse(current || '') - Date.parse(previous || '');
  return Number.isFinite(difference) ? Math.max(0, difference / 1000) : null;
}

function rememberRecentSegment(capture, segment, download) {
  capture.recentSegments = Array.isArray(capture.recentSegments) ? capture.recentSegments : [];
  capture.recentSegments.push({
    sequence: segment.sequence,
    durationSeconds: segment.durationSeconds,
    fileName: download.fileName,
    capturedAt: download.capturedAt
  });
  capture.recentSegments = capture.recentSegments.slice(-(colorBarLookbackSegments + 1));
}

async function updateSilenceLog(segment, download, capture, knownMaxVolumeDb = null) {
  const segmentPath = path.join(capture.sessionDir, 'segments', download.fileName);
  const maxVolumeDb = typeof knownMaxVolumeDb === 'number' && !Number.isNaN(knownMaxVolumeDb)
    ? knownMaxVolumeDb
    : await readSegmentMaxVolumeDb(segmentPath);
  if (maxVolumeDb === null) {
    return;
  }

  const silence = initializeSilenceLog(capture);
  const isSilent = maxVolumeDb <= silence.thresholdDb;
  const endSeconds = Number(capture.videoPositionSeconds || 0);
  const startSeconds = Math.max(0, endSeconds - Number(segment.durationSeconds || 0));

  let silenceStarted = false;
  let silenceEnded = false;
  if (isSilent && !silence.activePeriod) {
    silenceStarted = true;
    silence.activePeriod = {
      startSeconds,
      startLabel: formatDuration(startSeconds),
      startedAt: download.capturedAt,
      startSequence: segment.sequence,
      endSeconds: null,
      endLabel: '',
      endedAt: '',
      endSequence: null
    };
  } else if (!isSilent && silence.activePeriod) {
    silenceEnded = true;
    silence.activePeriod.endSeconds = startSeconds;
    silence.activePeriod.endLabel = formatDuration(startSeconds);
    silence.activePeriod.endedAt = download.capturedAt;
    silence.activePeriod.endSequence = segment.sequence - 1;
    silence.activePeriod.durationSeconds = Math.max(0, startSeconds - silence.activePeriod.startSeconds);
    silence.periods.push(silence.activePeriod);
    silence.activePeriod = null;
  }

  await recordColorBarTransitions(capture, {
    includePriorSegments: silenceStarted || silenceEnded,
    scanCurrentSegment: isSilent || silenceStarted || silenceEnded
  });

  await writeJsonAtomically(path.join(capture.sessionDir, 'silence-boundaries.json'), {
    sourceKey: capture.sourceKey || '',
    videoId: capture.id,
    streamUrl: capture.hlsUrl || '',
    thresholdDb: silence.thresholdDb,
    generatedAt: new Date().toISOString(),
    periods: silence.periods,
    activePeriod: silence.activePeriod,
    note: 'Times are relative to the captured video timeline; an activePeriod has not yet been followed by audible audio.'
  });
}

async function recordColorBarTransitions(capture, options = {}) {
  const log = initializeColorBarLog(capture);
  const recent = Array.isArray(capture.recentSegments) ? capture.recentSegments : [];
  const candidates = options.includePriorSegments
    ? recent
    : options.scanCurrentSegment
      ? recent.slice(-1)
      : [];

  for (const segment of candidates) {
    if (!segment || log.events.some((event) => Number(event.sequence) === Number(segment.sequence))) {
      continue;
    }
    const filePath = path.join(capture.sessionDir, 'segments', segment.fileName);
    const colorBarOffsets = await findColorBarOffsets(filePath);
    const visualTransitionOffsets = await findAbruptVisualTransitionOffsets(filePath);
    const detections = [
      ...colorBarOffsets.slice(0, 1).map((offsetSeconds) => ({
        offsetSeconds,
        type: 'color-bars',
        note: 'SMPTE-style color bars detected during a silent-boundary scan.'
      })),
      ...visualTransitionOffsets.map((offsetSeconds) => ({
        offsetSeconds,
        type: 'visual-source-transition',
        note: 'Abrupt visual-source transition detected during a silent-boundary scan.'
      }))
    ];
    if (detections.length === 0) {
      continue;
    }
    const current = recent.at(-1);
    const currentEndSeconds = Number(capture.videoPositionSeconds || 0);
    const sequenceDistance = Number(current?.sequence || 0) - Number(segment.sequence || 0);
    const segmentStartSeconds = Math.max(
      0,
      currentEndSeconds - Number(current?.durationSeconds || 0) - (sequenceDistance * Number(segment.durationSeconds || 0))
    );
    for (const detection of detections) {
      log.events.push({
        type: detection.type,
        sequence: segment.sequence,
        fileName: segment.fileName,
        capturedAt: segment.capturedAt,
        detectedOffsetSeconds: detection.offsetSeconds,
        videoTimelineSeconds: segmentStartSeconds + detection.offsetSeconds,
        videoTimelineLabel: formatDuration(segmentStartSeconds + detection.offsetSeconds),
        detectedAt: new Date().toISOString(),
        note: detection.note
      });
    }
  }

  if (log.events.length > 0) {
    await writeJsonAtomically(path.join(capture.sessionDir, 'color-bar-transitions.json'), {
      sourceKey: capture.sourceKey || '',
      videoId: capture.id,
      streamUrl: capture.hlsUrl || '',
      scanFramesPerSecond: colorBarScanFps,
      visualTransitionScanFramesPerSecond: visualTransitionScanFps,
      events: log.events
    });
  }
}

function initializeColorBarLog(capture) {
  if (!capture.colorBarLog || typeof capture.colorBarLog !== 'object') {
    capture.colorBarLog = {};
  }
  capture.colorBarLog.events = Array.isArray(capture.colorBarLog.events) ? capture.colorBarLog.events : [];
  return capture.colorBarLog;
}

async function findColorBarOffsets(filePath) {
  try {
    const { stdout } = await execFileAsync(TOOLS.ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-vf', `fps=${colorBarScanFps},scale=70:1:flags=area,format=rgb24`,
      '-f', 'rawvideo',
      '-'
    ], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    const data = Buffer.from(stdout || '');
    const frameSize = 70 * 3;
    const offsets = [];
    for (
      let offset = 0, frameIndex = 0;
      offset + frameSize <= data.length;
      offset += frameSize, frameIndex += 1
    ) {
      if (looksLikeColorBars(data.subarray(offset, offset + frameSize))) {
        offsets.push(frameIndex / colorBarScanFps);
      }
    }
    return offsets;
  } catch {
    return [];
  }
}

function looksLikeColorBars(frame) {
  let saturatedColumns = 0;
  let colorTransitions = 0;
  let previous = null;
  for (let index = 0; index < frame.length; index += 3) {
    const red = frame[index];
    const green = frame[index + 1];
    const blue = frame[index + 2];
    if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 70) {
      saturatedColumns += 1;
    }
    if (previous && Math.abs(red - previous[0]) + Math.abs(green - previous[1]) + Math.abs(blue - previous[2]) >= 120) {
      colorTransitions += 1;
    }
    previous = [red, green, blue];
  }
  return saturatedColumns >= 45 && colorTransitions >= 5;
}

async function findAbruptVisualTransitionOffsets(filePath) {
  try {
    const width = 64;
    const height = 36;
    const frameSize = width * height * 3;
    const { stdout } = await execFileAsync(TOOLS.ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-vf', `fps=${visualTransitionScanFps},scale=${width}:${height}:flags=area,format=rgb24`,
      '-f', 'rawvideo',
      '-'
    ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
    const data = Buffer.from(stdout || '');
    const offsets = [];
    let previous = null;
    for (let offset = 0, frameIndex = 0; offset + frameSize <= data.length; offset += frameSize, frameIndex += 1) {
      const frame = data.subarray(offset, offset + frameSize);
      if (previous && averagePixelDifference(frame, previous) >= visualTransitionThreshold) {
        const offsetSeconds = frameIndex / visualTransitionScanFps;
        if (offsets.length === 0 || offsetSeconds - offsets.at(-1) >= 0.2) {
          offsets.push(offsetSeconds);
        }
      }
      previous = frame;
    }
    return offsets;
  } catch {
    return [];
  }
}

function averagePixelDifference(current, previous) {
  let total = 0;
  for (let index = 0; index < current.length; index += 1) {
    total += Math.abs(current[index] - previous[index]);
  }
  return total / current.length;
}

function initializeSilenceLog(capture) {
  if (!capture.silenceLog || typeof capture.silenceLog !== 'object') {
    capture.silenceLog = {};
  }
  capture.silenceLog.thresholdDb = Number(capture.silenceLog.thresholdDb ?? silenceThresholdDb);
  capture.silenceLog.periods = Array.isArray(capture.silenceLog.periods) ? capture.silenceLog.periods : [];
  capture.silenceLog.activePeriod = capture.silenceLog.activePeriod || null;
  return capture.silenceLog;
}

async function readSegmentMaxVolumeDb(filePath) {
  try {
    const { stderr } = await execFileAsync(TOOLS.ffmpeg, [
      '-hide_banner',
      '-nostats',
      '-i', filePath,
      '-map', '0:a:0',
      '-af', 'volumedetect',
      '-f', 'null',
      '-'
    ], { maxBuffer: 1024 * 1024 });
    const match = String(stderr || '').match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?)|inf)\s*dB/i);
    if (!match) {
      return null;
    }
    return /^-?inf$/i.test(match[1]) ? -Infinity : Number(match[1]);
  } catch {
    return null;
  }
}

function initializeSlideShow(capture) {
  if (!capture.slideShow || typeof capture.slideShow !== 'object') {
    capture.slideShow = {};
  }
  capture.slideShow.active = Boolean(capture.slideShow.active);
  capture.slideShow.startedAt = String(capture.slideShow.startedAt || '');
  capture.slideShow.startSequence = Number.isFinite(capture.slideShow.startSequence) ? capture.slideShow.startSequence : null;
  capture.slideShow.discardedSegmentCount = Number(capture.slideShow.discardedSegmentCount || 0);
  capture.slideShow.discardedDurationSeconds = Number(capture.slideShow.discardedDurationSeconds || 0);
  return capture.slideShow;
}

async function completeCapture(capture, reason) {
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

// Playlists and live segments use the steady `liveMedia` rate profile; the startup backfill of
// earlier segments uses the faster `liveBackfill` profile (see http.profiles in config.local.js).
function hlsFetchOptions(timeoutMs = hlsRequestTimeoutMs, retries = hlsFetchRetries, rateProfile = 'liveMedia') {
  return {
    rateProfile,
    timeoutMs,
    retries,
    retryDelayMs: hlsRetryDelayMs,
    quiet: true
  };
}

function pageFetchOptions() {
  return {
    timeoutMs: pageRequestTimeoutMs,
    retries: pageFetchRetries,
    retryDelayMs: hlsRetryDelayMs,
    quiet: true
  };
}

function timeoutSignal(timeoutMs) {
  const value = Number(timeoutMs || 0);
  return Number.isFinite(value) && value > 0 && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(value)
    : undefined;
}

function initializeCaptureMetrics(capture) {
  capture.capturedDurationSeconds = Number(capture.capturedDurationSeconds || 0);
  capture.lostDurationSeconds = Number(capture.lostDurationSeconds || 0);
  capture.videoPositionSeconds = Number(capture.videoPositionSeconds || (capture.capturedDurationSeconds + capture.lostDurationSeconds));
  capture.lastSegmentSequence = Number.isFinite(capture.lastSegmentSequence)
    ? capture.lastSegmentSequence
    : null;
  capture.lastObservedSegmentSequence = Number.isFinite(capture.lastObservedSegmentSequence)
    ? capture.lastObservedSegmentSequence
    : capture.lastSegmentSequence;
  capture.lastObservedAt = String(capture.lastObservedAt || capture.lastSegmentAt || '');
  capture.discardedSegmentKeys = Array.isArray(capture.discardedSegmentKeys) ? capture.discardedSegmentKeys : [];
  capture.discardedSegmentCount = Number(capture.discardedSegmentCount || 0);
  capture.discardedDurationSeconds = Number(capture.discardedDurationSeconds || 0);
  initializeSlideShow(capture);
  capture.lastProgressOutputAt = String(capture.lastProgressOutputAt || '');
  capture.lastErrorOutputAt = String(capture.lastErrorOutputAt || '');
  if (capture.currentStream && typeof capture.currentStream === 'object') {
    capture.currentStream.segmentCount = Number(capture.currentStream.segmentCount || 0);
    capture.currentStream.bytesCaptured = Number(capture.currentStream.bytesCaptured || 0);
    capture.currentStream.capturedDurationSeconds = Number(capture.currentStream.capturedDurationSeconds || 0);
    capture.currentStream.lostDurationSeconds = Number(capture.currentStream.lostDurationSeconds || 0);
    capture.currentStream.videoPositionSeconds = Number(
      capture.currentStream.videoPositionSeconds
      || (capture.currentStream.capturedDurationSeconds + capture.currentStream.lostDurationSeconds)
    );
    capture.currentStream.lastSegmentSequence = Number.isFinite(capture.currentStream.lastSegmentSequence)
      ? capture.currentStream.lastSegmentSequence
      : null;
  }
}

function reportCaptureProgress(capture, status) {
  const now = Date.now();
  const previous = Date.parse(capture.lastProgressOutputAt || '');
  if (Number.isFinite(previous) && now - previous < captureProgressIntervalMs) {
    return;
  }

  capture.lastProgressOutputAt = new Date(now).toISOString();
  const prefix = `[live ${formatCaptureLabel(capture)}]`;
  const stream = capture.currentStream || capture;
  if (status && status !== 'capturing') {
    console.log(`${prefix} ${status} | pos ${formatDuration(stream.videoPositionSeconds)} | ${formatEasternTime(stream.lastSegmentAt)}`);
    return;
  }
  console.log(
    `${prefix} cap ${formatDuration(stream.capturedDurationSeconds)}`
      + ` | miss ${formatDuration(stream.lostDurationSeconds)}`
      + ` | pos ${formatDuration(stream.videoPositionSeconds)}`
      + ` | ${formatEasternTime(stream.lastSegmentAt)}`
  );
}

function formatCaptureLabel(capture) {
  const hlsUrl = safeUrl(capture?.hlsUrl);
  const parts = hlsUrl?.pathname.split('/').filter(Boolean) || [];
  const streamName = parts.length >= 2 ? parts.slice(-3, -1).join('/') : String(capture?.id || 'stream');
  const identifier = String(capture?.currentStream?.identifier || '').trim();
  return identifier ? `${streamName}/${identifier}` : streamName;
}

function reportCaptureError(capture) {
  const now = Date.now();
  const previous = Date.parse(capture.lastErrorOutputAt || '');
  if (Number.isFinite(previous) && now - previous < captureProgressIntervalMs) {
    return;
  }

  capture.lastErrorOutputAt = new Date(now).toISOString();
  console.warn(`[live ${capture.id}] capture request failed; retrying | ${capture.lastErrorMessage}`);
}

function isCaptureStale(capture, staleMs) {
  const reference = String(capture.lastObservedAt || capture.lastSegmentAt || capture.lastSeenLiveAt || capture.firstSeenAt || '').trim();
  if (!reference) {
    return false;
  }

  const referenceTime = Date.parse(reference);
  if (!Number.isFinite(referenceTime)) {
    return false;
  }

  return Date.now() - referenceTime >= staleMs;
}

async function fetchWithRedirectCookies(url, options = {}) {
  const retries = Math.max(0, Number(options.retries || 0));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchRedirectChain(url, options);
    } catch (error) {
      if (isRobotsDisallowedError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < retries) {
        await sleep(Number(options.retryDelayMs || hlsRetryDelayMs) * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function fetchRedirectChain(url, options = {}) {
  let currentUrl = url;
  const redirectChain = [url];
  const redirects = Number(options.maxRedirects || maxRedirects);

  for (let redirectCount = 0; redirectCount <= redirects; redirectCount += 1) {
    const headers = new Headers(options.headers || {});
    const response = await fetchWithDefaults(currentUrl, {
      headers,
      redirect: 'manual',
      rateProfile: options.rateProfile,
      quiet: options.quiet,
      signal: timeoutSignal(options.timeoutMs)
    });

    if (!isRedirectResponse(response.status)) {
      if (isRetryableStatus(response.status)) {
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        throw new Error(`Request returned ${response.status}: ${currentUrl}`);
      }
      return {
        response,
        finalUrl: currentUrl,
        redirectChain
      };
    }

    const location = response.headers.get('location');
    if (!location) {
      return {
        response,
        finalUrl: currentUrl,
        redirectChain
      };
    }

    currentUrl = new URL(location, currentUrl).toString();
    redirectChain.push(currentUrl);
  }

  throw new Error(`Too many redirects while fetching ${url}`);
}

async function streamResponseToFile(response, destinationPath, options = {}) {
  if (!response.body) {
    throw new Error('Response body was empty');
  }

  const writeStream = fs.createWriteStream(destinationPath, { flags: 'w' });
  const reader = response.body.getReader();
  let downloadedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      downloadedBytes += chunk.length;
      if (!writeStream.write(chunk)) {
        await onceDrain(writeStream);
      }
      options.onVisibleOutput?.();
    }

    await endStream(writeStream);
  } catch (error) {
    writeStream.destroy();
    throw error;
  }

  return downloadedBytes;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function extractAnchorText(html) {
  const match = String(html || '').match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  return match ? match[1] : html;
}

function cleanInlineText(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractMeetingTitle(html, pageUrl) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const source = SOURCES.find((item) => sourceProvider(item).isProviderUrl(safeUrl(pageUrl))) || SOURCES[0];
  return match ? sourceProvider(source).cleanTitle(decodeHtmlEntities(match[1])) : '';
}

function sanitizeSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'stream';
}

function formatSnapshotTimestamp(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}-${minutes}-${seconds}`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${Math.round(value)}b`;
  if (value < 1024 * 1024) return formatCompactUnit(value / 1024, 'kb');
  if (value < 1024 * 1024 * 1024) return formatCompactUnit(value / (1024 * 1024), 'mb');
  return formatCompactUnit(value / (1024 * 1024 * 1024), 'gb');
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatEasternTime(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    return 'not yet';
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LOCALE.timeZone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function formatCompactUnit(value, unit) {
  const amount = Number(value || 0);
  if (amount >= 100) {
    return `${Math.round(amount)}${unit}`;
  }
  if (amount >= 10) {
    return `${amount.toFixed(1).replace(/\.0$/, '')}${unit}`;
  }
  return `${amount.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}${unit}`;
}

async function appendJsonLine(filePath, value) {
  await appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function writeTextAtomically(filePath, value) {
  const tempPath = `${filePath}.download`;
  await rm(tempPath, { force: true });
  await writeFile(tempPath, String(value || ''));
  await rename(tempPath, filePath);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
