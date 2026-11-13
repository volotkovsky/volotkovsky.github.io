// npm run export -- --region <name>
//
// Section 7, steps 10-11: writes the region's parcel data files from the build's PostGIS
// tables (staging_<region>.parcels, metrics, meta) to data/out/<region>/:
//
//   parcels.json        header (region, county, FIPS, dates, setbacks, fields) and one row
//                       per parcel, ordered by id, values rounded per section 15.3; a metric
//                       whose layer the region lacks is left out of `fields`
//   attrs/index.json    every kept source column: type, filled and distinct counts, top
//                       values (strings) or min and max (numbers)
//   attrs/<COLUMN>.json one kept column in parcels.json row order, strings dictionary-encoded
//
// Source columns left out: the id column (already `id`), --drop columns of the build, owner
// mailing-address columns (MAIL*, MADD*, MCITY, MSTATE, MZIP, MUNIT; N-09), and columns that
// are empty or hold one value in every row. attrs/ is rewritten from scratch each run.
// Refuses to export a build whose validation (50_validate.sql) has not passed.
// Prints file sizes, raw and gzipped, against the N-06 budget.
//
// The pure parts (rounding, profiling, encoding) are in encode.ts, tested by Vitest.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import type { AttrIndex, ParcelsJson } from '../../app/src/lib/types.ts';
import { fail, readArgs, required } from './args.ts';
import {
  type Cell, attrFile, caseCollisions, encodeColumn, fieldsFor, isMailingColumn, parcelRow, profileColumn,
} from './encode.ts';
import { DATA_DIR, REGION_RE, ensureGisUp, fmt, ident, stagingSchema, withDb } from './gis.ts';

const USAGE = 'npm run export -- --region <name>';
const args = readArgs(USAGE, { region: { type: 'string' } });
const region = required(args.region, '--region', USAGE);
if (!REGION_RE.test(region)) fail('--region must be lowercase letters, digits and dashes, e.g. nc-halifax', USAGE);
const schema = stagingSchema(region);
const outDir = path.join(DATA_DIR, 'out', region);
const N06_BYTES = 3 * 1024 * 1024;

const NUMERIC = new Set(['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision']);

try {
  await ensureGisUp();
} catch (err) {
  fail((err as Error).message);
}

// Dates come back as text (YYYY-MM-DD), not JS Dates shifted by the time zone.
pg.types.setTypeParser(1082, (v: string) => v);

await withDb(async (db) => {
  const ok = (await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${schema}.metrics`])).rows[0]?.ok === true;
  if (!ok) fail(`no build for ${region} (${schema}.metrics missing); run npm run build first`);
  const meta = Object.fromEntries((await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM ${ident(schema)}.meta`)).rows.map((r) => [r.key, r.value])) as Record<string, any>;
  if (meta.validate?.passed !== true) fail(`the ${region} build has not passed validation; rerun npm run build`);

  // parcels.json fields: drop metrics whose layer the region lacks.
  const layers: Record<string, boolean> = { ...(meta.layers ?? {}), owner: !!meta.owner_column };
  const fields = fieldsFor(layers);
  const left = ['dl', 'dl100', 'dl230', 'dl345', 'ds', 'ds100', 'ds230', 'ra', 'fl', 'wl', 'wb', 'st', 'sm', 'cr', 'pa', 'fo', 'ob', 'obn', 'oba']
    .filter((f) => !(fields as string[]).includes(f));

  // Source columns to profile.
  const idColumn = String(meta.id_column);
  const drop = new Set<string>(meta.drop ?? []);
  const cols = (await db.query<{ name: string; type: string }>(
    `SELECT column_name AS name, data_type AS type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'parcels' AND column_name NOT IN ('id', 'geom')
     ORDER BY ordinal_position`, [schema])).rows;
  const mailing = cols.filter((c) => isMailingColumn(c.name)).map((c) => c.name);
  const userDropped = cols.filter((c) => drop.has(c.name) && !isMailingColumn(c.name)).map((c) => c.name);
  const source = cols.filter((c) => c.name !== idColumn && !drop.has(c.name) && !isMailingColumn(c.name))
    .map((c) => ({ name: c.name, type: NUMERIC.has(c.type) ? 'number' as const : 'string' as const }));

  const select = [
    'm.*',
    ...source.map((c, k) => `${c.type === 'number' ? `p.${ident(c.name)}::float8` : `p.${ident(c.name)}::text`} AS ${ident(`_c${k}`)}`),
  ].join(', ');
  const rows = (await db.query(
    `SELECT ${select} FROM ${ident(schema)}.metrics m JOIN ${ident(schema)}.parcels p USING (id) ORDER BY m.id COLLATE "C"`)).rows;

  console.log(`== export ${region}: ${fmt(rows.length)} parcels`);
  console.log(`parcels.json: ${fields.length} fields${left.length ? ` (left out, layer missing: ${left.join(', ')})` : ''}`);

  // parcels.json, one row per line so diffs and partial reads stay readable.
  const sources = JSON.parse(await readFile(path.join(DATA_DIR, 'sources.json'), 'utf8')) as { layer: string; updated?: string }[];
  const header: Omit<ParcelsJson, 'rows'> = {
    v: 3,
    region,
    county: meta.detected.county,
    fips: meta.detected.fips,
    built: localDate(),
    source_date: sources.find((s) => s.layer === 'parcels')?.updated ?? null,
    setback_ft: meta.setback_ft,
    water_buffer_ft: meta.water_buffer_ft,
    fields,
  };
  const head = JSON.stringify(header);
  const parcelsJson = `${head.slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(parcelRow(r, fields))).join(',\n')}\n]}\n`;

  // attrs/: profile, drop empty and constant columns, encode the rest.
  const index: AttrIndex = { columns: [] };
  const files: [string, string][] = [];
  const empty: string[] = [];
  const constant: string[] = [];
  source.forEach((c, k) => {
    const values = rows.map((r) => r[`_c${k}`] as Cell);
    const p = profileColumn(c.name, c.type, values);
    if (p.dropped === 'empty') return void empty.push(c.name);
    if (p.dropped === 'constant') return void constant.push(c.name);
    index.columns.push(p.info);
    files.push([attrFile(c.name), JSON.stringify(encodeColumn(c.name, c.type, values))]);
  });
  const clash = caseCollisions(index.columns.map((c) => c.name));
  if (clash.length) fail(`columns whose attrs/ files would collide on Windows and macOS: ${clash.map((g) => g.join('/')).join(', ')}; --drop one of each`);

  console.log(`attrs: ${index.columns.length} of ${cols.length} source columns kept`);
  console.log(`  dropped, id column: ${idColumn}`);
  if (mailing.length) console.log(`  dropped, mailing address: ${mailing.join(', ')}`);
  if (userDropped.length) console.log(`  dropped, --drop: ${userDropped.join(', ')}`);
  if (empty.length) console.log(`  dropped, empty: ${empty.join(', ')}`);
  if (constant.length) console.log(`  dropped, one value in every row: ${constant.join(', ')}`);

  // Write.
  await mkdir(outDir, { recursive: true });
  await rm(path.join(outDir, 'attrs'), { recursive: true, force: true });
  await mkdir(path.join(outDir, 'attrs'));
  await writeFile(path.join(outDir, 'parcels.json'), parcelsJson);
  const indexJson = `${JSON.stringify(index)}\n`;
  await writeFile(path.join(outDir, 'attrs', 'index.json'), indexJson);
  for (const [f, body] of files) await writeFile(path.join(outDir, 'attrs', f), `${body}\n`);

  // Sizes (N-06: parcels.json plus the columns the default setup loads under 3 MB gzipped).
  const size = (s: string) => [Buffer.byteLength(s), gzipSync(s).length] as const;
  const [pRaw, pGz] = size(parcelsJson);
  const [iRaw, iGz] = size(indexJson);
  const attrSizes = files.map(([f, b]) => ({ f, raw: Buffer.byteLength(b), gz: gzipSync(b).length })).sort((a, b) => b.gz - a.gz);
  const aGz = attrSizes.reduce((s, a) => s + a.gz, 0);
  const aRaw = attrSizes.reduce((s, a) => s + a.raw, 0);
  console.log(`\n== sizes (out/${region}/; raw, gzipped)`);
  console.log(`parcels.json       ${mb(pRaw)}  ${mb(pGz)}`);
  console.log(`attrs/index.json   ${mb(iRaw)}  ${mb(iGz)}`);
  console.log(`attrs/ columns     ${mb(aRaw)}  ${mb(aGz)}  (${files.length} files; largest: ${attrSizes.slice(0, 3).map((a) => `${a.f} ${mb(a.gz)}`).join(', ')})`);
  const budgetLeft = N06_BYTES - pGz - iGz;
  console.log(`N-06: parcels.json + index use ${mb(pGz + iGz)} of 3 MB gzipped; ${mb(Math.max(budgetLeft, 0))} left for the columns the default setup loads`);
  if (budgetLeft < 0) console.warn('warning: over the N-06 budget before any attribute column; move rarely used metrics to attrs/ (section 14)');
});

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2).padStart(6)} MB`;
}
