import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATA_ROOT, RECORDER, SOURCES, TOOLS, TRANSCRIPTION } from '../config/runtime-config.js';
import { run } from '../media/encode.js';
import { libraryRecordings, recordersRecordings } from './publish-library.js';

// What this agent's machine has, reported with its heartbeat (the hub's Agents page shows it): the machine and its
// system, processors and memory, Node, ffmpeg (needed to record and encode), whisper.cpp and its model (needed to
// transcribe), its accelerators (GPUs, an AI accelerator), the sources it's set up to record, and its data folder with how many recordings are in it (agents on
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

// Accelerators: NVIDIA GPUs (nvidia-smi), an Apple Silicon GPU, and a Hailo AI accelerator (a Raspberry Pi's AI Kit
// or HAT: /dev/hailo0, its kind from hailortcli). [{ kind: nvidia | apple | hailo, name, memoryGb? }]
export function parseNvidia(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.split(',').map((part) => part.trim()))
    .filter(([name]) => name)
    .map(([name, mib]) => ({
      kind: 'nvidia',
      name,
      ...(Number(mib) ? { memoryGb: Math.round(Number(mib) / 1024) } : {})
    }));
}
const HAILO_NAMES = { HAILO8: 'Hailo-8 (26 TOPS)', HAILO8L: 'Hailo-8L (13 TOPS)', HAILO10H: 'Hailo-10H' };
export function parseHailo(text) {
  const architecture = String(text || '').match(/Device Architecture:\s*(\S+)/)?.[1];
  return { kind: 'hailo', name: HAILO_NAMES[architecture] || (architecture ? architecture : 'Hailo AI accelerator') };
}

async function accelerators(cpuModel) {
  const found = [];
  const nvidia = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']).catch(
    () => null
  );
  if (nvidia) found.push(...parseNvidia(nvidia.stdout));
  if (process.platform === 'darwin' && process.arch === 'arm64')
    found.push({ kind: 'apple', name: `${cpuModel || 'Apple Silicon'} GPU` });
  if (fs.existsSync('/dev/hailo0')) {
    const identify = await run('hailortcli', ['fw-control', 'identify']).catch(() => null);
    found.push(parseHailo(identify?.stdout));
  }
  return found;
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
    whisperModel: path.basename(TRANSCRIPTION.whisperCppModel),
    accelerators: await accelerators(os.cpus()[0]?.model?.trim()),
    sources: SOURCES.filter((source) => !RECORDER.sources || RECORDER.sources.includes(source.key)).map(
      (source) => source.key
    ),
    dataDir: DATA_ROOT,
    recordings: countRecordings(),
    checkedAt: new Date().toISOString()
  };
}
