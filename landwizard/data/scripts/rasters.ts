// Section 7, step 7: prepare the rasters (T-34). Runs inside `npm run build`, after
// sql/30_clip.sql and before sql/40_metrics.sql, because the zonal statistics need the
// cleaned `parcels` table.
//
// Everything runs with the `gdal` command line in the container (GDAL 3.12+), in the
// measuring projection, on the region bbox plus about 2 km (so slope at the county edge
// has neighbours). Files go to raw/<region>/derived/ and are rebuilt on every run.
//
//   DEM  fetched/dem.tif -> dem.tif (30 m, bilinear) -> slope.tif (degrees, Horn)
//        -> steep.tif (slope over 5 degrees = 1) -> steep.gpkg -> staging.steep
//        slope.tif + parcels -> slope_mean.csv (area-weighted mean per parcel, fractional
//        pixel coverage, so parcels smaller than a pixel still get a value) -> staging.slope_mean
//   CDL  fetched/cdl.tif -> landcover.tif (nearest; 1 cropland, 2 pasture and hay,
//        3 forest, other classes nodata) -> landcover.gpkg -> staging.landcover
//
// CDL groups (section 7, step 7): cropland 1-61 except 37, 66-77, 204-254; pasture and
// hay 37, 176; forest 141-143. Shrubland (152) and the wetland classes (190, 195) are in
// no group. A raster the region lacks leaves its table absent; the shares are then null.

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import type { Bbox } from './detect.ts';
import { DATA_DIR, fmt, gis, ident, ogrPg, toContainer } from './gis.ts';

const SLOPE_STEEP_DEG = 5;
const CDL_MAPPING = '[1,36]=1; 37=2; [38,61]=1; [66,77]=1; [141,143]=3; 176=2; [204,254]=1; DEFAULT=NO_DATA';
/** About 2 km at these latitudes; slope needs neighbours past the last parcel. */
const MARGIN_DEG = 0.02;

export interface RasterJob {
  region: string;
  schema: string;
  crs: number;
  /** Parcel bbox in WGS84. */
  bbox: Bbox;
  /** Container paths of fetched/dem.tif and cdl.tif, or null when unavailable. */
  dem: string | null;
  cdl: string | null;
}

export async function prepareRasters(db: pg.Client, job: RasterJob): Promise<void> {
  console.log('\n== rasters');
  const rel = `raw/${job.region}/derived`;
  await mkdir(path.join(DATA_DIR, rel), { recursive: true });
  const d = (f: string) => toContainer(`${rel}/${f}`);
  const [w, s, e, n] = job.bbox;
  const bbox = [w - MARGIN_DEG, s - MARGIN_DEG, e + MARGIN_DEG, n + MARGIN_DEG].join(',');
  const grid = ['--output-crs', `EPSG:${job.crs}`, '--resolution', '30,30', '--bbox', bbox, '--bbox-crs', 'EPSG:4326'];
  // Inputs and outputs are always named with --input/--output: with --overwrite, a swapped
  // positional pair deletes the input.
  const io = (input: string, output: string) => ['--input', input, '--output', output, '--overwrite', '--quiet'];

  if (job.dem) {
    let t0 = Date.now();
    await gis('gdal', ['raster', 'reproject', ...io(job.dem, d('dem.tif')), ...grid, '--resampling', 'bilinear']);
    await gis('gdal', ['raster', 'slope', ...io(d('dem.tif'), d('slope.tif')), '--unit', 'degree']);
    await gis('gdal', ['raster', 'reclassify', ...io(d('slope.tif'), d('steep.tif')), '--ot', 'Int16',
      '--mapping', `[0,${SLOPE_STEEP_DEG}]=NO_DATA; (${SLOPE_STEEP_DEG},90]=1; DEFAULT=NO_DATA`]);
    await gis('gdal', ['raster', 'polygonize', ...io(d('steep.tif'), d('steep.gpkg')), '--output-layer', 'steep', '--attribute-name', 'cls']);
    await loadPolygons(job.schema, d('steep.gpkg'), 'steep');
    console.log(`steep: slope over ${SLOPE_STEEP_DEG} degrees, ${fmt(await count(db, job.schema, 'steep'))} polygons (${secs(t0)})`);

    t0 = Date.now();
    await gis('ogr2ogr', ['-f', 'GPKG', '-overwrite', d('zones.gpkg'), ogrPg(), '-nln', 'zones',
      '-sql', `SELECT id, geom FROM ${ident(job.schema)}.parcels`]);
    await gis('gdal', ['raster', 'zonal-stats', ...io(d('slope.tif'), d('slope_mean.csv')), '--zones', d('zones.gpkg'),
      '--include-field', 'id', '--stat', 'mean', '--pixels', 'fractional']);
    const loaded = await loadSlopeMean(db, job.schema, path.join(DATA_DIR, rel, 'slope_mean.csv'));
    console.log(`slope_mean: mean slope for ${fmt(loaded)} parcels (${secs(t0)})`);
  } else {
    console.log('dem: unavailable; st and sm will be null');
  }

  if (job.cdl) {
    const t0 = Date.now();
    await gis('gdal', ['raster', 'reproject', ...io(job.cdl, d('cdl.tif')), ...grid, '--resampling', 'nearest']);
    await gis('gdal', ['raster', 'reclassify', ...io(d('cdl.tif'), d('landcover.tif')), '--ot', 'UInt8', '--mapping', CDL_MAPPING]);
    await gis('gdal', ['raster', 'polygonize', ...io(d('landcover.tif'), d('landcover.gpkg')),
      '--output-layer', 'landcover', '--attribute-name', 'cls']);
    await loadPolygons(job.schema, d('landcover.gpkg'), 'landcover');
    console.log(`landcover: cropland, pasture and forest, ${fmt(await count(db, job.schema, 'landcover'))} polygons (${secs(t0)})`);
  } else {
    console.log('cdl: unavailable; cr, pa and fo will be null');
  }
}

/** ogr2ogr a polygonized layer into staging, keeping its (measuring) projection. */
async function loadPolygons(schema: string, source: string, layer: string): Promise<void> {
  await gis('ogr2ogr', [
    '-f', 'PostgreSQL', ogrPg(), source, layer, '-nln', layer, '-lco', `SCHEMA=${schema}`,
    '-lco', 'GEOMETRY_NAME=geom', '-lco', 'FID=ogc_fid', '-nlt', 'PROMOTE_TO_MULTI', '-overwrite',
  ]);
}

/** Load the zonal-stats CSV (`id,mean`) into staging.slope_mean. */
async function loadSlopeMean(db: pg.Client, schema: string, csvFile: string): Promise<number> {
  const ids: string[] = [];
  const means: (number | null)[] = [];
  const lines = (await readFile(csvFile, 'utf8')).split(/\r?\n/).filter(Boolean);
  if (lines[0]?.trim() !== 'id,mean') throw new Error(`${csvFile}: unexpected header ${lines[0]}`);
  for (const line of lines.slice(1)) {
    const m = /^"?((?:[^"]|"")*)"?,(.*)$/.exec(line);
    if (!m) throw new Error(`${csvFile}: cannot read line ${line}`);
    ids.push(m[1]!.replaceAll('""', '"'));
    means.push(m[2] === '' ? null : Number(m[2]));
  }
  const t = `${ident(schema)}.slope_mean`;
  await db.query(`CREATE TABLE ${t} (id text PRIMARY KEY, mean float8)`);
  await db.query(`INSERT INTO ${t} SELECT * FROM unnest($1::text[], $2::float8[])`, [ids, means]);
  return ids.length;
}

async function count(db: pg.Client, schema: string, table: string): Promise<number> {
  return Number((await db.query(`SELECT count(*) AS n FROM ${ident(schema)}.${ident(table)}`)).rows[0]?.n ?? 0);
}

function secs(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)} s`;
}
