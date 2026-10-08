import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { DATA_ROOT } from '../config/runtime-config.js';
import { binPath, REPO_ROOT } from '../config/paths.js';

// Background processes for capturing (shared by the web server and recorders): each command runs as its own process
// (its own process group, output to a log file), so it outlives whatever started it, and can be found again by pid.
export const LOG_DIR = path.join(DATA_ROOT, 'logs');

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Starts bin/<command> detached, logging to data/logs/<time>-<kind>-<source>.log. Returns { pid, logPath, startedAt }.
export function startDetached(command, args, { kind = command, sourceKey = '' } = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const logPath = path.join(LOG_DIR, `${startedAt.replace(/[:.]/g, '-')}-${kind}${sourceKey ? `-${sourceKey}` : ''}.log`);
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [binPath(command), ...args], { cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.closeSync(log);
  return { pid: child.pid ?? null, logPath, startedAt };
}

// Stops a detached process and its children: an interrupt first (the same as Ctrl+C in a terminal), then a terminate
// if it's still running after graceMs.
export function stopDetached(pid, graceMs = 15000) {
  if (!pid) return;
  const signal = (name) => {
    try {
      process.kill(-Number(pid), name);
    } catch {
      try { process.kill(Number(pid), name); } catch { /* already gone */ }
    }
  };
  signal('SIGINT');
  setTimeout(() => { if (isAlive(pid)) signal('SIGTERM'); }, graceMs).unref();
}

// Capture processes running on this machine besides knownPids (started from a terminal, for example), so a second
// capture of the same stream is never started beside one.
export function externalCaptures(sourceKey, knownPids = []) {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return output.split('\n').map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    // Node itself running a capture script (not a shell whose command line mentions one).
    .filter((item) => /^(\S*\/)?node\s+(\S+\s+)*\S*(bin\/capture\.js|scripts\/capture\.js|capture-live\.js)/.test(item.command) && !knownPids.includes(item.pid))
    .filter((item) => !/--source\s/.test(item.command) || new RegExp(`--source\\s+${sourceKey.replace(/[^a-z0-9-]/gi, '')}(\\s|$)`).test(item.command));
}

export function tailLog(logPath, lines = 40) {
  try {
    const stats = fs.statSync(logPath);
    const length = Math.min(stats.size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, length, stats.size - length);
    fs.closeSync(fd);
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}
