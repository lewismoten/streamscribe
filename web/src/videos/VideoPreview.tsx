import { useEffect, useRef, useState } from 'react';
import { useRecords } from '../data/useRecords.ts';
import { clock } from '../format.ts';
import type { MediaData } from '../meeting/MediaPlayer.tsx';
import { mediaUrlOf } from '../pages/MeetingsPage.tsx';
import type { VideoItem } from './types.ts';

// The video as it will be: its clips played one after another, from each meeting's audio and video on the hub (a
// meeting without them on the hub is passed over, and said so). The published video is made from the recordings
// themselves, by an agent.
export default function VideoPreview({ items }: { items: VideoItem[] }) {
  const { records: media } = useRecords<MediaData>('media');
  const [index, setIndex] = useState<number | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const mediaOf = (item: VideoItem) => media?.find((record) => record.id === `${item.recordingId}:${item.part}`)?.data;
  const current = index === null ? null : items[index];
  const file = current ? mediaOf(current)?.video || mediaOf(current)?.audio : null;

  // Without the meeting's media on the hub, on to the next clip.
  useEffect(() => {
    if (index !== null && current && !file) {
      const timer = window.setTimeout(() => setIndex(index + 1 < items.length ? index + 1 : null), 1500);
      return () => window.clearTimeout(timer);
    }
  }, [index, current, file, items.length]);

  const start = () => {
    const element = player.current;
    if (!element || !current) return;
    element.currentTime = current.from;
    element.play().catch(() => {});
  };
  const watch = () => {
    const element = player.current;
    if (!element || !current || element.currentTime < current.to) return;
    element.pause();
    setIndex(index !== null && index + 1 < items.length ? index + 1 : null);
  };

  return (
    <div className="video-preview">
      {current && file ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- a preview of clips; their captions come with publishing
        <video
          key={`${index}-${current.key}`}
          ref={player}
          src={mediaUrlOf(file.path)}
          controls
          onLoadedMetadata={start}
          onTimeUpdate={watch}
        />
      ) : (
        <div className="video-preview-blank">
          {current ? `“${current.title}”: its meeting's audio and video aren't on the hub` : 'Preview'}
        </div>
      )}
      <div className="toolbar">
        <button type="button" className="button" onClick={() => setIndex(0)} disabled={!items.length}>
          ▶ Play the video
        </button>
        {current && (
          <span className="small">
            Clip {index! + 1} of {items.length}: {current.title} ({clock(current.from)}–{clock(current.to)})
          </span>
        )}
        {index !== null && (
          <button type="button" className="link-button" onClick={() => setIndex(null)}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
