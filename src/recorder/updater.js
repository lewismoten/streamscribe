import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../config/paths.js';
import { STATE_ROOT } from '../config/runtime-config.js';
import { runStreaming } from './tools.js';

// An installed agent updating itself from the hub, so nobody has to log in to each machine after a deploy. Every ten
// minutes it asks the hub which build its agent package is (GET agent-build: the commit, and the package's sha256);
// when that differs from its own build it's behind. It updates when asked on the Agents page (an update job for it in
// the work queue; older websites set agent_settings updateAt), or by itself when its autoUpdate setting is on (it
// queues an update job for itself, so that shows in the queue too), and only while idle (not recording, not
// working on a job, not installing a tool): it downloads the package with its own key, checks it against the sha256,
// unpacks it beside itself, swaps the new code in (bin/, src/, package.json, …; config.local.js and its data are
// never touched; the old code is kept in .update/previous/, and put back if the swap fails), and exits, so its service
// (systemd, launchd) starts it again on the new code. Captures it started keep running and are picked up again.
// A copy run from a git repository (a developer's) never updates itself: it reports, and leaves the code to git.
const EVERY_MS = 10 * 60000;
const handledFile = () => path.join(STATE_ROOT, 'update.json');

export const readBuild = (root = REPO_ROOT) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
  } catch {
    return null;
  }
};
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function updater({
  root = REPO_ROOT,
  hubBuild,
  download,
  isIdle = () => true,
  restart = () => {},
  queueUpdate = null,
  log = () => {},
  unpack = (archive, folder) => runStreaming('tar', ['-xzf', archive, '-C', folder])
}) {
  const current = readBuild(root);
  const managed = Boolean(current?.commit) && !fs.existsSync(path.join(root, '.git'));
  let latest = null;
  let checkedAt = 0;
  let running = null;
  // A build that failed to install isn't tried again by itself (only when asked, or for another build); one queued as
  // an update job (autoUpdate) isn't queued twice.
  let failedCommit = null;
  let queuedCommit = null;
  let report = {
    current: current?.commit || null,
    canUpdate: managed,
    ...(managed ? {} : { note: 'Runs from a git repository: updated with git, not from the hub' })
  };
  const handled = () => {
    try {
      return JSON.parse(fs.readFileSync(handledFile(), 'utf8')).updateAt || null;
    } catch {
      return null;
    }
  };
  const markHandled = (updateAt) => {
    if (!updateAt) return;
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    fs.writeFileSync(handledFile(), JSON.stringify({ updateAt }));
  };

  // The hub's package in place of this code (not restarted yet): { from, to }.
  async function swapIn(onStep = () => {}) {
    const step = (message, share) => {
      report = { ...report, state: 'updating', step: message };
      onStep(share, message);
    };
    const work = path.join(root, '.update');
    const fresh = path.join(work, 'new');
    const previous = path.join(work, 'previous');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(fresh, { recursive: true });
    step(`Downloading ${latest.commit}`, 0.1);
    const archive = path.join(work, 'agent.tgz');
    await download(archive);
    if (latest.sha256 && sha256(archive) !== latest.sha256)
      throw new Error("The download doesn't match the hub's package");
    step('Unpacking', 0.5);
    await unpack(archive, fresh);
    const unpacked = readBuild(fresh);
    if (unpacked?.commit !== latest.commit || !fs.existsSync(path.join(fresh, 'bin', 'recorder.js')))
      throw new Error("The package isn't the build the hub says it is");
    // The swap: each top-level entry of the package in place of the old one (kept until it's done).
    step('Swapping in the new code', 0.8);
    fs.mkdirSync(previous, { recursive: true });
    const moved = [];
    try {
      for (const name of fs.readdirSync(fresh)) {
        if (name === 'config.local.js' || name.startsWith('.')) continue;
        if (fs.existsSync(path.join(root, name))) {
          fs.renameSync(path.join(root, name), path.join(previous, name));
          moved.push(name);
        }
        fs.renameSync(path.join(fresh, name), path.join(root, name));
      }
    } catch (error) {
      for (const name of moved) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
        fs.renameSync(path.join(previous, name), path.join(root, name));
      }
      throw error;
    }
    fs.rmSync(archive, { force: true });
    report = { ...report, state: 'restarting', step: `Updated to ${latest.commit}; restarting` };
    log(`Updated from ${current?.commit} to ${latest.commit}: restarting`);
    return { from: current?.commit || null, to: latest.commit };
  }

  // Asked through its settings (by an older website): swapped in and restarted.
  async function update(updateAt) {
    await swapIn();
    markHandled(updateAt);
    restart();
  }

  return {
    // Checks the hub's build now and then (at once when asked), and updates when it should and can.
    async tick(now, settings = {}) {
      if (running) return;
      const updateAt = settings.updateAt || null;
      const asked = Boolean(updateAt) && updateAt !== handled();
      if (now >= checkedAt || asked) {
        checkedAt = now + EVERY_MS;
        try {
          latest = await hubBuild();
          report = { ...report, latest: latest?.commit || null, checkedAt: new Date(now).toISOString() };
        } catch (error) {
          report = { ...report, error: `Couldn't ask the hub: ${error.message}` };
          return;
        }
      }
      const behind = Boolean(latest?.commit && latest.commit !== current?.commit);
      report = { ...report, behind };
      const auto = settings.autoUpdate && behind && latest.commit !== failedCommit;
      // By itself: as an update job for itself, so it shows in the work queue (done when it's idle).
      if (!asked && auto && queueUpdate && managed) {
        if (queuedCommit !== latest.commit) {
          queuedCommit = latest.commit;
          await queueUpdate(latest.commit).catch(() => {
            queuedCommit = null;
          });
        }
        return;
      }
      if (!asked && !auto) return;
      if (!managed || !behind) {
        markHandled(updateAt);
        report = { ...report, state: managed ? 'up to date' : 'not updated (git)', step: null };
        return;
      }
      if (!isIdle()) {
        report = { ...report, state: 'waiting', step: 'Updating when idle (after the recording or job)' };
        return;
      }
      running = update(updateAt)
        .catch((error) => {
          markHandled(updateAt);
          failedCommit = latest.commit;
          report = { ...report, state: 'failed', error: error.message, step: null };
          log(`Update failed: ${error.message}`);
        })
        .finally(() => {
          running = null;
        });
      await running;
    },
    // An update job from the work queue ({ type: 'update', forAgent }): only while nothing else runs here (jobs.js
    // takes one job at a time, so not during another job; and not while recording), then a restart once the job shows
    // as done.
    job: () => ({
      canDo: () => !running && isIdle(),
      async run(job, { progress }) {
        if (!managed) throw new Error('This agent runs from a git repository: update it with git');
        latest = await hubBuild();
        report = { ...report, latest: latest?.commit || null, checkedAt: new Date().toISOString() };
        if (!latest?.commit) throw new Error('The hub has no agent package');
        if (latest.commit === current?.commit) return { current: current.commit, note: 'Already up to date' };
        running = swapIn(progress);
        try {
          return await running;
        } catch (error) {
          failedCommit = latest.commit;
          report = { ...report, state: 'failed', error: error.message, step: null };
          throw error;
        } finally {
          running = null;
        }
      },
      done: (job, result) => {
        if (result?.to) restart();
      }
    }),
    // { current, latest, behind, canUpdate, state, step, error, checkedAt }
    report: () => report
  };
}
