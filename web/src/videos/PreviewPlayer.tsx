import { useEffect, useMemo, useRef } from 'react';
import { useRecords } from '../data/useRecords.ts';
import type { MediaData } from '../meeting/MediaPlayer.tsx';
import { mediaUrlOf } from '../pages/MeetingsPage.tsx';
import { overlaysAt, type Overlay, type OverlayKind } from './overlays.ts';
import { layout, itemAt, type VideoItem } from './types.ts';

// The video as it will be, from each meeting's audio and (silent) video on the hub, played together and kept in step:
// its clips one after another from the playhead, at each clip's volume, with the overlays turned on drawn over it.
// The editor holds the playhead (time) and whether it's playing; this follows them, and reports the time as it plays.
export default function PreviewPlayer({
  items,
  time,
  playing,
  onTime,
  onPlaying,
  overlaysOf,
  kinds
}: {
  items: VideoItem[];
  time: number;
  playing: boolean;
  onTime: (seconds: number) => void;
  onPlaying: (playing: boolean) => void;
  overlaysOf: (item: VideoItem) => Overlay[];
  kinds: Record<OverlayKind, boolean>;
}) {
  const { records: media } = useRecords<MediaData>('media');
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const reported = useRef(time);
  const shownIndex = useRef(-1);
  const { starts, total } = layout(items);
  const index = itemAt(items, time);
  const item = items[index];
  const files = item ? media?.find((record) => record.id === `${item.recordingId}:${item.part}`)?.data : undefined;
  const videoUrl = files?.video ? mediaUrlOf(files.video.path) : '';
  const audioUrl = files?.audio ? mediaUrlOf(files.audio.path) : '';
  const overlays = useMemo(
    () => (item ? overlaysOf(item).filter((overlay) => kinds[overlay.kind]) : []),
    [item, overlaysOf, kinds]
  );
  const local = item ? time - starts[index] : 0;

  // To the playhead: when another clip begins, or when the editor moved it (not as it plays).
  useEffect(() => {
    if (!item) return;
    const at = item.from + (time - starts[index]);
    const moved = shownIndex.current !== index || Math.abs(time - reported.current) > 0.25;
    shownIndex.current = index;
    reported.current = time;
    if (!moved) return;
    for (const element of [audio.current, video.current])
      if (element && element.readyState > 0) element.currentTime = at;
  }, [time, index, item, starts]);
  // Each clip's volume (the preview can't go above full).
  useEffect(() => {
    if (audio.current) audio.current.volume = item?.muted ? 0 : Math.min(1, item?.volume ?? 1);
  }, [item]);
  // Playing and pausing both together.
  useEffect(() => {
    for (const element of [audio.current, video.current]) {
      if (!element) continue;
      if (playing) element.play().catch(() => {});
      else element.pause();
    }
    // Again when the files change (the next clip from another meeting), so it keeps playing.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [playing, videoUrl, audioUrl]);
  // As it plays: the playhead follows the sound (or the picture, without sound), the picture keeps up with the sound,
  // and at a clip's end the next one begins (or it stops at the video's end).
  useEffect(() => {
    if (!playing || !item) return;
    let frame = 0;
    const tick = () => {
      const master = audioUrl ? audio.current : video.current;
      if (master && master.readyState > 0) {
        if (audioUrl && videoUrl && video.current && Math.abs(video.current.currentTime - master.currentTime) > 0.3)
          video.current.currentTime = master.currentTime;
        const at = master.currentTime;
        if (at >= item.to - 0.04) {
          if (index + 1 < items.length) onTime(starts[index + 1]);
          else {
            onPlaying(false);
            onTime(total);
          }
          return;
        }
        if (at >= item.from - 0.5) {
          const next = starts[index] + Math.max(0, at - item.from);
          reported.current = next;
          onTime(next);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, item, index, items.length, starts, total, audioUrl, videoUrl, onTime, onPlaying]);
  // A newly loaded file starts at the playhead.
  const ready = (element: HTMLMediaElement | null) => {
    if (!element || !item) return;
    element.currentTime = item.from + (time - starts[index]);
    if (playing) element.play().catch(() => {});
  };

  return (
    <div className="preview-player">
      <div className="preview-frame">
        {videoUrl ? (
          // The sound comes from the meeting's audio file (the hub's video is silent).
          // oxlint-disable-next-line jsx-a11y/media-has-caption
          <video ref={video} src={videoUrl} muted playsInline onLoadedMetadata={() => ready(video.current)} />
        ) : (
          <div className="preview-blank">
            {item
              ? audioUrl
                ? 'Sound only'
                : "This meeting's audio and video aren't on the hub"
              : 'Add clips to the timeline'}
          </div>
        )}
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
        {audioUrl && <audio ref={audio} src={audioUrl} onLoadedMetadata={() => ready(audio.current)} />}
        <div className="preview-overlays" aria-live="off">
          {overlaysAt(overlays, local).map((overlay) => (
            <span key={`${overlay.kind}-${overlay.from}`} className={`preview-overlay overlay-${overlay.kind}`}>
              {overlay.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
