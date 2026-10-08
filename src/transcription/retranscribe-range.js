import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { TOOLS } from '../config/runtime-config.js';
import { loadJson, writeJson } from '../util/fs-utils.js';
import { runCommand } from '../util/process.js';
import { formatPosition, renderFinalTranscript } from './transcript.js';
import { loadSessionSegments } from '../sessions/session.js';
import { boostFilter, extractRangeAudio } from '../media/segment-audio.js';
import { binPath } from '../config/paths.js';

// Boosts the audio of part of a session (or full meeting) and transcribes that part again, for stretches where the
// speaker's microphone was off and others barely picked them up. Usually started from the thumbnails page (the
// local server runs it); it can also be run directly:
//   npm run retranscribe-range -- --session <folder> --from 01:02:03 --to 01:05:00 [--gain 18] [--highpass 120]
//     [--normalize] [--denoise] [--quality thorough|quick] [--preview] [--remove <portion id>] [--job <id>]
//
// --preview   only renders the boosted audio ({session}/retranscribe/previews/{job}.m4a) to listen to
// --peaks     only measures the original audio's loudness for a waveform ({session}/retranscribe/peaks/{job}.json)
// --clip      only cuts the range as an MP4 with extract-clip ({session}/clips/), for downloading
//             (--accurate for frame-exact cuts)
// --remove    takes a re-transcribed portion back out (its original lines return)
// Otherwise the new lines replace the transcript's lines in that range: they are kept in
// transcripts/retranscribed.json (raw.json is never changed) and the final transcript is rebuilt.
// With --job, progress is written to {session}/retranscribe/jobs/{job}.json for the page to follow.

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = path.resolve(options.session);
  const workDir = path.join(sessionDir, 'retranscribe');
  const jobPath = options.job ? path.join(workDir, 'jobs', `${options.job}.json`) : '';
  const job = {
    id: options.job,
    action: options.remove
      ? 'remove'
      : options.clip
        ? 'clip'
        : options.peaks
          ? 'peaks'
          : options.preview
            ? 'preview'
            : 'transcribe',
    from: options.from,
    to: options.to,
    settings: settingsOf(options),
    quality: options.quality,
    startedAt: new Date().toISOString()
  };
  const report = async (status, extra = {}) => {
    Object.assign(job, { status, updatedAt: new Date().toISOString() }, extra);
    if (jobPath) await writeJson(jobPath, job);
    if (extra.message) console.log(extra.message);
  };

  try {
    if (options.remove) {
      const file = path.join(sessionDir, 'transcripts', 'retranscribed.json');
      const index = await loadJson(file, { portions: [] });
      const portions = index.portions.filter((portion) => portion.id !== options.remove);
      await writeJson(file, { ...index, portions });
      await renderFinalTranscript(sessionDir);
      await report('done', {
        message: `Removed re-transcribed portion ${options.remove}; the original lines are back`
      });
      return;
    }
    if (!(options.to > options.from)) throw new Error('--to must be after --from');
    if (options.clip) {
      const name = `clip-${formatPosition(options.from).replace(/:/g, '-')}-to-${formatPosition(options.to).replace(/:/g, '-')}${options.accurate ? '-exact' : ''}.mp4`;
      await report('running', {
        message: `Cutting ${formatPosition(options.from)}-${formatPosition(options.to)}${options.accurate ? ' (frame-exact)' : ''}...`
      });
      await runNode('extract-clip.js', [
        '--session',
        sessionDir,
        '--from',
        String(options.from),
        '--to',
        String(options.to),
        '--output',
        path.join(sessionDir, 'clips', name),
        ...(options.accurate ? ['--accurate'] : [])
      ]);
      await report('done', { clip: `clips/${name}`, message: `Clip ready: ${name}` });
      return;
    }
    if (options.to - options.from > 3 * 3600) throw new Error('That range is longer than 3 hours');
    const session = await loadSessionSegments(sessionDir);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'retranscribe-'));
    try {
      await report('running', {
        message: `Extracting the audio for ${formatPosition(options.from)}-${formatPosition(options.to)}...`
      });
      const original = await extractRangeAudio(
        sessionDir,
        session,
        options.from,
        options.to,
        path.join(tempDir, 'original.wav'),
        tempDir
      );
      if (options.peaks) {
        // Loudness for a waveform: the loudest sample in each of up to 1,200 slices (8 kHz is plenty to see speech).
        const rawPath = path.join(tempDir, 'peaks.pcm');
        await runCommand(TOOLS.ffmpeg, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          original,
          '-ac',
          '1',
          '-ar',
          '8000',
          '-f',
          's16le',
          rawPath
        ]);
        const samples = await readFile(rawPath);
        const sampleCount = Math.floor(samples.length / 2);
        const count = Math.max(1, Math.min(1200, sampleCount));
        const peaks = [];
        for (let slice = 0; slice < count; slice += 1) {
          let loudest = 0;
          const end = Math.floor(((slice + 1) * sampleCount) / count);
          for (let index = Math.floor((slice * sampleCount) / count); index < end; index += 1) {
            const value = Math.abs(samples.readInt16LE(index * 2));
            if (value > loudest) loudest = value;
          }
          peaks.push(Number((loudest / 32768).toFixed(4)));
        }
        const peaksName = `${options.job || Date.now().toString(36)}.json`;
        await writeJson(path.join(workDir, 'peaks', peaksName), { from: options.from, to: options.to, peaks });
        await report('done', { peaks: `peaks/${peaksName}`, message: `Waveform ready (${peaks.length} points)` });
        return;
      }
      const processed = path.join(tempDir, 'boosted.wav');
      await runCommand(TOOLS.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        original,
        '-af',
        boostFilter(job.settings),
        '-c:a',
        'pcm_s16le',
        processed
      ]);

      if (options.preview) {
        const previewName = `${options.job || Date.now().toString(36)}.m4a`;
        const previewPath = path.join(workDir, 'previews', previewName);
        await fs.promises.mkdir(path.dirname(previewPath), { recursive: true });
        await runCommand(TOOLS.ffmpeg, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          processed,
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          previewPath
        ]);
        await report('done', { preview: `previews/${previewName}`, message: `Preview ready: ${previewPath}` });
        return;
      }

      await report('running', {
        message: `Transcribing ${formatPosition(options.to - options.from)} (${options.quality} quality)...`
      });
      const outputDir = path.join(tempDir, 'transcript');
      await runNode('transcribe-media.js', [
        '--input',
        processed,
        '--quality',
        options.quality,
        '--output-dir',
        outputDir
      ]);
      const result = await loadJson(path.join(outputDir, `boosted-${options.quality}.json`));
      const portion = {
        id: options.job || Date.now().toString(36),
        from: options.from,
        to: options.to,
        settings: job.settings,
        quality: options.quality,
        createdAt: new Date().toISOString(),
        lines: result.lines.map((line) => {
          const startSeconds = Number((options.from + line.startSeconds).toFixed(3));
          const clock = session.clockAt(startSeconds);
          return {
            text: line.text,
            startSeconds,
            endSeconds: Number(Math.min(options.to, options.from + line.endSeconds).toFixed(3)),
            clockTime: clock === null ? '' : new Date(clock * 1000).toISOString()
          };
        })
      };
      const file = path.join(sessionDir, 'transcripts', 'retranscribed.json');
      const index = await loadJson(file, {
        note: 'Portions transcribed again with boosted audio; each replaces the raw lines in its range. Manage from the thumbnails page.',
        portions: []
      });
      await writeJson(file, { ...index, portions: [...index.portions, portion] });
      await renderFinalTranscript(sessionDir);
      await report('done', {
        portion: portion.id,
        lineCount: portion.lines.length,
        message: `Re-transcribed ${formatPosition(options.from)}-${formatPosition(options.to)}: ${portion.lines.length} lines replace the originals in that range`
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    await report('failed', { message: error.message || String(error) });
    process.exitCode = 1;
  }
}

function settingsOf(options) {
  return { gainDb: options.gain, highpassHz: options.highpass, normalize: options.normalize, denoise: options.denoise };
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath(script), ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
  });
}

function parseArgs(argv) {
  const options = {
    session: '',
    from: null,
    to: null,
    gain: 0,
    highpass: 0,
    normalize: false,
    denoise: false,
    quality: 'thorough',
    preview: false,
    peaks: false,
    clip: false,
    accurate: false,
    remove: '',
    job: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--session') options.session = argv[++index];
    else if (arg === '--from') options.from = parsePosition(argv[++index]);
    else if (arg === '--to') options.to = parsePosition(argv[++index]);
    else if (arg === '--gain') options.gain = Number(argv[++index]);
    else if (arg === '--highpass') options.highpass = Number(argv[++index]);
    else if (arg === '--normalize') options.normalize = true;
    else if (arg === '--denoise') options.denoise = true;
    else if (arg === '--quality') options.quality = String(argv[++index] || '').toLowerCase();
    else if (arg === '--preview') options.preview = true;
    else if (arg === '--peaks') options.peaks = true;
    else if (arg === '--clip') options.clip = true;
    else if (arg === '--accurate') options.accurate = true;
    else if (arg === '--remove') options.remove = argv[++index];
    else if (arg === '--job') options.job = argv[++index];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.session || (!options.remove && (options.from === null || options.to === null))) {
    throw new Error(
      'Usage: npm run retranscribe-range -- --session <folder> --from HH:MM:SS --to HH:MM:SS [--gain dB] [--highpass Hz] [--normalize] [--denoise] [--quality thorough|quick] [--preview]'
    );
  }
  if (!Number.isFinite(options.gain) || options.gain < -10 || options.gain > 40)
    throw new Error('--gain must be between -10 and 40 dB');
  if (!Number.isFinite(options.highpass) || options.highpass < 0 || options.highpass > 500)
    throw new Error('--highpass must be between 0 and 500 Hz');
  if (!['quick', 'thorough'].includes(options.quality)) throw new Error('--quality must be quick or thorough');
  return options;
}

function parsePosition(value) {
  const parts = String(value || '')
    .split(':')
    .map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid time "${value}" (use HH:MM:SS, MM:SS, or seconds)`);
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

// Started by bin/retranscribe-range.js.
export const run = () =>
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
