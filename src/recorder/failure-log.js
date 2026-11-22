import os from 'os';

// The log a failed job leaves on the hub (jobs.js uploads it as a private file and links it from the job), so a failure
// can be looked into from the website: the job, the agent and its machine, the error, what the agent logged during the
// job, and the last commands it ran with the end of what each said (src/util/command-log.js). At most MOST_BYTES: the
// oldest lines go first when there's more. Never settings or keys: only what the job and its commands said.
export const MOST_BYTES = 256 * 1024;
// How much of the rolling error.log (failureLog entries joined by DIVIDER) is kept: oldest whole entries drop first.
export const ROLLING_MAX_BYTES = 512 * 1024;
export const DIVIDER = `\n${'='.repeat(72)}\n\n`;

const section = (title, body) => `== ${title} ==\n${String(body || '(none)').trim()}\n`;

export function failureLog({ job, error, lines = [], commands = [], agent = {}, ffmpeg = '' }) {
  const head = [
    section(
      'Job',
      [
        `${job.title || job.type} (${job.type}, ${job.id})`,
        job.recordingId ? `recording ${job.recordingId}` : '',
        job.items?.length ? `${job.items.length} clips` : '',
        job.startedAt ? `started ${job.startedAt}` : '',
        `failed ${new Date().toISOString()}`
      ]
        .filter(Boolean)
        .join('\n')
    ),
    section(
      'Agent',
      [
        `${agent.name || agent.id} (${agent.id}), version ${agent.version || '?'}`,
        `${os.hostname()} · ${os.type()} ${os.release()} · ${process.arch} · ${os.cpus().length} CPUs · ${Math.round(os.totalmem() / 1e9)} GB`,
        `Node ${process.versions.node}`,
        ffmpeg ? `ffmpeg ${ffmpeg}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    ),
    section('Error', error?.stack || error?.message || String(error))
  ].join('\n');
  const commandText = commands
    .map((item) => `$ ${item.command}\n  (exit ${item.code}, ${item.seconds} s, ${item.at})\n${item.output.trim()}`)
    .join('\n\n');
  let logLines = [...lines];
  const compose = () =>
    [
      head,
      section('What it logged during the job', logLines.join('\n')),
      section('Its last commands', commandText)
    ].join('\n');
  let text = compose();
  // Too long: the oldest of its log lines go first.
  while (Buffer.byteLength(text) > MOST_BYTES && logLines.length > 1) {
    logLines = ['(earlier lines left out)', ...logLines.slice(Math.ceil(logLines.length / 4) + 1)];
    text = compose();
  }
  return Buffer.byteLength(text) > MOST_BYTES ? Buffer.from(text).subarray(-MOST_BYTES).toString() : text;
}

// One failed job's entry appended to the rolling error.log (replacing the old one-file-per-failure layout: a
// server with many failing jobs used to leave a scattered folder per job, each holding its own timestamped file --
// now there's a single file to check, oldest whole entries dropped first once it passes ROLLING_MAX_BYTES.
export function appendEntry(existing, entry, maxBytes = ROLLING_MAX_BYTES) {
  const entries = String(existing || '')
    .split(DIVIDER)
    .map((part) => part.trim())
    .filter(Boolean);
  entries.push(entry.trim());
  let text = entries.join(DIVIDER);
  while (Buffer.byteLength(text) > maxBytes && entries.length > 1) {
    entries.shift();
    text = entries.join(DIVIDER);
  }
  return `${text}\n`;
}
