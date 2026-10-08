import { RECORDER } from '../config/runtime-config.js';

// Whether to stop recording a meeting. Never before its scheduled end: standby before then is the lead-up or a recess.
// After it, stop once the standby slide has shown for standbyMinutes, or no new video has arrived for idleMinutes, and
// at the latest capMinutes past the end. A still title card (such as "Executive Session") is kept video, so a closed
// session never counts as ended. A schedule's overrun settings override the recorder's.
export function overrunSettings(occurrence) {
  return {
    ...RECORDER.overrun,
    ...Object.fromEntries(
      Object.entries(occurrence.overrun || {})
        .filter(([, value]) => Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Number(value)])
    )
  };
}

export function shouldStop(occurrence, activity, now, startedAt) {
  const settings = overrunSettings(occurrence);
  if (now < occurrence.end) return { stop: false };
  if (now >= occurrence.end + settings.capMinutes * 60000)
    return { stop: true, reason: 'cap', detail: `${settings.capMinutes} minutes past the scheduled end` };
  // Quiet since the newest kept video (or since recording started, if none came).
  const since = activity.lastKeptAt ?? startedAt;
  const quietMinutes = (now - since) / 60000;
  if (activity.discardedAfterKept > 0 && quietMinutes >= settings.standbyMinutes) {
    return {
      stop: true,
      reason: 'standby',
      detail: `the standby slide for ${Math.round(quietMinutes * 10) / 10} minutes`
    };
  }
  if (quietMinutes >= settings.idleMinutes)
    return { stop: true, reason: 'idle', detail: `no new video for ${Math.round(quietMinutes * 10) / 10} minutes` };
  return { stop: false };
}
