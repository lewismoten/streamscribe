import path from 'path';

// The last commands this process ran (ffmpeg, ffprobe, git, cmake, tar, …) and the end of what each said, so a failed
// job's log (src/recorder/failure-log.js) can show what happened just before. Kept small: the last 12, each with the
// last 2 KB of its output.
const KEEP = 12;
const TAIL = 2048;
const commands = [];

// ffmpeg's loudnorm measurement pass (src/media/encode.js) prints a JSON object one key per line, so capturing it
// raw made a single command's output read as dozens of separate, context-free "messages" in a failure log (each
// `"output_tp" : "-1.50",` looking like its own line). Any JSON object embedded in the output is folded onto one
// line here; plain text output is left alone.
export function compactOutput(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return text;
  try {
    const compact = JSON.stringify(JSON.parse(text.slice(start, end + 1)));
    return [text.slice(0, start).trim(), compact, text.slice(end + 1).trim()].filter(Boolean).join(' ');
  } catch {
    return text; // braces that aren't actually one JSON object -- leave it as it was
  }
}

export function noteCommand(command, args, { code = null, output = '', startedAt = Date.now() } = {}) {
  const shown = [path.basename(command), ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
  commands.push({
    at: new Date(startedAt).toISOString(),
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    command: shown.length > 400 ? `${shown.slice(0, 400)}…` : shown,
    code,
    output: compactOutput(output).slice(-TAIL)
  });
  if (commands.length > KEEP) commands.splice(0, commands.length - KEEP);
}

// Those run since a moment (a job's start), oldest first.
export const commandsSince = (since = 0) => commands.filter((item) => Date.parse(item.at) >= since);
