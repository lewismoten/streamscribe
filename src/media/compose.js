import { TOOLS } from '../config/runtime-config.js';
import { run } from './encode.js';

// Joining clips (each an MP4 with sound, as makeClip makes them) into one video: each scaled to fit 1280×720 (padded
// with black where its shape differs), at 30 frames a second and 48 kHz sound, one after another; and the same sound
// alone as an M4A. Clips from different meetings can differ in size, so the pieces are made alike before joining.
export async function joinClips(clips, { video, audio, signal }) {
  if (!clips.length) throw new Error('No clips to join');
  const inputs = clips.flatMap((clip) => ['-i', clip]);
  const pieces = clips
    .map(
      (_, index) =>
        `[${index}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}];` +
        `[${index}:a]aresample=48000,aformat=channel_layouts=mono[a${index}];`
    )
    .join('');
  const joined = clips.map((_, index) => `[v${index}][a${index}]`).join('') + `concat=n=${clips.length}:v=1:a=1[v][a]`;
  await run(
    TOOLS.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...inputs,
      '-filter_complex',
      pieces + joined,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      video
    ],
    { signal }
  );
  await run(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-c:a', 'copy', audio], {
    signal
  });
  return { width: 1280, height: 720 };
}
