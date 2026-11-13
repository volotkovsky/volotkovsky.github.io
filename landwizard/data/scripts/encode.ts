// Pure parts of the export (section 7, steps 10-11; section 15.3), kept apart from the
// database so Vitest can test them on small sample tables: rounding of parcels.json values,
// mailing-address column detection, attribute profiling and dictionary encoding.

import type { AttrColumn, AttrInfo, ParcelField } from '../../app/src/lib/types.ts';

/** Decimals per parcels.json field (section 15.3); undefined = stored as is. */
export const DECIMALS: Partial<Record<ParcelField, number>> = {
  acres: 2, ba: 1,
  dl: 2, dl100: 2, dl230: 2, dl345: 2, ds: 2, ds100: 2, ds230: 2,
  fl: 2, wl: 2, wb: 2, st: 2, sm: 1, cr: 2, pa: 2, fo: 2,
  oba: 1, lon: 5, lat: 5,
};

/** Every parcels.json field in contract order. */
export const ALL_FIELDS: ParcelField[] = [
  'id', 'acres', 'ba', 'dl', 'dl100', 'dl230', 'dl345', 'ds', 'ds100', 'ds230', 'ra',
  'fl', 'wl', 'wb', 'st', 'sm', 'cr', 'pa', 'fo', 'ob', 'obn', 'oba', 'lon', 'lat',
];

/** Which loaded layer (meta.layers key, or `owner` for an owner column) each metric needs. */
export const FIELD_NEEDS: Partial<Record<ParcelField, (layers: Record<string, boolean>) => boolean>> = {
  ds: (l) => !!l.substations, ds100: (l) => !!l.substations, ds230: (l) => !!l.substations,
  ra: (l) => !!l.roads,
  fl: (l) => !!l.flood, ba: () => true,
  wl: (l) => !!l.wetlands,
  wb: (l) => !!l.wetlands || !!l.waterways,
  st: (l) => !!l.dem, sm: (l) => !!l.dem,
  cr: (l) => !!l.cdl, pa: (l) => !!l.cdl, fo: (l) => !!l.cdl,
  ob: (l) => !!l.owner, obn: (l) => !!l.owner, oba: (l) => !!l.owner,
};

/** The parcels.json fields for a region with these layers, in contract order. */
export function fieldsFor(layers: Record<string, boolean>): ParcelField[] {
  return ALL_FIELDS.filter((f) => FIELD_NEEDS[f]?.(layers) ?? true);
}

/**
 * Round half away from zero to `decimals` places, exactly for decimal input (1.005 -> 1.01,
 * which `toFixed` gets wrong), with -0 turned into 0. Null and undefined stay null.
 */
export function round(x: number | null | undefined, decimals: number): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  // Shift the decimal point in the text form, so 1.005 is 100.5 and not 100.49999999999999.
  // Very small or large numbers print with an exponent (1e-7); those are not near a .5 tie.
  const s = String(Math.abs(x));
  const scaled = s.includes('e') ? Math.abs(x) * 10 ** decimals : Number(`${s}e${decimals}`);
  const r = Math.sign(x) * (Math.round(scaled) / 10 ** decimals);
  return r === 0 ? 0 : Number(r.toFixed(decimals));
}

/** One parcels.json row from a metrics row: fields in order, each rounded per DECIMALS. */
export function parcelRow(m: Record<string, unknown>, fields: ParcelField[]): (string | number | null)[] {
  return fields.map((f) => {
    const v = m[f];
    if (f === 'id') return String(v);
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    const d = DECIMALS[f];
    return d === undefined ? (Number.isFinite(n) ? n : null) : round(n, d);
  });
}

/**
 * Owner mailing-address columns, dropped by default (section 7, N-09): names starting with
 * MAIL or MADD, and MCITY, MSTATE, MZIP, MUNIT. Case-insensitive.
 */
export function isMailingColumn(name: string): boolean {
  const n = name.toUpperCase();
  return n.startsWith('MAIL') || n.startsWith('MADD') || ['MCITY', 'MSTATE', 'MZIP', 'MUNIT'].includes(n);
}

export type Cell = string | number | null;

/** Empty = null, undefined, or a string that is blank after trimming. */
function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export interface Profiled {
  info: AttrInfo;
  /** Why the column is not exported, or null when it is kept. */
  dropped: 'empty' | 'constant' | null;
}

/** How many top values attrs/index.json lists for a string column. */
export const TOP_N = 10;

/**
 * Profile one column: filled and distinct counts, top values (strings) or min and max
 * (numbers). A column is dropped when no row is filled, or when every row holds the same
 * value: a column filled in only some rows still tells those rows apart, so a one-value
 * flag such as MULTISTRUC = 'Y' is kept.
 */
export function profileColumn(name: string, type: 'string' | 'number', values: Cell[]): Profiled {
  const counts = new Map<string | number, number>();
  for (const v of values) {
    if (isEmpty(v)) continue;
    const k = type === 'number' ? Number(v) : String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let filled = 0;
  for (const c of counts.values()) filled += c;
  const distinct = counts.size;
  const dropped = filled === 0 ? 'empty' : distinct === 1 && filled === values.length ? 'constant' : null;
  if (type === 'number') {
    let min = Infinity;
    let max = -Infinity;
    for (const k of counts.keys()) {
      const n = k as number;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    return { info: { name, type, filled, distinct, min: filled ? min : 0, max: filled ? max : 0 }, dropped };
  }
  const top = byFrequency(counts as Map<string, number>).slice(0, TOP_N);
  return { info: { name, type, filled, distinct, top }, dropped };
}

/** Values by count, most frequent first; ties in code-point order, so output is stable. */
function byFrequency(counts: Map<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Encode one column for attrs/<COLUMN>.json, in row order. Strings: dictionary `d` sorted by
 * frequency (so common values get small indices and compress well) and `i` with -1 for
 * empty. Numbers: values directly in `v`, null for empty.
 */
export function encodeColumn(name: string, type: 'string' | 'number', values: Cell[]): AttrColumn {
  if (type === 'number') {
    return { name, v: values.map((v) => (isEmpty(v) || !Number.isFinite(Number(v)) ? null : Number(v))) };
  }
  const counts = new Map<string, number>();
  for (const v of values) if (!isEmpty(v)) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  const d = byFrequency(counts).map(([k]) => k);
  const index = new Map(d.map((k, i) => [k, i]));
  return { name, d, i: values.map((v) => (isEmpty(v) ? -1 : index.get(String(v))!)) };
}

/** Decode an attrs column back to values (the app's view; used by tests). */
export function decodeColumn(col: AttrColumn): Cell[] {
  return 'v' in col ? col.v : col.i.map((i) => (i < 0 ? null : col.d[i] ?? null));
}

/** Column names that would collide as file names on a case-insensitive file system. */
export function caseCollisions(names: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const k = n.toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** File name of a column under attrs/ (column names may hold characters unsafe in a path). */
export function attrFile(name: string): string {
  return `${encodeURIComponent(name)}.json`;
}
