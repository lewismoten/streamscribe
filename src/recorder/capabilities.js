import fs from 'fs';
import os from 'os';
import { RECORDER, SOURCES, TOOLS, TRANSCRIPTION } from '../config/runtime-config.js';
import { run } from '../media/encode.js';

// What this agent's machine has, reported with its heartbeat (the hub's Agents page shows it): the machine and its
// system, processors and memory, Node, ffmpeg (needed to record and encode), whisper.cpp and its model (needed to
// transcribe), and the sources it's set up to record. Checked when the agent starts, then hourly.
async function firstLine(command, args) {
  try { return (await run(command, args)).stdout.split('\n')[0].trim(); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/\0/g, '').trim(); } catch { return ''; }
}

export async function detectCapabilities() {
  const release = readText('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
  const ffmpeg = await firstLine(TOOLS.ffmpeg, ['-version']);
  const whisper = await firstLine(TOOLS.whisperCpp, ['--help']).then((line) => line !== null).catch(() => false);
  return {
    hostname: os.hostname(),
    machine: readText('/proc/device-tree/model') || (process.platform === 'darwin' ? 'Mac' : ''),
    system: release || `${os.type()} ${os.release()}`,
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim() || '',
    memoryGb: Math.round(os.totalmem() / 1e9 * 10) / 10,
    node: process.versions.node,
    ffmpeg: ffmpeg ? ffmpeg.replace(/^ffmpeg version\s+/, '').split(' ')[0] : null,
    whisper: whisper && fs.existsSync(TRANSCRIPTION.whisperCppModel) ? 'ready' : whisper ? 'no model' : null,
    sources: SOURCES.filter((source) => !RECORDER.sources || RECORDER.sources.includes(source.key)).map((source) => source.key),
    checkedAt: new Date().toISOString()
  };
}
