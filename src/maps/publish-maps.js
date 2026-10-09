import fs from 'fs';
import path from 'path';
import { RECORDER, STATE_ROOT } from '../config/runtime-config.js';
import { SyncClient } from '../sync/client.js';
import { SqliteStore } from '../sync/stores/node-sqlite.js';
import { hubConfigured } from '../recorder/hub-api.js';
import { MAPS_ROOT } from './fetch-maps.js';

// The maps build-maps made (data/maps/svg/index.json) to the hub's Maps section (collection maps, public): each SVG's
// text with its title, group, what it shows, and credits. A map too large for a record (over 240 KB) stays here.
//   npm run publish-maps -- [--dry-run]
const LIMIT = 240 * 1024;

export async function publishMaps({ dryRun = false, log = console.log } = {}) {
  if (!hubConfigured()) throw new Error('Set recorder.hubUrl and recorder.key in config.local.js first');
  const index = JSON.parse(fs.readFileSync(path.join(MAPS_ROOT, 'svg', 'index.json'), 'utf8'));
  const client = new SyncClient({
    store: new SqliteStore(path.join(STATE_ROOT, 'publish-maps.sqlite')),
    hubUrl: RECORDER.hubUrl,
    key: RECORDER.key
  });
  await client.pull();
  let sent = 0;
  for (const map of index.maps) {
    const svg = fs.readFileSync(path.join(MAPS_ROOT, 'svg', map.file), 'utf8');
    if (svg.length > LIMIT) {
      log(`  ${map.file}: ${Math.round(svg.length / 1024)} KB, too large for the hub (kept in ${MAPS_ROOT}/svg)`);
      continue;
    }
    const id = map.file.replace(/\.svg$/, '');
    const data = {
      title: map.title,
      group: map.group,
      about: map.about,
      credits: map.credits,
      sources: map.sources,
      kind: 'svg',
      svg,
      builtAt: index.builtAt
    };
    const current = (await client.get('maps', id))?.data;
    if (current && current.svg === svg && current.title === map.title) continue;
    log(`  ${map.file}`);
    sent += 1;
    if (!dryRun) await client.put('maps', id, data);
  }
  // Maps in layers: one record for the map (its layers, which areas can be shaded, credits) and one per layer.
  const layered = path.join(MAPS_ROOT, 'layered');
  for (const file of fs.existsSync(layered) ? fs.readdirSync(layered).filter((name) => name.endsWith('.json')) : []) {
    const map = JSON.parse(fs.readFileSync(path.join(layered, file), 'utf8'));
    for (const layer of map.layers) {
      if (layer.svg.length > LIMIT) {
        log(`  ${map.id} ${layer.id}: ${Math.round(layer.svg.length / 1024)} KB, too large for the hub`);
        continue;
      }
      const id = `${map.id}--${layer.id}`;
      const data = { kind: 'layer', map: map.id, title: layer.title, svg: layer.svg };
      if ((await client.get('maps', id))?.data?.svg === layer.svg) continue;
      log(`  ${map.id}: ${layer.title}`);
      sent += 1;
      if (!dryRun) await client.put('maps', id, data);
    }
    const data = {
      kind: 'layered',
      title: map.title,
      group: map.id === 'region' ? 'Region' : 'County',
      about: map.about,
      width: map.width,
      height: map.height,
      layers: map.layers.map((layer) => ({
        id: layer.id,
        title: layer.title,
        on: layer.on,
        record: `${map.id}--${layer.id}`,
        credits: layer.credits
      })),
      shades: map.shades,
      credits: map.credits,
      sources: map.sources,
      builtAt: index.builtAt
    };
    if (JSON.stringify((await client.get('maps', map.id))?.data) === JSON.stringify(data)) continue;
    log(`  ${map.title} (in layers)`);
    sent += 1;
    if (!dryRun) await client.put('maps', map.id, data);
  }
  if (!dryRun) await client.sync();
  return sent;
}

export const run = () =>
  publishMaps({ dryRun: process.argv.includes('--dry-run') })
    .then((sent) => console.log(`${process.argv.includes('--dry-run') ? 'Would send' : 'Sent'} ${sent} maps`))
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
