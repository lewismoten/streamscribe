// Public map data for the Maps section (fetch-maps.js downloads it into data/maps/raw; build-maps.js draws SVG maps
// from it), each with who publishes it, where it's from, and how to credit it. Warren County, Virginia (FIPS 51187)
// and its town of Front Royal are the place; change COUNTY to use another.
//   kind 'zip'     a zipped shapefile (unzipped as is)
//   kind 'arcgis'  an ArcGIS map service layer, saved as GeoJSON a page at a time (where, or within the county's box)
//   kind 'file'    a file as is
//   heavy          large: only with --heavy; kept on this machine (data/ isn't committed or published)
export const COUNTY = {
  state: '51',
  county: '187',
  name: 'Warren County',
  town: 'Front Royal',
  box: [-78.42, 38.78, -77.98, 39.08]
};

// The region around it (for the regional map): the county and its neighbors (Clarke, Fauquier, Frederick, Page,
// Rappahannock, Shenandoah, and the city of Winchester), each fetched where data comes a county at a time.
export const REGION = {
  counties: ['043', '061', '069', '139', '157', '171', '187', '840'],
  box: [-78.9, 38.45, -77.65, 39.45],
  // Places to mark (by name; Census places first, else USGS place names).
  towns: [
    'Front Royal',
    'Browntown',
    'Chester Gap',
    'Bentonville',
    'Linden',
    'Riverton',
    'Flint Hill',
    'Strasburg',
    'Middletown',
    'Toms Brook',
    'Woodstock',
    'Stephens City',
    'Winchester',
    'Berryville',
    'Boyce',
    'Washington',
    'Luray',
    'Stanley',
    'Marshall',
    'Edinburg',
    'Markham'
  ],
  // Roads to draw (by their Census names), each labeled with its number.
  roads: [
    { match: /^I- ?66\b/, label: '66', kind: 'interstate' },
    { match: /^I- ?81\b/, label: '81', kind: 'interstate' },
    { match: /^Skyline Dr/i, label: 'Skyline Drive', kind: 'parkway' },
    { match: /^US Hwy 522\b/, label: '522', kind: 'us' },
    { match: /^US Hwy 340\b/, label: '340', kind: 'us' },
    { match: /^US Hwy 211\b/, label: '211', kind: 'us' },
    { match: /^US Hwy 11\b/, label: '11', kind: 'us' },
    { match: /^US Hwy 17\b/, label: '17', kind: 'us' },
    { match: /^US Hwy 50\b/, label: '50', kind: 'us' },
    { match: /^US Hwy 33\b/, label: '33', kind: 'us' },
    { match: /^State Rte 55\b/, label: '55', kind: 'state' },
    { match: /^State Rte 42\b/, label: '42', kind: 'state' },
    { match: /^State Rte 48\b/, label: '48', kind: 'state' },
    { match: /^State Rte 7\b/, label: '7', kind: 'state' }
  ],
  rivers: [/^Shenandoah Riv/, /^(N|North) Fork Shenandoah Riv/, /^(S|South) Fork Shenandoah Riv/]
};

const CENSUS = 'U.S. Census Bureau, TIGER/Line and cartographic boundary files (public domain)';
const VGIN =
  'Virginia Geographic Information Network (VGIN), Virginia Department of Emergency Management, via the Virginia DCR Civil Reference Layers service';
const civil =
  'https://dsfmportal.dcr.virginia.gov/server/rest/services/CivilReference/Civil_Reference_Layers/MapServer';

export const MAP_SOURCES = [
  {
    id: 'states',
    title: 'States',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_500k.zip',
    credit: CENSUS,
    about: 'The outline of Virginia (and its neighbors), generalized for mapping (1:500,000).'
  },
  {
    id: 'counties',
    title: 'Counties',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip',
    credit: CENSUS,
    about: "Every county and independent city; Virginia's are drawn."
  },
  {
    id: 'districts',
    title: 'County subdivisions (magisterial districts)',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_51_cousub_500k.zip',
    credit: CENSUS,
    about:
      "Virginia's county subdivisions, which are its counties' magisterial districts (for Warren County: Fork, Happy Creek, North River, Shenandoah, South River)."
  },
  {
    id: 'places',
    title: 'Towns and cities',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_51_place_500k.zip',
    credit: CENSUS,
    about: "Virginia's incorporated places (Front Royal's town limits) and census-designated places."
  },
  {
    id: 'precincts',
    title: 'Voting precincts (2020)',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/TIGER2020PL/LAYER/VTD/2020/tl_2020_51187_vtd20.zip',
    credit: CENSUS,
    about: "Warren County's voting districts as of the 2020 census (including the town's precincts)."
  },
  {
    id: 'roads',
    title: 'Roads',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/ROADS/tl_2024_51187_roads.zip',
    credit: CENSUS,
    about: 'Every road in Warren County with its name (and route type), as the census draws them.'
  },
  {
    id: 'water-lines',
    title: 'Streams and rivers',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/LINEARWATER/tl_2024_51187_linearwater.zip',
    credit: CENSUS,
    about: 'Streams, rivers, and canals as lines.'
  },
  {
    id: 'water-areas',
    title: 'Lakes and wide rivers',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/AREAWATER/tl_2024_51187_areawater.zip',
    credit: CENSUS,
    about: 'Lakes, ponds, and wide stretches of the Shenandoah as areas.'
  },
  {
    id: 'counties-detail',
    title: 'Counties (full detail)',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/COUNTY/tl_2024_us_county.zip',
    credit: CENSUS,
    about: 'Every county at full detail, for the slippy map when zoomed in (the generalized file is for drawn maps).'
  },
  {
    id: 'districts-detail',
    title: 'Magisterial districts (full detail)',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/COUSUB/tl_2024_51_cousub.zip',
    credit: CENSUS,
    about: "Virginia's county subdivisions at full detail, for the slippy map."
  },
  {
    id: 'places-detail',
    title: 'Towns and cities (full detail)',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/PLACE/tl_2024_51_place.zip',
    credit: CENSUS,
    about: "Virginia's places at full detail (Front Royal's limits street by street), for the slippy map."
  },
  {
    id: 'state-roads',
    title: 'Major roads (state)',
    kind: 'zip',
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/PRISECROADS/tl_2024_51_prisecroads.zip',
    credit: CENSUS,
    about: "Virginia's interstates, US highways, and state routes."
  },
  {
    id: 'region-roads',
    title: 'Roads of the region (for Skyline Drive)',
    kind: 'zip',
    perCounty: true,
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/ROADS/tl_2024_51{county}_roads.zip',
    credit: CENSUS,
    about: 'Every road in the county and its neighbors (the regional map takes Skyline Drive from them).'
  },
  {
    id: 'region-water',
    title: 'Streams and rivers of the region',
    kind: 'zip',
    perCounty: true,
    url: 'https://www2.census.gov/geo/tiger/TIGER2024/LINEARWATER/tl_2024_51{county}_linearwater.zip',
    credit: CENSUS,
    about: 'Streams and rivers in the county and its neighbors (the regional map takes the Shenandoah and its forks).'
  },
  {
    id: 'place-names',
    title: 'Place names (USGS)',
    kind: 'zip',
    url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_VA_Text.zip',
    credit: 'U.S. Geological Survey, Geographic Names Information System (GNIS) (public domain)',
    about:
      "Every named place in Virginia with its location: villages like Browntown and Bentonville that aren't census places."
  },
  {
    id: 'fire-stations',
    title: 'Fire and EMS stations',
    kind: 'arcgis',
    url: 'https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer/16',
    within: 'region',
    credit: 'U.S. Geological Survey, National Structures Dataset (public domain)',
    about: 'Fire and EMS stations with their names and addresses, in the county and its neighbors.'
  },
  {
    id: 'vdot-roads',
    title: 'Roads with route numbers (VDOT)',
    kind: 'arcgis',
    url: `${civil}/6`,
    within: 'box',
    credit: `${VGIN}; Virginia Department of Transportation (VDOT)`,
    about: 'Road centerlines with street names, VDOT route numbers (such as 627), and traffic counts.'
  },
  {
    id: 'parcels',
    title: 'Tax parcels',
    kind: 'arcgis',
    url: `${civil}/3`,
    where: `FIPS='51187'`,
    heavy: true,
    credit: `${VGIN} (parcel boundaries from Warren County; for maps and analysis, not legal descriptions or surveys)`,
    about: "Every parcel's outline with its parcel id (the tax map number), about 28,000 for Warren County."
  },
  {
    id: 'buildings',
    title: 'Building footprints',
    kind: 'arcgis',
    url: `${civil}/2`,
    within: 'box',
    heavy: true,
    credit: VGIN,
    about: 'The outline of each building, from aerial imagery.'
  },
  {
    id: 'elevation',
    title: 'Elevation (1/3 arc-second)',
    kind: 'file',
    url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n39w079/USGS_13_n39w079.tif',
    heavy: true,
    credit: 'U.S. Geological Survey, 3D Elevation Program (3DEP) (public domain)',
    about:
      'Ground elevation about every 10 meters (GeoTIFF, 38–39°N 78–79°W: the south of the county and the town; 490 MB).'
  }
];

// Wanted, not found yet as open data (to look for, or to ask the county or town for): zoning, historic districts
// (the town's historic district; the Virginia Department of Historic Resources keeps the register), the industrial
// corridor, and the town's own wards (Front Royal's council is elected at large).
// Also fire and rescue first-due districts: the county map's station areas are only the nearest station by straight
// line, until the county's own are had.
export const MAP_WANTED = [
  'Zoning',
  'Historic districts',
  'Industrial corridor',
  'Town wards',
  'Fire first-due districts'
];
