import fs from 'fs';
import path from 'path';
import { MAPS_ROOT } from './fetch-maps.js';
import { FIRE_COMPANIES, FIRE_SOURCE } from './fire-areas.js';
import { readShapefile } from './shapefile.js';
import { COUNTY, MAP_SOURCES, REGION } from './sources.js';
import { boxOf, escape, labelAt, pathOf, projection, ringsOf } from './draw.js';

// Maps in layers: each layer the same size and place (one projection per map), so they can be shown together or not,
// and areas that can be shaded by id (a county being talked about, a fire company's area). Two maps:
//   region  the county and its neighbors: counties (named; ids county-<FIPS>), towns, major roads (numbered), rivers
//   county  the county: magisterial districts (ids district-<GEOID>), fire and rescue service areas (ids fire-co-<n>,
//           from the county's Map 5.3; see fire-areas.js), fire stations, the roads people know, water, towns, the
//           town's limits
// Each is saved as data/maps/layered/<map>.json (its layers' SVG, which areas can be shaded, credits) and one SVG file
// per layer in data/maps/layered/<map>/; publish-maps sends them to the hub.

const LAYERED = path.join(MAPS_ROOT, 'layered');
const raw = (id) => path.join(MAPS_ROOT, 'raw', id);
const has = (id) => fs.existsSync(raw(id));
// Every shapefile of a source (a county at a time for some), as one list.
const shapes = (id) =>
  has(id)
    ? fs
        .readdirSync(raw(id))
        .filter((name) => name.endsWith('.shp'))
        .flatMap((name) => readShapefile(path.join(raw(id), name)))
    : [];
const geojson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).features : []);
const creditOf = (...ids) => [
  ...new Set(ids.map((id) => MAP_SOURCES.find((source) => source.id === id)?.credit).filter(Boolean))
];
const within = (box) => (feature) =>
  ringsOf(feature.geometry).some((ring) =>
    ring.some(([lon, lat]) => lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3])
  );
const halo = 'paint-order="stroke" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"';
const text = (x, y, words, { size = 12, weight = 400, fill = '#222', anchor = 'middle', italic = false } = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${italic ? ' font-style="italic"' : ''} ${halo}>${escape(words)}</text>`;

// Where to label a line: the middle of its longest piece.
function lineMiddle(features, project) {
  const pieces = features.flatMap((feature) => ringsOf(feature.geometry)).map((ring) => ring.map(project.point));
  const longest = pieces.sort((a, b) => b.length - a.length)[0];
  return longest?.[Math.floor(longest.length / 2)] || null;
}
// A route's number on its shield: interstates blue, US routes white, state routes in an oval.
function shield(x, y, label, kind) {
  if (kind === 'parkway') return text(x, y - 6, label, { size: 11, italic: true, fill: '#2f6b2f' });
  const width = 10 + label.length * 7;
  const shape =
    kind === 'interstate'
      ? `<rect x="${-width / 2}" y="-9" width="${width}" height="18" rx="4" fill="#1f4e9c" stroke="#fff" stroke-width="1.5"/>`
      : kind === 'us'
        ? `<rect x="${-width / 2}" y="-9" width="${width}" height="18" rx="2" fill="#fff" stroke="#222" stroke-width="1.5"/>`
        : `<ellipse rx="${width / 2 + 2}" ry="9" fill="#fff" stroke="#222" stroke-width="1.5"/>`;
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">${shape}<text y="4" font-size="11" font-weight="700" text-anchor="middle" fill="${kind === 'interstate' ? '#fff' : '#222'}">${escape(label)}</text></g>`;
}
const ROAD_STYLE = {
  interstate: { color: '#d4462f', width: 4 },
  us: { color: '#e07b39', width: 2.6 },
  state: { color: '#c79a3b', width: 1.8 },
  parkway: { color: '#3c8d3c', width: 2, dash: '6 3' },
  local: { color: '#666', width: 1.2 }
};
const roadPath = (features, project, style, tolerance = 1) =>
  features
    .map(
      (feature) =>
        `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: false, tolerance })}" fill="none" stroke="${style.color}" stroke-width="${style.width}" stroke-linecap="round" stroke-linejoin="round"${style.dash ? ` stroke-dasharray="${style.dash}"` : ''}><title>${escape(feature.properties.FULLNAME || feature.properties.STREET_NAME_FULL || '')}</title></path>`
    )
    .join('');

// Places to mark: Census places (their middle), else USGS place names in the region's counties.
function townsIn(names, box) {
  const places = has('places') ? shapes('places') : [];
  const gnisFile = has('place-names')
    ? fs.readdirSync(path.join(raw('place-names'), 'Text')).find((name) => name.endsWith('.txt'))
    : null;
  const gnis = gnisFile
    ? fs
        .readFileSync(path.join(raw('place-names'), 'Text', gnisFile), 'utf8')
        .split('\n')
        .map((line) => line.split('|'))
        .filter((row) => row[2] === 'Populated Place' && REGION.counties.includes(row[6]))
    : [];
  return names
    .map((name) => {
      const place = places.find((feature) => feature.properties.NAME === name);
      if (place) {
        const points = ringsOf(place.geometry).flat();
        const xs = points.map((point) => point[0]);
        const ys = points.map((point) => point[1]);
        return {
          name,
          kind: /town|city/.test(place.properties.NAMELSAD) ? 'town' : 'village',
          at: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
        };
      }
      const row = gnis.find((item) => item[1] === name);
      return row ? { name, kind: 'village', at: [Number(row[16]), Number(row[15])] } : null;
    })
    .filter(
      (town) => town && town.at[0] >= box[0] && town.at[0] <= box[2] && town.at[1] >= box[1] && town.at[1] <= box[3]
    );
}
const townsLayer = (towns, project) =>
  towns
    .map((town) => {
      const [x, y] = project.point(town.at);
      const big = town.kind === 'town';
      return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${big ? 5 : 3.5}" fill="${big ? '#222' : '#fff'}" stroke="#222" stroke-width="1.5"><title>${escape(town.name)}</title></circle>${text(x + 7, y + 4, town.name, { size: big ? 13 : 11, weight: big ? 600 : 400, anchor: 'start' })}</g>`;
    })
    .join('');

function save(map) {
  const folder = path.join(LAYERED, map.id);
  fs.mkdirSync(folder, { recursive: true });
  const { width, height } = map.project;
  for (const layer of map.layers)
    fs.writeFileSync(
      path.join(folder, `${layer.id}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif">\n<title>${escape(`${map.title}: ${layer.title}`)}</title>\n${layer.svg}\n</svg>\n`
    );
  const out = {
    id: map.id,
    title: map.title,
    about: map.about,
    width,
    height,
    layers: map.layers.map(({ id, title, on, svg, credits }) => ({ id, title, on, svg, credits })),
    shades: map.shades,
    credits: [...new Set(map.layers.flatMap((layer) => layer.credits))],
    sources: map.sources
  };
  fs.writeFileSync(path.join(LAYERED, `${map.id}.json`), JSON.stringify(out));
  return out;
}

function regionMap() {
  const box = REGION.box;
  const project = projection(box);
  const counties = shapes('counties').filter(within(box));
  const virginia = counties.filter((feature) => feature.properties.STATEFP === COUNTY.state);
  const others = counties.filter((feature) => feature.properties.STATEFP !== COUNTY.state);
  const states = shapes('states').filter(within(box));
  const countyLayer = [
    ...others.map(
      (feature) =>
        `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: true })}" fill="#f2f2f2" stroke="#c8c8c8" stroke-width="0.8" fill-rule="evenodd"><title>${escape(feature.properties.NAMELSAD)}</title></path>`
    ),
    ...virginia.map(
      (feature) =>
        `<path id="county-${feature.properties.GEOID}" class="area" d="${pathOf(ringsOf(feature.geometry), project, { closed: true })}" fill="#f6f3ea" stroke="#8a8a80" stroke-width="1" fill-rule="evenodd"><title>${escape(feature.properties.NAMELSAD)}</title></path>`
    ),
    ...states.map(
      (feature) =>
        `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: true })}" fill="none" stroke="#555" stroke-width="1.6" stroke-dasharray="8 4"/>`
    ),
    ...counties.map((feature) => {
      const [x, y] = labelAt(feature.geometry, project);
      const city = /city/i.test(feature.properties.NAMELSAD);
      const name = feature.properties.STATEFP === COUNTY.state ? feature.properties.NAME : feature.properties.NAMELSAD;
      return x > 0 && x < project.width && y > 0 && y < project.height
        ? text(x, y + (city ? -10 : 0), name.toUpperCase(), {
            size: city ? 9 : 13,
            weight: 600,
            fill: feature.properties.STATEFP === COUNTY.state ? '#7a7466' : '#aaa'
          })
        : '';
    })
  ].join('\n');
  // Rivers.
  const rivers = shapes('region-water').filter(
    (feature) =>
      REGION.rivers.some((pattern) => pattern.test(feature.properties.FULLNAME || '')) && within(box)(feature)
  );
  const riverNames = [...new Set(rivers.map((feature) => feature.properties.FULLNAME))];
  const waterLayer =
    rivers
      .map(
        (feature) =>
          `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: false, tolerance: 0.8 })}" fill="none" stroke="#3d86c6" stroke-width="2.2" stroke-linecap="round"><title>${escape(feature.properties.FULLNAME.replace(/ Riv$/, ' River'))}</title></path>`
      )
      .join('') +
    riverNames
      .map((name) => {
        const middle = lineMiddle(
          rivers.filter((feature) => feature.properties.FULLNAME === name),
          project
        );
        return middle
          ? text(middle[0], middle[1] - 6, name.replace(/ Riv$/, ' River'), { size: 11, italic: true, fill: '#1f5f99' })
          : '';
      })
      .join('');
  // Roads: the major ones by name, Skyline Drive from the counties' roads; each with a number shield.
  const major = shapes('state-roads').filter(within(box));
  const skyline = shapes('region-roads').filter((feature) => feature.properties.FULLNAME === 'Skyline Dr');
  const roadLayers = [];
  const shields = [];
  for (const route of REGION.roads) {
    const features = (route.kind === 'parkway' ? skyline : major).filter((feature) =>
      route.match.test(feature.properties.FULLNAME || '')
    );
    if (!features.length) continue;
    roadLayers.push(roadPath(features, project, ROAD_STYLE[route.kind], 1));
    const middle = lineMiddle(features, project);
    if (middle) shields.push(shield(middle[0], middle[1], route.label, route.kind));
  }
  const towns = townsIn(REGION.towns, box);
  return save({
    id: 'region',
    title: `${COUNTY.name} and its neighbors`,
    about: `${COUNTY.name} and the counties around it, with towns, the roads that connect them, and the Shenandoah River and its forks.`,
    project,
    layers: [
      { id: 'counties', title: 'Counties', on: true, svg: countyLayer, credits: creditOf('counties', 'states') },
      { id: 'water', title: 'Rivers', on: true, svg: waterLayer, credits: creditOf('region-water') },
      {
        id: 'roads',
        title: 'Major roads',
        on: true,
        svg: roadLayers.join('\n') + shields.join(''),
        credits: creditOf('state-roads', 'region-roads')
      },
      {
        id: 'towns',
        title: 'Towns',
        on: true,
        svg: townsLayer(towns, project),
        credits: creditOf('places', 'place-names')
      }
    ],
    shades: virginia
      .map((feature) => ({ id: `county-${feature.properties.GEOID}`, label: feature.properties.NAMELSAD }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    sources: ['counties', 'states', 'region-water', 'state-roads', 'region-roads', 'places', 'place-names']
      .map((id) => MAP_SOURCES.find((source) => source.id === id)?.url)
      .filter(Boolean)
  });
}

// The roads people in the county know by name (those on its fire and rescue map), drawn and labeled.
const KNOWN_ROADS = [
  'Reliance Rd',
  'Winchester Rd',
  'Fairground Rd',
  'Howellsville Rd',
  'Strasburg Rd',
  'Fort Valley Rd',
  'Morgan Ford Rd',
  'Happy Creek Rd',
  'W 14th St',
  'E 6th St',
  'South St',
  'John Marshall Hwy',
  'Rivermont Dr',
  'Panhandle Rd',
  'Remount Rd',
  'Stonewall Jackson Hwy',
  'Indian Hollow Rd',
  'Bentonville Rd',
  'Browntown Rd',
  'Gooney Manor Loop',
  'N Royal Ave',
  'S Royal Ave',
  'N Commerce Ave',
  'Skyline Dr'
];
const TOWN_STREETS = ['W 14th St', 'E 6th St', 'South St', 'N Royal Ave', 'S Royal Ave', 'N Commerce Ave'];
const rgb = (color) => `rgb(${color.map((value) => Math.round(value * 2.55)).join(',')})`;
const inside = ([lon, lat], rings) => {
  let hit = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  return hit;
};

function countyMap() {
  const county = shapes('counties').find(
    (feature) => feature.properties.STATEFP === COUNTY.state && feature.properties.COUNTYFP === COUNTY.county
  );
  const box = boxOf([county], 0.03);
  const project = projection(box);
  const outline = `<path d="${pathOf(ringsOf(county.geometry), project, { closed: true })}" fill="none" stroke="#333" stroke-width="2"/>`;
  const districts = shapes('districts').filter((feature) => feature.properties.COUNTYFP === COUNTY.county);
  const districtLayer =
    districts
      .map(
        (feature) =>
          `<path id="district-${feature.properties.GEOID}" class="area" d="${pathOf(ringsOf(feature.geometry), project, { closed: true })}" fill="#f6f3ea" stroke="#9a9488" stroke-width="1.5" fill-rule="evenodd"><title>${escape(feature.properties.NAMELSAD)}</title></path>`
      )
      .join('') +
    outline +
    districts
      .map((feature) => {
        const [x, y] = labelAt(feature.geometry, project);
        return text(x, y, feature.properties.NAME.toUpperCase(), { size: 15, weight: 600, fill: '#7a7466' });
      })
      .join('');
  // Fire and rescue service areas (the county's Map 5.3), in its colors.
  const areas = geojson(path.join(MAPS_ROOT, 'fire-areas.geojson'));
  const fireLayer = areas.length
    ? areas
        .map((feature) => {
          const company = FIRE_COMPANIES.find((item) => item.company === feature.properties.company);
          return `<path id="fire-${feature.properties.company
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(
              /-$/,
              ''
            )}" class="area" d="${pathOf(ringsOf(feature.geometry), project, { closed: true })}" fill="${rgb(company.color)}" fill-opacity="0.85" stroke="#fff" stroke-width="1.5" fill-rule="evenodd"><title>${escape(`${feature.properties.company} ${feature.properties.name}`)}</title></path>`;
        })
        .join('') +
      outline +
      areas
        .map((feature) => {
          const [x, y] = labelAt(feature.geometry, project);
          // (A little below the middle, clear of a town's marker there.)
          return text(x, y + 16, `${feature.properties.company} ${feature.properties.name}`, { size: 12, weight: 600 });
        })
        .join('')
    : '';
  // Fire and EMS stations in the county.
  const countyRings = ringsOf(county.geometry);
  const stations = geojson(path.join(raw('fire-stations'), 'fire-stations.geojson')).filter(
    (feature) => feature.geometry && inside(feature.geometry.coordinates, countyRings)
  );
  const stationLayer = stations
    .map((feature) => {
      const [x, y] = project.point(feature.geometry.coordinates);
      const name = String(feature.properties.name || feature.properties.NAME || 'Fire station')
        .replace(/ Volunteer Fire (and Rescue )?Department/i, ' VFD')
        .replace(/ Fire and Rescue/i, ' F&R');
      return `<g><rect x="${(x - 6).toFixed(1)}" y="${(y - 6).toFixed(1)}" width="12" height="12" rx="2" fill="#c62828" stroke="#fff" stroke-width="1.5"><title>${escape(`${feature.properties.name || ''}, ${feature.properties.address || ''}`)}</title></rect>${text(x + 9, y + 4, name, { size: 10, anchor: 'start', fill: '#8e1c1c' })}</g>`;
    })
    .join('');
  // Roads: interstates and routes, and the roads people know by name.
  const major = shapes('state-roads').filter(within(box));
  const local = shapes('roads');
  const routes = [];
  const labels = [];
  for (const route of REGION.roads.filter((item) => item.kind !== 'parkway')) {
    const features = major.filter((feature) => route.match.test(feature.properties.FULLNAME || ''));
    if (!features.length) continue;
    routes.push(roadPath(features, project, ROAD_STYLE[route.kind], 0.8));
    const middle = lineMiddle(features, project);
    if (middle) labels.push(shield(middle[0], middle[1], route.label, route.kind));
  }
  for (const name of KNOWN_ROADS) {
    const features = local.filter((feature) => feature.properties.FULLNAME === name);
    if (!features.length) continue;
    routes.unshift(roadPath(features, project, name === 'Skyline Dr' ? ROAD_STYLE.parkway : ROAD_STYLE.local, 0.8));
    const middle = lineMiddle(features, project);
    // (The town's own streets are drawn, not named: the middle of town is crowded.)
    if (middle && !TOWN_STREETS.includes(name))
      labels.push(
        text(
          middle[0],
          middle[1] - 4,
          name.replace(/ Rd$/, ' Road').replace(/ Hwy$/, ' Highway').replace(/ Dr$/, ' Drive'),
          {
            size: 10,
            fill: '#444'
          }
        )
      );
  }
  // Water: the Shenandoah's forks, and its wide stretches.
  const rivers = shapes('water-lines').filter((feature) =>
    REGION.rivers.some((pattern) => pattern.test(feature.properties.FULLNAME || ''))
  );
  const lakes = shapes('water-areas');
  const waterLayer =
    lakes
      .map(
        (feature) =>
          `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: true, tolerance: 0.6 })}" fill="#a9cdea" fill-rule="evenodd"/>`
      )
      .join('') +
    rivers
      .map(
        (feature) =>
          `<path d="${pathOf(ringsOf(feature.geometry), project, { closed: false, tolerance: 0.6 })}" fill="none" stroke="#3d86c6" stroke-width="2.4"><title>${escape(feature.properties.FULLNAME.replace(/ Riv$/, ' River'))}</title></path>`
      )
      .join('') +
    [...new Set(rivers.map((feature) => feature.properties.FULLNAME))]
      .map((name) => {
        const middle = lineMiddle(
          rivers.filter((feature) => feature.properties.FULLNAME === name),
          project
        );
        return middle
          ? text(middle[0], middle[1] + 14, name.replace(/ Riv$/, ' River'), {
              size: 11,
              italic: true,
              fill: '#1f5f99'
            })
          : '';
      })
      .join('');
  const town = shapes('places').find((feature) => feature.properties.NAME === COUNTY.town);
  const limits = town
    ? `<path id="town-limits" d="${pathOf(ringsOf(town.geometry), project, { closed: true })}" fill="none" stroke="#7a3b2e" stroke-width="2" stroke-dasharray="6 3" fill-rule="evenodd"><title>${escape(town.properties.NAMELSAD)} limits</title></path>`
    : '';
  const towns = townsIn(REGION.towns, box).filter((item) => inside(item.at, countyRings) || item.name === COUNTY.town);
  return save({
    id: 'county',
    title: COUNTY.name,
    about: `${COUNTY.name}'s magisterial districts, with its fire and rescue service areas, fire stations, the roads people know, the river, and towns as layers.`,
    project,
    layers: [
      {
        id: 'districts',
        title: 'Magisterial districts',
        on: true,
        svg: districtLayer,
        credits: creditOf('districts', 'counties')
      },
      {
        id: 'fire',
        title: 'Fire and rescue service areas',
        on: false,
        svg: fireLayer,
        credits: [FIRE_SOURCE.credit]
      },
      {
        id: 'water',
        title: 'River and lakes',
        on: true,
        svg: waterLayer,
        credits: creditOf('water-lines', 'water-areas')
      },
      {
        id: 'roads',
        title: 'Roads',
        on: true,
        svg: routes.join('\n') + labels.join(''),
        credits: creditOf('roads', 'state-roads')
      },
      { id: 'town-limits', title: `${COUNTY.town} town limits`, on: true, svg: limits, credits: creditOf('places') },
      {
        id: 'stations',
        title: 'Fire and EMS stations',
        on: false,
        svg: stationLayer,
        credits: creditOf('fire-stations')
      },
      {
        id: 'towns',
        title: 'Towns and villages',
        on: true,
        svg: townsLayer(towns, project),
        credits: creditOf('places', 'place-names')
      }
    ],
    shades: [
      ...districts
        .map((feature) => ({ id: `district-${feature.properties.GEOID}`, label: feature.properties.NAMELSAD }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      ...areas.map((feature) => ({
        id: `fire-${feature.properties.company
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-$/, '')}`,
        label: `${feature.properties.company} ${feature.properties.name} (fire and rescue)`
      }))
    ],
    sources: [
      ...[
        'districts',
        'counties',
        'water-lines',
        'water-areas',
        'roads',
        'state-roads',
        'places',
        'place-names',
        'fire-stations'
      ]
        .map((id) => MAP_SOURCES.find((source) => source.id === id)?.url)
        .filter(Boolean),
      FIRE_SOURCE.url
    ]
  });
}

export function buildLayered({ log = console.log } = {}) {
  const maps = [regionMap(), countyMap()];
  for (const map of maps)
    log(
      `  ${map.id}: ${map.layers.map((layer) => `${layer.id} ${Math.round(layer.svg.length / 1024)} KB`).join(', ')}`
    );
  return maps;
}
