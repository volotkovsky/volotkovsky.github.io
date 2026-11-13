// County and measuring-projection detection (section 7, "State and county" and
// "Measuring projection"). The parcel centroids are intersected with Census TIGER
// counties in PostGIS (table ref.counties) and the county holding most of them wins.
// Used by fetch.ts (on a temporary geometry-only load) and build.ts (on staging).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { DATA_DIR, gis, ident, ogrPg, toContainer } from './gis.ts';

/** National TIGER counties, normalized by fetch.ts: layer `counties` with geoid, statefp, countyfp, name. */
export const COUNTIES_FILE = 'raw/_national/counties.gpkg';
export const COUNTIES_TABLE = 'ref.counties';

/** Overlays are clipped to the region plus 10 miles so distances near the edge are right. */
export const BUFFER_M = 16_093.44;

/** State FIPS code -> USPS abbreviation (50 states, DC, Puerto Rico). */
export const STATES: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE',
  '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA',
  '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
  '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '72': 'PR',
};

/** Measuring projection by state: CONUS Albers (EPSG:5070), Alaska Albers (EPSG:3338). */
export function measuringCrs(statefp: string): number {
  if (statefp === '02') return 3338;
  if (statefp === '15' || statefp === '72') {
    throw new Error(`state ${STATES[statefp]} is outside the conterminous US and Alaska; v1 has no measuring projection for it`);
  }
  if (!(statefp in STATES)) throw new Error(`unknown state FIPS code ${statefp}`);
  return 5070;
}

/** [west, south, east, north] in WGS84 degrees. */
export type Bbox = [number, number, number, number];

export interface Detected {
  /** County FIPS code, e.g. 37083. */
  fips: string;
  statefp: string;
  /** USPS state abbreviation, e.g. NC. */
  state: string;
  /** e.g. "Halifax County, NC". */
  county: string;
  /** Share of parcel centroids inside the detected county. */
  share: number;
  /** Runner-up counties, for the printout. */
  others: { county: string; n: number }[];
  /** EPSG code of the measuring projection. */
  crs: number;
  bbox: Bbox;
  /** bbox grown by BUFFER_M in the measuring projection; overlays are fetched and loaded for it. */
  bboxBuffered: Bbox;
}

/** Written by fetch.ts to raw/<region>/fetched/region.json; read by build.ts. */
export interface RegionInfo {
  /** 2 since T-32 added the OSM lines, roads, waterways and the rasters. */
  v: 2;
  region: string;
  src: string;
  layer: string | null;
  fetched: string;
  detected: Detected;
  /** Whether each overlay was fetched; false means "layer unavailable in region". */
  layers: {
    substations: boolean; flood: boolean; wetlands: boolean;
    /** Layers of fetched/osm.gpkg; false when the query failed or the layer has no features. */
    osm_lines: boolean; roads: boolean; waterways: boolean;
    /** fetched/dem.tif and fetched/cdl.tif. */
    dem: boolean; cdl: boolean;
  };
}

export function regionFile(region: string): string {
  return path.join(DATA_DIR, 'raw', region, 'fetched', 'region.json');
}

export async function readRegion(region: string): Promise<RegionInfo | null> {
  try {
    return JSON.parse(await readFile(regionFile(region), 'utf8')) as RegionInfo;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeRegion(info: RegionInfo): Promise<void> {
  await mkdir(path.dirname(regionFile(info.region)), { recursive: true });
  await writeFile(regionFile(info.region), `${JSON.stringify(info, null, 2)}\n`);
}

/** Load raw/_national/counties.gpkg into ref.counties unless it is there already (or `force`). */
export async function ensureCounties(db: pg.Client, force = false): Promise<void> {
  await db.query('CREATE SCHEMA IF NOT EXISTS ref');
  const exists = (await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [COUNTIES_TABLE])).rows[0]?.ok === true;
  if (exists && !force) return;
  console.log(`loading ${COUNTIES_FILE} into ${COUNTIES_TABLE}`);
  await gis('ogr2ogr', [
    '-f', 'PostgreSQL', ogrPg(), toContainer(COUNTIES_FILE), 'counties',
    '-nln', 'counties', '-lco', 'SCHEMA=ref', '-lco', 'GEOMETRY_NAME=geom',
    '-nlt', 'PROMOTE_TO_MULTI', '-t_srs', 'EPSG:4326', '-overwrite',
  ]);
}

/**
 * Detect county and projection from a PostGIS table of parcel geometries in EPSG:4326.
 * `table` is a schema-qualified name such as `staging_nc_halifax.parcels_raw`.
 */
export async function detectFromTable(db: pg.Client, schema: string, table: string): Promise<Detected> {
  const t = `${ident(schema)}.${ident(table)}`;
  const votes = (await db.query<{ geoid: string; statefp: string; name: string; n: number; total: number }>(`
    WITH pts AS (
      SELECT ST_Centroid(geom) AS g FROM ${t} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    )
    SELECT c.geoid, c.statefp, c.name, COUNT(*)::int AS n, (SELECT COUNT(*) FROM pts)::int AS total
    FROM pts JOIN ${COUNTIES_TABLE} c ON ST_Intersects(c.geom, pts.g)
    GROUP BY c.geoid, c.statefp, c.name
    ORDER BY n DESC
    LIMIT 4`)).rows;

  const top = votes[0];
  if (!top) throw new Error('no parcel centroid falls inside a US county; check the parcel file CRS (.prj)');
  const state = STATES[top.statefp] ?? top.statefp;
  const crs = measuringCrs(top.statefp);

  const box = (await db.query<{ b: number[]; bb: number[] }>(`
    WITH e AS (SELECT ST_SetSRID(ST_Extent(geom)::geometry, 4326) AS g FROM ${t}),
         m AS (SELECT ST_Expand(ST_Envelope(ST_Transform(g, $1::int)), $2::float8) AS g FROM e),
         b AS (SELECT ST_Envelope(ST_Transform(g, 4326)) AS g FROM m)
    SELECT ARRAY[ST_XMin(e.g), ST_YMin(e.g), ST_XMax(e.g), ST_YMax(e.g)] AS b,
           ARRAY[ST_XMin(b.g), ST_YMin(b.g), ST_XMax(b.g), ST_YMax(b.g)] AS bb
    FROM e, b`, [crs, BUFFER_M])).rows[0]!;

  const round = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5) as Bbox;
  return {
    fips: top.geoid,
    statefp: top.statefp,
    state,
    county: `${top.name}, ${state}`,
    share: top.n / top.total,
    others: votes.slice(1).map((v) => ({ county: `${v.name}, ${STATES[v.statefp] ?? v.statefp}`, n: v.n })),
    crs,
    bbox: round(box.b),
    bboxBuffered: round(box.bb),
  };
}

export function printDetected(d: Detected): void {
  console.log(`county: ${d.county} (FIPS ${d.fips}), ${(d.share * 100).toFixed(1)}% of parcel centroids`);
  if (d.others.length) console.log(`  also: ${d.others.map((o) => `${o.county} ${o.n}`).join(', ')}`);
  console.log(`measuring projection: EPSG:${d.crs}`);
  console.log(`bbox: ${d.bbox.join(', ')}; with 10-mile buffer: ${d.bboxBuffered.join(', ')}`);
  if (d.share < 0.9) console.warn(`warning: only ${(d.share * 100).toFixed(1)}% of parcels are in ${d.county}; is this a multi-county file?`);
}
