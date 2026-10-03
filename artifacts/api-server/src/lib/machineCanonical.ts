// The one rule for "which Pinball Map machine is this name?" — used when a machine row is created
// (machineUpsert.ts, against the PM catalog), by venue repair (venueRepair.ts, against a roster), by
// the score-stats lookup (machineScoreStats.ts) and by Add Score's auto-select (the frontend copy).
//
// PURE: no imports, no fetch, no db. The frontend keeps a byte-identical copy at
// artifacts/pinball-tracker/src/lib/machineCanonical.ts, and machineCanonical.test.ts fails if the two
// drift — edit this file, then copy it over.
//
// Why it exists: the AI reads backglasses, not catalogs. "Jaws Pro Edition" and "No Good Gofers!" were
// saved verbatim as new machine rows (no image, no OPDB id) because the only lookup was an exact
// case-insensitive name match against "JAWS (Pro)" / "No Good Gofers".
//
// Matching order — each tier accepts only a UNIQUE candidate name (ambiguity is not a match):
//   1. exact, case-insensitive. First, so a real title containing an edition word ("Big Buck Hunter
//      Pro") is never re-read as base + edition.
//   2. normalized key: same base AND same edition (see machineNameParts).
//   3. the input names no edition: same base, when only one candidate has that base. So "The Munsters"
//      against the catalog's Pro/Premium/LE stays unmatched — a human picks the edition.
//   4. roster only: whole-word prefix of the base either way ("Transformers" ↔ "Transformers: More
//      Than Meets the Eye"), editions compatible (not both named and different). A venue roster is a
//      dozen machines, so a unique prefix there is meaningful; against ~2,300 catalog titles it isn't.
// With a roster, it is tried first (all tiers), then the catalog (tiers 1–3): what's at the venue wins.

export type CanonicalConfidence = 'exact' | 'normalized' | 'fuzzy';

export interface CanonicalMatch<T> {
  /** The candidate's own spelling — what to save. */
  name: string;
  entry: T;
  confidence: CanonicalConfidence;
  source: 'roster' | 'catalog';
}

export interface MachineNameParts {
  /** Folded, punctuation-free title without its edition: "jaws", "attack from mars remake". */
  base: string;
  /** 'pro' | 'premium' | 'le' | 'se' | 'ce', or '' when the name carries none. */
  edition: string;
}

// Edition words, mapped to one token each. "limited", "special", "collectors" only count as editions
// at the end of a name (optionally followed by "edition"), never mid-title.
const EDITIONS: Record<string, string> = {
  pro: 'pro',
  premium: 'premium',
  le: 'le',
  limited: 'le',
  se: 'se',
  special: 'se',
  ce: 'ce',
  collectors: 'ce',
};

function words(s: string): string[] {
  const t = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? t.split(' ') : [];
}

// Peels a trailing edition off a word list: "pro" / "pro edition" / "limited edition" / "le".
// Never peels the whole list — "Pro" alone is a title, not an edition of nothing.
function peelEdition(ws: string[]): { rest: string[]; edition: string } {
  const n = ws.length;
  if (n >= 2 && ws[n - 1] === 'edition' && EDITIONS[ws[n - 2]]) {
    return { rest: ws.slice(0, n - 2), edition: EDITIONS[ws[n - 2]] };
  }
  if (n >= 1 && EDITIONS[ws[n - 1]]) return { rest: ws.slice(0, n - 1), edition: EDITIONS[ws[n - 1]] };
  return { rest: ws, edition: '' };
}

/**
 * Splits a machine name into a comparable (base, edition): NFD diacritic fold ("Pokémon" → "pokemon"),
 * lowercase, apostrophes dropped ("Collector's" → "collectors"), "&" → "and", other punctuation → space,
 * a leading "the" dropped, and the edition taken from a parenthesized group ("(Pro)", "(Remake LE)",
 * "(Special Edition)") or bare at the end ("Pro Edition", "Premium"). A parenthesized group that is not
 * an edition ("(Remake)", "(50th Anniversary)", "(Home Edition)") stays part of the base.
 */
export function machineNameParts(name: string): MachineNameParts {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ');

  let edition = '';
  const outside = s.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    const ws = words(inner);
    const peeled = ws.length ? peelEdition(ws) : { rest: ws, edition: '' };
    // "(Pro)" peels to nothing — fine inside parentheses, the title is outside them.
    if (peeled.edition) edition = peeled.edition;
    return ` ${(peeled.edition ? peeled.rest : ws).join(' ')} `;
  });

  let ws = words(outside);
  if (ws[0] === 'the' && ws.length > 1) ws = ws.slice(1);
  if (!edition) {
    const peeled = peelEdition(ws);
    if (peeled.edition && peeled.rest.length > 0) {
      ws = peeled.rest;
      edition = peeled.edition;
    }
  }
  return { base: ws.join(' '), edition };
}

/** One string per (base, edition) — equal keys mean "the same machine" for tier 2. */
export function machineNameKey(name: string): string {
  const { base, edition } = machineNameParts(name);
  return edition ? `${base} [${edition}]` : base;
}

interface Keyed<T> {
  entry: T;
  name: string;
  lower: string;
  base: string;
  edition: string;
}

// Parsing ~2,300 catalog names per lookup is wasteful; parse each array once.
const keyedCache = new WeakMap<readonly object[], Keyed<any>[]>();
function keyed<T extends { name: string }>(list: readonly T[]): Keyed<T>[] {
  let k = keyedCache.get(list) as Keyed<T>[] | undefined;
  if (!k) {
    k = list.map(entry => ({ entry, name: entry.name, lower: entry.name.toLowerCase(), ...machineNameParts(entry.name) }));
    keyedCache.set(list, k);
  }
  return k;
}

// The candidates, collapsed to distinct names (the catalog lists some titles twice — "Poker Face"
// by Keeney and by Gottlieb — and those are one name for our purposes). Null when not exactly one.
function unique<T>(hits: Keyed<T>[]): Keyed<T> | null {
  if (hits.length === 0) return null;
  const first = hits[0];
  return hits.every(h => h.name === first.name) ? first : null;
}

function isWholeWordPrefix(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer === shorter || longer.startsWith(`${shorter} `);
}

function matchIn<T extends { name: string }>(
  raw: string,
  parts: MachineNameParts,
  list: readonly T[],
  allowPrefix: boolean,
): { hit: Keyed<T>; confidence: CanonicalConfidence } | null {
  const k = keyed(list);
  const lower = raw.toLowerCase();

  const exact = k.find(c => c.lower === lower);
  if (exact) return { hit: exact, confidence: 'exact' };
  if (!parts.base) return null;

  const normalized = unique(k.filter(c => c.base === parts.base && c.edition === parts.edition));
  if (normalized) return { hit: normalized, confidence: 'normalized' };
  // Several candidates share the exact key only when they differ in a way we can't see — stop here.
  if (k.some(c => c.base === parts.base && c.edition === parts.edition)) return null;

  if (!parts.edition) {
    const sameBase = unique(k.filter(c => c.base === parts.base));
    if (sameBase) return { hit: sameBase, confidence: 'normalized' };
    if (k.some(c => c.base === parts.base)) return null; // a multi-edition title needs a human
  }

  if (allowPrefix) {
    const prefix = unique(k.filter(c =>
      c.base !== ''
      && isWholeWordPrefix(parts.base, c.base)
      && !(parts.edition && c.edition && parts.edition !== c.edition)));
    if (prefix) return { hit: prefix, confidence: 'fuzzy' };
  }
  return null;
}

/**
 * Resolves a raw machine name (an AI read, something typed) to a known machine's own spelling, or null.
 * `roster` is a venue's machines (tried first, prefix tier allowed); `catalog` is the Pinball Map
 * catalog. Either may be omitted. Entries come back untouched in `entry`.
 */
export function resolveCanonicalName<T extends { name: string }>(
  raw: string,
  opts: { catalog?: readonly T[] | null; roster?: readonly T[] | null },
): CanonicalMatch<T> | null {
  const name = raw.trim();
  if (!name) return null;
  const parts = machineNameParts(name);

  if (opts.roster && opts.roster.length) {
    const m = matchIn(name, parts, opts.roster, true);
    if (m) return { name: m.hit.name, entry: m.hit.entry, confidence: m.confidence, source: 'roster' };
  }
  if (opts.catalog && opts.catalog.length) {
    const m = matchIn(name, parts, opts.catalog, false);
    if (m) return { name: m.hit.name, entry: m.hit.entry, confidence: m.confidence, source: 'catalog' };
  }
  return null;
}
