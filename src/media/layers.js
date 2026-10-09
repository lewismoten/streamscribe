import fs from 'fs';
import path from 'path';
import { maskPng } from './png.js';
import { qrPng } from './qr-image.js';

// A video's layers, drawn over the joined clips by ffmpeg (see compose.js), in order (later ones on top). Each is shown
// from `from` to `to` (seconds of the video), fading in and out over `fade` seconds (0: a cut), at a fixed size
// (`size`: fractions of the frame's width and height); its keyframes (`keys`: seconds into the layer) move it, and for
// pictures change what part shows (`crop`: fractions of the picture), each in step to the next:
//   qr           a QR code for `url` (color, background, error correction level), with an optional `title` under it
//   official-qr  a QR code to the official video at the moment shown, changing each second (`urls`: [{ at, url }])
//   image        a picture (`file`, downloaded by the agent), showing its `crop` (panning and zooming over time)
//   pip          a part of the video itself (`crop`) shown again as a picture in picture
//   blur         a part of the video (shape rect, ellipse, or polygon `points` within it) blurred, pixelated, or blacked
//                out (`effect`, `strength`), as for children in the audience

const even = (value) => Math.max(2, Math.round(value / 2) * 2);
const number = (value) => Number(value.toFixed(4));

// An expression for a value at time t that goes in step from each keyframe to the next (and holds before the first
// and after the last). points: [{ t, v }] in order.
export function steps(points) {
  if (!points.length) return '0';
  if (points.length === 1) return String(number(points[0].v));
  let expression = String(number(points.at(-1).v));
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const [a, b] = [points[index], points[index + 1]];
    const span = b.t - a.t || 1;
    const between = `${number(a.v)}+(${number(b.v - a.v)})*(t-${number(a.t)})/${number(span)}`;
    expression = `if(lt(t,${number(b.t)}),${between},${expression})`;
  }
  return `if(lt(t,${number(points[0].t)}),${number(points[0].v)},${expression})`;
}

const keysOf = (layer) =>
  [...(layer.keys?.length ? layer.keys : [{ at: 0, x: 0.05, y: 0.05 }])].sort((a, b) => a.at - b.at);
const track = (layer, read) => keysOf(layer).map((key) => ({ t: layer.from + key.at, v: read(key) }));
const cropOf = (key) => key.crop || { x: 0, y: 0, w: 1, h: 1 };

// Zooming a picture (or the video) so its crop fills the layer's box, then taking the box from it.
const panAndZoom = (layer, boxW, boxH) =>
  `scale=w='${boxW}/(${steps(track(layer, (key) => cropOf(key).w))})':h='${boxH}/(${steps(track(layer, (key) => cropOf(key).h))})':eval=frame,` +
  `crop=w=${boxW}:h=${boxH}:x='(${steps(track(layer, (key) => cropOf(key).x))})*iw':y='(${steps(track(layer, (key) => cropOf(key).y))})*ih'`;

const fades = (layer) => {
  const fade = Math.min(layer.fade || 0, (layer.to - layer.from) / 2);
  return fade > 0
    ? `,fade=t=in:st=${number(layer.from)}:d=${number(fade)}:alpha=1,fade=t=out:st=${number(layer.to - fade)}:d=${number(fade)}:alpha=1`
    : '';
};

const EFFECTS = {
  blur: (layer, boxW, boxH) =>
    `boxblur=luma_radius=${Math.max(1, Math.min(Math.floor(Math.min(boxW, boxH) / 2) - 1, Math.round(layer.strength || 12)))}:luma_power=3`,
  pixelate: (layer, boxW, boxH) => {
    const block = Math.max(2, Math.round(layer.strength || 16));
    return `scale=${Math.max(1, Math.round(boxW / block))}:${Math.max(1, Math.round(boxH / block))},scale=${boxW}:${boxH}:flags=neighbor`;
  },
  black: () => 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill'
};

// The inputs and filters for the layers: from the joined video [vin] to [vout]. firstInput is the number of the first
// extra input; files go in folder.
export function layerGraph(layers, { width, height, firstInput, folder, font }) {
  const inputs = [];
  const filters = [];
  let current = 'vin';
  let input = firstInput;
  const scale = height / 720;
  layers.forEach((layer, index) => {
    if (!(layer.to > layer.from)) return;
    const boxW = even((layer.size?.w || 0.2) * width);
    const boxH = even((layer.size?.h || 0.2) * height);
    const x = `(${steps(track(layer, (key) => key.x * width))})`;
    const y = `(${steps(track(layer, (key) => key.y * height))})`;
    const enable = `enable='between(t,${number(layer.from)},${number(layer.to)})'`;
    const next = `layer${index}`;
    const place = (picture, { shortest = true } = {}) =>
      filters.push(
        `[${current}][${picture}]overlay=x='${x}':y='${y}':${enable}${shortest ? ':shortest=1' : ''}[${next}]`
      );
    if (layer.kind === 'qr' || layer.kind === 'official-qr') {
      const options = { size: boxW, color: layer.color, background: layer.background, level: layer.level || 'M' };
      if (layer.kind === 'qr') {
        const file = path.join(folder, `qr-${index}.png`);
        fs.writeFileSync(file, qrPng(layer.url, options).png);
        inputs.push('-loop', '1', '-i', file);
        filters.push(`[${input}:v]format=rgba,scale=${boxW}:${boxW}:flags=neighbor${fades(layer)}[pic${index}]`);
        place(`pic${index}`);
      } else {
        // One picture a second, each the QR code for that second's address.
        const seconds = Math.ceil(layer.to - layer.from);
        const urls = [...(layer.urls || [])].sort((a, b) => a.at - b.at);
        for (let second = 0; second < seconds; second += 1) {
          const url = urls.filter((item) => item.at <= second).at(-1)?.url || urls[0]?.url || '';
          fs.writeFileSync(
            path.join(folder, `official-${index}-${String(second).padStart(5, '0')}.png`),
            qrPng(url || ' ', options).png
          );
        }
        inputs.push('-framerate', '1', '-i', path.join(folder, `official-${index}-%05d.png`));
        filters.push(
          `[${input}:v]format=rgba,scale=${boxW}:${boxW}:flags=neighbor,setpts=PTS-STARTPTS+${number(layer.from)}/TB${fades(layer)}[pic${index}]`
        );
        place(`pic${index}`, { shortest: false });
      }
      input += 1;
      current = next;
      // Its title, centered under it.
      if (layer.title && font) {
        const file = path.join(folder, `qr-title-${index}.txt`);
        fs.writeFileSync(file, layer.title);
        const titled = `titled${index}`;
        filters.push(
          `[${current}]drawtext=fontfile='${font}':textfile='${file}':fontcolor=white:fontsize=${Math.round(22 * scale)}` +
            `:box=1:boxcolor=black@0.6:boxborderw=${Math.round(6 * scale)}:x='${x}+(${boxW}-tw)/2':y='${y}+${boxW + Math.round(8 * scale)}':${enable}[${titled}]`
        );
        current = titled;
      }
      return;
    }
    if (layer.kind === 'image' && layer.file) {
      inputs.push('-loop', '1', '-i', layer.file);
      filters.push(`[${input}:v]format=rgba,${panAndZoom(layer, boxW, boxH)}${fades(layer)}[pic${index}]`);
      input += 1;
      place(`pic${index}`);
      current = next;
      return;
    }
    if (layer.kind === 'pip') {
      filters.push(`[${current}]split[base${index}][copy${index}]`);
      filters.push(`[copy${index}]format=rgba,${panAndZoom(layer, boxW, boxH)}${fades(layer)}[pic${index}]`);
      current = `base${index}`;
      place(`pic${index}`);
      current = next;
      return;
    }
    if (layer.kind === 'blur') {
      const effect = EFFECTS[layer.effect] || EFFECTS.blur;
      const file = path.join(folder, `mask-${index}.png`);
      fs.writeFileSync(file, maskPng(boxW, boxH, layer.shape || 'rect', layer.points || []));
      inputs.push('-loop', '1', '-i', file);
      filters.push(`[${current}]split[base${index}][copy${index}]`);
      filters.push(
        `[copy${index}]crop=w=${boxW}:h=${boxH}:x='${x}':y='${y}',${effect(layer, boxW, boxH)},format=rgba[fx${index}]`,
        `[${input}:v]format=gray,scale=${boxW}:${boxH}[mask${index}]`,
        `[fx${index}][mask${index}]alphamerge${fades(layer)}[pic${index}]`
      );
      input += 1;
      current = `base${index}`;
      place(`pic${index}`);
      current = next;
    }
  });
  filters.push(`[${current}]null[vout]`);
  return { inputs, filter: filters.join(';') };
}
