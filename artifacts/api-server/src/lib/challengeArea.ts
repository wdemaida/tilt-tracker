import { db, machines, scores, userChallengeAreas } from '@workspace/db';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { ChallengeError, type UserRef } from './challenges.js';
import { ensureSeeded, reachOf, recTarget, viewerBests } from './challengeReach.js';
import type { Reach } from './challengeRecs.js';
import { getArea as defaultGetArea, type AreaResult } from './pmAreaCache.js';
import { getStoredCatalog as defaultStoredCatalog, catalogIndex, type PinballMachine } from './pinballMap.js';
import { upsertMachineByName } from './machineUpsert.js';
import { geocodePostalCode as defaultGeocode } from './hereApi.js';
import { TtlCache } from './nearbyLookup.js';
import { pmLocationUrl } from './pinballmapApi.js';
import type { Viewer } from './venueActivity.js';
import {
  AREA_RADIUS_CHOICES, areaCell, areaMachines, cellFromKey, matchAreaSides, parsePostalCode, parseRadius, roundCentroid,
  type MatchSide, type MineHalf, type Spot, type TheirsHalf,
} from './areaMatch.js';

// Last Resort areas + "Expand search" (feature/last-resort) — the DB half. Pure rules live in
// areaMatch.ts; Pinball Map is only ever reached through pmAreaCache.ts (one request per 0.1° cell
// per 7 days, charged to the Expand limits in pmGuards.ts). challengeReach.ts — the everyday
// recommendations — still imports none of this and makes zero Pinball Map calls.
//
// PRIVACY:
//  - The ZIP, centroid and radius are owner-only (GET/PUT/DELETE /api/me/challenge-area). The
//    browser never gets coordinates — not even its own.
//  - A friend's side of an Expand match is a spot COUNT plus their area's city label ("2 spots near
//    @collasta, Portland, OR") — never a venue name, a distance, their ZIP or a coordinate.
//  - Recommendations are friends only (recTarget: 403 not_friends), and Expand is single-friend.

type AppUser = { id: number; username: string; displayName: string; role: string };

// ── the owner's own area ─────────────────────────────────────────────────────

export interface ChallengeAreaView {
  postalCode: string;
  radiusMiles: number;
  /** "Dennis, MA" — the ZIP's city. */
  label: string | null;
  updatedAt: string;
}

export interface ChallengeAreaResponse {
  area: ChallengeAreaView | null;
  radiusChoices: number[];
}

async function areaRow(userId: number) {
  const [row] = await db.select().from(userChallengeAreas).where(eq(userChallengeAreas.userId, userId)).limit(1);
  return row ?? null;
}

const toView = (row: NonNullable<Awaited<ReturnType<typeof areaRow>>>): ChallengeAreaView => ({
  postalCode: row.postalCode, radiusMiles: row.radiusMiles, label: row.placeLabel, updatedAt: row.updatedAt.toISOString(),
});

/** GET /api/me/challenge-area — your own area (or null) and the radius choices. */
export async function getChallengeArea(userId: number): Promise<ChallengeAreaResponse> {
  const row = await areaRow(userId);
  return { area: row ? toView(row) : null, radiusChoices: [...AREA_RADIUS_CHOICES] };
}

export interface SetAreaDeps {
  geocode?: typeof defaultGeocode;
  /** Consulted only when the ZIP has to be geocoded (a new ZIP) — return false to refuse (rate limit). */
  allowGeocode?: () => boolean;
}

/**
 * PUT /api/me/challenge-area {postalCode, radiusMiles}. A new ZIP costs one HERE geocode (never
 * Pinball Map); changing only the radius costs nothing. 400 invalid_postal_code / invalid_radius,
 * 422 postal_code_not_found, 429 rate_limited, 503 geocode_unavailable.
 */
export async function setChallengeArea(userId: number, body: Record<string, unknown>, deps: SetAreaDeps = {}): Promise<{ response: ChallengeAreaResponse; geocoded: boolean }> {
  const postalCode = parsePostalCode(body.postalCode);
  if (!postalCode) throw new ChallengeError(400, 'invalid_postal_code', 'Enter a 5-digit US ZIP code');
  const radiusMiles = parseRadius(body.radiusMiles);
  if (radiusMiles == null) throw new ChallengeError(400, 'invalid_radius', `Pick a radius of ${AREA_RADIUS_CHOICES.join(', ')} miles`);

  const existing = await areaRow(userId);
  let point: { lat: number; lng: number; label: string | null };
  let geocoded = false;
  if (existing && existing.postalCode === postalCode) {
    point = { lat: existing.lat, lng: existing.lng, label: existing.placeLabel };
  } else {
    if (deps.allowGeocode && !deps.allowGeocode()) {
      throw new ChallengeError(429, 'rate_limited', 'Too many ZIP code changes today — try again tomorrow');
    }
    const found = await (deps.geocode ?? defaultGeocode)(postalCode);
    geocoded = true;
    if (found.status === 'not_found') throw new ChallengeError(422, 'postal_code_not_found', 'That ZIP code wasn’t found');
    if (found.status !== 'ok') throw new ChallengeError(503, 'geocode_unavailable', 'Couldn’t look up that ZIP code just now — try again in a minute');
    const c = roundCentroid(found.point.lat, found.point.lng);
    point = { ...c, label: [found.point.city, found.point.state].filter(Boolean).join(', ') || null };
  }
  const values = {
    postalCode, country: 'US', lat: point.lat, lng: point.lng, placeLabel: point.label, radiusMiles,
    cellKey: areaCell(point.lat, point.lng).key, updatedAt: new Date(),
  };
  await db.insert(userChallengeAreas).values({ userId, ...values })
    .onConflictDoUpdate({ target: userChallengeAreas.userId, set: values });
  return { response: await getChallengeArea(userId), geocoded };
}

/** DELETE /api/me/challenge-area. True when there was one. */
export async function clearChallengeArea(userId: number): Promise<boolean> {
  const gone = await db.delete(userChallengeAreas).where(eq(userChallengeAreas.userId, userId)).returning({ id: userChallengeAreas.userId });
  return gone.length > 0;
}

// ── Expand search ────────────────────────────────────────────────────────────

/** The viewer's side of a match, with Pinball Map attribution links on their own spots. */
export type MineHalfView =
  | { kind: 'area'; spotCount: number; spots: Array<Spot & { url: string }> }
  | { kind: 'reach'; level: 1 | 2 | 3 };

export interface AreaMatchView {
  /** The TiltTrack machine, or null when TiltTrack has no row for it yet (POST …/expand/machine makes one). */
  machineId: number | null;
  pmMachineId: number;
  name: string;
  manufacturer: string | null;
  year: number | null;
  imageUrl: string | null;
  viewerBest?: number;
  mine: MineHalfView;
  theirs: TheirsHalf;
}

export type AreaStatus = 'ok' | 'none' | 'unavailable';

export interface ExpandView {
  user: UserRef;
  matches: AreaMatchView[];
  areas: { mine: AreaStatus; theirs: AreaStatus };
  /** The friend's area city ("Portland, OR"), only when their area was used. */
  theirPlace: string | null;
  /** When the oldest Pinball Map data used was fetched (ISO), null when none was used. */
  asOf: string | null;
  /** Some of it is past its 7-day TTL (Pinball Map failed or the limit refused a refresh). */
  stale: boolean;
}

export interface ExpandDeps {
  getArea?: typeof defaultGetArea;
  storedCatalog?: () => Promise<PinballMachine[] | null>;
  /** Charged per cell that's about to go to Pinball Map live (pmGuards.takeAreaLive in the route). */
  allowLive?: () => boolean;
  now?: Date;
}

// PM machine ids an Expand search just returned to this user — the only ids POST …/expand/machine
// will turn into a TiltTrack machine row. 30 minutes, per process (same as pmGuards' allowlists).
const OFFERED_TTL_MS = 30 * 60_000;
const offered = new TtlCache<true>(OFFERED_TTL_MS, 20_000);
setInterval(() => offered.sweep(), 10 * 60_000).unref();
const offerKey = (userId: number, pmMachineId: number) => `${userId}:${pmMachineId}`;

/** PM catalog → id lookups: by lowercased name (catalogIndex) and by exact OPDB id. */
function catalogLookups(catalog: PinballMachine[]) {
  const byId = new Map(catalog.map(m => [m.id, m]));
  const byName = catalogIndex(catalog);
  const byOpdb = new Map<string, PinballMachine>();
  for (const m of catalog) if (m.opdb_id && !byOpdb.has(m.opdb_id)) byOpdb.set(m.opdb_id, m);
  return { byId, byName, byOpdb };
}

/** TiltTrack machine ids → PM machine ids (same exact model: name, else exact OPDB id). */
async function ttToPm(ids: number[], lookups: ReturnType<typeof catalogLookups>): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const rows = await db.select({ id: machines.id, name: machines.name, opdbId: machines.opdbId }).from(machines).where(inArray(machines.id, ids));
  for (const r of rows) {
    const pm = lookups.byName.get(r.name.toLowerCase()) ?? (r.opdbId ? lookups.byOpdb.get(r.opdbId) : undefined);
    if (pm) out.set(r.id, pm.id);
  }
  return out;
}

/** PM machine ids → existing TiltTrack machine rows (name match first, then exact OPDB id). */
async function pmToTt(pmIds: number[], lookups: ReturnType<typeof catalogLookups>) {
  const out = new Map<number, { id: number; name: string; imageUrl: string | null; manufacturer: string | null; year: number | null }>();
  const entries = pmIds.map(id => lookups.byId.get(id)).filter((m): m is PinballMachine => !!m);
  if (!entries.length) return out;
  const names = entries.map(m => m.name.toLowerCase());
  const opdbs = entries.map(m => m.opdb_id).filter((o): o is string => !!o);
  const rows = await db.select({
    id: machines.id, name: machines.name, opdbId: machines.opdbId, imageUrl: machines.imageUrl, manufacturer: machines.manufacturer, year: machines.year,
  }).from(machines).where(or(
    inArray(sql`lower(${machines.name})`, names),
    opdbs.length ? inArray(machines.opdbId, opdbs) : sql`false`,
  ));
  for (const m of entries) {
    const hit = rows.find(r => r.name.toLowerCase() === m.name.toLowerCase()) ?? (m.opdb_id ? rows.find(r => r.opdbId === m.opdb_id) : undefined);
    if (hit) out.set(m.id, { id: hit.id, name: hit.name, imageUrl: hit.imageUrl, manufacturer: hit.manufacturer, year: hit.year });
  }
  return out;
}

/** A reach as PM machine ids → the best (lowest) level, for the given levels. */
function reachLevels(r: Reach, toPm: Map<number, number>, levels: Array<1 | 2 | 3>): Map<number, 1 | 2 | 3> {
  const out = new Map<number, 1 | 2 | 3>();
  const by = { 1: r.level1, 2: r.level2, 3: r.level3 } as const;
  for (const l of levels) {
    for (const m of by[l]) {
      const pm = toPm.get(m.machineId);
      if (pm != null && !out.has(pm)) out.set(pm, l);
    }
  }
  return out;
}

/**
 * POST /api/challenges/recommendations/:username/expand — machines the viewer and this friend could
 * meet on using their Last Resort areas (exact model only). Both areas → the machines in both; one
 * area → that area intersected with the other player's reach (the viewer's levels 1–2, the friend's
 * 1–3). Friends only. At most one Pinball Map request per distinct cell (≤ 2), each only when its
 * cached copy is older than 7 days, and only if `allowLive` agrees.
 */
export async function expandFor(viewer: AppUser, username: string, deps: ExpandDeps = {}): Promise<ExpandView> {
  const now = deps.now ?? new Date();
  const target = await recTarget(viewer, username);
  const [myArea, theirArea] = await Promise.all([areaRow(viewer.id), areaRow(target.id)]);
  const empty = (mine: AreaStatus, theirs: AreaStatus): ExpandView =>
    ({ user: target, matches: [], areas: { mine, theirs }, theirPlace: null, asOf: null, stale: false });
  if (!myArea && !theirArea) return empty('none', 'none');

  const catalog = await (deps.storedCatalog ?? defaultStoredCatalog)();
  if (!catalog?.length) throw new ChallengeError(503, 'catalog_unavailable', 'The machine list isn’t loaded yet — try again in a few minutes');
  const lookups = catalogLookups(catalog);

  // One getArea per distinct cell (two friends in the same cell share one row and one request).
  const getArea = deps.getArea ?? defaultGetArea;
  const cellKeys = [...new Set([myArea?.cellKey, theirArea?.cellKey].filter((k): k is string => !!k))];
  const fetched = new Map<string, AreaResult | null>();
  await Promise.all(cellKeys.map(async key => {
    const cell = cellFromKey(key);
    try {
      fetched.set(key, cell ? await getArea(cell, { allowLive: deps.allowLive }) : null);
    } catch {
      fetched.set(key, null);
    }
  }));
  const areaOf = (row: typeof myArea) => (row ? fetched.get(row.cellKey) ?? null : null);
  const myResult = areaOf(myArea);
  const theirResult = areaOf(theirArea);
  const mineStatus: AreaStatus = !myArea ? 'none' : myResult ? 'ok' : 'unavailable';
  const theirsStatus: AreaStatus = !theirArea ? 'none' : theirResult ? 'ok' : 'unavailable';
  if (mineStatus !== 'ok' && theirsStatus !== 'ok') return empty(mineStatus, theirsStatus);

  // Reaches (our own tables only), for a side without a usable area and for "familiar".
  await Promise.all([ensureSeeded(target.id, now), ensureSeeded(viewer.id, now)]);
  const v: Viewer = { id: viewer.id, role: viewer.role };
  const [theirReach, myReach] = await Promise.all([reachOf(target.id, v, now), reachOf(viewer.id, v, now)]);
  const scored = await db.selectDistinct({ id: scores.machineId }).from(scores).where(eq(scores.userId, viewer.id));
  const ttIds = [...new Set([
    ...[theirReach, myReach].flatMap(r => [...r.level1, ...r.level2, ...r.level3].map(m => m.machineId)),
    ...scored.map(s => s.id),
  ])];
  const toPm = await ttToPm(ttIds, lookups);

  const mine: MatchSide = mineStatus === 'ok'
    ? { kind: 'area', spots: areaMachines(myResult!.locations, { lat: myArea!.lat, lng: myArea!.lng }, myArea!.radiusMiles) }
    : { kind: 'reach', levels: reachLevels(myReach, toPm, [1, 2]) };
  const theirs: MatchSide = theirsStatus === 'ok'
    ? { kind: 'area', spots: areaMachines(theirResult!.locations, { lat: theirArea!.lat, lng: theirArea!.lng }, theirArea!.radiusMiles) }
    : { kind: 'reach', levels: reachLevels(theirReach, toPm, [1, 2, 3]) };
  const familiar = new Set<number>([
    ...reachLevels(theirReach, toPm, [1, 2, 3]).keys(),
    ...reachLevels(myReach, toPm, [1]).keys(),
    ...scored.map(s => toPm.get(s.id)).filter((x): x is number => x != null),
  ]);

  const raw = matchAreaSides(mine, theirs, familiar);
  const existing = await pmToTt(raw.map(m => m.pmMachineId), lookups);
  const best = await viewerBests(viewer.id, [...existing.values()].map(m => m.id));
  const matches: AreaMatchView[] = [];
  for (const m of raw) {
    const cat = lookups.byId.get(m.pmMachineId);
    if (!cat) continue; // not in the stored catalog — nothing to name it by
    const tt = existing.get(m.pmMachineId);
    offered.set(offerKey(viewer.id, m.pmMachineId), true);
    const half: MineHalf = m.mine;
    const view: AreaMatchView = {
      machineId: tt?.id ?? null, pmMachineId: m.pmMachineId,
      name: tt?.name ?? cat.name, manufacturer: tt?.manufacturer ?? cat.manufacturer, year: tt?.year ?? cat.year,
      imageUrl: tt?.imageUrl ?? cat.opdb_img ?? null,
      mine: half.kind === 'area'
        ? { kind: 'area', spotCount: half.spotCount, spots: half.spots.map(s => ({ ...s, url: pmLocationUrl(s.pmLocationId) })) }
        : half,
      // Rebuilt field by field so nothing but the count / level can ever ride along.
      theirs: m.theirs.kind === 'area' ? { kind: 'area', spotCount: m.theirs.spotCount } : { kind: 'reach', level: m.theirs.level },
    };
    if (tt && best.has(tt.id)) view.viewerBest = best.get(tt.id);
    matches.push(view);
  }

  const used = [mineStatus === 'ok' ? myResult : null, theirsStatus === 'ok' ? theirResult : null].filter((r): r is AreaResult => !!r);
  const oldest = used.reduce<Date | null>((min, r) => (!min || r.fetchedAt < min ? r.fetchedAt : min), null);
  return {
    user: target,
    matches,
    areas: { mine: mineStatus, theirs: theirsStatus },
    theirPlace: theirsStatus === 'ok' ? theirArea!.placeLabel : null,
    asOf: oldest ? oldest.toISOString() : null,
    stale: used.some(r => r.stale),
  };
}

/**
 * POST /api/challenges/recommendations/:username/expand/machine {pmMachineId} — the viewer picked an
 * Expand match TiltTrack has no machine row for: make it from the STORED Pinball Map catalog (no
 * request) and return it. Only ids an Expand search returned to this user in the last 30 minutes
 * (404 not_offered otherwise), so this can't mint arbitrary catalog rows.
 */
export async function machineForAreaMatch(viewerId: number, rawPmId: unknown, deps: Pick<ExpandDeps, 'storedCatalog'> = {}) {
  const pmMachineId = Number(rawPmId);
  if (!Number.isInteger(pmMachineId) || pmMachineId <= 0 || !offered.get(offerKey(viewerId, pmMachineId))) {
    throw new ChallengeError(404, 'not_offered', 'Search again — that match has expired');
  }
  const catalog = await (deps.storedCatalog ?? defaultStoredCatalog)();
  const lookups = catalog ? catalogLookups(catalog) : null;
  const entry = lookups?.byId.get(pmMachineId);
  if (!catalog || !lookups || !entry) throw new ChallengeError(503, 'catalog_unavailable', 'The machine list isn’t loaded yet — try again in a few minutes');
  const found = (await pmToTt([pmMachineId], lookups)).get(pmMachineId);
  if (found) return found;
  const row = await upsertMachineByName(entry.name, { catalog });
  return { id: row.id, name: row.name, imageUrl: row.imageUrl, manufacturer: row.manufacturer, year: row.year };
}
