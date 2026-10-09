# Maps

The website's **Maps** section (under Research) shows maps of the state, the county, and the town, each with the
credits for its data. They're drawn from public data on the recording machine and sent to the hub:

```bash
npm run fetch-maps      # download the public map data into data/maps/raw (light data; --heavy for the rest)
npm run build-maps      # draw SVG maps into data/maps/svg (with index.json: titles, credits, sources)
npm run publish-maps    # send them to the hub's Maps section (-- --dry-run to see what would go)
```

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

Census and USGS data are public domain. VGIN's parcel boundaries are for maps and analysis, not legal descriptions or
surveys. The sources and their credits are in [`src/maps/sources.js`](../../src/maps/sources.js); each map says which
it used.

## The maps

`build-maps` draws: Virginia county by county (the county marked); the county's magisterial districts with the town;
its 2020 voting precincts; its roads and water; the town with its roads; and its VDOT state routes (hover a road for
its name and route number). Shapes are simplified to suit a web page. The roads and routes maps are larger than a hub
record (240 KB), so they stay in `data/maps/svg` for now.

## Not found yet

Zoning, historic districts, the industrial corridor, and town wards (Front Royal's council is elected at large) aren't
published as open data that we've found; they're listed in `src/maps/sources.js` to look for or ask the county and
town for.
