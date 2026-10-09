// Reading a shapefile (src/maps/shapefile.js): a polygon and its attributes, written here byte by byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readShapefile } from '../src/maps/shapefile.js';

test('a polygon and its attributes', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-shp-'));
  const ring = [
    [-78.2, 38.9],
    [-78.1, 38.9],
    [-78.1, 39],
    [-78.2, 38.9]
  ];
  const content = Buffer.alloc(44 + 4 + ring.length * 16);
  content.writeInt32LE(5, 0);
  content.writeInt32LE(1, 36);
  content.writeInt32LE(ring.length, 40);
  content.writeInt32LE(0, 44);
  ring.forEach(([x, y], index) => {
    content.writeDoubleLE(x, 48 + index * 16);
    content.writeDoubleLE(y, 56 + index * 16);
  });
  const header = Buffer.alloc(100);
  const record = Buffer.alloc(8);
  record.writeInt32BE(1, 0);
  record.writeInt32BE(content.length / 2, 4);
  fs.writeFileSync(path.join(folder, 'a.shp'), Buffer.concat([header, record, content]));
  // A dBASE file with one field, NAME (C, 12).
  const dbfHeader = Buffer.alloc(32);
  dbfHeader.writeUInt32LE(1, 4);
  dbfHeader.writeUInt16LE(32 + 32 + 1, 8);
  dbfHeader.writeUInt16LE(1 + 12, 10);
  const field = Buffer.alloc(32);
  field.write('NAME', 0, 'latin1');
  field.write('C', 11, 'latin1');
  field[16] = 12;
  const row = Buffer.from(' Front Royal ', 'latin1');
  fs.writeFileSync(path.join(folder, 'a.dbf'), Buffer.concat([dbfHeader, field, Buffer.from([0x0d]), row]));
  const [feature] = readShapefile(path.join(folder, 'a.shp'));
  assert.equal(feature.properties.NAME, 'Front Royal');
  assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: [ring] });
  fs.rmSync(folder, { recursive: true, force: true });
});
