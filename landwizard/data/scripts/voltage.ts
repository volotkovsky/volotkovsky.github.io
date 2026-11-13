// Voltage parsing for OSM `voltage` tags (T-33). fetch.ts stores the result as `max_kv` on
// OSM power lines and substations; 40_metrics.sql picks the voltage-class distances
// (dl100, dl230, dl345, ds100, ds230) from it.
//
// OSM tags voltage in volts, with `;` between circuits: `230000;115000`. Real tags also
// hold unknown parts (`230000;115000;?`), units (`115 kV`, `13.2kV`), commas as list
// separators and words (`medium`). Anything unreadable is skipped; a tag with no readable
// part gives null, which counts for the "any voltage" distance only.

/** Highest voltage in kV from an OSM voltage tag, or null when no part is readable. */
export function maxKv(tag: string | null | undefined): number | null {
  if (!tag) return null;
  let max: number | null = null;
  for (const part of tag.split(/[;,/]/)) {
    const kv = partKv(part);
    if (kv !== null && (max === null || kv > max)) max = kv;
  }
  return max;
}

/**
 * One voltage value in kV. Units are optional: `kV` means kilovolts, `V` or no unit means
 * volts as OSM asks, except that a bare number under 1,000 is taken as kV. Nobody runs a
 * power line at 115 volts, so `115` is a kV value tagged without its unit.
 */
function partKv(part: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(kv|v)?\s*$/i.exec(part);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const unit = m[2]?.toLowerCase();
  if (unit === 'kv') return n;
  if (unit === 'v') return n / 1000;
  return n < 1000 ? n : n / 1000;
}
