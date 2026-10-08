import type { DatabaseSync } from 'node:sqlite';
import { externalCaptures, isAlive, startDetached, stopDetached, tailLog } from '../src/capture/jobs.js';

// Captures started from the web app, recorded as jobs in the library database. The processes themselves are handled by
// src/capture/jobs.js, which recorders share.

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

const alive = (pid: number | null): boolean => isAlive(pid);
export { externalCaptures, tailLog };

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

// Starts a script as its own process (see src/capture/jobs.js), recorded as a job.
function startJob(db: DatabaseSync, sourceKey: string, kind: string, script: string, args: string[]): Job {
  const started = startDetached(script, args, { kind, sourceKey });
  const id = Number(db.prepare("INSERT INTO jobs (source_key, kind, pid, args, log_path, started_at, status) VALUES (?, ?, ?, ?, ?, ?, 'running')")
    .run(sourceKey, kind, started.pid, JSON.stringify([script, ...args]), started.logPath, started.startedAt).lastInsertRowid);
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
    stopDetached(job.pid);
  }
  return jobs;
}
