import fs from 'fs';
import path from 'path';
import { MAPS_ROOT } from './fetch-maps.js';
import { readShapefile } from './shapefile.js';
import { COUNTY, MAP_SOURCES } from './sources.js';
import { buildLayered } from './layered.js';
import { boxOf, COLORS, escape, labelAt, pathOf, projection, ringsOf, svgOf } from './draw.js';

// SVG maps from the downloaded map data (fetch-maps.js): Virginia's counties (the county marked), the county's
// magisterial districts (with the town), its voting precincts, its roads and water, and the town; each simplified to
// a size a web page can show, credited in it, and listed in data/maps/svg/index.json (title, what it shows, credits,
// sources). publish-maps sends them to the hub's Maps section.
//   npm run build-maps
const OUT = path.join(MAPS_ROOT, 'svg');
const shp = (id) => {
  const folder = path.join(MAPS_ROOT, 'raw', id);
  const file = fs.existsSync(folder) && fs.readdirSync(folder).find((name) => name.endsWith('.shp'));
  if (!file) throw new Error(`No ${id} map data (npm run fetch-maps first)`);
  return readShapefile(path.join(folder, file));
};
const geojson = (id) => {
  const file = path.join(MAPS_ROOT, 'raw', id, `${id}.geojson`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).features : [];
};
const creditOf = (...ids) => [
  ...new Set(ids.map((id) => MAP_SOURCES.find((source) => source.id === id)?.credit).filter(Boolean))
];

export function buildMaps({ log = console.log } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const maps = [];
  const save = (file, map) => {
    fs.writeFileSync(path.join(OUT, file), svgOf(map));
    maps.push({
      file,
      title: map.title,
      about: map.about,
      group: map.group,
      credits: map.credits,
      sources: map.sources.map((id) => MAP_SOURCES.find((source) => source.id === id)?.url).filter(Boolean),
      bytes: fs.statSync(path.join(OUT, file)).size
    });
    log(`  ${file}: ${Math.round(fs.statSync(path.join(OUT, file)).size / 1024)} KB`);
  };
  const counties = shp('counties').filter((feature) => feature.properties.STATEFP === COUNTY.state);
  const county = counties.find((feature) => feature.properties.COUNTYFP === COUNTY.county);
  const state = shp('states').find((feature) => feature.properties.STATEFP === COUNTY.state);
  const districts = shp('districts').filter((feature) => feature.properties.COUNTYFP === COUNTY.county);
  const town = shp('places').find((feature) => feature.properties.NAME === COUNTY.town);

  // Virginia's counties, the county marked.
  {
    const project = projection(boxOf([state]));
    const body = [
      ...counties.map(
        (feature) =>
          `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: true, tolerance: 0.4 })}" fill="${feature === county ? '#2f8f83' : '#eef1ee'}" stroke="#9aa59c" stroke-width="0.5" fill-rule="evenodd"><title>${escape(feature.properties.NAMELSAD || feature.properties.NAME)}</title></path>`
      ),
      `<path d="${pathOf(ringsOf(state.geometry), project, { closed: true, tolerance: 0.4 })}" fill="none" stroke="#333" stroke-width="1.2"/>`,
      (() => {
        const [x, y] = labelAt(county.geometry, project);
        return `<text x="${x.toFixed(1)}" y="${(y - 14).toFixed(1)}" font-size="14" font-weight="600" text-anchor="middle" fill="#1d5c55">${escape(COUNTY.name)}</text>`;
      })()
    ].join('\n');
    save('virginia-counties.svg', {
      title: 'Virginia, county by county',
      about: `Virginia's counties and independent cities, with ${COUNTY.name} marked.`,
      group: 'State',
      credits: creditOf('counties', 'states'),
      sources: ['counties', 'states'],
      project,
      body
    });
  }

  // The county's magisterial districts, with the town.
  const countyProject = projection(boxOf([county]));
  {
    const project = countyProject;
    const body = [
      ...districts.map(
        (feature, index) =>
          `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: true })}" fill="${COLORS[index % COLORS.length]}" stroke="#fff" stroke-width="2" fill-rule="evenodd"><title>${escape(feature.properties.NAMELSAD || feature.properties.NAME)}</title></path>`
      ),
      town
        ? `<path d="${pathOf(ringsOf(town.geometry), project, { closed: true })}" fill="#ffffff88" stroke="#7a3b2e" stroke-width="1.5" stroke-dasharray="5 3" fill-rule="evenodd"><title>${escape(town.properties.NAMELSAD)}</title></path>`
        : '',
      `<path d="${pathOf(ringsOf(county.geometry), project, { closed: true })}" fill="none" stroke="#333" stroke-width="2"/>`,
      ...districts.map((feature) => {
        const [x, y] = labelAt(feature.geometry, project);
        return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="20" font-weight="600" text-anchor="middle" fill="#333">${escape(feature.properties.NAME)}</text>`;
      }),
      town
        ? (() => {
            const [x, y] = labelAt(town.geometry, project);
            return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="14" font-style="italic" text-anchor="middle" fill="#7a3b2e">${escape(COUNTY.town)}</text>`;
          })()
        : ''
    ].join('\n');
    save('county-districts.svg', {
      title: `${COUNTY.name} magisterial districts`,
      about: `Each district elects one member of the Board of Supervisors; the town of ${COUNTY.town} is dashed.`,
      group: 'County',
      credits: creditOf('districts', 'places', 'counties'),
      sources: ['districts', 'places', 'counties'],
      project,
      body
    });
  }

  // Voting precincts.
  if (fs.existsSync(path.join(MAPS_ROOT, 'raw', 'precincts'))) {
    const precincts = shp('precincts');
    const project = countyProject;
    const body = [
      ...precincts.map(
        (feature, index) =>
          `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: true })}" fill="${COLORS[index % COLORS.length]}" stroke="#fff" stroke-width="1.5" fill-rule="evenodd"><title>${escape(feature.properties.NAMELSAD20 || feature.properties.NAME20)}</title></path>`
      ),
      `<path d="${pathOf(ringsOf(county.geometry), project, { closed: true })}" fill="none" stroke="#333" stroke-width="2"/>`,
      ...precincts.map((feature) => {
        const [x, y] = labelAt(feature.geometry, project);
        return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="11" text-anchor="middle" fill="#333">${escape(feature.properties.NAME20)}</text>`;
      })
    ].join('\n');
    save('county-precincts.svg', {
      title: `${COUNTY.name} voting precincts (2020)`,
      about: 'Voting districts as the 2020 census drew them.',
      group: 'County',
      credits: creditOf('precincts', 'counties'),
      sources: ['precincts', 'counties'],
      project,
      body
    });
  }

  // Roads and water, county-wide and in the town.
  const roads = shp('roads');
  const waterLines = fs.existsSync(path.join(MAPS_ROOT, 'raw', 'water-lines')) ? shp('water-lines') : [];
  const waterAreas = fs.existsSync(path.join(MAPS_ROOT, 'raw', 'water-areas')) ? shp('water-areas') : [];
  const roadWidth = (feature) => ({ S1100: 3, S1200: 2, S1400: 0.7 })[feature.properties.MTFCC] ?? 0.5;
  // Only what's in a box (for the town's map).
  const inside = (features, box) =>
    !box
      ? features
      : features.filter((feature) =>
          ringsOf(feature.geometry).some((ring) =>
            ring.some(([lon, lat]) => lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3])
          )
        );
  const roadsBody = (project, { tolerance, labels, box = null }) =>
    [
      ...inside(waterAreas, box).map(
        (feature) =>
          `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: true, tolerance })}" fill="#b9d8ee" fill-rule="evenodd"/>`
      ),
      ...inside(waterLines, box).map(
        (feature) =>
          `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: false, tolerance })}" fill="none" stroke="#7fb3d9" stroke-width="0.8"/>`
      ),
      ...inside(roads, box)
        .sort((a, b) => roadWidth(a) - roadWidth(b))
        .map(
          (feature) =>
            `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: false, tolerance })}" fill="none" stroke="${roadWidth(feature) >= 2 ? '#c0703a' : '#666'}" stroke-width="${roadWidth(feature)}"><title>${escape(feature.properties.FULLNAME || 'Road')}</title></path>`
        ),
      ...(labels || [])
    ].join('\n');
  save('county-roads.svg', {
    title: `${COUNTY.name} roads and water`,
    about: 'Highways (orange) and every named road, streams, rivers, and lakes. Hover a road for its name.',
    group: 'County',
    credits: creditOf('roads', 'water-lines', 'water-areas'),
    sources: ['roads', 'water-lines', 'water-areas'],
    project: countyProject,
    body:
      roadsBody(countyProject, { tolerance: 1.5 }) +
      `\n<path d="${pathOf(ringsOf(county.geometry), countyProject, { closed: true })}" fill="none" stroke="#333" stroke-width="2"/>`
  });
  if (town) {
    const townBox = boxOf([town], 0.05);
    const project = projection(townBox);
    save('town.svg', {
      title: `Town of ${COUNTY.town}`,
      about: `The town limits (dashed), its roads, and the Shenandoah. Hover a road for its name.`,
      group: 'Town',
      credits: creditOf('places', 'roads', 'water-lines', 'water-areas'),
      sources: ['places', 'roads', 'water-lines', 'water-areas'],
      project,
      body:
        roadsBody(project, { tolerance: 1, box: townBox }) +
        `\n<path d="${pathOf(ringsOf(town.geometry), project, { closed: true })}" fill="none" stroke="#7a3b2e" stroke-width="2.5" stroke-dasharray="8 4" fill-rule="evenodd"/>`
    });
  }

  // VDOT routes, labeled by number, when downloaded.
  const vdot = geojson('vdot-roads');
  if (vdot.length) {
    const project = countyProject;
    const routes = vdot.filter((feature) => feature.properties.VDOT_RTE_NUMBER);
    save('county-routes.svg', {
      title: `${COUNTY.name} state routes`,
      about: 'Roads VDOT numbers (such as Route 627), colored by kind; hover one for its name and number.',
      group: 'County',
      credits: creditOf('vdot-roads'),
      sources: ['vdot-roads'],
      project,
      body:
        routes
          .map(
            (feature) =>
              `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: false, tolerance: 1.5 })}" fill="none" stroke="${/^(IS|US)/.test(feature.properties.VDOT_RTE_TYPE_CD || '') ? '#c0703a' : feature.properties.VDOT_RTE_TYPE_CD === 'SR' ? '#2f8f83' : '#777'}" stroke-width="${/^(IS|US)/.test(feature.properties.VDOT_RTE_TYPE_CD || '') ? 2.5 : 1}"><title>${escape(`${feature.properties.STREET_NAME_FULL || ''} (Route ${feature.properties.VDOT_RTE_NUMBER})`)}</title></path>`
          )
          .join('\n') +
        `\n<path d="${pathOf(ringsOf(county.geometry), project, { closed: true })}" fill="none" stroke="#333" stroke-width="2"/>`
    });
  }

  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ builtAt: new Date().toISOString(), maps }, null, 2));
  return maps;
}

export const run = () => {
  try {
    const maps = buildMaps();
    console.log(`${maps.length} maps in ${OUT}`);
    console.log('Maps in layers:');
    buildLayered();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
};
