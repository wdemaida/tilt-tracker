// "Last Resort" areas (feature/last-resort) — the pure half: ZIP/radius rules, the shared cache cell,
// distances, and matching two players' areas. No database, no network (challengeArea.ts loads,
// pmAreaCache.ts fetches).
//
// A Last Resort area = a US ZIP + a radius: "anywhere within N miles I'd still drive to for a
// challenge". Matchmaking only looks at it when the viewer taps Expand search on the create form.
//
// THE CELL. One Pinball Map request (`closest_by_lat_lon`, send_all_within_distance, no_details)
// answers every location within `max_distance` of a point, each with its `machine_ids`. Users are
// grouped onto a 0.1° grid: the request is made from the grid point nearest the user's (rounded)
// ZIP centroid, out to AREA_FETCH_RADIUS_MILES, and the result is shared by everyone in that cell.
// Each user's own area is then cut out locally by haversine from their own centroid.
//
// Why 55 miles: the farthest a centroid can be from its grid point is half a cell in each direction,
// 0.05° of latitude (≈ 3.45 mi) and 0.05° of longitude (≤ 3.46 mi, at the equator; less further
// north) — at most ≈ 4.9 mi. The largest radius choice is 50, so 50 + 5 slack covers every choice
// from any point in the cell (areaMatch.test.ts checks it at several latitudes). Pinball Map caps
// max_distance at 800 for no_details requests and sets no result-count cap (pbm
// locations_controller.rb, read 2026-10-02); the Portland recording at 55 mi was 342 locations,
// ~250 KB, under a second.
//
// PRIVACY: a friend's side of a match is a COUNT of spots (plus, in challengeArea.ts, their area's
// city label) — never a venue name, distance, ZIP or coordinate. `matchAreaSides` enforces that by
// construction: the `theirs` half of a match has no field that could carry one.

export const AREA_RADIUS_CHOICES = [5, 10, 15, 20, 30, 50] as const;
export type AreaRadius = (typeof AREA_RADIUS_CHOICES)[number];
export const AREA_MAX_RADIUS_MILES = 50;
/** Grid size for the shared cache cell, in degrees. */
export const AREA_CELL_DEGREES = 0.1;
/** Covers the centroid → grid-point offset (≤ ≈ 4.9 mi, see above). */
export const AREA_CELL_SLACK_MILES = 5;
/** What one cell's Pinball Map request asks for: the largest radius choice plus the cell slack. */
export const AREA_FETCH_RADIUS_MILES = AREA_MAX_RADIUS_MILES + AREA_CELL_SLACK_MILES;
/** Matches returned by one Expand search. */
export const AREA_MATCH_CAP = 10;
/** Nearest spots listed for the viewer's own side of a match. */
export const AREA_SPOTS_SHOWN = 3;

const EARTH_RADIUS_MILES = 3958.7613;

/** A US ZIP: 5 digits, or ZIP+4 (stored as its 5 digits). Null = invalid. */
export function parsePostalCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(raw);
  return m ? m[1] : null;
}

/** One of AREA_RADIUS_CHOICES, or null. */
export function parseRadius(raw: unknown): AreaRadius | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && (AREA_RADIUS_CHOICES as readonly number[]).includes(n) ? (n as AreaRadius) : null;
}

/** A ZIP centroid as stored: 2 decimals (≈ 1 km) — never anything finer. */
export function roundCentroid(lat: number, lng: number): { lat: number; lng: number } {
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
}

export interface AreaCell { key: string; lat: number; lng: number }

/** The grid point nearest (lat, lng) and its cache key ("45.5,-122.7"). */
export function areaCell(lat: number, lng: number): AreaCell {
  const perDegree = Math.round(1 / AREA_CELL_DEGREES); // 10 — integer maths keeps -122.7 exact
  const snap = (v: number) => Math.round(v * perDegree) / perDegree;
  const cLat = snap(lat);
  const cLng = snap(lng);
  // Normalise -0 so the key and the request both read "0.0", not "-0.0".
  const fix = (v: number) => (Object.is(v, -0) ? 0 : v);
  return { key: `${fix(cLat).toFixed(1)},${fix(cLng).toFixed(1)}`, lat: fix(cLat), lng: fix(cLng) };
}

/** Parses a cell key back into its grid point. */
export function cellFromKey(key: string): AreaCell | null {
  const [lat, lng] = key.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { key, lat, lng };
}

export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** One Pinball Map location as cached in pm_area_cache.locations — only what matching needs. */
export interface AreaLocation {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
  lat: number;
  lon: number;
  machineIds: number[];
}

/**
 * Trims a closest_by_lat_lon answer to AreaLocation rows (PM sends lat/lon as decimal strings and a
 * couple of dozen other fields per location). Rows without an id, a name or real coordinates are
 * dropped.
 */
export function trimAreaLocations(raw: unknown[]): AreaLocation[] {
  const out: AreaLocation[] = [];
  for (const r of raw as any[]) {
    const id = Number(r?.id);
    const lat = Number(r?.lat);
    const lon = Number(r?.lon);
    if (!Number.isInteger(id) || id <= 0 || typeof r?.name !== 'string' || !r.name.trim()) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const machineIds = Array.isArray(r.machine_ids)
      ? [...new Set((r.machine_ids as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0))]
      : [];
    out.push({ id, name: r.name.trim(), city: r.city ?? null, state: r.state ?? null, lat, lon, machineIds });
  }
  return out;
}

/** A Pinball Map location inside someone's area, with its distance from their centroid. */
export interface Spot {
  pmLocationId: number;
  name: string;
  city: string | null;
  /** Miles from the area's centroid, 1 decimal. */
  miles: number;
}

/**
 * The machines inside one area: PM machine id → the spots that have it, nearest first. `center` is
 * the user's own (rounded) centroid, never the cell's grid point.
 */
export function areaMachines(locs: AreaLocation[], center: { lat: number; lng: number }, radiusMiles: number): Map<number, Spot[]> {
  const by = new Map<number, Spot[]>();
  for (const l of locs) {
    const miles = haversineMiles(center, { lat: l.lat, lng: l.lon });
    if (miles > radiusMiles) continue;
    const spot: Spot = { pmLocationId: l.id, name: l.name, city: l.city, miles: Math.round(miles * 10) / 10 };
    for (const id of l.machineIds) (by.get(id) ?? by.set(id, []).get(id)!).push(spot);
  }
  for (const spots of by.values()) spots.sort((a, b) => a.miles - b.miles || a.pmLocationId - b.pmLocationId);
  return by;
}

// ── matching ──────────────────────────────────────────────────────────────────

/** A player's side, in Pinball Map machine ids: their Last Resort area, or their reach (levels). */
export type MatchSide =
  | { kind: 'area'; spots: Map<number, Spot[]> }
  | { kind: 'reach'; levels: Map<number, 1 | 2 | 3> };

/** The viewer's side of one match: their own spots (names + miles are theirs to see), or a reach level. */
export type MineHalf =
  | { kind: 'area'; spotCount: number; spots: Spot[] }
  | { kind: 'reach'; level: 1 | 2 | 3 };

/** The friend's side: a count only, or a reach level — never a name, distance or place. */
export type TheirsHalf =
  | { kind: 'area'; spotCount: number }
  | { kind: 'reach'; level: 1 | 2 | 3 };

export interface RawAreaMatch {
  pmMachineId: number;
  mine: MineHalf;
  theirs: TheirsHalf;
  /** In either player's picks / scores, or the friend's reach — ranked first. */
  familiar: boolean;
}

const sideCount = (s: MatchSide, id: number) => (s.kind === 'area' ? s.spots.get(id)?.length ?? 0 : s.levels.has(id) ? 1 : 0);

/**
 * Exact-model matches between the viewer's side and the friend's side (at least one must be an
 * area — two reaches are just the ordinary recommendations). Ranked: familiar first (`familiar` = PM
 * ids in either player's picks / scores or the friend's reach), then the most spots near the
 * scarcer side (min of the two counts; a reach side counts 1), then the viewer's nearest spot, then
 * PM id. Capped at `cap`.
 */
export function matchAreaSides(mine: MatchSide, theirs: MatchSide, familiar: Set<number>, cap = AREA_MATCH_CAP): RawAreaMatch[] {
  if (mine.kind !== 'area' && theirs.kind !== 'area') return [];
  const mineIds = mine.kind === 'area' ? [...mine.spots.keys()] : [...mine.levels.keys()];
  const shared = mineIds.filter(id => sideCount(theirs, id) > 0);
  const nearest = (id: number) => (mine.kind === 'area' ? mine.spots.get(id)?.[0]?.miles ?? Infinity : Infinity);
  const ranked = shared.sort((a, b) =>
    Number(familiar.has(b)) - Number(familiar.has(a))
    || Math.min(sideCount(mine, b), sideCount(theirs, b)) - Math.min(sideCount(mine, a), sideCount(theirs, a))
    || nearest(a) - nearest(b)
    || a - b);
  return ranked.slice(0, cap).map(id => ({
    pmMachineId: id,
    mine: mine.kind === 'area'
      ? { kind: 'area', spotCount: mine.spots.get(id)!.length, spots: mine.spots.get(id)!.slice(0, AREA_SPOTS_SHOWN) }
      : { kind: 'reach', level: mine.levels.get(id)! },
    theirs: theirs.kind === 'area'
      ? { kind: 'area', spotCount: theirs.spots.get(id)!.length }
      : { kind: 'reach', level: theirs.levels.get(id)! },
    familiar: familiar.has(id),
  }));
}
