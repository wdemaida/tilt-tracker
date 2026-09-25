// Typeahead matching over the Pinball Map machine catalog. Pure (no fetch, no db) so it can be unit
// tested against a fixture list — pinballMap.ts owns the cache and builds the index from it.
//
// The old search was a plain substring filter, so "theater" found nothing because the catalog spells
// it "Theatre of Magic". This matches per token instead: every query token must match some name
// token by prefix, or — for tokens of 4+ chars — within a small edit distance.

/**
 * Search-side normalization: case, diacritics, punctuation, whitespace, and a leading "the".
 * Unlike venueRepair's normalizeMachineName this deliberately KEEPS edition suffixes, so
 * "godzilla pro" still finds "Godzilla (Pro)" and the Pro/Premium/LE variants stay distinguishable
 * in the results list.
 */
export function normalizeForSearch(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Drop apostrophes rather than splitting on them: "Stoker's" → "stokers", not "stoker s".
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  // Only strip "the" when something is left — a bare "the" query shouldn't become empty.
  return s.startsWith('the ') ? s.slice(4) : s;
}

/**
 * Optimal-string-alignment Damerau-Levenshtein distance, bailing out early once every cell in a row
 * exceeds `max` (returns max + 1 in that case). Tokens are short, so this is cheap.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[n];
}

/** Fuzzy budget for a query token: short tokens are prefix-only, otherwise 1 edit (4–6) or 2 (7+). */
function fuzzBudget(len: number): number {
  if (len < 4) return 0;
  return len <= 6 ? 1 : 2;
}

export interface IndexedMachine<T> {
  item: T;
  name: string;
  norm: string;
  tokens: string[];
}

export function buildSearchIndex<T extends { name: string }>(items: T[]): IndexedMachine<T>[] {
  return items.map(item => {
    const norm = normalizeForSearch(item.name);
    return { item, name: item.name, norm, tokens: norm ? norm.split(' ') : [] };
  });
}

/**
 * Best match of one query token against a machine's tokens: 0 = prefix/exact, n>0 = fuzzy with n
 * edits, -1 = no match. Fuzzy requires the first letter to agree (first-letter typos are rare, and
 * this keeps "star" from pulling in "Scar…" / "Tsar…" style junk).
 */
function matchToken(q: string, tokens: string[], isLast: boolean): number {
  let best = -1;
  const budget = fuzzBudget(q.length);
  for (const t of tokens) {
    if (t.startsWith(q)) return 0;
    if (budget === 0 || t[0] !== q[0]) continue;
    let d = editDistance(q, t, budget);
    // The last token may still be mid-typing ("theate" → "theatre"): also compare it against the
    // same-length prefix of the name token. Limited to 5+ chars so short partials stay strict.
    if (isLast && q.length >= 5 && t.length > q.length) {
      d = Math.min(d, editDistance(q, t.slice(0, q.length), budget));
    }
    if (d <= budget && (best === -1 || d < best)) best = d;
  }
  return best;
}

// Rank tiers (lower is better).
const EXACT = 0;
const STARTS_WITH = 1;
const ALL_PREFIX = 2;
const FUZZY = 3;
const SUBSTRING = 4; // old behaviour's safety net: normalized substring anywhere, e.g. "zilla"

export function searchIndex<T>(index: IndexedMachine<T>[], query: string, limit = 10): T[] {
  const nq = normalizeForSearch(query);
  if (!nq) return [];
  const qTokens = nq.split(' ');

  const hits: { tier: number; dist: number; name: string; item: T }[] = [];
  for (const m of index) {
    let tier: number;
    let dist = 0;
    if (m.norm === nq) tier = EXACT;
    else if (m.norm.startsWith(nq)) tier = STARTS_WITH;
    else {
      let ok = true;
      for (let i = 0; i < qTokens.length; i++) {
        const d = matchToken(qTokens[i], m.tokens, i === qTokens.length - 1);
        if (d < 0) { ok = false; break; }
        dist += d;
      }
      if (ok) tier = dist === 0 ? ALL_PREFIX : FUZZY;
      else if (nq.length >= 3 && m.norm.includes(nq)) { tier = SUBSTRING; dist = 0; }
      else continue;
    }
    hits.push({ tier, dist, name: m.name, item: m.item });
  }

  hits.sort((a, b) => a.tier - b.tier || a.dist - b.dist || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map(h => h.item);
}
