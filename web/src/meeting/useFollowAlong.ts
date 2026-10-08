import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShownLine } from './words.ts';

// Following along: the line being spoken is highlighted and scrolled near the top of the transcript (level with the
// player), and its word being spoken is marked. Scrolling the transcript yourself stops the following until
// "Follow along" (or a click on a time) turns it back on.
export const lineKey = (line: { part: string; start: number }) => `${line.part}-${line.start}`;

// Keys that scroll the transcript list when it (or something in it) has focus.
const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];

export function useFollowAlong(lines: ShownLine[], playingPart: string | undefined) {
  const list = useRef<HTMLOListElement | null>(null);
  const [nowLine, setNowLine] = useState('');
  const [following, setFollowing] = useState(true);
  const playerTime = useRef(0);

  // The player's time as it plays: the line spoken is kept in state; the word is marked straight in the page
  // (re-rendering the whole transcript several times a second would be slow).
  const onTime = useCallback(
    (seconds: number) => {
      playerTime.current = seconds;
      let current = '';
      for (const line of lines) if (line.part === playingPart && line.start <= seconds + 0.2) current = lineKey(line);
      setNowLine((previous) => (previous === current ? previous : current));
      const root = list.current;
      if (!root) return;
      let word: Element | null = null;
      for (const button of root.querySelectorAll('li.now [data-at]'))
        if (Number((button as HTMLElement).dataset.at) <= seconds + 0.05) word = button;
      const previous = root.querySelector('.speaking');
      if (previous !== word) {
        previous?.classList.remove('speaking');
        word?.classList.add('speaking');
      }
    },
    [lines, playingPart]
  );

  useEffect(() => {
    const root = list.current;
    if (!root || !nowLine || !following) return;
    const line = root.querySelector<HTMLElement>(`li[data-line="${CSS.escape(nowLine)}"]`);
    if (line) root.scrollTo({ top: Math.max(0, line.offsetTop - 12), behavior: 'smooth' });
  }, [nowLine, following]);

  // The transcript list: scrolling it yourself (wheel, touch, or keys) stops the following. Listened for here rather
  // than with JSX handlers, as the list itself isn't a control.
  const listRef = useCallback((node: HTMLOListElement | null) => {
    list.current = node;
    if (!node) return;
    const stop = () => setFollowing(false);
    const key = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.includes(event.key)) stop();
    };
    node.addEventListener('wheel', stop, { passive: true });
    node.addEventListener('touchmove', stop, { passive: true });
    node.addEventListener('keydown', key);
    return () => {
      node.removeEventListener('wheel', stop);
      node.removeEventListener('touchmove', stop);
      node.removeEventListener('keydown', key);
      list.current = null;
    };
  }, []);

  const follow = useCallback(() => setFollowing(true), []);
  const currentTime = useCallback(() => playerTime.current, []);
  return { listRef, onTime, nowLine, following, follow, currentTime };
}
