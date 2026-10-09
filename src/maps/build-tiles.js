import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { MAPS_ROOT } from './fetch-maps.js';
import { readShapefile } from './shapefile.js';
import { COUNTY, REGION } from './sources.js';

// The slippy map's tiles, in one PMTiles file (data/maps/tiles/warren-county.pmtiles) that the website reads a piece at
// a time: a base map (streets, water, places, land: Protomaps' build of OpenStreetMap) as deep as each area needs,
//   the state       zoom 0–10
//   the region      zoom 11–13 (the county and its neighbors)
//   the county      zoom 14–15 (deeper is drawn from these, larger)
// and our own layers over it (tippecanoe, the same depths): counties (by id, to shade), the county's magisterial
// districts, its fire and rescue service areas, fire and EMS stations, and the town's limits. Needs tippecanoe and
// pmtiles (brew install tippecanoe pmtiles); the base map extracts are kept and reused unless --again.
//   npm run build-tiles -- [--again] [--build 20261009]
const TILES = path.join(MAPS_ROOT, 'tiles');
const STATE_ZOOM = 10;
const REGION_ZOOM = 13;
const COUNTY_ZOOM = 15;
export const BASEMAP_CREDIT = '© OpenStreetMap contributors (ODbL), via Protomaps';

const run = (command, args) => {
  const done = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`${command} ${args[0]}: ${done.stderr?.slice(-400) || done.error?.message}`);
};
const write = (file, value) => fs.writeFileSync(path.join(TILES, file), JSON.stringify(value));
const feature = (properties, geometry, minzoom, maxzoom) => ({
  type: 'Feature',
  tippecanoe: { minzoom, maxzoom },
  properties,
  geometry
});
const polygon = (shape) => ({ type: 'MultiPolygon', coordinates: shape.geometry.coordinates.map((ring) => [ring]) });

async function latestBuild() {
  const builds = await (await fetch('https://build-metadata.protomaps.dev/builds.json')).json();
  return builds.at(-1).key.replace(/\.pmtiles$/, '');
}

export async function buildTiles({ again = false, build = null, log = console.log } = {}) {
  fs.mkdirSync(TILES, { recursive: true });
  // Full detail where it's been fetched (the slippy map zooms to streets), else the generalized files.
  const shp = (detail, fallback) => {
    const folder = path.join(MAPS_ROOT, 'raw', detail);
    const file = fs.existsSync(folder) && fs.readdirSync(folder).find((name) => name.endsWith('.shp'));
    return readShapefile(file ? path.join(folder, file) : path.join(MAPS_ROOT, 'raw', fallback));
  };
  const state = readShapefile(path.join(MAPS_ROOT, 'raw', 'states', 'cb_2023_us_state_500k.shp')).find(
    (item) => item.properties.STATEFP === COUNTY.state
  );
  const counties = shp('counties-detail', 'counties/cb_2023_us_county_500k.shp').filter(
    (item) => item.properties.STATEFP === COUNTY.state
  );
  const county = counties.find((item) => item.properties.COUNTYFP === COUNTY.county);
  write('area-state.geojson', { type: 'Feature', properties: {}, geometry: polygon(state) });
  write('area-county.geojson', { type: 'Feature', properties: {}, geometry: polygon(county) });

  // 1. The base map, as deep as each area needs.
  const source = `https://build.protomaps.com/${build || (await latestBuild())}.pmtiles`;
  const extracts = [
    ['base-state.pmtiles', ['--region', path.join(TILES, 'area-state.geojson'), '--maxzoom', String(STATE_ZOOM)]],
    [
      'base-region.pmtiles',
      // (=, as the box starts with a minus sign, which would read as a flag.)
      [`--bbox=${REGION.box.join(',')}`, '--minzoom', String(STATE_ZOOM + 1), '--maxzoom', String(REGION_ZOOM)]
    ],
    [
      'base-county.pmtiles',
      [
        '--region',
        path.join(TILES, 'area-county.geojson'),
        '--minzoom',
        String(REGION_ZOOM + 1),
        '--maxzoom',
        String(COUNTY_ZOOM)
      ]
    ]
  ];
  for (const [file, args] of extracts) {
    if (fs.existsSync(path.join(TILES, file)) && !again) {
      log(`  ${file}: already here`);
      continue;
    }
    log(`  ${file}: from ${source}`);
    run('pmtiles', ['extract', source, path.join(TILES, file), ...args, '--quiet']);
  }

  // 2. Our layers, each feature only as deep as its area goes.
  const inRegion = (item) => REGION.counties.includes(item.properties.COUNTYFP);
  write('counties.geojson', {
    type: 'FeatureCollection',
    features: counties.map((item) =>
      feature(
        { id: `county-${item.properties.GEOID}`, name: item.properties.NAMELSAD },
        polygon(item),
        4,
        item === county ? COUNTY_ZOOM : inRegion(item) ? REGION_ZOOM : STATE_ZOOM
      )
    )
  });
  const districts = shp('districts-detail', 'districts/cb_2023_51_cousub_500k.shp').filter(
    (item) => item.properties.COUNTYFP === COUNTY.county
  );
  write('districts.geojson', {
    type: 'FeatureCollection',
    features: districts.map((item) =>
      feature(
        { id: `district-${item.properties.GEOID}`, name: item.properties.NAMELSAD },
        polygon(item),
        8,
        COUNTY_ZOOM
      )
    )
  });
  const fireFile = path.join(MAPS_ROOT, 'fire-areas.geojson');
  const fire = fs.existsSync(fireFile) ? JSON.parse(fs.readFileSync(fireFile, 'utf8')).features : [];
  write('fire-areas.geojson', {
    type: 'FeatureCollection',
    features: fire.map((item) =>
      feature(
        {
          id: `fire-${item.properties.company
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/-$/, '')}`,
          name: `${item.properties.company} ${item.properties.name}`
        },
        item.geometry,
        8,
        COUNTY_ZOOM
      )
    )
  });
  const stationsFile = path.join(MAPS_ROOT, 'raw', 'fire-stations', 'fire-stations.geojson');
  const stations = fs.existsSync(stationsFile) ? JSON.parse(fs.readFileSync(stationsFile, 'utf8')).features : [];
  write('stations.geojson', {
    type: 'FeatureCollection',
    features: stations
      .filter((item) => item.geometry)
      .map((item) =>
        feature(
          { name: item.properties.name || 'Fire station', address: item.properties.address || '' },
          item.geometry,
          10,
          COUNTY_ZOOM
        )
      )
  });
  const town = shp('places-detail', 'places/cb_2023_51_place_500k.shp').find(
    (item) => item.properties.NAME === COUNTY.town
  );
  write('town-limits.geojson', {
    type: 'FeatureCollection',
    features: town ? [feature({ name: town.properties.NAMELSAD }, polygon(town), 9, COUNTY_ZOOM)] : []
  });
  log('  our layers: tippecanoe');
  run('tippecanoe', [
    '-o',
    path.join(TILES, 'ours.pmtiles'),
    '--force',
    '--quiet',
    '-Z0',
    `-z${COUNTY_ZOOM}`,
    '--no-tile-size-limit',
    '--detect-shared-borders',
    ...['counties', 'districts', 'fire-areas', 'stations', 'town-limits'].flatMap((layer) => [
      '-L',
      `${layer}:${path.join(TILES, `${layer}.geojson`)}`
    ])
  ]);

  // 3. One file: the base map and ours, tile by tile.
  const out = path.join(TILES, 'warren-county.pmtiles');
  log('  joining');
  run('tile-join', [
    '-o',
    out,
    '--force',
    '--quiet',
    '--no-tile-size-limit',
    ...extracts.map(([file]) => path.join(TILES, file)),
    path.join(TILES, 'ours.pmtiles')
  ]);
  const info = {
    file: 'warren-county.pmtiles',
    bytes: fs.statSync(out).size,
    builtAt: new Date().toISOString(),
    basemap: source,
    center: [(COUNTY.box[0] + COUNTY.box[2]) / 2, (COUNTY.box[1] + COUNTY.box[3]) / 2],
    bounds: REGION.box,
    zooms: { state: STATE_ZOOM, region: REGION_ZOOM, county: COUNTY_ZOOM },
    layers: ['counties', 'districts', 'fire-areas', 'stations', 'town-limits'],
    credits: [
      BASEMAP_CREDIT,
      'U.S. Census Bureau (public domain)',
      'Warren County GIS Department, Map 5.3: Fire and Rescue Service Areas (2010)',
      'U.S. Geological Survey, National Structures Dataset (public domain)'
    ]
  };
  write('warren-county.json', info);
  log(`  ${out}: ${Math.round(info.bytes / 1e6)} MB`);
  return info;
}

export const runCli = () => {
  const argv = process.argv.slice(2);
  buildTiles({
    again: argv.includes('--again'),
    build: argv.includes('--build') ? argv[argv.indexOf('--build') + 1] : null
  }).catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
};
