// npm run build -- --region <name> --src raw/<region>/<parcel file> --id <column> [--layer <name>] [--drop A,B]
//                   [--owner <column>] [--setback-ft 50] [--water-buffer-ft 50]
//
// Steps 2-3 of the data build (section 7), then the SQL steps: loads the parcel file and
// the overlays fetched by `npm run fetch` into a fresh per-region schema
// (`staging_<region>`, loaded in EPSG:4326), checks the county detected from the
// staged parcels against fetch's, records the run in `meta`, and runs data/sql/*.sql in
// file-name order.
//
// Tables in staging_<region>:
//   parcels_raw   the parcel file as is: source column names (not laundered), MultiPolygon
//   lines         transmission lines within the region bbox + 10 miles
//   substations   OSM substation points
//   flood         flood hazard polygons (absent when the region has no NFHL)
//   wetlands      NWI polygons (absent when unavailable)
//   osm_lines     OSM power=line|minor_line with voltage and max_kv (absent when unavailable)
//   roads         OSM highway=* with access tags (absent when unavailable)
//   waterways     OSM waterway=river|stream|canal (absent when unavailable)
//   meta          key -> jsonb: region, src, id column, drop list, water_buffer_ft, detected
//                 county and CRS, layers, rasters (container paths of fetched/dem.tif, cdl.tif)
//
// The rasters stay files until the raster step (section 7, step 7; scripts/rasters.ts),
// which runs before the first SQL file numbered 40 or more and adds staging tables
// steep, landcover (polygons in the measuring CRS) and slope_mean (mean slope per parcel),
// and, with an owner column, owner_key (normalized owner per parcel, scripts/owners.ts).
//
// SQL files may use {{schema}}, {{id}} (quoted ID column), {{crs}} (measuring EPSG code) and
// {{setback_m}} and {{water_buffer_m}} (--setback-ft, --water-buffer-ft in meters);
// they run with search_path = staging_<region>, public, each in its own transaction, and
// report counts with RAISE NOTICE (printed) and into meta.
//
// The SQL steps then add (section 7, steps 4-8):
//   parcels       10_identify: `id` (trimmed --id), empty ids dropped, duplicates merged;
//                 20_clean: geometry in the measuring CRS, made valid, blank text -> NULL
//   region        30_clip: union of parcels (`geom`) and that plus 10 miles (`buf`)
//   overlays      30_clip: moved to the measuring CRS in place and clipped to region.buf
//   metrics       40_metrics: acres, distances, road access, flood and wetland share;
//                 41_shares: buffered water, steep, slope and land-cover shares;
//                 42_buildable: buildable acres; 43_owner_blocks: owner blocks
//   meta          identify, clean, clip, metrics, shares: the counts each step printed

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { fail, list, readArgs, required } from './args.ts';
import { type Detected, detectFromTable, ensureCounties, printDetected, readRegion } from './detect.ts';
import { detectOwnerColumn, normalizeOwner } from './owners.ts';
import { prepareRasters } from './rasters.ts';
import {
  DATA_DIR, REGION_RE, dataPath, ensureGisUp, fmt, gis, gisJson, ident, ogrPg, reportGdalWarnings, stagingSchema,
  toContainer, withDb,
} from './gis.ts';

const USAGE = 'npm run build -- --region <name> --src <parcel file under data/> --id <column> [--layer <name>] [--drop A,B] [--owner <column>] [--setback-ft 50] [--water-buffer-ft 50]';
const SQL_DIR = path.join(DATA_DIR, 'sql');

const args = readArgs(USAGE, {
  region: { type: 'string' },
  src: { type: 'string' },
  id: { type: 'string' },
  layer: { type: 'string' },
  drop: { type: 'string' },
  owner: { type: 'string' },
  'setback-ft': { type: 'string' },
  'water-buffer-ft': { type: 'string' },
});

const region = required(args.region, '--region', USAGE);
if (!REGION_RE.test(region)) fail('--region must be lowercase letters, digits and dashes, e.g. nc-halifax', USAGE);
const src = required(args.src, '--src', USAGE);
const idColumn = required(args.id, '--id', USAGE);
const drop = list(args.drop);
const setbackFt = feet(args['setback-ft'], '--setback-ft', 50);
const waterBufferFt = feet(args['water-buffer-ft'], '--water-buffer-ft', 50);
const schema = stagingSchema(region);
const started = Date.now();

let srcC: string;
try {
  dataPath(src);
  srcC = toContainer(src);
  await ensureGisUp();
} catch (err) {
  fail((err as Error).message);
}

const info = await readRegion(region);
if (!info) fail(`raw/${region}/fetched/region.json not found; run \`npm run fetch -- --region ${region} --src ${src}\` first`);
if ((info.v as number) < 2) {
  fail(`raw/${region}/fetched/region.json predates the OSM and raster layers; rerun \`npm run fetch -- --region ${region} --src ${src}\` (cached files are reused)`);
}
if (path.normalize(info.src) !== path.normalize(src)) {
  console.warn(`warning: overlays were fetched for --src ${info.src}, building from ${src}`);
}

await withDb(async (db) => {
  console.log(`== load into ${schema}`);
  await db.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
  await db.query(`CREATE SCHEMA ${ident(schema)}`);

  // Parcels: keep source column names and values untouched; cleaning is sql/10-20.
  const expected = await featureCount(srcC, args.layer);
  await load('parcels_raw', srcC, args.layer, ['-lco', 'LAUNDER=NO', '-lco', 'PRECISION=NO', '-nlt', 'PROMOTE_TO_MULTI']);
  const sourceRows = await count(db, 'parcels_raw');
  if (sourceRows !== expected) fail(`parcels_raw has ${fmt(sourceRows)} rows, the source has ${fmt(expected)}`);
  const ownerColumn = await checkColumns(db);

  // Detection on the staged parcels must agree with what fetch downloaded overlays for.
  await ensureCounties(db);
  const detected = await detectFromTable(db, schema, 'parcels_raw');
  if (detected.fips !== info.detected.fips) {
    fail(`parcels are in ${detected.county} (FIPS ${detected.fips}) but overlays were fetched for ${info.detected.county}; rerun fetch with --force`);
  }

  // Overlays. Lines are national, so only the buffered bbox is loaded.
  const spat = ['-spat', ...info.detected.bboxBuffered.map(String)];
  const fetched = `raw/${region}/fetched`;
  await load('lines', toContainer('raw/_national/lines.gpkg'), 'lines', [...spat, '-nlt', 'MULTILINESTRING']);
  const layers = {
    lines: true,
    substations: await loadOptional('substations', info.layers.substations, `${fetched}/substations.geojson`, undefined, ['-nlt', 'POINT']),
    flood: await loadOptional('flood', info.layers.flood, `${fetched}/flood.gpkg`, 'flood', ['-nlt', 'MULTIPOLYGON']),
    wetlands: await loadOptional('wetlands', info.layers.wetlands, `${fetched}/wetlands.gpkg`, 'wetlands', ['-nlt', 'MULTIPOLYGON']),
    osm_lines: await loadOptional('osm_lines', info.layers.osm_lines, `${fetched}/osm.gpkg`, 'osm_lines', ['-nlt', 'MULTILINESTRING']),
    roads: await loadOptional('roads', info.layers.roads, `${fetched}/osm.gpkg`, 'roads', ['-nlt', 'MULTILINESTRING']),
    waterways: await loadOptional('waterways', info.layers.waterways, `${fetched}/osm.gpkg`, 'waterways', ['-nlt', 'MULTILINESTRING']),
  };

  // Rasters: checked here, prepared by the raster step.
  const rasters: Record<string, string | null> = {};
  for (const [key, file] of [['dem', `${fetched}/dem.tif`], ['cdl', `${fetched}/cdl.tif`]] as const) {
    const ok = info.layers[key] && existsSync(path.join(DATA_DIR, file));
    if (info.layers[key] && !ok) console.warn(`warning: ${file} is missing although region.json lists ${key}; rerun fetch`);
    rasters[key] = ok ? toContainer(file) : null;
    console.log(`${key}: ${ok ? file : 'unavailable'}`);
  }

  await writeMeta(db, detected, { ...layers, dem: rasters.dem !== null, cdl: rasters.cdl !== null }, sourceRows, rasters, ownerColumn);

  console.log('\n== detect');
  printDetected(detected);

  await runSql(db, detected, rasters, ownerColumn);
  await exportSpotCheck(db);

  console.log('\n== report');
  const tables = (await db.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema])).rows;
  for (const { t } of tables) console.log(`${t.padEnd(14)} ${fmt(await count(db, t)).padStart(10)} rows`);
  for (const [k, ok] of Object.entries(layers)) if (!ok) console.log(`${k}: unavailable in ${region} (metrics will be null)`);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

// ---------------------------------------------------------------------------------------

/** ogr2ogr one layer into staging as `table`, in EPSG:4326, with GDAL warnings summarized. */
async function load(table: string, source: string, layer: string | undefined, extra: string[]): Promise<void> {
  console.log(`${table}: loading ${source.replace(/^\/data\//, '')}`);
  const warnings: string[] = [];
  await gis('ogr2ogr', [
    '-f', 'PostgreSQL', ogrPg(), source, ...(layer ? [layer] : []),
    '-nln', table, '-lco', `SCHEMA=${schema}`, '-lco', 'GEOMETRY_NAME=geom', '-lco', 'FID=ogc_fid',
    '-t_srs', 'EPSG:4326', ...extra,
  ], { stderrLines: warnings });
  reportGdalWarnings(warnings.filter((w) => !/^Warning 1: .*geometry of type/.test(w)));
}

async function loadOptional(table: string, available: boolean, file: string, layer: string | undefined, extra: string[]): Promise<boolean> {
  if (!available) return false;
  if (!existsSync(path.join(DATA_DIR, file))) {
    console.warn(`warning: ${file} is missing although region.json lists ${table}; rerun fetch`);
    return false;
  }
  await load(table, toContainer(file), layer, extra);
  return true;
}

async function featureCount(source: string, layer: string | undefined): Promise<number> {
  const out = await gisJson<{ layers: { featureCount?: number }[] }>('ogrinfo', ['-json', '-so', '-ro', source, ...(layer ? [layer] : ['-al'])]);
  if (out.layers.length !== 1 && !layer) fail(`${src} has ${out.layers.length} layers; pick one with --layer`);
  return out.layers[0]?.featureCount ?? 0;
}

async function count(db: pg.Client, table: string): Promise<number> {
  return Number((await db.query(`SELECT COUNT(*) AS n FROM ${ident(schema)}.${ident(table)}`)).rows[0]?.n ?? 0);
}

/** Check --id, --drop and --owner against the staged columns; return the owner column to use. */
async function checkColumns(db: pg.Client): Promise<string | null> {
  const cols = (await db.query<{ c: string }>(
    `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'parcels_raw'`, [schema])).rows.map((r) => r.c);
  if (!cols.includes(idColumn)) {
    const near = cols.find((c) => c.toLowerCase() === idColumn.toLowerCase());
    fail(`--id ${idColumn} is not a column of ${src}${near ? `; did you mean ${near}?` : ''} (see npm run inspect)`);
  }
  for (const d of drop) if (!cols.includes(d)) fail(`--drop ${d} is not a column of ${src}`);
  if (args.owner !== undefined) {
    if (!cols.includes(args.owner)) fail(`--owner ${args.owner} is not a column of ${src}`);
    console.log(`owner column: ${args.owner} (--owner)`);
    return args.owner;
  }
  const { column, candidates } = detectOwnerColumn(cols);
  if (column) console.log(`owner column: ${column} (found by name; pass --owner to pick another)`);
  else if (candidates.length) console.warn(`warning: several owner columns (${candidates.join(', ')}); pass --owner to get owner blocks`);
  else console.warn('warning: no OWN*NAME column; pass --owner to get owner blocks (ob, obn, oba stay null)');
  return column;
}

async function writeMeta(
  db: pg.Client, detected: Detected, layers: Record<string, boolean>, sourceRows: number, rasters: Record<string, string | null>,
  ownerColumn: string | null,
): Promise<void> {
  const t = `${ident(schema)}.meta`;
  await db.query(`CREATE TABLE ${t} (key text PRIMARY KEY, value jsonb NOT NULL)`);
  const rows: Record<string, unknown> = {
    region, src, layer: args.layer ?? null, id_column: idColumn, drop, owner_column: ownerColumn,
    setback_ft: setbackFt, water_buffer_ft: waterBufferFt, detected, layers, rasters,
    source_rows: sourceRows, loaded_at: new Date().toISOString(),
  };
  for (const [k, v] of Object.entries(rows)) await db.query(`INSERT INTO ${t} VALUES ($1, $2::jsonb)`, [k, JSON.stringify(v)]);
}

/** Run data/sql/NN_*.sql in order, with {{schema}}, {{id}} and {{crs}} filled in. */
async function runSql(
  db: pg.Client, detected: Detected, rasters: Record<string, string | null>, ownerColumn: string | null,
): Promise<void> {
  const files = existsSync(SQL_DIR) ? (await readdir(SQL_DIR)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort() : [];
  console.log(`\n== sql (${files.length} file${files.length === 1 ? '' : 's'})`);
  const vars: Record<string, string> = {
    schema: ident(schema), id: ident(idColumn), crs: String(detected.crs),
    setback_m: String(setbackFt * 0.3048), water_buffer_m: String(waterBufferFt * 0.3048),
  };
  let rastersDone = false;
  // SQL files report their counts with RAISE NOTICE.
  db.on('notice', (n) => console.log(`  ${n.message}`));
  for (const f of files) {
    // Section 7, step 7 sits between the clip (30_) and the metrics (40_): it needs the
    // cleaned parcels, and the metrics need its tables.
    if (!rastersDone && Number(/^\d+/.exec(f)![0]) >= 40) {
      try {
        await prepareRasters(db, { region, schema, crs: detected.crs, bbox: detected.bbox, dem: rasters.dem ?? null, cdl: rasters.cdl ?? null });
        if (ownerColumn) await writeOwnerKeys(db, ownerColumn);
      } catch (err) {
        const msg = (err as Error).message;
        // Windows won't replace a file another program holds open; QGIS is the usual one.
        if (/Permission denied|being used by another process/i.test(msg)) {
          const line = msg.split('\n').find((l) => /denied|another process/i.test(l)) ?? '';
          fail(`cannot overwrite a file in raw/${region}/derived/; close it in QGIS (or any other program) and rerun\n  ${line}`);
        }
        fail(`raster step: ${msg}`);
      }
      rastersDone = true;
      console.log('');
    }
    const text = (await readFile(path.join(SQL_DIR, f), 'utf8')).replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const v = vars[k];
      if (v === undefined) fail(`${f}: unknown placeholder {{${k}}}`);
      return v;
    });
    const t0 = Date.now();
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL search_path TO ${ident(schema)}, public`);
      await db.query(text);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      fail(`${f}: ${(err as Error).message}`);
    }
    console.log(`${f}  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}

/** A non-negative distance option in feet, with a default. */
function feet(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${flag} must be a distance in feet, 0 or more`, USAGE);
  return n;
}

/**
 * Owner keys for owner blocks (F-32): staging.owner_key(id, key), normalized in TypeScript
 * (scripts/owners.ts, unit-tested) rather than in SQL, so the build uses the tested rules.
 */
async function writeOwnerKeys(db: pg.Client, column: string): Promise<void> {
  const rows = (await db.query<{ id: string; owner: string | null }>(
    `SELECT id, ${ident(column)}::text AS owner FROM ${ident(schema)}.parcels`)).rows;
  const keys = rows.map((r) => normalizeOwner(r.owner));
  const t = `${ident(schema)}.owner_key`;
  await db.query(`CREATE TABLE ${t} (id text PRIMARY KEY, key text)`);
  await db.query(`INSERT INTO ${t} SELECT * FROM unnest($1::text[], $2::text[])`, [rows.map((r) => r.id), keys]);
  const distinctRaw = new Set(rows.map((r) => r.owner).filter(Boolean)).size;
  const distinctKeys = new Set(keys.filter(Boolean)).size;
  console.log(`owner_key: ${fmt(distinctRaw)} owner names -> ${fmt(distinctKeys)} keys (${column}); ${fmt(keys.filter((k) => k === null).length)} parcels without an owner`);
}

/**
 * T-07: write the 5 spot-check parcels picked by 50_validate.sql to
 * raw/<region>/derived/spotcheck.gpkg (measuring CRS; QGIS reprojects on the fly) and print
 * their metrics, to compare with QGIS measurements by hand.
 */
async function exportSpotCheck(db: pg.Client): Promise<void> {
  const exists = (await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${schema}.spot_check`])).rows[0]?.ok === true;
  if (!exists) return;
  const rel = `raw/${region}/derived/spotcheck.gpkg`;
  await gis('ogr2ogr', ['-f', 'GPKG', '-overwrite', toContainer(rel), ogrPg(), '-nln', 'spot_check',
    '-sql', `SELECT n, why, id, acres, ba, dl, dl230, ds, ds230, ra, fl, wl, wb, st, sm, cr, pa, fo, obn, oba, lon, lat, geom FROM ${ident(schema)}.spot_check`]);
  const rows = (await db.query(`SELECT * FROM ${ident(schema)}.spot_check ORDER BY n`)).rows as Record<string, unknown>[];
  console.log(`
== spot check (${rel}; check each in QGIS)`);
  const f = (v: unknown, d: number) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
  for (const r of rows) {
    console.log(`${r.n}. ${r.id}  ${r.why}`);
    console.log(`   acres ${f(r.acres, 2)}, buildable ${f(r.ba, 1)}; line ${f(r.dl, 2)} mi (230+ kV ${f(r.dl230, 2)}), substation ${f(r.ds, 2)} mi (230+ kV ${f(r.ds230, 2)}); road access ${r.ra ?? '-'}`);
    console.log(`   flood ${f(r.fl, 2)}, wetland ${f(r.wl, 2)}, water+buffer ${f(r.wb, 2)}, steep ${f(r.st, 2)}, slope ${f(r.sm, 1)} deg; crop ${f(r.cr, 2)}, pasture ${f(r.pa, 2)}, forest ${f(r.fo, 2)}; block ${r.obn ?? '-'} parcels, ${f(r.oba, 1)} ac; at ${f(r.lat, 5)}, ${f(r.lon, 5)}`);
  }
}
