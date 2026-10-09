import fs from 'fs';

// Reading a shapefile (.shp with its .dbf) into GeoJSON-like features, for the map data the Census Bureau publishes:
// points, polylines, and polygons (each ring a list of [longitude, latitude]), with their attributes. Enough for
// TIGER/Line and cartographic boundary files; nothing else is needed.
function readDbf(file) {
  const bytes = fs.readFileSync(file);
  const count = bytes.readUInt32LE(4);
  const headerLength = bytes.readUInt16LE(8);
  const recordLength = bytes.readUInt16LE(10);
  const fields = [];
  for (let at = 32; bytes[at] !== 0x0d; at += 32) {
    fields.push({
      name: bytes.toString('latin1', at, at + 11).replace(/\0.*$/, ''),
      type: String.fromCharCode(bytes[at + 11]),
      length: bytes[at + 16]
    });
  }
  const records = [];
  for (let index = 0; index < count; index += 1) {
    let at = headerLength + index * recordLength + 1;
    const record = {};
    for (const field of fields) {
      const text = bytes.toString('utf8', at, at + field.length).trim();
      record[field.name] = field.type === 'N' || field.type === 'F' ? (text === '' ? null : Number(text)) : text;
      at += field.length;
    }
    records.push(record);
  }
  return records;
}

export function readShapefile(shpFile) {
  const bytes = fs.readFileSync(shpFile);
  const properties = readDbf(shpFile.replace(/\.shp$/i, '.dbf'));
  const features = [];
  let at = 100;
  let index = 0;
  while (at < bytes.length) {
    const length = bytes.readInt32BE(at + 4) * 2;
    const start = at + 8;
    const type = bytes.readInt32LE(start);
    let geometry = null;
    if (type === 1)
      geometry = { type: 'Point', coordinates: [bytes.readDoubleLE(start + 4), bytes.readDoubleLE(start + 12)] };
    else if (type === 3 || type === 5) {
      const parts = bytes.readInt32LE(start + 36);
      const points = bytes.readInt32LE(start + 40);
      const partStarts = Array.from({ length: parts }, (_, part) => bytes.readInt32LE(start + 44 + part * 4));
      const pointsAt = start + 44 + parts * 4;
      const rings = partStarts.map((from, part) => {
        const to = part + 1 < parts ? partStarts[part + 1] : points;
        return Array.from({ length: to - from }, (_, point) => [
          bytes.readDoubleLE(pointsAt + (from + point) * 16),
          bytes.readDoubleLE(pointsAt + (from + point) * 16 + 8)
        ]);
      });
      geometry = type === 3 ? { type: 'MultiLineString', coordinates: rings } : { type: 'Polygon', coordinates: rings };
    }
    features.push({ type: 'Feature', properties: properties[index] || {}, geometry });
    at = start + length;
    index += 1;
  }
  return features;
}
