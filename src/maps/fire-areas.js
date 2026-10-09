import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { MAPS_ROOT } from './fetch-maps.js';
import { readShapefile } from './shapefile.js';
import { COUNTY } from './sources.js';

// The county's fire and rescue service areas, from its GIS department's Map 5.3 (a PDF whose areas are vector shapes
// in page coordinates): each company's area is the map's shape in its legend color. They're placed on the earth by
// fitting their combined outline to the Census outline of the county (scale, rotation, and position, refined by
// matching each point of the county's outline to the nearest point of theirs), and saved as GeoJSON
// (data/maps/fire-areas.geojson) with how closely they fit. build-maps draws them over the county map.
//   npm run fire-areas
export const FIRE_COMPANIES = [
  { company: 'Co. 1', name: 'Front Royal', color: [73.4375, 98.826599, 87.889099] },
  { company: 'Co. 2', name: 'Rivermont', color: [87.5, 74.21875, 98.826599] },
  { company: 'Co. 3', name: 'South Warren', color: [98.826599, 84.375, 95.3125] },
  { company: 'Co. 4', name: 'Linden', color: [98.826599, 97.264099, 83.201599] },
  { company: 'Co. 5', name: 'Shenandoah Shores', color: [98.826599, 82.03125, 71.484375] },
  { company: 'Co. 6', name: 'Shenandoah Farms', color: [75.389099, 94.53125, 98.826599] },
  { company: 'Co. 8', name: 'Fortsmouth', color: [98.826599, 72.264099, 77.734375] },
  { company: 'Co. 9', name: 'Chester Gap', color: [71.484375, 98.826599, 72.65625] },
  { company: 'Co. 10', name: 'North Warren', color: [98.826599, 98.046875, 70.3125] },
  { company: 'Co. 12', name: 'Middletown', color: [98.826599, 73.4375, 90.625] }
];
export const FIRE_SOURCE = {
  url: 'https://warrencountysheriff.org/DocumentCenter/View/416/Map-53----Fire-and-Rescue-Service-Areas-PDF',
  credit: 'Warren County GIS Department, Map 5.3: Fire and Rescue Service Areas (2010), placed on the county outline'
};

// A path's rings (M … L/C … Z), as page points (curves by their end points).
function ringsOfPath(d) {
  const rings = [];
  let ring = null;
  const tokens = d.match(/[MLCZ]|-?[\d.]+/g) || [];
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++];
    if (command === 'M') {
      ring = [[Number(tokens[index]), Number(tokens[index + 1])]];
      rings.push(ring);
      index += 2;
    } else if (command === 'L') {
      ring.push([Number(tokens[index]), Number(tokens[index + 1])]);
      index += 2;
    } else if (command === 'C') {
      ring.push([Number(tokens[index + 4]), Number(tokens[index + 5])]);
      index += 6;
    } else if (command === 'Z' && ring.length) ring.push([...ring[0]]);
  }
  return rings.filter((item) => item.length > 3);
}

// The best similarity (scale, rotation, shift) taking points a onto points b (Umeyama, least squares).
function similarity(a, b) {
  const mean = (points) =>
    points.reduce((sum, [x, y]) => [sum[0] + x / points.length, sum[1] + y / points.length], [0, 0]);
  const [ma, mb] = [mean(a), mean(b)];
  let [sxx, sxy, syx, syy, va] = [0, 0, 0, 0, 0];
  a.forEach(([ax, ay], index) => {
    const [x1, y1] = [ax - ma[0], ay - ma[1]];
    const [x2, y2] = [b[index][0] - mb[0], b[index][1] - mb[1]];
    sxx += x1 * x2;
    sxy += x1 * y2;
    syx += y1 * x2;
    syy += y1 * y2;
    va += x1 * x1 + y1 * y1;
  });
  const angle = Math.atan2(sxy - syx, sxx + syy);
  const scale = Math.hypot(sxx + syy, sxy - syx) / va;
  const [cos, sin] = [Math.cos(angle) * scale, Math.sin(angle) * scale];
  return {
    scale,
    angle,
    apply: ([x, y]) => [cos * (x - ma[0]) - sin * (y - ma[1]) + mb[0], sin * (x - ma[0]) + cos * (y - ma[1]) + mb[1]]
  };
}

export function fireAreas({ log = console.log } = {}) {
  const folder = path.join(MAPS_ROOT, 'raw', 'fire-areas');
  const pdf = path.join(folder, 'map-53-fire-rescue-areas.pdf');
  if (!fs.existsSync(pdf)) throw new Error(`Download the map first: ${FIRE_SOURCE.url} → ${pdf}`);
  const svgFile = path.join(folder, 'map.svg');
  if (!fs.existsSync(svgFile)) {
    const made = spawnSync('pdftocairo', ['-svg', pdf, svgFile]);
    if (made.status !== 0) throw new Error(`pdftocairo (from poppler) is needed: ${made.stderr}`);
  }
  const svg = fs.readFileSync(svgFile, 'utf8');
  const paths = [...svg.matchAll(/<path[^>]*fill="rgb\(([^)]*)\)"[^>]*d="([^"]*)"/g)].map((match) => ({
    color: match[1].split(',').map((part) => Number(part.replace('%', ''))),
    rings: ringsOfPath(match[2])
  }));
  const close = (a, b) => a.every((value, index) => Math.abs(value - b[index]) < 0.01);
  const areas = FIRE_COMPANIES.map((company) => {
    const shape = paths
      .filter((item) => close(item.color, company.color))
      .sort((a, b) => b.rings.flat().length - a.rings.flat().length)[0];
    if (!shape) throw new Error(`No area in the map for ${company.company} ${company.name}`);
    return { ...company, rings: shape.rings };
  });

  // Meters around the county's middle (east, north), and back to longitude and latitude.
  const county = readShapefile(path.join(MAPS_ROOT, 'raw', 'counties', 'cb_2023_us_county_500k.shp')).find(
    (feature) => feature.properties.STATEFP === COUNTY.state && feature.properties.COUNTYFP === COUNTY.county
  );
  const outline = county.geometry.coordinates.flat();
  const [lon0, lat0] = [(COUNTY.box[0] + COUNTY.box[2]) / 2, (COUNTY.box[1] + COUNTY.box[3]) / 2];
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  const toMeters = ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky];
  const toLonLat = ([x, y]) => [Number((x / kx + lon0).toFixed(6)), Number((y / ky + lat0).toFixed(6))];
  const target = outline.map(toMeters);

  // The areas' points (page y runs down, so flipped), and their outer edge: points within 8 page units of the edge of
  // their combined bounds, or any point (the matching takes the nearest).
  const page = areas.flatMap((area) => area.rings.flat()).map(([x, y]) => [x, -y]);
  const bounds = (points) => {
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const [pb, tb] = [bounds(page), bounds(target)];
  // A start from the bounds (north up), then refined: each point of the county outline matched to the nearest area point.
  let transform = similarity(
    [
      [pb[0], pb[1]],
      [pb[2], pb[3]]
    ],
    [
      [tb[0], tb[1]],
      [tb[2], tb[3]]
    ]
  );
  let rms = Infinity;
  for (let round = 0; round < 30; round += 1) {
    const placed = page.map(transform.apply);
    const pairs = target.map((point) => {
      let best = 0;
      let distance = Infinity;
      placed.forEach((candidate, index) => {
        const d = (candidate[0] - point[0]) ** 2 + (candidate[1] - point[1]) ** 2;
        if (d < distance) [best, distance] = [index, d];
      });
      return { from: page[best], to: point, distance };
    });
    rms = Math.sqrt(pairs.reduce((sum, pair) => sum + pair.distance, 0) / pairs.length);
    transform = similarity(
      pairs.map((pair) => pair.from),
      pairs.map((pair) => pair.to)
    );
  }
  log(
    `Fitted to the county outline: ${Math.round(rms)} m RMS, rotated ${((transform.angle * 180) / Math.PI).toFixed(2)}°`
  );
  const features = areas.map((area) => ({
    type: 'Feature',
    properties: { company: area.company, name: area.name },
    geometry: {
      type: 'Polygon',
      coordinates: area.rings.map((ring) => ring.map(([x, y]) => toLonLat(transform.apply([x, -y]))))
    }
  }));
  const out = path.join(MAPS_ROOT, 'fire-areas.geojson');
  fs.writeFileSync(
    out,
    JSON.stringify({ type: 'FeatureCollection', source: FIRE_SOURCE, fitMeters: Math.round(rms), features })
  );
  log(`${features.length} service areas in ${out}`);
  return { features, rms };
}

export const run = () => {
  try {
    fireAreas();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
};
