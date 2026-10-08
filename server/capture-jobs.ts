import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { DATA_ROOT } from '../src/config/runtime-config.js';
import { binPath, REPO_ROOT } from '../src/config/paths.js';

const LOG_DIR = path.join(DATA_ROOT, 'logs');

export interface Job {
  id: number;
  source_key: string;
  kind: string;
  pid: number | null;
  args: string;
  log_path: string;
  started_at: string;
  ended_at: string | null;
  status: string;
}

const alive = (pid: number | null): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Capture processes running on this machine that weren't started here (from a terminal, for example), so a second
// capture of the same stream is never started beside one.
export function externalCaptures(sourceKey: string, knownPids: number[]): { pid: number; command: string }[] {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return output.split('\n').map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    // Node itself running a capture script (not a shell whose command line mentions one).
    .filter((item) => /^(\S*\/)?node\s+(\S+\s+)*\S*(bin\/capture\.js|scripts\/capture\.js|capture-live\.js)/.test(item.command) && !knownPids.includes(item.pid))
    .filter((item) => !/--source\s/.test(item.command) || new RegExp(`--source\\s+${sourceKey.replace(/[^a-z0-9-]/gi, '')}(\\s|$)`).test(item.command));
}

// Marks jobs whose process has exited as finished.
export function refreshJobs(db: DatabaseSync): Job[] {
  const running = db.prepare("SELECT * FROM jobs WHERE status IN ('running', 'stopping')").all() as unknown as Job[];
  for (const job of running) {
    if (!alive(job.pid)) {
      db.prepare("UPDATE jobs SET status = ?, ended_at = ? WHERE id = ?").run(job.status === 'stopping' ? 'stopped' : 'exited', new Date().toISOString(), job.id);
    }
  }
  return db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 50').all() as unknown as Job[];
}

export function runningJobs(db: DatabaseSync, sourceKey: string): Job[] {
  return refreshJobs(db).filter((job) => job.source_key === sourceKey && (job.status === 'running' || job.status === 'stopping'));
}

// Starts a script as its own process (its own process group, output to a log file), so it outlives the server.
function startJob(db: DatabaseSync, sourceKey: string, kind: string, script: string, args: string[]): Job {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(LOG_DIR, `${stamp}-${kind}-${sourceKey}.log`);
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [binPath(script), ...args], { cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.closeSync(log);
  const id = Number(db.prepare("INSERT INTO jobs (source_key, kind, pid, args, log_path, started_at, status) VALUES (?, ?, ?, ?, ?, ?, 'running')")
    .run(sourceKey, kind, child.pid ?? null, JSON.stringify([script, ...args]), logPath, new Date().toISOString()).lastInsertRowid);
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Job;
}

// A live capture of one source, plus a thumbnail watcher that keeps its review page current while it records.
export function startCapture(db: DatabaseSync, sourceKey: string): Job[] {
  if (runningJobs(db, sourceKey).some((job) => job.kind === 'capture')) {
    throw new Error('A capture of this source is already running');
  }
  const external = externalCaptures(sourceKey, []);
  if (external.length) {
    throw new Error(`A capture is already running outside the app (process ${external.map((item) => item.pid).join(', ')})`);
  }
  const capture = startJob(db, sourceKey, 'capture', 'capture.js', ['--source', sourceKey]);
  const thumbnails = startJob(db, sourceKey, 'thumbnails', 'extract-thumbnails.js', ['--source', sourceKey, '--watch', '15']);
  return [capture, thumbnails];
}

// Stops a source's jobs: an interrupt first (the same as Ctrl+C in a terminal), then a terminate for anything still
// running 15 seconds later. Signals go to each job's whole process group (its ffmpeg children too).
export function stopCapture(db: DatabaseSync, sourceKey: string): Job[] {
  const jobs = runningJobs(db, sourceKey);
  for (const job of jobs) {
    db.prepare("UPDATE jobs SET status = 'stopping' WHERE id = ?").run(job.id);
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-Number(job.pid), name);
      } catch {
        try {
          process.kill(Number(job.pid), name);
        } catch {
          // already gone
        }
      }
    };
    signal('SIGINT');
    setTimeout(() => {
      if (alive(job.pid)) signal('SIGTERM');
    }, 15000).unref();
  }
  return jobs;
}

export function tailLog(logPath: string, lines = 40): string[] {
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
