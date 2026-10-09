import zlib from 'zlib';

// PNG files from pixels, with nothing but Node (for agents: QR codes and blur masks drawn into videos by ffmpeg).
// Pixels are RGBA, row by row.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// '#1a2b3c' → [r, g, b, 255].
export function rgbaOf(color, fallback = [0, 0, 0, 255]) {
  const match = String(color || '').match(/^#([0-9a-f]{6})$/i);
  if (!match) return fallback;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
}

// A mask the size of a blur area: white inside its shape, transparent outside. A rect fills it; an ellipse touches
// its sides; a polygon's points are fractions of its width and height.
export function maskPng(width, height, shape, points = []) {
  const pixels = new Uint8Array(width * height * 4);
  const inside = (x, y) => {
    if (shape === 'ellipse') {
      const dx = (x + 0.5) / width - 0.5;
      const dy = (y + 0.5) / height - 0.5;
      return dx * dx + dy * dy <= 0.25;
    }
    if (shape === 'polygon' && points.length >= 3) {
      const [px, py] = [(x + 0.5) / width, (y + 0.5) / height];
      let hit = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    }
    return true;
  };
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (!inside(x, y)) continue;
      pixels.set([255, 255, 255, 255], (y * width + x) * 4);
    }
  return encodePng(width, height, pixels);
}
