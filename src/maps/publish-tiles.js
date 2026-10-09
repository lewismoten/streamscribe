import fs from 'fs';
import path from 'path';
import { RECORDER, STATE_ROOT } from '../config/runtime-config.js';
import { SyncClient } from '../sync/client.js';
import { SqliteStore } from '../sync/stores/node-sqlite.js';
import { hubConfigured } from '../recorder/hub-api.js';
import { hubFiles } from '../recorder/hub-files.js';
import { MAPS_ROOT } from './fetch-maps.js';
import { COUNTY } from './sources.js';

// The slippy map's tiles (build-tiles.js) to the hub: the PMTiles file to its public maps/ folder (sent in pieces; a
// file it has already isn't sent again), served at api.php/tiles/<file>; and the maps record `tiles` saying where it
// is, what's in it (layers, which areas can be shaded), and the credits, which the Maps page's slippy map reads.
//   npm run publish-tiles
export async function publishTiles({ log = console.log } = {}) {
  if (!hubConfigured()) throw new Error('Set recorder.hubUrl and recorder.key in config.local.js first');
  const infoFile = path.join(MAPS_ROOT, 'tiles', 'warren-county.json');
  if (!fs.existsSync(infoFile)) throw new Error('Build the tiles first (npm run build-tiles)');
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  log(`Sending ${info.file} (${Math.round(info.bytes / 1e6)} MB)`);
  await hubFiles().sendFolder(
    'public',
    'maps',
    [{ local: path.join(MAPS_ROOT, 'tiles', info.file), name: info.file }],
    {
      keepOthers: true,
      onProgress: (share) => process.stdout.write(`\r  ${Math.round(share * 100)}%`)
    }
  );
  process.stdout.write('\n');
  // The areas that can be shaded, by id (as in the tiles).
  const read = (name) => JSON.parse(fs.readFileSync(path.join(MAPS_ROOT, 'tiles', `${name}.geojson`), 'utf8')).features;
  const shades = ['counties', 'districts', 'fire-areas'].flatMap((layer) =>
    read(layer)
      .map((feature) => ({ id: feature.properties.id, label: feature.properties.name, layer }))
      .sort((a, b) => a.label.localeCompare(b.label))
  );
  const client = new SyncClient({
    store: new SqliteStore(path.join(STATE_ROOT, 'publish-maps.sqlite')),
    hubUrl: RECORDER.hubUrl,
    key: RECORDER.key
  });
  await client.pull();
  await client.put('maps', 'tiles', {
    kind: 'tiles',
    title: `${COUNTY.name} slippy map`,
    group: 'Other',
    file: `tiles/${info.file}`,
    builtAt: info.builtAt,
    center: info.center,
    bounds: info.bounds,
    zooms: info.zooms,
    layers: info.layers,
    shades,
    credits: info.credits
  });
  await client.sync();
  log('Published: the Maps page has the slippy map.');
}

export const run = () =>
  publishTiles().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
