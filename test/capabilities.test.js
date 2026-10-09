// What an agent reports of its machine (src/recorder/capabilities.js, src/config/build.js): its accelerators, read
// from nvidia-smi and hailortcli, and its version with the commit it was built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHailo, parseNvidia } from '../src/recorder/capabilities.js';
import { buildVersion } from '../src/config/build.js';

test('accelerators: NVIDIA GPUs and a Hailo accelerator', () => {
  assert.deepEqual(parseNvidia('NVIDIA GeForce RTX 3080 Ti, 12288\nNVIDIA GeForce GTX 1080 Ti, 11264\n'), [
    { kind: 'nvidia', name: 'NVIDIA GeForce RTX 3080 Ti', memoryGb: 12 },
    { kind: 'nvidia', name: 'NVIDIA GeForce GTX 1080 Ti', memoryGb: 11 }
  ]);
  assert.deepEqual(parseNvidia(''), []);
  assert.deepEqual(parseHailo('Executing on device: 0000:01:00.0\nDevice Architecture: HAILO8\n'), {
    kind: 'hailo',
    name: 'Hailo-8 (26 TOPS)'
  });
  assert.equal(parseHailo('Device Architecture: HAILO8L').name, 'Hailo-8L (13 TOPS)');
  assert.equal(parseHailo(null).name, 'Hailo AI accelerator', "found, though hailortcli couldn't say which");
});

test('the version, with the commit it was built from', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-build-'));
  try {
    fs.writeFileSync(path.join(folder, 'package.json'), '{"version":"2.3.4"}');
    assert.equal(buildVersion(folder), '2.3.4', 'neither a package nor a repository');
    fs.writeFileSync(path.join(folder, 'build.json'), '{"commit":"abc1234","builtAt":"2026-10-09T22:00:00Z"}');
    assert.equal(buildVersion(folder), '2.3.4+abc1234');
    assert.match(buildVersion(), /^\d+\.\d+\.\d+\+[0-9a-f]{7,}(\.dirty)?$/, 'this repository: from git');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
