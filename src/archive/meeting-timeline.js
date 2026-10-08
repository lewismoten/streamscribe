

// Positions between the meeting's timeline and its sources (live sessions and the archive), and time ranges.

// Position mapping between the meeting and its sources.
export function liveToMeeting(pieces, sessionDir, position) {
  const live = pieces.find((piece) => piece.kind === 'live' && piece.session === sessionDir && position >= piece.liveStart - 0.5 && position < piece.liveEnd + 0.5);
  if (live) {
    return Number((live.meetingStart + Math.max(0, Math.min(live.duration, position - live.liveStart))).toFixed(3));
  }
  const fill = pieces.find((piece) => piece.liveHole?.session === sessionDir && position >= piece.liveHole.start - 0.5 && position < piece.liveHole.end + 0.5);
  return fill ? Number((fill.meetingStart + Math.max(0, Math.min(fill.duration, position - fill.liveHole.start))).toFixed(3)) : null;
}

export function archiveToMeeting(pieces, archiveTime) {
  const piece = pieces.find((item) => item.kind === 'archive' && archiveTime >= item.archiveStart - 0.5 && archiveTime < item.archiveEnd + 0.5);
  return piece ? Number((piece.meetingStart + Math.max(0, Math.min(piece.duration, archiveTime - piece.archiveStart))).toFixed(3)) : null;
}

export function meetingToSource(pieces, position) {
  const piece = pieces.find((item) => position >= item.meetingStart && position < item.meetingStart + item.duration) || pieces.at(-1);
  const offset = position - piece.meetingStart;
  return piece.kind === 'live' ? { session: piece.session, position: piece.liveStart + offset } : { archiveTime: piece.archiveStart + offset };
}

export function sourceToMeeting(pieces, ref) {
  return ref.session ? liveToMeeting(pieces, ref.session, ref.position) : archiveToMeeting(pieces, ref.archiveTime);
}

export function remap(previousPieces, pieces, position) {
  return sourceToMeeting(pieces, meetingToSource(previousPieces, position));
}

export function merge(ranges) {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    if (merged.length && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function subtract(ranges, remove) {
  let result = ranges;
  for (const [removeStart, removeEnd] of remove) {
    result = result.flatMap(([start, end]) => {
      if (removeEnd <= start || removeStart >= end) return [[start, end]];
      return [[start, removeStart], [removeEnd, end]].filter(([from, to]) => to - from > 0.001);
    });
  }
  return result;
}
