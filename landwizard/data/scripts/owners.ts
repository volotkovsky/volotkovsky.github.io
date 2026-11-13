// Owner names for owner blocks (F-32, T-35). The build normalizes each parcel's owner
// here, writes the keys to staging.owner_key, and sql/43_owner_blocks.sql clusters parcels
// with the same key that touch or lie within 30 m of each other.
//
// Normalization (section 4.8, plus what the Halifax names showed):
//   - upper case, accents dropped
//   - parenthesized notes dropped: (LE), (LIFE ESTATE), (HEIRS), (WENDYS)
//   - co-owners after `&` dropped, so `SMITH JOHN & MARY ETAL` matches `SMITH JOHN`; but not
//     in business names (`BARNES & BRIDGERS LLC`) or after an initial (`C & D FOWLER
//     PROPERTIES LLC`, `R & D RENTALS`, `P&Z LAND LLC`), where `&` is part of the name
//   - punctuation removed: `SMITH, JOHN` = `SMITH JOHN`, `O'NEAL` = `ONEAL`
//   - ETAL, ET AL, ET UX, ET VIR, HEIRS, LIFE ESTATE, UDI (undivided interest) and share
//     fractions such as 1/2 dropped; LE (life estate) only as the last word, being a surname too
// Generational suffixes (JR, SR, II, III) stay: they name a different person.

/** Words that mark a business, trust or public owner, whose `&` is part of the name. */
const ENTITY_WORDS = new Set([
  'LLC', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LP', 'LLP', 'LTD', 'PLLC', 'PC',
  'PARTNERSHIP', 'PARTNERS', 'ASSOCIATES', 'ASSOCIATION', 'ASSOC', 'PROPERTIES', 'PROPERTY', 'RENTALS', 'REALTY',
  'HOLDINGS', 'INVESTMENTS', 'ENTERPRISES', 'DEVELOPMENT', 'FARMS', 'TIMBER', 'BANK', 'MINISTRIES',
  'TRUST', 'TRUSTEES', 'FOUNDATION', 'GROUP', 'SONS', 'BROTHERS', 'BROS', 'CITY', 'TOWN', 'COUNTY', 'STATE',
]);

/** Tokens that say how a person holds the land, not who they are. */
const DROP_TOKENS = new Set(['ETAL', 'ETALS', 'ETUX', 'ETVIR', 'HEIRS', 'HEIR', 'UDI']);
/** Dropped only as the last word: LE (life estate) is also a surname (`LE, THANH`). */
const TRAILING_TOKENS = new Set(['LE']);

/** A stable comparison key for an owner name, or null when the name is empty. */
export function normalizeOwner(name: string | null | undefined): string | null {
  if (!name) return null;
  let s = name.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase(); // accents: É -> E
  s = s.replace(/\([^)]*\)?/g, ' ');
  s = dropCoOwners(s);
  s = s
    .replace(/\b\d+\s*\/\s*\d+\b/g, ' ')        // share fractions: 1/2, 2/3
    .replace(/['’`]/g, '')                      // O'NEAL -> ONEAL
    .replace(/[^A-Z0-9&]+/g, ' ')               // other punctuation -> space
    .replace(/\bET\s+(AL|ALS|UX|VIR)\b/g, ' ')  // ET AL, ET UX, ET VIR
    .replace(/\bLIFE\s+ESTATE\b/g, ' ');
  const tokens = s.split(' ').filter((t) => t && !DROP_TOKENS.has(t));
  while (tokens.length > 1 && TRAILING_TOKENS.has(tokens.at(-1)!)) tokens.pop();
  const key = tokens.join(' ').replace(/\s*&\s*/g, ' & ').trim();
  return key === '' || key === '&' ? null : key;
}

/** Cut `A & B` to `A`, unless `&` belongs to a business name or follows an initial. */
function dropCoOwners(s: string): string {
  const amp = s.indexOf('&');
  if (amp < 0) return s;
  const words = s.replace(/[^A-Z0-9&]+/g, ' ').trim().split(' ');
  if (words.some((w) => ENTITY_WORDS.has(w))) return s;
  const before = s.slice(0, amp).replace(/[^A-Z0-9]+/g, ' ').trim();
  if (before === '') return s.slice(amp + 1);  // `& MARY`: nothing before it
  if (/^[A-Z0-9]$/.test(before)) return s;     // `C & D`, `P&Z`: initials, part of the name
  return s.slice(0, amp);
}

/**
 * Pick the owner column when --owner is not given: the one column named like OWN*NAME
 * (case-insensitive). Returns null when there is none or more than one.
 */
export function detectOwnerColumn(columns: string[]): { column: string | null; candidates: string[] } {
  const candidates = columns.filter((c) => /^own.*name$/i.test(c));
  return { column: candidates.length === 1 ? candidates[0]! : null, candidates };
}
