import { describe, expect, it } from 'vitest';
import {
  ALL_FIELDS, attrFile, caseCollisions, decodeColumn, encodeColumn, fieldsFor, isMailingColumn, parcelRow, profileColumn, round,
} from '../scripts/encode.ts';

// A small sample table in the shape export.ts reads: metrics columns plus source columns.
const sample = [
  { id: '0101258', acres: 152.374999, ba: 118.449, dl: 0.835, dl100: 0.835, dl230: 3.1049, dl345: null, ds: 1.915, ds100: 1.915,
    ds230: null, ra: 2, fl: 0.0349999, wl: 0.005, wb: 0.0612, st: 0.02, sm: 1.45, cr: 0.71, pa: 0.08, fo: 0.15,
    ob: 412, obn: 3, oba: 288.05, lon: -77.586115, lat: 36.338145 },
  { id: '0101259', acres: 0.004, ba: 0, dl: 0, dl100: 0.0049, dl230: 9.999, dl345: null, ds: 0.3, ds100: 0.3,
    ds230: 7.25, ra: 0, fl: -0.0000001, wl: 0, wb: 1, st: 0, sm: 0.04, cr: 0, pa: 0, fo: 1,
    ob: 7, obn: 1, oba: 0.004, lon: -77.9, lat: 36.1 },
];
const layersAll = { lines: true, substations: true, roads: true, flood: true, wetlands: true, waterways: true, dem: true, cdl: true, owner: true };

describe('round', () => {
  it('rounds half away from zero on the decimal value', () => {
    expect(round(1.005, 2)).toBe(1.01); // toFixed gives 1.00
    expect(round(0.125, 2)).toBe(0.13);
    expect(round(2.5, 0)).toBe(3);
    expect(round(-77.586115, 5)).toBe(-77.58612);
    expect(round(-2.5, 0)).toBe(-3);
  });

  it('turns -0 into 0 and keeps null', () => {
    expect(Object.is(round(-0.0000001, 2), 0)).toBe(true);
    expect(round(null, 2)).toBeNull();
    expect(round(undefined, 2)).toBeNull();
    expect(round(Number.NaN, 2)).toBeNull();
  });
});

describe('parcelRow', () => {
  it('rounds each field per section 15.3', () => {
    expect(parcelRow(sample[0]!, ALL_FIELDS)).toEqual([
      '0101258', 152.37, 118.4, 0.84, 0.84, 3.1, null, 1.92, 1.92, null, 2,
      0.03, 0.01, 0.06, 0.02, 1.5, 0.71, 0.08, 0.15, 412, 3, 288.1, -77.58612, 36.33815,
    ]);
  });

  it('keeps small values, shares of 0 and 1, and serializes compactly', () => {
    const row = parcelRow(sample[1]!, ALL_FIELDS);
    expect(row).toEqual([
      '0101259', 0, 0, 0, 0, 10, null, 0.3, 0.3, 7.25, 0,
      0, 0, 1, 0, 0, 0, 0, 1, 7, 1, 0, -77.9, 36.1,
    ]);
    expect(JSON.stringify(row)).not.toMatch(/-0[,\]]/);
    expect(JSON.stringify(row)).not.toMatch(/\d\.\d{6,}/);
  });

  it('accepts numbers that arrive as strings (bigint, numeric) and an id that is a number', () => {
    expect(parcelRow({ id: 42, acres: '3.14159', ob: '12' }, ['id', 'acres', 'ob'])).toEqual(['42', 3.14, 12]);
  });
});

describe('fieldsFor', () => {
  it('keeps every field when every layer is loaded', () => {
    expect(fieldsFor(layersAll)).toEqual(ALL_FIELDS);
  });

  it('leaves out the metrics of missing layers, keeping contract order', () => {
    const f = fieldsFor({ lines: true, substations: true, roads: true, wetlands: true });
    expect(f).toEqual(['id', 'acres', 'ba', 'dl', 'dl100', 'dl230', 'dl345', 'ds', 'ds100', 'ds230', 'ra', 'wl', 'wb', 'lon', 'lat']);
  });

  it('keeps wb with waterways alone', () => {
    expect(fieldsFor({ lines: true, waterways: true })).toContain('wb');
  });
});

describe('isMailingColumn', () => {
  it('matches the Halifax mailing columns', () => {
    for (const c of ['MAILADD', 'MADDPREF', 'MADDRNO', 'MADDSTNAME', 'MADDSTR', 'MADDSTSUF', 'MADDSTTYP', 'MCITY', 'MSTATE', 'MZIP', 'MUNIT']) {
      expect(isMailingColumn(c), c).toBe(true);
    }
    expect(isMailingColumn('mail_address')).toBe(true);
  });

  it('keeps site address, owner and similar-looking columns', () => {
    for (const c of ['SITEADD', 'SADDSTR', 'SCITY', 'SZIP', 'OWNNAME', 'MAPREF', 'MULTISTRUC', 'MUNITS', 'MZIPCODE']) {
      expect(isMailingColumn(c), c).toBe(false);
    }
  });
});

describe('profileColumn', () => {
  it('counts filled and distinct values and lists top values by frequency', () => {
    const p = profileColumn('LEGDECFULL', 'string', ['RANCH', 'CONVENTIONAL', null, 'CONVENTIONAL', '  ', 'A', 'CONVENTIONAL', 'RANCH']);
    expect(p.dropped).toBeNull();
    expect(p.info).toEqual({ name: 'LEGDECFULL', type: 'string', filled: 6, distinct: 3, top: [['CONVENTIONAL', 3], ['RANCH', 2], ['A', 1]] });
  });

  it('caps top values at 10, ties in code-point order', () => {
    const vals = Array.from({ length: 15 }, (_, k) => `V${String(k).padStart(2, '0')}`);
    const p = profileColumn('X', 'string', vals);
    expect(p.info.type === 'string' && p.info.top.map(([v]) => v)).toEqual(vals.slice(0, 10));
  });

  it('gives min and max for numbers', () => {
    expect(profileColumn('GISACRES', 'number', [3, null, 0, 7042, 3]).info)
      .toEqual({ name: 'GISACRES', type: 'number', filled: 4, distinct: 3, min: 0, max: 7042 });
  });

  it('drops empty and constant columns, keeps a one-value flag', () => {
    expect(profileColumn('E', 'string', [null, '', ' ']).dropped).toBe('empty');
    expect(profileColumn('C', 'string', ['37083', '37083', '37083']).dropped).toBe('constant');
    expect(profileColumn('N', 'number', [1, 1]).dropped).toBe('constant');
    expect(profileColumn('MULTISTRUC', 'string', ['Y', null, null]).dropped).toBeNull();
  });
});

describe('encodeColumn', () => {
  it('dictionary-encodes strings, most frequent first, -1 for empty', () => {
    const col = encodeColumn('LEGDECFULL', 'string', ['RANCH', null, 'CONVENTIONAL', 'CONVENTIONAL', '']);
    expect(col).toEqual({ name: 'LEGDECFULL', d: ['CONVENTIONAL', 'RANCH'], i: [1, -1, 0, 0, -1] });
  });

  it('stores numbers directly, null for empty', () => {
    expect(encodeColumn('GISACRES', 'number', [3, null, 0.5, ''])).toEqual({ name: 'GISACRES', v: [3, null, 0.5, null] });
  });

  it('round-trips in row order', () => {
    const values = ['b', 'a', null, 'a', 'c', 'a', 'b'];
    expect(decodeColumn(encodeColumn('X', 'string', values))).toEqual(values);
    const nums = [1, null, 2.5, -3];
    expect(decodeColumn(encodeColumn('Y', 'number', nums))).toEqual(nums);
  });

  it('keeps values that differ only in case or accents apart', () => {
    const col = encodeColumn('X', 'string', ['Main', 'MAIN', 'Café', 'Cafe']);
    expect('d' in col && col.d.length).toBe(4);
  });
});

describe('file names', () => {
  it('finds names that collide on a case-insensitive file system', () => {
    expect(caseCollisions(['OWNNAME', 'OwnerName2', 'OWNNAME2', 'ownname'])).toEqual([['OWNNAME', 'ownname']]);
  });

  it('escapes unsafe characters', () => {
    expect(attrFile('GISACRES')).toBe('GISACRES.json');
    expect(attrFile('A/B C')).toBe('A%2FB%20C.json');
  });
});
