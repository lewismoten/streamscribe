import { create } from '../vendor/qr/matrix-encoder.js';
import { encodePng, rgbaOf } from './png.js';

// A QR code as a PNG (for agents to draw into videos): its modules in a color on a background, with a quiet zone of
// four modules around it, each module a whole number of pixels (at least the size asked for). radius rounds its
// corners (a share of its size): outside them it's transparent.
export function qrPng(text, { size = 240, color = '#000000', background = '#ffffff', level = 'M', radius = 0 } = {}) {
  const qr = create(String(text), { errorCorrectionLevel: level });
  const count = qr.modules.size + 8;
  const scale = Math.max(1, Math.ceil(size / count));
  const width = count * scale;
  const pixels = new Uint8Array(width * width * 4);
  const [dark, light] = [rgbaOf(color), rgbaOf(background, [255, 255, 255, 255])];
  const clear = [0, 0, 0, 0];
  const r = Math.max(0, Math.min(0.5, radius)) * width;
  // Outside a rounded corner: beyond the corner's circle, in one of the four corner squares.
  const outside = (x, y) => {
    if (!r) return false;
    const [cx, cy] = [
      x + 0.5 < r ? r : x + 0.5 > width - r ? width - r : null,
      y + 0.5 < r ? r : y + 0.5 > width - r ? width - r : null
    ];
    return cx !== null && cy !== null && (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r;
  };
  for (let y = 0; y < width; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (outside(x, y)) {
        pixels.set(clear, (y * width + x) * 4);
        continue;
      }
      const [row, column] = [Math.floor(y / scale) - 4, Math.floor(x / scale) - 4];
      const on =
        row >= 0 && column >= 0 && row < qr.modules.size && column < qr.modules.size && qr.modules.get(row, column);
      pixels.set(on ? dark : light, (y * width + x) * 4);
    }
  return { png: encodePng(width, width, pixels), size: width, version: qr.version };
}
