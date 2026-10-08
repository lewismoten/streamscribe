import { execFile as execFileCallback } from 'child_process';
import { LOCALE } from '../../config/runtime-config.js';
import { rename, rm } from 'fs/promises';
import { promisify } from 'util';
import { fileExists } from '../../util/fs-utils.js';
import { formatClock, escapeFilterText, execFileText } from './format.js';

// Rendering pieces of the video: captured segments normalized to one format, and title clips for gaps (with the
// time burned in), with ffprobe to read what a file holds.

export const execFileAsync = promisify(execFileCallback);

export const defaultGapThresholdSeconds = 5;

export const defaultWidth = 1280;

export const defaultHeight = 720;

export const defaultFrameRate = 30;

export const defaultAudioSampleRate = 48000;

export function buildGapOverlayText({
  title,
  lostWallClockEastern,
  resumeWallClockEastern,
  durationSeconds,
  gapStartSeconds,
  jumpToSeconds
}) {
  return [
    title,
    `Lost at ${lostWallClockEastern}`,
    `Missing feed duration ${formatClock(durationSeconds)}`,
    `Resume at ${resumeWallClockEastern}`,
    `${formatClock(gapStartSeconds)} to ${formatClock(jumpToSeconds)} rendered timeline`
  ].join('\n');
}

export async function normalizeSegmentClip(sourcePath, destinationPath, options) {
  if (!options.force && await fileExists(destinationPath)) {
    return;
  }

  const destinationPartialPath = `${destinationPath}.download`;
  await rm(destinationPartialPath, { force: true });
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath
  ];

  if (!options.hasAudio) {
    args.push(
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=stereo:sample_rate=${options.audioSampleRate}`
    );
  }

  const videoFilters = [
    `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease`,
    `pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2:black`,
    `fps=${options.frameRate}`,
    'format=yuv420p'
  ];
  if (options.burnWallClock && Number.isFinite(options.airStartEpoch)) {
    // A ticking clock of when each frame aired: frame time (from 0) plus the segment's air time, in the
    // configured time zone (set through TZ for ffmpeg).
    videoFilters.push('setpts=PTS-STARTPTS');
    videoFilters.push([
      `drawtext=text='%{pts\\:localtime\\:${options.airStartEpoch.toFixed(3)}\\:%a %b %d %Y  %I\\\\\\:%M\\\\\\:%S %p %Z}'`,
      'fontcolor=white',
      'fontsize=24',
      'x=w-text_w-24',
      'y=h-text_h-22',
      'box=1',
      'boxcolor=black@0.65',
      'boxborderw=8'
    ].join(':'));
  }

  args.push(
    '-map', '0:v:0',
    ...(options.hasAudio ? ['-map', '0:a:0?'] : ['-map', '1:a:0']),
    '-vf', videoFilters.join(','),
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'aac',
    '-ar', String(options.audioSampleRate),
    '-b:a', '128k',
    '-ac', '2',
    '-f', 'mp4',
    '-movflags', '+faststart',
    destinationPartialPath
  );

  await execFileText(options.ffmpegPath, args, { TZ: LOCALE.timeZone });
  await rename(destinationPartialPath, destinationPath);
}

export async function renderGapClip(destinationPath, options) {
  if (!options.force && await fileExists(destinationPath)) {
    return;
  }

  const destinationPartialPath = `${destinationPath}.download`;
  await rm(destinationPartialPath, { force: true });
  const videoFilters = buildGapVideoFilters(options);

  await execFileText(options.ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=black:s=${options.width}x${options.height}:r=${options.frameRate}:d=${options.durationSeconds}`,
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=${options.audioSampleRate}`,
    '-vf', videoFilters.join(','),
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', String(options.audioSampleRate),
    '-b:a', '128k',
    '-ac', '2',
    '-f', 'mp4',
    '-movflags', '+faststart',
    destinationPartialPath
  ]);
  await rename(destinationPartialPath, destinationPath);
}

export function buildGapVideoFilters(options) {
  const durationSeconds = Math.max(0.001, Number(options.durationSeconds || 0));
  const durationExpression = durationSeconds.toFixed(3);
  const filters = [
    gapDrawTextFilter(String(options.title || 'Live feed'), 'h*0.20', 34, false),
    gapDrawTextFilter('LIVE FEED NOT CAPTURED', 'h*0.29', 30, false, 'yellow'),
    gapDrawTextFilter(`Lost at ${options.lostWallClockEastern || 'unknown time'}`, 'h*0.38', 28, false),
    gapDrawTextFilter(
      `Elapsed since loss\\: ${buildDynamicClockText('t')}`,
      'h*0.47',
      30,
      true,
      'white'
    ),
    gapDrawTextFilter(
      `Remaining until live feed resumes\\: ${buildDynamicClockText(`max(0\\,${durationExpression}-t)`)}`,
      'h*0.56',
      30,
      true,
      'white'
    ),
    gapDrawTextFilter(`Resume at ${options.resumeWallClockEastern || 'unknown time'}`, 'h*0.65', 28, false),
    gapDrawTextFilter(`Jump to ${options.jumpToLabel || '00:00:00'} to continue live feed`, 'h*0.72', 24, false, 'white'),
    'drawbox=x=iw*0.10:y=ih*0.83:w=iw*0.80:h=18:color=white@0.25:t=fill'
  ];

  const steps = 20;
  for (let index = 1; index <= steps; index += 1) {
    const threshold = ((durationSeconds * index) / steps).toFixed(3);
    filters.push(
      `drawbox=x=iw*0.10+${index - 1}*iw*0.80/${steps}:y=ih*0.83:w=iw*0.80/${steps}-2:h=18:color=lime:t=fill:enable='gte(t,${threshold})'`
    );
  }
  return filters;
}

export function gapDrawTextFilter(text, y, fontSize, preEscaped, color = 'white') {
  const value = preEscaped ? text : escapeFilterText(text);
  return [
    `drawtext=text='${value}'`,
    `fontcolor=${color}`,
    `fontsize=${fontSize}`,
    'x=(w-text_w)/2',
    `y=${y}`,
    'box=1',
    'boxcolor=black@0.60',
    'boxborderw=8'
  ].join(':');
}

export function buildDynamicClockText(secondsExpression) {
  const seconds = String(secondsExpression);
  return [
    `%{eif\\:trunc((${seconds})/3600)\\:d\\:2}`,
    `%{eif\\:trunc(mod(${seconds}\\,3600)/60)\\:d\\:2}`,
    `%{eif\\:trunc(mod(${seconds}\\,60))\\:d\\:2}`
  ].join('\\:');
}

export async function probeVideoFile(ffprobePath, filePath) {
  const stdout = await execFileText(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    filePath
  ]);
  const payload = JSON.parse(stdout || '{}');
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const videoStream = streams.find((stream) => String(stream.codec_type || '') === 'video') || {};
  const audioStream = streams.find((stream) => String(stream.codec_type || '') === 'audio') || {};

  return {
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    frameRate: parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate || ''),
    audioSampleRate: Number(audioStream.sample_rate || 0),
    hasAudio: Boolean(audioStream.codec_name)
  };
}

export function parseFps(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 0;
  }
  if (!raw.includes('/')) {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  const [numerator, denominator] = raw.split('/');
  const top = Number.parseFloat(numerator);
  const bottom = Number.parseFloat(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) {
    return 0;
  }
  return top / bottom;
}
