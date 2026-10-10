import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { STATE_ROOT, TOOLS, TRANSCRIPTION } from '../config/runtime-config.js';
import { noteCommand } from '../util/command-log.js';

// Tools an agent installs on itself when asked on the hub's Agents page (agent_settings tools.whisper: { model, at }; a
// new `at` asks again). Only what's written here can be installed, from where it says: the website picks a tool and a
// model from these lists, never a command. Nothing needs sudo:
//   whisper.cpp   on a Mac, Homebrew's whisper-cpp; elsewhere the latest release built from source (needs git, cmake,
//                 and a C++ compiler, which the Linux install command puts in) under ~/.local/share/streamscribe-tools,
//                 for NVIDIA GPUs (CUDA) when NVIDIA's compiler (nvcc, from the CUDA toolkit) is there
//   its model     one of WHISPER_MODELS from Hugging Face into ~/.cache/whisper-cpp, with the voice-activity model
// It's asked through the work queue (an install job for this agent: tools.job()), or by older websites through its
// settings. What's installed is kept in <state>/tools.json and used when the configured (or default) tool or model isn't there
// (applyInstalledTools), so a set path in config.local.js always wins.
export const WHISPER_MODELS = {
  'tiny.en': { label: 'Tiny (English), 75 MB: fastest, rough' },
  'base.en': { label: 'Base (English), 142 MB: for a Raspberry Pi' },
  'small.en': { label: 'Small (English), 466 MB: a fast Pi, or a PC without a GPU' },
  'medium.en': { label: 'Medium (English), 1.5 GB' },
  'large-v3-turbo': { label: 'Large v3 Turbo, 1.6 GB: nearly as accurate, much faster (best with a GPU)' },
  'large-v3': { label: 'Large v3, 3.1 GB: the most accurate (practical with a GPU: NVIDIA or Apple Silicon)' }
};
const MODEL_URL = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
const VAD_NAME = 'ggml-silero-v5.1.2.bin';
const VAD_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_NAME}`;
const REPO = 'https://github.com/ggml-org/whisper.cpp';
const MODELS_DIR = path.join(os.homedir(), '.cache', 'whisper-cpp');
const BUILD_ROOT = path.join(os.homedir(), '.local', 'share', 'streamscribe-tools');
const recordFile = () => path.join(STATE_ROOT, 'tools.json');

function readRecord() {
  try {
    return JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeRecord(record) {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  fs.writeFileSync(recordFile(), JSON.stringify(record, null, 1));
}

// A command, line by line (each line of its output to onLine); resolves with its output, rejects with its last lines.
export function runStreaming(command, args, { cwd, env, onLine = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    let output = '';
    let pending = '';
    const take = (chunk) => {
      output = (output + chunk).slice(-20000);
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const startedAt = Date.now();
    child.on('error', (error) => {
      noteCommand(command, args, { code: error.code || 'error', output: error.message, startedAt });
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      noteCommand(command, args, { code, output, startedAt });
      if (signal?.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)}: ${output.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

const which = (name) =>
  (process.env.PATH || '')
    .split(path.delimiter)
    .map((folder) => path.join(folder, name))
    .find((file) => fs.existsSync(file)) || null;
const brew = () =>
  [which('brew'), '/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((file) => file && fs.existsSync(file)) || null;

// The newest release's tag (vX.Y.Z), from the repository's tags.
export function newestTag(lsRemote) {
  const versions = lsRemote
    .split('\n')
    .map((line) => line.match(/refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/))
    .filter(Boolean)
    .map((match) => ({ tag: match[1], parts: match.slice(2, 5).map(Number) }))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return versions[0]?.tag || null;
}

// whisper.cpp's command: the path of whisper-cli once installed.
async function installWhisper({ step, signal, platform = process.platform }) {
  if (platform === 'darwin') {
    const brewCommand = brew();
    if (!brewCommand) throw new Error('Needs Homebrew (https://brew.sh) on a Mac');
    step('Installing whisper-cpp with Homebrew', 0.05);
    const prefix = (await runStreaming(brewCommand, ['--prefix'], { signal })).trim();
    const installed = path.join(prefix, 'bin', 'whisper-cli');
    if (!fs.existsSync(installed))
      await runStreaming(brewCommand, ['install', 'whisper-cpp'], {
        signal,
        onLine: (line) => step(`Homebrew: ${line.slice(0, 120)}`, 0.2)
      });
    if (!fs.existsSync(installed)) throw new Error(`Homebrew didn't install ${installed}`);
    return { command: installed, version: 'Homebrew' };
  }
  const missing = [
    ['git', 'git'],
    ['cmake', 'cmake'],
    ['c++', 'a C++ compiler']
  ].filter(([command]) => !which(command));
  if (missing.length)
    throw new Error(
      `Building whisper.cpp needs ${missing.map(([, name]) => name).join(', ')}: run the agent's Reinstall command (it adds them), or sudo apt install git cmake build-essential`
    );
  // NVIDIA's compiler, for a build that runs on the GPUs.
  const nvcc = [which('nvcc'), '/usr/local/cuda/bin/nvcc'].find((file) => file && fs.existsSync(file)) || null;
  step('Finding the newest whisper.cpp release', 0.03);
  const tag = newestTag(await runStreaming('git', ['ls-remote', '--tags', '--refs', REPO], { signal }));
  if (!tag) throw new Error('No release found');
  const folder = path.join(BUILD_ROOT, 'whisper.cpp');
  const built = path.join(folder, 'build', 'bin', 'whisper-cli');
  const version = nvcc ? `${tag} (CUDA)` : tag;
  // Already built from this release (by an install that then failed downloading a model, say): not built again.
  const marker = path.join(folder, '.streamscribe-built');
  const builtBefore = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : readRecord().whisper?.version;
  if (builtBefore === version && fs.existsSync(built)) return { command: built, version };
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(BUILD_ROOT, { recursive: true });
  step(`Downloading whisper.cpp ${tag}`, 0.05);
  await runStreaming('git', ['clone', '--depth', '1', '--branch', tag, REPO, folder], { signal });
  step(
    `Building whisper.cpp${nvcc ? ' for NVIDIA GPUs' : ''} (several minutes on a Raspberry Pi, longer with CUDA)`,
    0.1
  );
  const env = nvcc
    ? { ...process.env, CUDACXX: nvcc, PATH: `${path.dirname(nvcc)}${path.delimiter}${process.env.PATH}` }
    : process.env;
  await runStreaming(
    'cmake',
    [
      '-B',
      'build',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DBUILD_SHARED_LIBS=OFF',
      ...(nvcc ? ['-DGGML_CUDA=1'] : [])
    ],
    { cwd: folder, env, signal }
  );
  await runStreaming(
    'cmake',
    ['--build', 'build', '--config', 'Release', '-j', String(Math.max(1, os.cpus().length))],
    {
      cwd: folder,
      env,
      signal,
      onLine: (line) => {
        const percent = Number(line.match(/^\[\s*(\d+)%\]/)?.[1]);
        if (Number.isFinite(percent)) step(`Building whisper.cpp ${version}: ${percent}%`, 0.1 + (percent / 100) * 0.5);
      }
    }
  );
  if (!fs.existsSync(built)) throw new Error(`The build didn't make ${built}`);
  fs.writeFileSync(marker, version);
  return { command: built, version };
}

// What went wrong with a request, with its cause (fetch says only "fetch failed"): "fetch failed (ETIMEDOUT,
// us.aws.cdn.hf.co)".
export function failure(error, url) {
  const cause = error.cause;
  const detail = [cause?.code || cause?.message, cause?.hostname || (url ? new URL(url).host : '')]
    .filter(Boolean)
    .join(', ');
  return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message;
}

// A file from the web into place (kept if already there; resumed from a partial download). A dropped connection is
// tried again, from where it stopped, up to `tries` times, waiting longer each time.
async function download(url, file, { signal, onShare = () => {}, fetchFile = fetch, tries = 4, waitMs = 5000 }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  // (Already here, and not partly downloaded again since: kept.)
  if (fs.existsSync(file) && !fs.existsSync(partial)) return file;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await downloadOnce(url, file, partial, { signal, onShare, fetchFile });
      return file;
    } catch (error) {
      // (A refusal from the server, 404 say, isn't tried again.)
      if (signal?.aborted || attempt >= tries || /^[45]\d\d from /.test(error.message))
        throw new Error(
          `${path.basename(file)}: ${failure(error, url)}${attempt > 1 ? ` (after ${attempt} tries)` : ''}`,
          { cause: error }
        );
      await new Promise((resolve) => setTimeout(resolve, waitMs * attempt));
    }
  }
}

async function downloadOnce(url, file, partial, { signal, onShare, fetchFile }) {
  const have = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const response = await fetchFile(url, { signal, headers: have ? { range: `bytes=${have}-` } : {} });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  const resumed = response.status === 206;
  const total = Number(response.headers.get('content-length') || 0) + (resumed ? have : 0);
  const out = fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w' });
  let got = resumed ? have : 0;
  try {
    for await (const chunk of response.body) {
      got += chunk.length;
      if (total) onShare(got / total);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  if (total && fs.statSync(partial).size !== total) throw new Error('download cut short');
  fs.renameSync(partial, file);
}

// Uses what was installed here wherever the configured (or default) tool or model isn't there.
export function applyInstalledTools() {
  const whisper = readRecord().whisper;
  if (!whisper) return;
  const onPath = TOOLS.whisperCpp.includes('/') ? fs.existsSync(TOOLS.whisperCpp) : Boolean(which(TOOLS.whisperCpp));
  if (!onPath && whisper.command && fs.existsSync(whisper.command)) TOOLS.whisperCpp = whisper.command;
  if (!fs.existsSync(TRANSCRIPTION.whisperCppModel) && whisper.model && fs.existsSync(whisper.model))
    TRANSCRIPTION.whisperCppModel = whisper.model;
  if (!fs.existsSync(TRANSCRIPTION.whisperCppVadModel) && whisper.vadModel && fs.existsSync(whisper.vadModel))
    TRANSCRIPTION.whisperCppVadModel = whisper.vadModel;
}

// The installer an agent runs (agent-settings.js asks it to consider its settings each minute). Its report:
// { whisper: { state: installing | installed | failed, step, share, version, model, error, at } }.
export function toolInstaller({
  log = () => {},
  onInstalled = () => {},
  install = installWhisper,
  fetchFile,
  modelsDir = MODELS_DIR,
  retryWaitMs = 5000
} = {}) {
  let running = null;
  let controller = null;
  let report = {};
  const record = readRecord();
  if (record.whisper) report.whisper = { state: 'installed', ...record.whisper };

  // Installs whisper.cpp and a model; throws when it can't (the report says why). onStep(message, share) follows it.
  async function whisper(request, { signal, onStep = () => {} }) {
    const model = WHISPER_MODELS[request.model] ? request.model : 'base.en';
    const step = (message, share) => {
      report = { ...report, whisper: { ...report.whisper, state: 'installing', step: message, share } };
      onStep(message, share);
    };
    report = { ...report, whisper: { state: 'installing', step: 'Starting', share: 0, at: request.at, model } };
    try {
      const { command, version } = await install({ step, signal });
      const modelFile = path.join(modelsDir, `ggml-${model}.bin`);
      step(`Downloading the ${model} model`, 0.6);
      await download(MODEL_URL(model), modelFile, {
        signal,
        fetchFile,
        waitMs: retryWaitMs,
        onShare: (share) => step(`Downloading the ${model} model: ${Math.round(share * 100)}%`, 0.6 + share * 0.35)
      });
      step('Downloading the voice-activity model', 0.95);
      const vadModel = await download(VAD_URL, path.join(modelsDir, VAD_NAME), {
        signal,
        fetchFile,
        waitMs: retryWaitMs
      });
      const done = {
        command,
        version,
        model: modelFile,
        vadModel,
        requestedAt: request.at,
        at: new Date().toISOString()
      };
      writeRecord({ ...readRecord(), whisper: done });
      // (The new model is used from now on, as is the tool where the configured one isn't there.)
      TRANSCRIPTION.whisperCppModel = modelFile;
      applyInstalledTools();
      report = { ...report, whisper: { state: 'installed', ...done } };
      log(`Tools: whisper.cpp ${version} with the ${model} model installed`);
      onInstalled();
      return { version, model: path.basename(modelFile) };
    } catch (error) {
      report = {
        ...report,
        whisper: { ...report.whisper, state: 'failed', error: error.message, requestedAt: request.at }
      };
      log(`Tools: installing whisper.cpp failed: ${error.message}`);
      throw error;
    }
  }

  return {
    // Installs what the settings ask for that hasn't been done for that request (one at a time).
    consider(tools = {}) {
      const request = tools.whisper;
      if (!request?.at || running) return;
      const handled = report.whisper?.requestedAt || readRecord().whisper?.requestedAt;
      if (handled === request.at) return;
      controller = new AbortController();
      running = whisper(request, { signal: controller.signal })
        .catch(() => {})
        .finally(() => {
          running = null;
        });
    },
    // An install job from the work queue (jobs.js: { type: 'install', tool: 'whisper', model }), run now.
    job: () => ({
      canDo: () => !running,
      async run(job, { signal, progress }) {
        if (job.tool !== 'whisper') throw new Error(`Not a tool this agent installs: ${job.tool}`);
        running = whisper(
          { model: job.model, at: job.createdAt || new Date().toISOString() },
          {
            signal,
            onStep: (message, share) => progress(share, message)
          }
        );
        try {
          return await running;
        } finally {
          running = null;
        }
      }
    }),
    busy: () => Boolean(running),
    settled: () => running || Promise.resolve(),
    report: () => report,
    stop() {
      controller?.abort();
    }
  };
}
