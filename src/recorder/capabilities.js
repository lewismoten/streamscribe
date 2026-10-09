import fs from 'fs';
import os from 'os';
import { DATA_ROOT, RECORDER, SOURCES, TOOLS, TRANSCRIPTION } from '../config/runtime-config.js';
import { run } from '../media/encode.js';
import { libraryRecordings, recordersRecordings } from './publish-library.js';

// What this agent's machine has, reported with its heartbeat (the hub's Agents page shows it): the machine and its
// system, processors and memory, Node, ffmpeg (needed to record and encode), whisper.cpp and its model (needed to
// transcribe), the sources it's set up to record, and its data folder with how many recordings are in it (agents on
// one machine with the same folder share their recordings, which the Agents page says). Checked when the agent starts, then hourly.
async function firstLine(command, args) {
  try {
    return (await run(command, args)).stdout.split('\n')[0].trim();
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}

function countRecordings() {
  let count = 0;
  for (const read of [() => libraryRecordings({ all: true }), recordersRecordings])
    try {
      count += read().length;
    } catch {
      /* no library here */
    }
  return count;
}

export async function detectCapabilities() {
  const release = readText('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
  const ffmpeg = await firstLine(TOOLS.ffmpeg, ['-version']);
  const whisper = await firstLine(TOOLS.whisperCpp, ['--help'])
    .then((line) => line !== null)
    .catch(() => false);
  return {
    hostname: os.hostname(),
    machine: readText('/proc/device-tree/model') || (process.platform === 'darwin' ? 'Mac' : ''),
    system: release || `${os.type()} ${os.release()}`,
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim() || '',
    memoryGb: Math.round((os.totalmem() / 1e9) * 10) / 10,
    node: process.versions.node,
    ffmpeg: ffmpeg ? ffmpeg.replace(/^ffmpeg version\s+/, '').split(' ')[0] : null,
    whisper: whisper && fs.existsSync(TRANSCRIPTION.whisperCppModel) ? 'ready' : whisper ? 'no model' : null,
    sources: SOURCES.filter((source) => !RECORDER.sources || RECORDER.sources.includes(source.key)).map(
      (source) => source.key
    ),
    dataDir: DATA_ROOT,
    recordings: countRecordings(),
    checkedAt: new Date().toISOString()
  };
}
