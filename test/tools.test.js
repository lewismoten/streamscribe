// Tools an agent installs on itself when asked on the Agents page (src/recorder/tools.js): the newest release's tag,
// and an install asked for once (a new request asks again), its model downloaded (resumed after a cut), and used.
// Everything goes in temporary folders: this machine's state, tools, and models are left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-tools-'));
process.env.STATE_DIR = path.join(folder, 'state');
const { newestTag, toolInstaller, WHISPER_MODELS } = await import('../src/recorder/tools.js');
const { TRANSCRIPTION } = await import('../src/config/runtime-config.js');

test('the newest release tag', () => {
  const tags = ['abc\trefs/tags/v1.7.9', 'abc\trefs/tags/v1.10.0', 'abc\trefs/tags/v1.8.2', 'abc\trefs/tags/nightly'];
  assert.equal(newestTag(tags.join('\n')), 'v1.10.0');
  assert.equal(newestTag(''), null);
});

test('installing whisper.cpp and a model when asked, once per request', async () => {
  const modelsDir = path.join(folder, 'models');
  const tool = path.join(folder, 'bin', 'whisper-cli');
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, '');
  let installs = 0;
  const fetched = [];
  // A pretend web: the model, which arrives in two goes (the first cut short).
  const body = Buffer.alloc(1000, 7);
  const fetchFile = async (url, { headers }) => {
    fetched.push({ url, range: headers.range || null });
    const from = headers.range ? Number(headers.range.match(/bytes=(\d+)-/)[1]) : 0;
    return new Response(body.subarray(from), {
      status: from ? 206 : 200,
      headers: { 'content-length': String(body.length - from) }
    });
  };
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, 'ggml-base.en.bin.part'), body.subarray(0, 400));
  let installed = 0;
  const installer = toolInstaller({
    install: async ({ step }) => {
      installs += 1;
      step('Building', 0.5);
      return { command: tool, version: 'v1.10.0' };
    },
    fetchFile,
    modelsDir,
    onInstalled: () => (installed += 1)
  });
  try {
    assert.ok(WHISPER_MODELS['base.en']);
    installer.consider({ whisper: { model: 'base.en', at: '2026-10-09T20:00:00Z' } });
    assert.equal(installer.report().whisper.state, 'installing');
    await installer.settled();
    const done = installer.report().whisper;
    assert.equal(done.state, 'installed', done.error);
    assert.equal(done.version, 'v1.10.0');
    assert.deepEqual(fs.readFileSync(path.join(modelsDir, 'ggml-base.en.bin')), body, 'resumed, whole');
    assert.equal(fetched[0].range, 'bytes=400-');
    assert.ok(
      fetched.some((item) => /whisper-vad/.test(item.url)),
      'the voice-activity model too'
    );
    assert.equal(TRANSCRIPTION.whisperCppModel, path.join(modelsDir, 'ggml-base.en.bin'), 'used from now on');
    assert.equal(installed, 1);
    // The same request again: nothing (it was done); a new one installs again.
    installer.consider({ whisper: { model: 'base.en', at: '2026-10-09T20:00:00Z' } });
    await installer.settled();
    assert.equal(installs, 1);
    installer.consider({ whisper: { model: 'nonsense; rm -rf /', at: '2026-10-09T21:00:00Z' } });
    await installer.settled();
    assert.equal(installs, 2);
    assert.equal(installer.report().whisper.model.endsWith('ggml-base.en.bin'), true, 'only models on the list');
    // A failure is reported, not thrown.
    const failing = toolInstaller({
      install: async () => {
        throw new Error('Building whisper.cpp needs cmake');
      },
      fetchFile,
      modelsDir
    });
    failing.consider({ whisper: { model: 'tiny.en', at: '2026-10-09T22:00:00Z' } });
    await failing.settled();
    assert.equal(failing.report().whisper.state, 'failed');
    assert.match(failing.report().whisper.error, /cmake/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
