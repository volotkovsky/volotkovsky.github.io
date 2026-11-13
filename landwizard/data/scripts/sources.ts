// data/sources.json: source, URL, download date and license per layer (section 5).
// The app reads it for the layer info popups (F-04). `fetch.ts` upserts the layers it
// downloads; the parcels entry is written by hand and never touched here.
//
// TODO(T-10): move SourceEntry to app/src/lib/types.ts and import it from there.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './gis.ts';

export type LayerKey =
  | 'parcels' | 'lines' | 'osm_lines' | 'substations' | 'flood' | 'wetlands' | 'waterways' | 'roads'
  | 'elevation' | 'landcover' | 'counties';

export interface SourceEntry {
  layer: LayerKey;
  name: string;
  url: string;
  /** ISO date the file was downloaded. */
  downloaded: string;
  license: string;
  /** ISO date the publisher last changed the data, when the source reports it. */
  updated?: string;
  /** Anything a reader of the layer popup should know, e.g. that a fallback source was used. */
  note?: string;
}

export const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');

const ORDER: LayerKey[] = [
  'parcels', 'lines', 'osm_lines', 'substations', 'flood', 'wetlands', 'waterways', 'roads', 'elevation', 'landcover', 'counties',
];

export async function readSources(): Promise<SourceEntry[]> {
  try {
    return JSON.parse(await readFile(SOURCES_FILE, 'utf8')) as SourceEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Replace the entries for the given layers, keep all others, write in a fixed layer order. */
export async function upsertSources(entries: SourceEntry[]): Promise<void> {
  const byLayer = new Map((await readSources()).map((e) => [e.layer, e]));
  for (const e of entries) byLayer.set(e.layer, e);
  const sorted = [...byLayer.values()].sort((a, b) => ORDER.indexOf(a.layer) - ORDER.indexOf(b.layer));
  await writeFile(SOURCES_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
