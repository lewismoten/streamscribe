import path from 'path';
import { mkdirChecked as mkdir } from '../config/ensure-mounted-volume.js';
import { STATE_ROOT, SOURCES } from '../config/runtime-config.js';
import { parsePositiveIntegerArg, selectConfiguredSources } from '../util/cli.js';
import { loadJson, removeStaleDownloadFiles, writeJsonAtomically } from '../util/fs-utils.js';
import {
  defaultDiscoveryPollMs,
  defaultSegmentPollMs,
  defaultVideoPageRefreshMs,
  defaultCaptureStaleMs,
  quietProgressIntervalMs,
  repeatedQuietProgressIntervalMs
} from './constants.js';
import { discoverLiveEntries, getMonitorUrls } from './discovery.js';
import { sanitizeSegment, sleep } from './files.js';
import { pollCaptureSession } from './poll.js';
import { restoreRecentCaptureSessions, ensureCaptureSession, completeCapture } from './sessions.js';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sources = selectConfiguredSources(SOURCES, options.sources, 'sources').filter(
    (source) => getMonitorUrls(source).length > 0
  );

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

  console.log(
    `Monitoring live source ${source.name} (${source.key}, ${source.provider}) into ${source.liveStorageDir}`
  );
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
      const hasRecordingAtStart = Object.values(state.captures || {}).some(
        (capture) => capture && capture.status === 'recording'
      );
      const shouldDiscover =
        liveEntries.length === 0 || !hasRecordingAtStart || Date.now() - lastDiscoveryAtMs >= options.pollMs;

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

      const hasRecording = Object.values(state.captures || {}).some(
        (capture) => capture && capture.status === 'recording'
      );
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
  return Object.values(state?.captures || {}).filter((capture) => capture && capture.status === 'recording').length;
}

// Started by bin/capture.js.
export const run = () =>
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
