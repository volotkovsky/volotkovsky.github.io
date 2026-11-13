// npm run tiles -- --region <name>
//
// Section 7, step 11: writes every file the app reads for a region to data/out/<region>/,
// from the build's PostGIS tables (staging_<region>):
//
//   parcels.json, attrs/  npm run export (export.ts), run first
//   parcels.fgb           parcel polygons with `id`, EPSG:4326, spatially indexed (KMZ export
//                         and the client-side measuring read it by bounding box)
//   parcels.pmtiles       parcel polygons, zoom 11-16, attribute `id` only; no parcel is
//                         dropped at any zoom, so feature state works for every id (F-05)
//   layers.pmtiles        one tile layer per overlay the region has:
//                           lines     zoom 5-14, kv (max kV or null), src (HIFLD or OSM), operator, name
//                           flood     zoom 9-14, flood hazard areas (SFHA) only, zone
//                           wetlands  zoom 9-14, NWI polygons, type
//                         (tiles under 250 KB: the smallest polygons drop out at zooms 9-10)
//   substations.geojson   substation points with name and kv, leaving out generation and
//                         industrial ones as the ds metrics do
//
// Overlays are as clipped by 30_clip.sql: the region plus 10 miles. Intermediate files go
// to raw/<region>/derived/tiles/ (on the data drive, git-ignored). Prints file sizes and
// warns on any file over GitHub's 100 MB per-file limit (N-06).

import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail, readArgs, required } from './args.ts';
import { DATA_DIR, REGION_RE, ensureGisUp, gis, ident, ogrPg, run, stagingSchema, toContainer, withDb } from './gis.ts';

const USAGE = 'npm run tiles -- --region <name>';
const args = readArgs(USAGE, { region: { type: 'string' } });
const region = required(args.region, '--region', USAGE);
if (!REGION_RE.test(region)) fail('--region must be lowercase letters, digits and dashes, e.g. nc-halifax', USAGE);
const schema = stagingSchema(region);
const out = `out/${region}`;
const tmp = `raw/${region}/derived/tiles`;
const started = Date.now();
const MAX_FILE = 100 * 1024 * 1024;

try {
  await ensureGisUp();
} catch (err) {
  fail((err as Error).message);
}

// parcels.json and attrs/ first; export.ts checks that the build passed validation.
await run(process.execPath, [path.join(DATA_DIR, 'scripts', 'export.ts'), '--region', region]).catch(() => process.exit(1));

const has = await withDb(async (db) => {
  const r = await db.query<{ t: string; ok: boolean }>(
    `SELECT t, to_regclass($1 || '.' || t) IS NOT NULL AS ok FROM unnest($2::text[]) t`,
    [schema, ['parcels', 'lines', 'osm_lines', 'flood', 'wetlands', 'substations']]);
  return Object.fromEntries(r.rows.map((x) => [x.t, x.ok])) as Record<string, boolean>;
});

await rm(path.join(DATA_DIR, tmp), { recursive: true, force: true });
await mkdir(path.join(DATA_DIR, tmp), { recursive: true });
await mkdir(path.join(DATA_DIR, out), { recursive: true });

const s = ident(schema);
console.log('\n== vector files');
await step('parcels.fgb', () => ogr(`${out}/parcels.fgb`, 'parcels', 'FlatGeobuf',
  `SELECT id, ST_Transform(geom, 4326) AS geom FROM ${s}.parcels ORDER BY id`, ['-nlt', 'MULTIPOLYGON', '-lco', 'SPATIAL_INDEX=YES']));

const overlays: { layer: string; file: string; zooms: [number, number] }[] = [];
const lineSql = [
  `SELECT CASE WHEN voltage > 0 THEN voltage ELSE substring(volt_class FROM '^\\d+')::float8 END AS kv,
          'HIFLD'::text AS src, NULLIF(owner, 'NOT AVAILABLE') AS operator, NULL::text AS name, geom FROM ${s}.lines`,
  ...(has.osm_lines ? [`SELECT max_kv, 'OSM', operator, name, geom FROM ${s}.osm_lines`] : []),
].join(' UNION ALL ');
await step('lines', () => ogr(`${tmp}/lines.fgb`, 'lines', 'FlatGeobuf',
  `SELECT kv, src, operator, name, ST_Transform(geom, 4326) AS geom FROM (${lineSql}) l`, ['-nlt', 'MULTILINESTRING']));
overlays.push({ layer: 'lines', file: `${tmp}/lines.fgb`, zooms: [5, 14] });
if (has.flood) {
  await step('flood', () => ogr(`${tmp}/flood.fgb`, 'flood', 'FlatGeobuf',
    `SELECT fld_zone AS zone, ST_Transform(geom, 4326) AS geom FROM ${s}.flood WHERE sfha_tf = 'T'`, ['-nlt', 'MULTIPOLYGON']));
  overlays.push({ layer: 'flood', file: `${tmp}/flood.fgb`, zooms: [9, 14] });
}
if (has.wetlands) {
  await step('wetlands', () => ogr(`${tmp}/wetlands.fgb`, 'wetlands', 'FlatGeobuf',
    `SELECT wetland_type AS type, ST_Transform(geom, 4326) AS geom FROM ${s}.wetlands`, ['-nlt', 'MULTIPOLYGON']));
  overlays.push({ layer: 'wetlands', file: `${tmp}/wetlands.fgb`, zooms: [9, 14] });
}
if (has.substations) {
  await step('substations.geojson', () => ogr(`${out}/substations.geojson`, 'substations', 'GeoJSON',
    `SELECT name, max_kv AS kv, ST_Transform(geom, 4326) AS geom FROM ${s}.substations
     WHERE substation IS NULL OR substation NOT IN ('generation', 'industrial') ORDER BY osm_id`,
    ['-nlt', 'POINT', '-lco', 'RFC7946=YES', '-lco', 'COORDINATE_PRECISION=6']));
} else {
  await rm(path.join(DATA_DIR, out, 'substations.geojson'), { force: true });
}

console.log('\n== tiles');
// Parcels: every feature kept at every zoom (no feature or tile-size limit), shared borders
// simplified once so neighbours don't gap; only `id` as an attribute.
await step('parcels.pmtiles', () => gis('tippecanoe', [
  '-o', toContainer(`${out}/parcels.pmtiles`), '--force', '--quiet', '-l', 'parcels', '-Z11', '-z16',
  '--no-feature-limit', '--no-tile-size-limit', '--detect-shared-borders', '--no-tiny-polygon-reduction',
  '-y', 'id', toContainer(`${out}/parcels.fgb`)]));

// Overlays: one tippecanoe run per layer (each with its own zoom range), then tile-join.
for (const o of overlays) {
  const big = o.layer !== 'lines';
  await step(`${o.layer}.pmtiles`, () => gis('tippecanoe', [
    '-o', toContainer(`${tmp}/${o.layer}.pmtiles`), '--force', '--quiet', '-l', o.layer, `-Z${o.zooms[0]}`, `-z${o.zooms[1]}`,
    // Polygons: at county zooms (9-10) the smallest are dropped to keep tiles under 250 KB
    // (unlimited, Halifax wetlands make 461 KB tiles at z9); none are dropped from z11 on.
    ...(big ? ['--drop-smallest-as-needed', '--maximum-tile-bytes=250000', '--detect-shared-borders']
      : ['--no-feature-limit', '--no-tile-size-limit']),
    toContainer(o.file)]));
}
await step('layers.pmtiles', () => gis('tile-join', [
  '-o', toContainer(`${out}/layers.pmtiles`), '--force', '--quiet', '--no-tile-size-limit',
  ...overlays.map((o) => toContainer(`${tmp}/${o.layer}.pmtiles`))]));

console.log(`\n== files (out/${region}/)`);
for (const f of ['parcels.pmtiles', 'layers.pmtiles', 'parcels.fgb', 'substations.geojson', 'parcels.json']) {
  const p = path.join(DATA_DIR, out, f);
  if (!existsSync(p)) continue;
  const n = (await stat(p)).size;
  console.log(`${f.padEnd(20)} ${(n / 1024 / 1024).toFixed(2).padStart(7)} MB${n > MAX_FILE ? '  OVER 100 MB: GitHub Pages and Releases refuse it' : ''}`);
}
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);

/** ogr2ogr from PostGIS into a file, replacing it. */
async function ogr(dest: string, layer: string, driver: string, sql: string, extra: string[] = []): Promise<string> {
  await rm(path.join(DATA_DIR, dest), { force: true }); // the GeoJSON driver won't overwrite
  return gis('ogr2ogr', ['-f', driver, '-overwrite', toContainer(dest), ogrPg(), '-nln', layer, '-sql', sql, ...extra]);
}

async function step(label: string, fn: () => Promise<unknown>): Promise<void> {
  const t = Date.now();
  try {
    await fn();
  } catch (err) {
    fail(`${label}: ${(err as Error).message}`);
  }
  console.log(`${label.padEnd(20)} ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
