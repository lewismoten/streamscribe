import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { mediaUrl } from '../data/hub.ts';
import { clock } from '../format.ts';

// A recording part's published audio with its silent video kept in step (npm run publish-media makes both), or with
// the stills changing as it plays ("pictures": lighter, and all there is once the video is past its keep time).
// The audio leads: the video follows its play, pause, seeks, and speed, and is put back when it drifts. Both carry
// the page's captions (the transcript as WebVTT, see captions.ts).
export interface MediaFile {
  path: string;
  bytes: number;
  type: string;
  width?: number;
  height?: number;
}
export interface MediaData {
  recordingId: string;
  part: string;
  partIndex: number;
  title: string;
  sourceKey: string;
  sourceName?: string;
  recordedAt: string;
  seconds: number;
  audio: MediaFile;
  video: MediaFile | null;
}
type Mode = 'video' | 'pictures';
// For the page: jump to a time and play. Called straight from a click, since Safari only lets a page start playing
// inside the click itself.
export interface PlayerControl {
  playFrom: (seconds: number) => void;
}
const MODE_KEY = 'streamscribe.playerMode';

function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'pictures' ? 'pictures' : 'video';
  } catch {
    return 'video';
  }
}

export default function MediaPlayer({
  media,
  stills,
  seek,
  onTime,
  control,
  captions
}: {
  media: MediaData;
  stills: { position: number; path: string }[];
  seek: { time: number; n: number } | null;
  onTime: (seconds: number) => void;
  control?: Ref<PlayerControl>;
  captions: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const audioTrack = useRef<HTMLTrackElement>(null);
  const videoTrack = useRef<HTMLTrackElement>(null);
  const [mode, setMode] = useState<Mode>(media.video ? savedMode() : 'pictures');
  const [time, setTime] = useState(0);
  const shown = media.video ? mode : 'pictures';
  const choose = (next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* not kept */
    }
  };

  useEffect(() => {
    const sound = audio.current;
    if (!sound) return;
    const picture = () => (shown === 'video' ? video.current : null);
    const align = () => {
      const view = picture();
      if (view && Math.abs(view.currentTime - sound.currentTime) > 0.3) view.currentTime = sound.currentTime;
    };
    const play = () => {
      align();
      picture()
        ?.play()
        .catch(() => {
          /* it catches up on the next align */
        });
    };
    const pause = () => picture()?.pause();
    const update = () => {
      setTime(sound.currentTime);
      onTime(sound.currentTime);
      align();
    };
    const rate = () => {
      const view = picture();
      if (view) view.playbackRate = sound.playbackRate;
    };
    sound.addEventListener('play', play);
    sound.addEventListener('pause', pause);
    sound.addEventListener('seeked', align);
    sound.addEventListener('timeupdate', update);
    sound.addEventListener('ratechange', rate);
    if (!sound.paused) play();
    return () => {
      sound.removeEventListener('play', play);
      sound.removeEventListener('pause', pause);
      sound.removeEventListener('seeked', align);
      sound.removeEventListener('timeupdate', update);
      sound.removeEventListener('ratechange', rate);
    };
  }, [shown, onTime]);

  // Jumps there (picture and sound together) and plays.
  const playFrom = (seconds: number) => {
    const sound = audio.current;
    if (!sound) return;
    const target = Math.max(0, seconds - 0.5);
    sound.currentTime = target;
    if (video.current) video.current.currentTime = target;
    setTime(target);
    onTime(target);
    sound.play().catch(() => {
      /* the browser wants a click on the player itself first */
    });
  };
  useImperativeHandle(control, () => ({ playFrom }));
  // A jump asked for before this player existed (a time in another part, which switches to it). Only a new seek
  // plays; the player's own changes don't repeat it.
  const playFromSeek = useEffectEvent(playFrom);
  useEffect(() => {
    if (seek) playFromSeek(seek.time);
  }, [seek]);

  // The captions as a file for the tracks: made here, and let go when they change or the player goes, so each
  // address lives exactly as long as the tracks use it. The video's track is new each time the video is shown again.
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([captions], { type: 'text/vtt' }));
    const tracks = shown === 'video' ? [audioTrack.current, videoTrack.current] : [audioTrack.current];
    for (const track of tracks) if (track) track.src = url;
    return () => URL.revokeObjectURL(url);
  }, [captions, shown]);

  const still = [...stills].reverse().find((item) => item.position <= time + 0.5) || stills[0];
  const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;
  return (
    <section className="panel player">
      <button
        type="button"
        className="player-picture"
        aria-label="Play or pause"
        onClick={() => {
          const sound = audio.current;
          if (sound) {
            if (sound.paused) sound.play();
            else sound.pause();
          }
        }}
      >
        {shown === 'video' && media.video ? (
          <video ref={video} src={mediaUrl(media.video.path)} muted playsInline preload="metadata">
            <track ref={videoTrack} kind="captions" srcLang="en" label="Transcript" default />
          </video>
        ) : still ? (
          <img src={mediaUrl(still.path)} alt="" />
        ) : (
          <span className="player-blank">Audio only</span>
        )}
      </button>
      <audio ref={audio} src={mediaUrl(media.audio.path)} controls preload="metadata">
        <track ref={audioTrack} kind="captions" srcLang="en" label="Transcript" default />
      </audio>
      <div className="player-bar">
        <span className="muted">
          {clock(time)} / {clock(media.seconds)}
        </span>
        {media.video && (
          <fieldset className="segmented" aria-label="Show">
            <button type="button" className={shown === 'video' ? 'on' : ''} onClick={() => choose('video')}>
              Video
            </button>
            <button type="button" className={shown === 'pictures' ? 'on' : ''} onClick={() => choose('pictures')}>
              Pictures
            </button>
          </fieldset>
        )}
        <a className="muted" href={mediaUrl(media.audio.path)} download>
          ⬇ Audio ({megabytes(media.audio.bytes)})
        </a>
      </div>
    </section>
  );
}
