import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { TOOLS } from '../../config/runtime-config.js';
import { runCommand } from '../../util/process.js';
import { formatPosition } from '../../transcription/transcript.js';
import { binPath } from '../../config/paths.js';

// Joins clips of a session (a playlist made on the review page) into one MP4. Each clip is cut frame-exact with
// extract-clip --accurate (re-encoded alike, so they join without re-encoding again), then the clips are joined in order.
//   npm run render-playlist -- --session <folder> --clips 01:02:03-01:04:00,01:20:00-01:21:30 [--output <file.mp4>] [--job <id>]
// Output (by default): {session}/clips/playlist-{time}.mp4. With --job, progress goes to {session}/clips/jobs/{id}.json
// (the review page follows it).

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = path.resolve(options.session);
  const clipsDir = path.join(sessionDir, 'clips');
  await fs.promises.mkdir(clipsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = options.output ? path.resolve(options.output) : path.join(clipsDir, `playlist-${stamp}.mp4`);
  const report = async (status, extra = {}) => {
    if (!options.job) return;
    const jobsDir = path.join(clipsDir, 'jobs');
    await fs.promises.mkdir(jobsDir, { recursive: true });
    await writeFile(path.join(jobsDir, `${options.job}.json`), `${JSON.stringify({ id: options.job, status, updatedAt: new Date().toISOString(), ...extra }, null, 2)}\n`);
  };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-playlist-'));
  try {
    const parts = [];
    for (const [index, clip] of options.clips.entries()) {
      const message = `Cutting clip ${index + 1} of ${options.clips.length} (${formatPosition(clip.from)}-${formatPosition(clip.to)})`;
      console.log(message);
      await report('running', { message, progress: index / (options.clips.length + 1) });
      const partPath = path.join(tempDir, `clip-${String(index).padStart(3, '0')}.mp4`);
      await runNode('extract-clip.js', ['--session', sessionDir, '--from', String(clip.from), '--to', String(clip.to), '--output', partPath, '--accurate']);
      parts.push(partPath);
    }
    await report('running', { message: 'Joining the clips', progress: options.clips.length / (options.clips.length + 1) });
    const listPath = path.join(tempDir, 'clips.txt');
    await writeFile(listPath, parts.map((part) => `file '${part}'`).join('\n'));
    const partial = `${outputPath}.download`;
    await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', partial]);
    fs.renameSync(partial, outputPath);
    const sizeMb = fs.statSync(outputPath).size / 1e6;
    const total = options.clips.reduce((sum, clip) => sum + (clip.to - clip.from), 0);
    console.log(`Saved ${options.clips.length} clips (${formatPosition(total)}) to ${outputPath} (${sizeMb.toFixed(1)} MB)`);
    await report('done', { file: path.relative(sessionDir, outputPath), message: `Playlist video ready (${sizeMb.toFixed(1)} MB)`, progress: 1 });
  } catch (error) {
    await report('failed', { message: String(error.message || error).slice(0, 500) });
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath(script), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
  });
}

function parsePosition(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) throw new Error(`Invalid time "${value}"`);
  return parts.reduce((total, part) => (total * 60) + part, 0);
}

function parseArgs(argv) {
  const options = { session: '', clips: [], output: '', job: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--session') options.session = argv[++index];
    else if (arg === '--clips') {
      options.clips = String(argv[++index]).split(',').filter(Boolean).map((range) => {
        const [from, to] = range.split('-').map(parsePosition);
        return { from, to };
      });
    } else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--job') options.job = argv[++index];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.session || options.clips.length === 0 || options.clips.some((clip) => !(clip.to > clip.from))) {
    throw new Error('Usage: npm run render-playlist -- --session <folder> --clips 01:02:03-01:04:00,01:20:00-01:21:30 [--output <file.mp4>]');
  }
  return options;
}

// Started by bin/render-playlist.js.
export const run = () => main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
