import { useEffect, useState } from 'react';

/**
 * The current time (milliseconds since 1970, as Date.now gives), kept up to date every `intervalMs`.
 *
 * Components can't call Date.now while rendering (it gives a different answer each render, so React can't keep the
 * render pure); one that shows something relative to now ("3 minutes ago", "starts in 2 hours", a running clock)
 * reads this instead, and re-renders each time it ticks. Pick the longest interval the display can stand: a minute
 * for "minutes ago", a second for a running clock.
 */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
