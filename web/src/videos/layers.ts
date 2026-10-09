import { newId } from '../../../src/sync/collections.js';

// A video's layers (over its clips, in order: later ones on top), as the editor keeps them in the video and an agent
// draws them (src/media/layers.js, which works out the same positions): QR codes, a QR code to the official video at
// the moment shown (changing each second), pictures (a document being discussed, panned and zoomed), a part of the
// video shown again (picture in picture), and blurred areas. Each has a fixed size (fractions of the frame) and
// keyframes (seconds into the layer) that move it, and for pictures change what part shows (crop), in step from one
// to the next.
export type LayerKind = 'qr' | 'official-qr' | 'image' | 'pip' | 'blur';
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LayerKey {
  at: number;
  x: number;
  y: number;
  crop?: Box;
}
export interface Layer {
  id: string;
  kind: LayerKind;
  name?: string;
  from: number;
  to: number;
  fade?: number;
  size: { w: number; h: number };
  keys: LayerKey[];
  // QR codes
  url?: string;
  title?: string;
  color?: string;
  background?: string;
  level?: 'L' | 'M' | 'Q' | 'H';
  // Pictures (a path on the hub) and their shape
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  // Blurred areas
  shape?: 'rect' | 'ellipse' | 'polygon';
  effect?: 'blur' | 'pixelate' | 'black';
  strength?: number;
  points?: [number, number][];
}
export const LAYER_KINDS: Record<LayerKind, { icon: string; label: string }> = {
  qr: { icon: '▦', label: 'QR code' },
  'official-qr': { icon: '▦', label: 'QR code to the official video (changes each second)' },
  image: { icon: '🖼', label: 'Picture' },
  pip: { icon: '⧉', label: 'Picture in picture (a part of the video)' },
  blur: { icon: '◌', label: 'Blurred area' }
};
export const BLUR_EFFECTS = { blur: 'Blur', pixelate: 'Pixelate', black: 'Black out' } as const;
export const SHAPES = { rect: 'Rectangle', ellipse: 'Circle or oval', polygon: 'Drawn shape' } as const;
export const ASPECT = 16 / 9;
const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };

const sorted = (layer: Layer) => [...layer.keys].sort((a, b) => a.at - b.at);
const lerp = (a: number, b: number, share: number) => a + (b - a) * share;

// Where a layer is at a moment of the video, and what part of its picture shows.
export function stateAt(layer: Layer, seconds: number): { x: number; y: number; crop: Box } {
  const keys = sorted(layer);
  const at = seconds - layer.from;
  if (!keys.length) return { x: 0.05, y: 0.05, crop: FULL };
  const after = keys.findIndex((key) => key.at > at);
  if (after === 0 || keys.length === 1) return { x: keys[0].x, y: keys[0].y, crop: keys[0].crop || FULL };
  if (after < 0) {
    const last = keys.at(-1)!;
    return { x: last.x, y: last.y, crop: last.crop || FULL };
  }
  const [a, b] = [keys[after - 1], keys[after]];
  const share = (at - a.at) / (b.at - a.at || 1);
  const [ca, cb] = [a.crop || FULL, b.crop || FULL];
  return {
    x: lerp(a.x, b.x, share),
    y: lerp(a.y, b.y, share),
    crop: {
      x: lerp(ca.x, cb.x, share),
      y: lerp(ca.y, cb.y, share),
      w: lerp(ca.w, cb.w, share),
      h: lerp(ca.h, cb.h, share)
    }
  };
}

// Whether a layer is on at a moment (to its end, inclusive: the video's last frame shows it).
export const isOn = (layer: Layer, seconds: number) => seconds >= layer.from && seconds <= layer.to;

// How visible a layer is at a moment (fading in and out).
export function opacityAt(layer: Layer, seconds: number) {
  if (seconds < layer.from || seconds >= layer.to) return 0;
  const fade = Math.min(layer.fade || 0, (layer.to - layer.from) / 2);
  if (!fade) return 1;
  return Math.max(0, Math.min(1, (seconds - layer.from) / fade, (layer.to - seconds) / fade));
}

// A change at a moment: the keyframe there (within a tenth of a second) changes, or one is added with the layer's
// state at that moment.
export function setKeyAt(layer: Layer, seconds: number, patch: Partial<Omit<LayerKey, 'at'>>): Layer {
  const at = Math.max(0, Math.min(layer.to - layer.from, Math.round((seconds - layer.from) * 10) / 10));
  const existing = layer.keys.find((key) => Math.abs(key.at - at) < 0.1);
  if (existing) return { ...layer, keys: layer.keys.map((key) => (key === existing ? { ...key, ...patch } : key)) };
  const state = stateAt(layer, seconds);
  const key: LayerKey = { at, x: state.x, y: state.y, ...(hasCrop(layer) ? { crop: state.crop } : {}), ...patch };
  return { ...layer, keys: [...layer.keys, key].sort((a, b) => a.at - b.at) };
}

export const hasCrop = (layer: Layer) => layer.kind === 'image' || layer.kind === 'pip';
export const isSquare = (layer: Layer) => layer.kind === 'qr' || layer.kind === 'official-qr';

// Where each kind starts (clear of the overlays: the body and chapter top left, the clock top right, the speaker
// bottom left), so new layers don't land on one another.
const STARTS: Record<LayerKind, { x: number; y: number }> = {
  qr: { x: 0.8, y: 0.14 },
  'official-qr': { x: 0.82, y: 0.6 },
  image: { x: 0.55, y: 0.14 },
  pip: { x: 0.65, y: 0.62 },
  blur: { x: 0.42, y: 0.36 }
};

// A new layer at a moment of the video, for ten seconds (or to the video's end), at a place in the frame.
export function newLayer(
  kind: LayerKind,
  at: number,
  total: number,
  extra: Partial<Layer> = {},
  place: { x: number; y: number } = STARTS[kind]
): Layer {
  // From the playhead (or, at the end, the last stretch of the video) for up to ten seconds.
  const from = Math.max(0, Math.min(at, total - Math.min(10, total)));
  const to = Math.min(Math.max(total, from + 1), from + 10);
  const w = kind === 'blur' ? 0.15 : kind === 'image' || kind === 'pip' ? 0.3 : 0.16;
  const pictureShape = extra.imageWidth && extra.imageHeight ? extra.imageHeight / extra.imageWidth : 9 / 16;
  const h =
    kind === 'qr' || kind === 'official-qr'
      ? w * ASPECT
      : kind === 'image'
        ? Math.min(0.9, w * ASPECT * pictureShape)
        : kind === 'blur'
          ? w * ASPECT
          : w;
  return {
    id: newId(),
    kind,
    from,
    to,
    fade: kind === 'blur' ? 0 : 0.4,
    size: { w, h },
    keys: [
      {
        at: 0,
        x: Math.max(0, Math.min(place.x, 1 - w)),
        y: Math.max(0, Math.min(place.y, 1 - h)),
        ...(kind === 'image'
          ? { crop: { ...FULL } }
          : kind === 'pip'
            ? { crop: { x: 0.35, y: 0.25, w: 0.3, h: 0.3 } }
            : {})
      }
    ],
    ...(kind === 'qr' || kind === 'official-qr'
      ? { color: '#000000', background: '#ffffff', level: 'M' as const }
      : {}),
    ...(kind === 'blur' ? { shape: 'ellipse' as const, effect: 'blur' as const, strength: 14 } : {}),
    ...extra
  };
}
