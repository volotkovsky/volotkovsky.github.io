import { describe, expect, it } from 'vitest';
import { detectOwnerColumn, normalizeOwner } from '../scripts/owners.ts';

const same = (a: string, b: string) => expect(normalizeOwner(a)).toBe(normalizeOwner(b));
const differ = (a: string, b: string) => expect(normalizeOwner(a)).not.toBe(normalizeOwner(b));

describe('normalizeOwner', () => {
  it('matches the spec example', () => {
    same('SMITH JOHN', 'SMITH JOHN & MARY ETAL');
    expect(normalizeOwner('SMITH JOHN & MARY ETAL')).toBe('SMITH JOHN');
  });

  it('drops ETAL, ET AL, ET UX and ET VIR', () => {
    expect(normalizeOwner('PILAND, JOHN E ETAL')).toBe('PILAND JOHN E');
    same('PILAND, JOHN E', 'PILAND JOHN E ET AL');
    same('JONES, ROBERT', 'JONES, ROBERT ET UX');
    same('JONES, MARY', 'JONES, MARY ET VIR');
    same('JONES, MARY', 'JONES, MARY ETUX');
  });

  it('drops co-owners after &', () => {
    same('FLEMING, BOBBY R', 'FLEMING, BOBBY R & CONNIE Y');
    same('MOODY, JOYCE A', 'MOODY, JOYCE A & EDGAR ROEBUCK');
    same('LASHLEY, JASPER JR', 'LASHLEY, JASPER JR & JOYCE');
  });

  it('removes punctuation and extra spaces', () => {
    same('SMITH, JOHN', 'SMITH JOHN');
    same('SMITH,JOHN', 'SMITH JOHN');
    same('CITY OF ROANOKE RAPIDS,', 'CITY OF ROANOKE RAPIDS');
    same('JONES, C. E.', 'JONES C E');
    same("O'NEAL, PAT", 'ONEAL PAT');
    same('BURGESS, LIZZIE ELLA  ', 'burgess lizzie ella');
    same('PEÑA, JOSÉ', 'PENA JOSE');
  });

  it('keeps & inside business names and after initials', () => {
    expect(normalizeOwner('BARNES & BRIDGERS LLC')).toBe('BARNES & BRIDGERS LLC');
    expect(normalizeOwner('C & D FOWLER PROPERTIES LLC')).toBe('C & D FOWLER PROPERTIES LLC');
    expect(normalizeOwner('R & D RENTALS, LLC')).toBe('R & D RENTALS LLC');
    same('P&Z LAND LLC', 'P & Z LAND LLC');
    expect(normalizeOwner('HIGH, JOHN H & COMPANY INC')).toBe('HIGH JOHN H & COMPANY INC');
    expect(normalizeOwner('A & B')).toBe('A & B');
    differ('BARNES & BRIDGERS LLC', 'BARNES');
  });

  it('drops life estate, heirs and share notes', () => {
    same('HARDEE, WANDA S', 'HARDEE, WANDA S (LE)');
    same('HARDEE, WANDA S', 'HARDEE, WANDA S LE');
    same('RICHARDSON, MARY LOUISE', 'RICHARDSON, MARY LOUISE(LIFE ESTATE)');
    same('EPPS, HARRY LEE', 'EPPS, HARRY LEE (HEIRS)');
    same('HUX, HERBERT W', 'HUX, HERBERT W HEIRS ET AL');
    same('HEDGEPETH, KEENYN L', 'HEDGEPETH, KEENYN L 1/2 UDI');
    same('STROBEL, ROGER W', 'STROBEL, ROGER W & BETTY JEAN P 2/3');
    same('TARHEEL CAPITALS CORP 2', 'TARHEEL CAPITALS CORP 2 (WENDYS),');
  });

  it('keeps LE as a surname and generational suffixes', () => {
    expect(normalizeOwner('LE, THANH')).toBe('LE THANH');
    expect(normalizeOwner('LE')).toBe('LE');
    differ('KERR, JAMES EDWARD', 'KERR, JAMES EDWARD II');
    differ('SMITH, JOHN', 'SMITH, JOHN JR');
  });

  it('gives null for empty names', () => {
    expect(normalizeOwner(null)).toBeNull();
    expect(normalizeOwner(undefined)).toBeNull();
    expect(normalizeOwner('')).toBeNull();
    expect(normalizeOwner('  , ')).toBeNull();
    expect(normalizeOwner('ETAL')).toBeNull();
    expect(normalizeOwner('&')).toBeNull();
  });
});

describe('detectOwnerColumn', () => {
  it('finds the one OWN*NAME column', () => {
    expect(detectOwnerColumn(['PARNO', 'OWNNAME', 'OWNNAME2', 'OwnerName2', 'OWNFRST'])).toEqual({ column: 'OWNNAME', candidates: ['OWNNAME'] });
    expect(detectOwnerColumn(['id', 'owner_name']).column).toBe('owner_name');
  });

  it('gives up on none or several', () => {
    expect(detectOwnerColumn(['PARNO', 'SITEADD']).column).toBeNull();
    expect(detectOwnerColumn(['OWNNAME', 'OWNERNAME']).column).toBeNull();
  });
});
