import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { assertMountedPathSync } from './ensure-mounted-volume.js';

// Settings from config.local.js at the repository root (copy config.example.js to start). Every script reads them
// from here.
const runtimeConfigDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(runtimeConfigDir, '..', '..');
const config = await loadLocalConfig();

// Data layout: everything lives under `dataDir` (default ./data): one folder per source, plus state/.
export const DATA_ROOT = process.env.DATA_DIR || config.dataDir || path.join(repoRoot, 'data');
assertMountedPathSync(DATA_ROOT, 'DATA_ROOT');
export const STATE_ROOT = process.env.STATE_DIR || config.stateDir || path.join(DATA_ROOT, 'state');
export const SOURCES = normalizeSources(config.sources);
export const TOOLS = normalizeTools(config.tools);
export const TRANSCRIPTION = normalizeTranscriptionConfig(config.transcription);
export const HTTP = normalizeHttpConfig(config.http);
export const LOCALE = normalizeLocaleConfig(config.locale);

export default { DATA_ROOT, STATE_ROOT, SOURCES, TOOLS, TRANSCRIPTION, HTTP, LOCALE };

async function loadLocalConfig() {
  // STREAMSCRIBE_CONFIG points to another settings file (for tests, or several setups side by side).
  const configPath = process.env.STREAMSCRIBE_CONFIG ? path.resolve(process.env.STREAMSCRIBE_CONFIG) : path.join(repoRoot, 'config.local.js');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${configPath}. Copy config.example.js to config.local.js at the repository root and edit it.`);
  }
  const module = await import(pathToFileURL(configPath).href);
  const value = module.default;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// A source is one stream to capture: a live HLS playlist (or pages that lead to one) and where its captures go.
// `provider` adds what is specific to a streaming service ('swagit'); 'hls' is any plain HLS stream.
function normalizeSources(value) {
  return (Array.isArray(value) ? value : []).map(normalizeSource).filter(Boolean);
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const urls = (list) => Array.from(new Set((Array.isArray(list) ? list : []).map(normalizeHttpUrl).filter(Boolean)));
  const discoveryUrls = urls(value.discoveryUrls);
  const liveUrls = urls(value.liveUrls);
  const key = String(value.key || '').trim();
  if (!key || (discoveryUrls.length === 0 && liveUrls.length === 0)) {
    return null;
  }
  const storageDir = String(value.storageDir || path.join(DATA_ROOT, key)).trim();
  // Without a provider named, Swagit addresses imply Swagit; anything else is plain HLS.
  const provider = String(value.provider || ([...liveUrls, ...discoveryUrls].some((url) => /(?:^|\.)swagit\.com$/i.test(new URL(url).hostname)) ? 'swagit' : 'hls')).trim().toLowerCase();
  return {
    key,
    name: String(value.name || key).trim(),
    provider,
    storageDir,
    discoveryUrls,
    liveUrls,
    liveStorageDir: String(value.liveStorageDir || path.join(storageDir, 'live')).trim(),
    // For providers whose segment names carry a stream identifier (Swagit's media-<id>_<n>.ts), start a new session
    // folder whenever it changes. Swagit renews it about hourly without the meeting changing; turn this off to keep
    // one session per meeting.
    splitOnStreamIdentifierChange: value.splitOnStreamIdentifierChange === true,
    newSessionAfterStandbyMinutes: Number(value.newSessionAfterStandbyMinutes ?? 10),
    // For plain HLS: a regular expression with two groups (identifier, sequence number) matching segment file names,
    // which lets a capture fetch earlier and missed segments by name. Swagit's pattern is built in.
    segmentPattern: value.segmentPattern ? String(value.segmentPattern) : ''
  };
}

function normalizeTools(value) {
  const tools = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = {
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    // whisper.cpp's command-line tool (brew install whisper-cpp); runs Whisper on Apple Silicon GPUs.
    whisperCpp: 'whisper-cli'
  };
  return Object.fromEntries(Object.entries({ ...defaults, ...tools }).map(([key, fallback]) => [key, String(tools[key] || fallback).trim() || fallback]));
}

function normalizeTranscriptionConfig(value) {
  const transcription = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const whisperCppDir = path.join(os.homedir(), '.cache', 'whisper-cpp');
  return {
    // whisper.cpp model files (download from huggingface.co/ggerganov/whisper.cpp and ggml-org/whisper-vad).
    whisperCppModel: String(transcription.whisperCppModel || path.join(whisperCppDir, 'ggml-large-v3.bin')).trim(),
    whisperCppVadModel: String(transcription.whisperCppVadModel ?? path.join(whisperCppDir, 'ggml-silero-v5.1.2.bin')).trim(),
    // What is being transcribed, which starts Whisper's prompt (for example "Warren County public meeting in Front
    // Royal, Virginia.").
    context: String(transcription.context || 'Public meeting.').trim(),
    // Names and terms Whisper should expect, most important first; as many as fit go into its prompt.
    vocabulary: Array.isArray(transcription.vocabulary)
      ? transcription.vocabulary.map((term) => String(term || '').trim()).filter(Boolean)
      : [],
    // File holding transcript corrections, managed with `npm run transcript-corrections` (git ignores it).
    correctionsFile: path.resolve(repoRoot, String(transcription.correctionsFile || 'transcription-corrections.local.json')),
    // Mishearings to fix after transcribing: { 'heard as': 'should be' }, matched case-insensitively on word boundaries.
    // Prefer the corrections file; entries here are merged with it.
    corrections: transcription.corrections && typeof transcription.corrections === 'object' && !Array.isArray(transcription.corrections)
      ? Object.fromEntries(Object.entries(transcription.corrections).map(([heard, fixed]) => [String(heard).trim(), String(fixed ?? '').trim()]).filter(([heard]) => heard))
      : {},
    whisperLanguage: String(process.env.WHISPER_LANGUAGE || transcription.whisperLanguage || 'en').trim() || 'en'
  };
}

function normalizeHttpConfig(value) {
  const http = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const cooldownMs = normalizeNonNegativeNumber(http.cooldownMs, 1000);
  const burst = normalizePositiveInteger(http.burst, 1);
  const defaultProfiles = {
    // Playlist polls and live segments: about one request a second, with short bursts of three.
    liveMedia: { cooldownMs: 1000, burst: 3 },
    // Catching up on earlier segments when a live capture starts: two requests a second.
    liveBackfill: { cooldownMs: 500, burst: 1 }
  };
  const configuredProfiles = http.profiles && typeof http.profiles === 'object' && !Array.isArray(http.profiles) ? http.profiles : {};
  const profiles = Object.fromEntries(Object.entries({ ...defaultProfiles, ...configuredProfiles })
    .filter(([, profile]) => profile && typeof profile === 'object')
    .map(([name, profile]) => [name, {
      cooldownMs: normalizeNonNegativeNumber(profile.cooldownMs, cooldownMs),
      burst: normalizePositiveInteger(profile.burst, burst)
    }]));
  profiles.default = { cooldownMs, burst };
  const robots = http.robots && typeof http.robots === 'object' && !Array.isArray(http.robots) ? http.robots : {};
  return {
    userAgent: String(http.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138 Safari/537.36').trim(),
    profiles,
    robots: {
      enabled: process.env.ROBOTS_CHECK === '0' ? false : robots.enabled !== false,
      userAgentToken: String(robots.userAgentToken || 'streamscribe').trim(),
      cacheHours: normalizeNonNegativeNumber(robots.cacheHours, 24),
      onUnreachable: String(robots.onUnreachable || 'allow').trim().toLowerCase() === 'disallow' ? 'disallow' : 'allow',
      honorCrawlDelay: robots.honorCrawlDelay !== false,
      ignoreHosts: Array.isArray(robots.ignoreHosts) ? robots.ignoreHosts.map((host) => String(host || '').trim()).filter(Boolean) : []
    }
  };
}

function normalizeLocaleConfig(value) {
  const locale = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // Times of day on pages and transcripts are shown in this time zone.
  return { timeZone: String(locale.timeZone || 'America/New_York').trim() };
}

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const url = new URL(raw);
    return /^https?:$/i.test(url.protocol) ? url.toString().replace(/\/+$/g, '') : '';
  } catch {
    return '';
  }
}

function normalizeNonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
