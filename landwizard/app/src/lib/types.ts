// Shared data contracts (section 15.3). The data scripts import these with `import type`,
// so the build and the app cannot disagree on a file format. Types only, no runtime code.
// T-10 adds the app's own types (setup, rules, filters) to this file.

/** A field of a parcels.json row. A metric whose layer the region lacks is left out of `fields`. */
export type ParcelField =
  | 'id' | 'acres' | 'ba'
  | 'dl' | 'dl100' | 'dl230' | 'dl345' | 'ds' | 'ds100' | 'ds230' | 'ra'
  | 'fl' | 'wl' | 'wb' | 'st' | 'sm' | 'cr' | 'pa' | 'fo'
  | 'ob' | 'obn' | 'oba' | 'lon' | 'lat';

/** parcels.json: a header plus one array per parcel, values in `fields` order. */
export interface ParcelsJson {
  v: 3;
  region: string;
  county: string;
  fips: string;
  /** Build date, YYYY-MM-DD. */
  built: string;
  /** Date of the parcel data (sources.json `updated` of the parcels entry), YYYY-MM-DD, or null. */
  source_date: string | null;
  setback_ft: number;
  water_buffer_ft: number;
  fields: ParcelField[];
  /** First value is the id (string); the rest are numbers or null. */
  rows: (string | number | null)[][];
}

/** One entry of attrs/index.json. */
export type AttrInfo =
  | { name: string; type: 'string'; filled: number; distinct: number; top: [string, number][] }
  | { name: string; type: 'number'; filled: number; distinct: number; min: number; max: number };

/** attrs/index.json: every kept source column. */
export interface AttrIndex {
  columns: AttrInfo[];
}

/**
 * attrs/<COLUMN>.json, in parcels.json row order. Strings are dictionary-encoded: `i` indexes
 * into `d`, -1 means empty. Numbers are stored directly in `v`, null means empty.
 * The file name is `${encodeURIComponent(name)}.json`.
 */
export type AttrColumn =
  | { name: string; d: string[]; i: number[] }
  | { name: string; v: (number | null)[] };

