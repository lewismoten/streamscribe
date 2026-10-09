import path from 'path';
import { SOURCES } from '../config/runtime-config.js';
import { byNearness, mirrorRecording } from './peers.js';

// Recordings this agent doesn't have but another it reaches does (peers.js): so it can take work on them, fetching
// what the work needs first (a stretch of a part for a clip, all of it for encoding). Which agent has what comes from
// their live reports (holds: the recording ids each has, its own and its copies); relayed agents aren't asked, as
// fetching through Tailscale's relay is too slow for video.
//   peers()    the agents this one reaches (agent-settings.js), with path and ping
//   holders()  Map of agent id → Set of the recording ids it holds
export function remoteRecordings({ client, peers, holders, mirror = mirrorRecording }) {
  const nearby = () => byNearness(peers()).filter((peer) => peer.path !== 'relay');

  // Whether an agent nearby holds the recording.
  const canFetch = (recordingId) => nearby().some((peer) => holders().get(peer.agentId)?.has(recordingId));

  // The recording's parts (or one part) copied into destDir, from/to seconds limiting it to a stretch; then as
  // findRecording gives a recording: { dir, items }.
  async function fetch(recordingId, partName, { from = null, to = null, destDir, signal, onProgress = () => {} }) {
    const record = (await client.get('recordings', recordingId))?.data;
    if (!record) throw new Error('No such recording on the hub');
    const parts = (record.parts || []).filter((part) => part.dir && (!partName || part.name === partName));
    if (!parts.length) throw new Error(`The recording has no part ${partName || ''} with files`);
    const holding = nearby().filter((peer) => holders().get(peer.agentId)?.has(recordingId));
    const source = SOURCES.find((item) => item.key === record.sourceKey) || {
      key: record.sourceKey,
      name: record.sourceName || record.sourceKey
    };
    const items = [];
    for (const [index, part] of parts.entries()) {
      const dir = path.join(destDir, `part-${part.index ?? index}`);
      await mirror(holding.length ? holding : nearby(), recordingId, {
        part: part.name,
        from,
        to,
        destDir: dir,
        signal,
        onProgress: (share, message) => onProgress((index + share) / parts.length, message)
      });
      items.push({
        row: { started_at: record.startedAt },
        dir,
        id: recordingId,
        part: { index: part.index ?? index, name: part.name, dir: part.dir, seconds: part.seconds },
        title: record.title,
        source
      });
    }
    return { dir: items[0].dir, items };
  }

  return { canFetch, fetch };
}
