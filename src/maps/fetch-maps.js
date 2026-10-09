import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { DATA_ROOT } from '../config/runtime-config.js';
import { COUNTY, MAP_SOURCES, REGION } from './sources.js';

// Downloads the public map data (sources.js) into data/maps/raw/<id>/, and keeps a list of what came from where, and
// when, in data/maps/sources.json (for credits). Already downloaded data is skipped unless --again; large data only
// with --heavy. One request at a time, with a pause between pages, to be polite to the services.
//   npm run fetch-maps -- [--only <id>,<id>] [--heavy] [--again]
export const MAPS_ROOT = path.join(DATA_ROOT, 'maps');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(url, file) {
  const response = await fetch(url, { headers: { 'user-agent': 'streamscribe (public meeting archive) map data' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

// An ArcGIS layer as GeoJSON, a page at a time (the service gives up to 2,000 features a request).
async function arcgis(source, file) {
  const features = [];
  for (let offset = 0; ; offset += 2000) {
    const query = new URLSearchParams({
      where: source.where || '1=1',
      outFields: '*',
      outSR: '4326',
      f: 'geojson',
      resultOffset: String(offset),
      resultRecordCount: '2000',
      ...(source.within
        ? {
            geometry: (source.within === 'region' ? REGION.box : COUNTY.box).join(','),
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects'
          }
        : {})
    });
    const response = await fetch(`${source.url}/query?${query}`);
    if (!response.ok) throw new Error(`${source.url}: ${response.status}`);
    const page = await response.json();
    if (page.error) throw new Error(`${source.url}: ${page.error.message}`);
    features.push(...(page.features || []));
    process.stdout.write(`\r  ${features.length} features`);
    if (!page.features?.length || !(page.exceededTransferLimit || page.properties?.exceededTransferLimit)) break;
    await pause(1000);
  }
  process.stdout.write('\n');
  fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
  return features.length;
}

export async function fetchMaps({ only = null, heavy = false, again = false, log = console.log } = {}) {
  const logPath = path.join(MAPS_ROOT, 'sources.json');
  const fetched = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : {};
  for (const source of MAP_SOURCES) {
    if (only && !only.includes(source.id)) continue;
    if (source.heavy && !heavy && !only) {
      log(`${source.title}: large, skipped (--heavy, or --only ${source.id})`);
      continue;
    }
    const folder = path.join(MAPS_ROOT, 'raw', source.id);
    if (fetched[source.id] && fs.existsSync(folder) && !again) {
      log(`${source.title}: already here`);
      continue;
    }
    fs.mkdirSync(folder, { recursive: true });
    log(`${source.title}: ${source.url}`);
    let count = null;
    if (source.kind === 'zip') {
      // One file, or one for each county of the region ({county} in its address).
      const urls = source.perCounty
        ? REGION.counties.map((county) => source.url.replace('{county}', county))
        : [source.url];
      for (const url of urls) {
        const zip = path.join(folder, path.basename(url));
        await download(url, zip);
        const unzipped = spawnSync('unzip', ['-o', '-q', zip, '-d', folder]);
        if (unzipped.status !== 0) throw new Error(`unzip ${zip}: ${unzipped.stderr}`);
        if (source.perCounty) await pause(500);
      }
    } else if (source.kind === 'arcgis') count = await arcgis(source, path.join(folder, `${source.id}.geojson`));
    else await download(source.url, path.join(folder, path.basename(source.url)));
    fetched[source.id] = {
      title: source.title,
      url: source.url,
      credit: source.credit,
      fetchedAt: new Date().toISOString(),
      ...(count === null ? {} : { features: count })
    };
    fs.writeFileSync(logPath, JSON.stringify(fetched, null, 2));
    await pause(500);
  }
  return fetched;
}

export const run = () => {
  const argv = process.argv.slice(2);
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  fetchMaps({
    only: value('--only')?.split(',') || null,
    heavy: argv.includes('--heavy'),
    again: argv.includes('--again')
  })
    .then((fetched) => console.log(`Map data in ${MAPS_ROOT}: ${Object.keys(fetched).length} sources`))
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
};
