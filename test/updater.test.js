// An installed agent updating itself from the hub (src/recorder/updater.js): behind but not asked (nothing), asked
// while busy (waits), asked while idle (the new code swapped in, its settings file untouched, the old code kept, then
// a restart), a download that doesn't match (nothing changed), and a copy run from git (never updated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-update-'));
process.env.STATE_DIR = path.join(folder, 'state');
const { updater } = await import('../src/recorder/updater.js');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
// An installed agent at build `old`, and the hub's package at build `new`.
function setUp(name, { git = false } = {}) {
  const root = path.join(folder, name, 'agent');
  write(path.join(root, 'build.json'), '{"commit":"old"}');
  write(path.join(root, 'bin', 'recorder.js'), 'old');
  write(path.join(root, 'src', 'a.js'), 'old');
  write(path.join(root, 'config.local.js'), 'export default { secret: 1 };');
  if (git) fs.mkdirSync(path.join(root, '.git'));
  const built = path.join(folder, name, 'package');
  write(path.join(built, 'build.json'), '{"commit":"new"}');
  write(path.join(built, 'bin', 'recorder.js'), 'new');
  write(path.join(built, 'src', 'a.js'), 'new');
  write(path.join(built, 'package.json'), '{"version":"1.0.0"}');
  const archive = path.join(folder, name, 'agent.tgz');
  execFileSync('tar', ['-czf', archive, '-C', built, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  return { root, archive, sha256 };
}

test('updating itself from the hub', async () => {
  const { root, archive, sha256 } = setUp('one');
  let idle = false;
  let restarts = 0;
  const updates = updater({
    root,
    hubBuild: async () => ({ commit: 'new', sha256 }),
    download: async (file) => fs.copyFileSync(archive, file),
    isIdle: () => idle,
    restart: () => (restarts += 1)
  });
  await updates.tick(Date.now(), {});
  assert.equal(updates.report().behind, true);
  assert.equal(updates.report().state, undefined, 'not asked: nothing done');
  await updates.tick(Date.now(), { updateAt: '2026-10-09T23:00:00Z' });
  assert.equal(updates.report().state, 'waiting', 'busy: later');
  idle = true;
  await updates.tick(Date.now(), { updateAt: '2026-10-09T23:00:00Z' });
  assert.equal(updates.report().state, 'restarting', updates.report().error);
  assert.equal(fs.readFileSync(path.join(root, 'bin', 'recorder.js'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'new');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8')).commit, 'new');
  assert.equal(fs.readFileSync(path.join(root, 'config.local.js'), 'utf8'), 'export default { secret: 1 };');
  assert.equal(fs.readFileSync(path.join(root, '.update', 'previous', 'src', 'a.js'), 'utf8'), 'old', 'kept');
  assert.equal(restarts, 1);
});

test('an update job from the work queue: swapped in, then a restart once the job is done', async () => {
  const { root, archive, sha256 } = setUp('four');
  let restarts = 0;
  const queued = [];
  const updates = updater({
    root,
    hubBuild: async () => ({ commit: 'new', sha256 }),
    download: async (file) => fs.copyFileSync(archive, file),
    restart: () => (restarts += 1),
    queueUpdate: async (commit) => queued.push(commit)
  });
  // By itself (autoUpdate): an update job for itself, queued once.
  await updates.tick(Date.now(), { autoUpdate: true });
  await updates.tick(Date.now(), { autoUpdate: true });
  assert.deepEqual(queued, ['new']);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'old', 'not updated outside the job');
  const job = updates.job();
  assert.equal(job.canDo({}), true);
  const steps = [];
  const result = await job.run({}, { progress: (share, message) => steps.push(message) });
  assert.deepEqual(result, { from: 'old', to: 'new' });
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'new');
  assert.ok(steps.includes('Unpacking'));
  assert.equal(restarts, 0, 'not before the job shows as done');
  job.done({}, result);
  assert.equal(restarts, 1);
});

test("a download that doesn't match, and a copy run from git", async () => {
  const bad = setUp('two');
  const corrupt = updater({
    root: bad.root,
    hubBuild: async () => ({ commit: 'new', sha256: 'f'.repeat(64) }),
    download: async (file) => fs.copyFileSync(bad.archive, file)
  });
  await corrupt.tick(Date.now(), { updateAt: '2026-10-09T23:30:00Z' });
  assert.equal(corrupt.report().state, 'failed');
  assert.match(corrupt.report().error, /doesn't match/);
  assert.equal(fs.readFileSync(path.join(bad.root, 'src', 'a.js'), 'utf8'), 'old', 'nothing changed');

  const repo = setUp('three', { git: true });
  let downloads = 0;
  const developer = updater({
    root: repo.root,
    hubBuild: async () => ({ commit: 'new', sha256: repo.sha256 }),
    download: async () => (downloads += 1)
  });
  await developer.tick(Date.now(), { updateAt: '2026-10-09T23:45:00Z', autoUpdate: true });
  assert.equal(developer.report().canUpdate, false);
  assert.equal(developer.report().state, 'not updated (git)');
  assert.equal(downloads, 0);
  fs.rmSync(folder, { recursive: true, force: true });
});
