import fs from 'fs';
import path from 'path';
import { TOOLS } from '../config/runtime-config.js';
import { run } from './encode.js';
import { layerGraph } from './layers.js';

// Joining clips (each an MP4 with sound, as makeClip makes them) into one video: each scaled to fit the size (1280×720,
// or 1920×1080 for production), padded with black where its shape differs, at 30 frames a second, its sound at its own
// volume (or silent); with its overlays drawn on (who is speaking, the body, the chapter, the time of day, a vote),
// each shown for its stretch of the clip; one after another; and the same sound alone as an M4A.
//
// An overlay is { kind: 'speaker' | 'body' | 'chapter' | 'clock' | 'vote', from, to, text } in seconds into its clip.
// Overlays need a font (one of the usual ones on macOS, Debian, or Ubuntu); without one the video is made without them.
// Then the video's layers go over the joined clips: QR codes, pictures, pictures in picture, and blurred areas (see
// layers.js).

const FONTS = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf'
];
export const overlayFont = () => FONTS.find((file) => fs.existsSync(file)) || null;

// Where each kind of overlay goes, at 720 lines (scaled for other sizes): the speaker low on the left, the body and the
// chapter at the top left, the time of day at the top right, a vote above the speaker.
const PLACES = {
  speaker: { x: '40', y: 'h-110', size: 34 },
  body: { x: '40', y: '30', size: 22 },
  chapter: { x: '40', y: '66', size: 28 },
  clock: { x: 'w-tw-40', y: '30', size: 24 },
  vote: { x: '40', y: 'h-170', size: 28 }
};

// Speaker names and chapter titles fade in and out as they change (a third of a second), rather than popping.
const FADES = new Set(['speaker', 'chapter', 'vote']);
const FADE = 0.3;
const fadeAlpha = (from, to) => {
  const [a, b] = [from.toFixed(2), to.toFixed(2)];
  return `:alpha='if(lt(t,${a}+${FADE}),(t-${a})/${FADE},if(gt(t,${b}-${FADE}),(${b}-t)/${FADE},1))'`;
};

// The drawtext filters for a clip's overlays (each text from a file, so nothing in it needs escaping for ffmpeg).
function overlayFilters(overlays, { font, scale, folder, prefix }) {
  return overlays
    .map((overlay, index) => {
      const place = PLACES[overlay.kind];
      if (!place || !overlay.text || !(overlay.to > overlay.from)) return '';
      const file = path.join(folder, `${prefix}-${index}.txt`);
      fs.writeFileSync(file, overlay.text);
      const at = (value) => value.replace(/\d+/g, (number) => String(Math.round(Number(number) * scale)));
      return (
        `,drawtext=fontfile='${font}':textfile='${file}':fontcolor=white:fontsize=${Math.round(place.size * scale)}` +
        `:box=1:boxcolor=black@0.6:boxborderw=${Math.round(10 * scale)}:x=${at(place.x)}:y=${at(place.y)}` +
        (FADES.has(overlay.kind) && overlay.to - overlay.from > FADE * 2 ? fadeAlpha(overlay.from, overlay.to) : '') +
        `:enable='between(t,${overlay.from.toFixed(2)},${overlay.to.toFixed(2)})'`
      );
    })
    .join('');
}

export async function joinClips(clips, { video, audio, height = 720, tempDir, signal, layers = [] }) {
  if (!clips.length) throw new Error('No clips to join');
  const width = Math.round((height * 16) / 9 / 2) * 2;
  const scale = height / 720;
  const font = overlayFont();
  const folder = fs.mkdtempSync(path.join(tempDir, 'overlays-'));
  const inputs = clips.flatMap((clip) => ['-i', clip.video]);
  const pieces = clips
    .map((clip, index) => {
      const drawn =
        font && clip.overlays?.length
          ? overlayFilters(clip.overlays, { font, scale, folder, prefix: `clip-${index}` })
          : '';
      const volume = clip.muted ? 0 : (clip.volume ?? 1);
      return (
        `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p${drawn}[v${index}];` +
        `[${index}:a]aresample=48000,aformat=channel_layouts=mono,volume=${volume}[a${index}];`
      );
    })
    .join('');
  const graph = layers.length
    ? layerGraph(layers, { width, height, firstInput: clips.length, folder, font })
    : { inputs: [], filter: '' };
  const joined =
    clips.map((_, index) => `[v${index}][a${index}]`).join('') +
    `concat=n=${clips.length}:v=1:a=1[${graph.filter ? 'vin' : 'v'}][a]` +
    (graph.filter ? `;${graph.filter.replace(/\[vout\]$/, '[v]')}` : '');
  await run(
    TOOLS.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...inputs,
      ...graph.inputs,
      '-filter_complex',
      pieces + joined,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      height > 720 ? 'medium' : 'veryfast',
      '-crf',
      height > 720 ? '19' : '26',
      '-c:a',
      'aac',
      '-b:a',
      height > 720 ? '160k' : '96k',
      '-movflags',
      '+faststart',
      video
    ],
    { signal }
  );
  await run(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-c:a', 'copy', audio], {
    signal
  });
  return { width, height, overlays: Boolean(font) };
}
