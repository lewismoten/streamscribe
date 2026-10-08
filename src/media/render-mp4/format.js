import { LOCALE } from '../../config/runtime-config.js';
import { execFileAsync } from './clips.js';

// Formatting and escaping helpers for render-mp4: times, file names, and ffmpeg filter text.

export function safeFileComponent(value) {
  return String(value || 'unknown-stream').replace(/[^a-z0-9._-]+/gi, '-');
}

export function formatEasternFileTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown-time';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCALE.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
    .formatToParts(date)
    .reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}-${parts.minute}-${parts.second}`;
}

export function formatEasternWallClock(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LOCALE.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(new Date(value));
}

export function formatEasternTimestamp(value) {
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
  }).format(new Date(value));
}

export function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.round(Number(totalSeconds || 0)));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function evenNumber(value) {
  const number = Math.max(2, Math.round(Number(value || 0)));
  return number % 2 === 0 ? number : number + 1;
}

export function positiveNumberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function positiveIntegerOrDefault(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function escapeConcatPath(value) {
  return String(value || '').replace(/'/g, `'\\''`);
}

export function escapeFilterPath(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'");
}

export function escapeFilterText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

export function execFileText(command, args, env = {}) {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
    env: { ...process.env, ...env }
  }).then((result) => String(result.stdout || ''));
}
