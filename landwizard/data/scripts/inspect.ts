// npm run inspect -- --src raw/<region>/<file> [--layer <name>]
//
// Prints the layers of a raw parcel file and, per column, its type and how many
// rows are filled and distinct, so the `--id` column for the build can be picked.
// Runs GDAL inside the gis container; the file must be under landwizard/data.

import { fail, readArgs, required } from './args.ts';
import { dataPath, ensureGisUp, gisJson, ident, toContainer } from './gis.ts';

const USAGE = 'npm run inspect -- --src <file under data/> [--layer <name>]';

// The parts of `ogrinfo -json -so` output used here (GDAL 3.7+).
interface OgrField { name: string; type: string; width?: number }
interface OgrLayer {
  name: string;
  featureCount?: number;
  geometryFields?: { type: string; coordinateSystem?: { projjson?: { name?: string; id?: { authority: string; code: number } } } }[];
  fields: OgrField[];
}
interface OgrInfo { driverShortName?: string; layers: OgrLayer[] }

interface ColumnStats { name: string; type: string; filled: number; distinct: number; sample: string }

const args = readArgs(USAGE, {
  src: { type: 'string' },
  layer: { type: 'string' },
});

const src = required(args.src, '--src', USAGE);
let containerSrc: string;
try {
  dataPath(src);
  containerSrc = toContainer(src);
  await ensureGisUp();
} catch (err) {
  fail((err as Error).message);
}

const info = await gisJson<OgrInfo>('ogrinfo', ['-json', '-ro', '-so', '-al', containerSrc]);

let layers = info.layers;
if (args.layer !== undefined) {
  layers = layers.filter((l) => l.name === args.layer);
  if (layers.length === 0) fail(`layer "${args.layer}" not found; layers: ${info.layers.map((l) => l.name).join(', ')}`);
}

console.log(`${src}  (${info.driverShortName ?? 'unknown driver'}, ${info.layers.length} layer${info.layers.length === 1 ? '' : 's'})`);

for (const layer of layers) {
  const stats = await layerStats(layer);
  printLayer(layer, stats);
}

/** One SQL pass over the layer: row count, then filled / distinct / sample per column. */
async function layerStats(layer: OgrLayer): Promise<{ rows: number; columns: ColumnStats[] }> {
  if (layer.fields.length === 0) return { rows: layer.featureCount ?? 0, columns: [] };

  // Every value is compared as trimmed text, so '' and '   ' count as empty.
  const select = layer.fields.map((f, i) => {
    const v = `NULLIF(TRIM(CAST(${ident(f.name)} AS TEXT)), '')`;
    return `COUNT(${v}) AS f${i}, COUNT(DISTINCT ${v}) AS d${i}, MIN(${v}) AS s${i}`;
  });
  const query = `SELECT COUNT(*) AS n, ${select.join(', ')} FROM ${ident(layer.name)}`;

  const warnings: string[] = [];
  const out = await gisJson<{ features: { properties: Record<string, string | number | null> }[] }>('ogr2ogr', [
    '-f', 'GeoJSON', '/vsistdout/', containerSrc, '-dialect', 'SQLite', '-sql', query,
  ], { stderrLines: warnings });
  reportWarnings(warnings);
  const p = out.features[0]?.properties ?? {};
  const num = (k: string) => Number(p[k] ?? 0);

  return {
    rows: num('n'),
    columns: layer.fields.map((f, i) => ({
      name: f.name,
      type: f.width ? `${f.type}(${f.width})` : f.type,
      filled: num(`f${i}`),
      distinct: num(`d${i}`),
      sample: p[`s${i}`] == null ? '' : String(p[`s${i}`]),
    })),
  };
}

function printLayer(layer: OgrLayer, { rows, columns }: { rows: number; columns: ColumnStats[] }): void {
  const geom = layer.geometryFields?.[0];
  const crs = geom?.coordinateSystem?.projjson;
  const crsText = crs ? `${crs.name ?? '?'}${crs.id ? ` (${crs.id.authority}:${crs.id.code})` : ''}` : 'no CRS';

  console.log('');
  console.log(`layer ${layer.name}: ${geom?.type ?? 'no geometry'}, ${fmt(rows)} rows, ${crsText}`);
  if (columns.length === 0) return;

  const header = ['column', 'type', 'filled', 'distinct', 'note', 'sample'];
  const body = columns.map((c) => [c.name, c.type, fmt(c.filled), fmt(c.distinct), note(c, rows), clip(c.sample, 40)]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const right = new Set([2, 3]);
  const line = (r: string[]) => r.map((cell, i) => (right.has(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join('  ').trimEnd();

  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of body) console.log(line(r));

  const ids = columns.filter((c) => c.filled === rows && c.distinct === rows).map((c) => c.name);
  const nearIds = columns
    .filter((c) => !ids.includes(c.name) && c.distinct >= rows * 0.99)
    .map((c) => `${c.name} (${fmt(rows - c.filled)} empty, ${fmt(c.filled - c.distinct)} duplicates)`);
  console.log('');
  console.log(`unique and complete (--id candidates): ${ids.length ? ids.join(', ') : 'none'}`);
  if (nearIds.length) console.log(`nearly unique: ${nearIds.join('; ')}`);
}

/**
 * Summarize GDAL warnings instead of printing up to 1,000 lines. The common one: a DBF
 * column declared Integer (0 decimals) that holds decimals, e.g. Halifax RECAREANO '12.6'.
 * GDAL truncates those values, so that column's counts are of the truncated values.
 */
function reportWarnings(lines: string[]): void {
  const truncated = new Map<string, { n: number; example: string }>();
  const other: string[] = [];
  for (const line of lines) {
    const m = /Value '([^']*)' of field [^.]+\.(\S+) parsed incompletely to integer/.exec(line);
    if (m) {
      const t = truncated.get(m[2]!) ?? { n: 0, example: m[1]! };
      t.n++;
      truncated.set(m[2]!, t);
    } else if (!/More than \d+ errors or warnings/.test(line)) {
      other.push(line);
    }
  }
  for (const [field, t] of truncated) {
    const n = t.n >= 1000 ? '1,000+' : fmt(t.n);
    console.warn(`warning: ${field} is declared Integer but holds decimals (e.g. ${t.example}); GDAL truncated ${n} values`);
  }
  for (const line of other.slice(0, 10)) console.warn(line);
  if (other.length > 10) console.warn(`… ${fmt(other.length - 10)} more GDAL messages`);
}

function note(c: ColumnStats, rows: number): string {
  if (c.filled === 0) return 'empty';
  if (c.distinct === 1) return 'constant';
  if (c.filled === rows && c.distinct === rows) return 'unique';
  return '';
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
