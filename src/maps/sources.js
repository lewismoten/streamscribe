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
export const MAP_WANTED = ['Zoning', 'Historic districts', 'Industrial corridor', 'Town wards'];
