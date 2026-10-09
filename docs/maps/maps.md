# Maps

The website's **Maps** section (under Research) shows maps of the state, the county, and the town, each with the
credits for its data. They're drawn from public data on the recording machine and sent to the hub:

```bash
npm run fetch-maps      # download the public map data into data/maps/raw (light data; --heavy for the rest)
npm run fire-areas      # place the county's fire and rescue service areas (from its Map 5.3 PDF; see below)
npm run build-maps      # draw the SVG maps into data/maps/svg, and the maps in layers into data/maps/layered
npm run publish-maps    # send them to the hub's Maps section (-- --dry-run to see what would go)
```

## The slippy map

The Maps page's **🗺 Explore the map** is a slippy map: drag and zoom smoothly from the state to the county's streets,
with labels that keep out of each other's way. It's one PMTiles file on the hub, read a piece at a time:

```bash
npm run build-tiles     # data/maps/tiles/warren-county.pmtiles (about 30 MB); needs tippecanoe and pmtiles
npm run publish-tiles   # send it to the hub (public maps/ folder, served at api.php/tiles/…) and tell the Maps page
```

- **The base map** (streets, water, land, buildings, places) is OpenStreetMap, from Protomaps' daily build, cut to
  what's needed: Virginia to zoom 10, the county and its neighbors to zoom 13, and the county itself to zoom 15 (the
  deepest Protomaps goes; the map draws closer from those). Only those parts are downloaded (about 30 MB of a 139 GB
  build). `--again` fetches them fresh; `--build <date>` picks a build.
- **Our layers** go into the same file (tippecanoe): counties (each with its id, to shade), the county's magisterial
  districts, its fire and rescue service areas, fire and EMS stations, and the town limits, each only as deep as its
  area goes. Boundaries come from the Census Bureau's full-detail files, so they follow the streets when zoomed in.
- On the page, each of our layers can be shown or hidden, and areas shaded in a color; the address keeps both
  (`/maps/explore?layers=counties,fire-areas&shade=county-51171`).
- The map's fonts and icons come from Protomaps' public assets (protomaps.github.io); they could be copied to the hub
  later.

Custom layers for research (markers, lines, areas, and polygons with notes and pictures) are the next step: they'll
draw on this map from the hub's records rather than going into the tiles.

## Maps in layers

Two maps are built in layers, every layer the same size and place, so any can be shown with any other:

- **The county and its neighbors** (`region`): counties with their names (neighboring states' counties faintly, the
  state line dashed), towns and villages (Front Royal, Browntown, Chester Gap, Bentonville, Linden, Riverton, Flint
  Hill, Strasburg, Middletown, Toms Brook, Woodstock, and more), major roads with their numbers (I-66, I-81, US 522,
  340, 211, 11, 17, 50, VA 55, 42, 7, and Skyline Drive), and the Shenandoah River with its North and South Forks.
- **The county** (`county`): its magisterial districts; its fire and rescue service areas (Co. 1 Front Royal through
  Co. 12 Middletown, in the county's colors); fire and EMS stations; the roads people know by name (Browntown Road,
  Bentonville Road, Reliance Road, Fort Valley Road, Howellsville Road, Remount Road, John Marshall Highway, …) with
  the interstates and routes; the river and lakes; the town limits; and towns and villages.

On the Maps page each has a checkbox per layer and **Shade** to fill areas (a county, a magisterial district, or a
fire company's area being talked about) in a color of your choice. The address keeps the choice
(`/maps/region?layers=counties,roads&shade=county-51171`), so a link can open a map with Shenandoah County shaded.
Shadeable areas have ids: `county-<FIPS>` (such as `county-51187` for Warren), `district-<GEOID>`, and `fire-co-<n>`.
Each layer is also saved as an SVG of its own in `data/maps/layered/<map>/`, for use elsewhere.

## Fire and rescue service areas

The county's areas come from its GIS department's **Map 5.3: Fire and Rescue Service Areas** (2010;
[the PDF](https://warrencountysheriff.org/DocumentCenter/View/416/Map-53----Fire-and-Rescue-Service-Areas-PDF), saved
in `data/maps/raw/fire-areas/`). Its areas are vector shapes, so `npm run fire-areas` takes each company's shape by its
legend color (with poppler's `pdftocairo`: `brew install poppler`), and places them on the earth by fitting their
combined outline to the Census outline of the county (they fit within about 60 meters on average). The result is
`data/maps/fire-areas.geojson`. The map is from 2010: areas changed since aren't shown, and the county's current
first-due areas would replace it.

People who may edit public bodies can also add a map on the Maps page: an SVG (up to 240 KB; shown in a sandboxed
frame, so nothing in it runs) or a picture (kept with the meetings' pictures, so only people who may see meetings see
it).

## The data

Everything downloaded stays in `data/maps/` on this machine (not committed, and not published except as the maps
built from it). `data/maps/sources.json` records what came from where, and when.

| Data                                        | Publisher                                      | Size   | Fetched            |
| ------------------------------------------- | ---------------------------------------------- | ------ | ------------------ |
| States, counties (generalized)              | U.S. Census Bureau cartographic boundary files | 11 MB  | by default         |
| Magisterial districts (county subdivisions) | U.S. Census Bureau                             | 0.4 MB | by default         |
| Towns and cities (Front Royal's limits)     | U.S. Census Bureau                             | 0.4 MB | by default         |
| Voting precincts (2020)                     | U.S. Census Bureau                             | 0.1 MB | by default         |
| Roads, streams, lakes                       | U.S. Census Bureau TIGER/Line                  | 2 MB   | by default         |
| Roads with VDOT route numbers and traffic   | VGIN and VDOT (Virginia DCR Civil Reference)   | 13 MB  | by default         |
| Tax parcels with parcel ids (about 28,000)  | VGIN, from Warren County                       | 22 MB  | `--heavy`          |
| Building footprints (about 31,000)          | VGIN                                           | 13 MB  | `--heavy`          |
| Elevation (1/3 arc-second GeoTIFF)          | U.S. Geological Survey 3DEP                    | 490 MB | `--only elevation` |
| Major roads (Virginia)                      | U.S. Census Bureau TIGER/Line                  | 27 MB  | by default         |
| Roads, streams of the neighboring counties  | U.S. Census Bureau TIGER/Line                  | 51 MB  | by default         |
| Place names (villages)                      | U.S. Geological Survey GNIS                    | 5 MB   | by default         |
| Fire and EMS stations                       | U.S. Geological Survey National Structures     | 0.1 MB | by default         |
| Fire and rescue service areas (Map 5.3 PDF) | Warren County GIS Department                   | 0.2 MB | by hand (above)    |
| Counties, districts, towns (full detail)    | U.S. Census Bureau TIGER/Line                  | 100 MB | by default         |
| Base map for the slippy map                 | OpenStreetMap contributors, via Protomaps      | 28 MB  | build-tiles        |

Census and USGS data are public domain. VGIN's parcel boundaries are for maps and analysis, not legal descriptions or
surveys. The sources and their credits are in [`src/maps/sources.js`](../../src/maps/sources.js); each map says which
it used.

## The maps

`build-maps` draws: Virginia county by county (the county marked); the county's magisterial districts with the town;
its 2020 voting precincts; its roads and water; the town with its roads; and its VDOT state routes (hover a road for
its name and route number). Shapes are simplified to suit a web page. The roads and routes maps are larger than a hub
record (240 KB), so they stay in `data/maps/svg` for now.

## Not found yet

Zoning, historic districts, the industrial corridor, town wards (Front Royal's council is elected at large), and current fire first-due areas aren't
published as open data that we've found; they're listed in `src/maps/sources.js` to look for or ask the county and
town for.
