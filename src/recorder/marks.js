import fs from 'fs';
import path from 'path';
import { SOURCES } from '../config/runtime-config.js';

// Review marks, both ways: a mark file changed on this machine (by the review page, or a script) is sent to the hub,
// and one changed on the hub (by another editor, or the web app) is written into the file here, where the review page
// and the local library pick it up. Marks are records 'recordingId:part:kind' (and 'sourceKey:people' for a source's
// people). Two-sided changes are merged by the sync client.
export const MARK_KINDS = ['speakers', 'agenda', 'votes', 'views', 'audio-boosts', 'meeting-info', 'word-edits', 'playlist'];

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function readFile(file) {
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), mtime: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}
function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
  return fs.statSync(file).mtimeMs;
}

async function syncOne(client, seen, id, file) {
  const local = readFile(file);
  const remote = await client.get('marks', id);
  const memory = seen[id] ??= { mtime: 0, rev: 0 };
  if (local && local.mtime > memory.mtime) {
    if (!remote || !same(remote.data, local.data)) await client.put('marks', id, local.data);
    memory.mtime = local.mtime;
  } else if (remote && !remote.pending && remote.rev > memory.rev && (!local || !same(remote.data, local.data))) {
    memory.mtime = writeFile(file, remote.data);
  }
  if (remote && !remote.pending) memory.rev = Math.max(memory.rev, remote.rev || 0);
}

export async function syncMarks(state, client) {
  state.marks ??= {};
  const sourcesSeen = new Set();
  for (const recording of Object.values(state.recordings || {})) {
    const source = SOURCES.find((item) => item.key === recording.sourceKey);
    if (!source || !recording.parts?.length) continue;
    sourcesSeen.add(source);
    for (const part of recording.parts) {
      for (const kind of MARK_KINDS) {
        await syncOne(client, state.marks, `${recording.id}:${part.name}:${kind}`, path.join(source.storageDir, part.dir, `${kind}.json`));
      }
    }
  }
  for (const source of sourcesSeen) {
    await syncOne(client, state.marks, `${source.key}:people`, path.join(source.storageDir, 'people', 'people.json'));
  }
}
