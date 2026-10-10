import path from 'path';

// The last commands this process ran (ffmpeg, ffprobe, git, cmake, tar, …) and the end of what each said, so a failed
// job's log (src/recorder/failure-log.js) can show what happened just before. Kept small: the last 12, each with the
// last 2 KB of its output.
const KEEP = 12;
const TAIL = 2048;
const commands = [];

export function noteCommand(command, args, { code = null, output = '', startedAt = Date.now() } = {}) {
  const shown = [path.basename(command), ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
  commands.push({
    at: new Date(startedAt).toISOString(),
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    command: shown.length > 400 ? `${shown.slice(0, 400)}…` : shown,
    code,
    output: String(output || '').slice(-TAIL)
  });
  if (commands.length > KEEP) commands.splice(0, commands.length - KEEP);
}

// Those run since a moment (a job's start), oldest first.
export const commandsSince = (since = 0) => commands.filter((item) => Date.parse(item.at) >= since);
