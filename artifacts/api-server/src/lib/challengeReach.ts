import {
  db, users, machines, venues, scores, venueMachineHistory, venueInventory, pmLocationCache,
  userChallengeMachines, userChallengeVenues, friendships,
} from '@workspace/db';
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { canSeeVenueActivity, visibleScoreSql, type Viewer } from './venueActivity.js';
import { isPrivateVenue } from './venueAddress.js';
import { matchScore, queryLength, MIN_QUERY_CHARS } from './venueSearch.js';
import { acceptedPairSql } from './friendships.js';
import { countVisits } from './statsCalc.js';
import { mergeRecommendations, rankRecentPlay, reachIds, type Reach, type ReachItem, type Recommendation } from './challengeRecs.js';
import { ChallengeError, type UserRef } from './challenges.js';
import type { PmLocationMachineXref } from './pinballmapApi.js';

// Which machines a player can reach, as a given viewer may see it (feature/challenge-recs) — the
// three levels challengeRecs.ts merges into the create form's "Recommended for @friend" block, plus
// the "Challenge me" preferences they come from (GET/PUT /api/me/challenge-prefs).
//
// ZERO PINBALL MAP CALLS. A challenge location's roster comes from, in order:
//   1. a public venue's cached Pinball Map roster — pm_location_cache joined directly, at any age.
//      Never getVenueRoster / pmClient: a stale roster is fine for a recommendation, and a page view
//      must not be able to trigger a fetch. (Same source order as venueOptions() in challenges.ts.)
//   2. no cached roster → venue_machine_history rows not marked removed;
//   3. a private venue → its owner-managed venue_inventory (never venue_machine_history: that's
//      Pinball Map-derived and only served past canSeeVenueLinkage).
// Roster names map to existing `machines` rows case-insensitively; names TiltTrack doesn't have
// are skipped (no rows are minted here). Worst case: 0 Pinball Map calls a day.
//
// PRIVACY:
//  - A private venue (residence or restricted tier) in someone's challenge locations only
//    contributes machines when that person owns it, or when the viewer may see its activity
//    (canSeeVenueActivity). Its machines never carry its name: "at home" when the owner is the
//    player, otherwise no label. Public venues carry their name.
//  - Level 3 (recent play) reads scores through visibleScoreSql(viewer), and carries no venue.
//  - Recommendations are for accepted friends only (403 not_friends otherwise).

type AppUser = { id: number; username: string; displayName: string; role: string };

export const MAX_CHALLENGE_MACHINES = 3;
/** A sanity cap on hand-picked challenge locations; seeding adds at most 5 + the user's residence. */
export const MAX_CHALLENGE_VENUES = 20;
/** Level 3 looks back this far. */
export const RECENT_PLAY_DAYS = 60;
/** Seeding / suggestions: venues with at least this many visits in the last SEED_WINDOW_DAYS. */
export const SEED_MIN_VISITS = 2;
export const SEED_WINDOW_DAYS = 180;
export const SEED_MAX_VENUES = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

const machineCols = { machineId: machines.id, name: machines.name, variant: machines.variant, imageUrl: machines.imageUrl };
type MachineRow = { machineId: number; name: string; variant: string | null; imageUrl: string | null };

// ── the three levels ─────────────────────────────────────────────────────────

/** Level 1: "Challenge me on", in the user's own order. */
export async function challengeMachines(userId: number): Promise<MachineRow[]> {
  return db.select(machineCols).from(userChallengeMachines)
    .innerJoin(machines, eq(machines.id, userChallengeMachines.machineId))
    .where(eq(userChallengeMachines.userId, userId))
    .orderBy(asc(userChallengeMachines.position), asc(userChallengeMachines.machineId));
}

interface LocationRow {
  id: number; name: string; ownerId: number | null; isResidence: boolean;
  privacyTier: 'full' | 'city_state' | 'hidden'; showMachinesAndScores: boolean; pinballMapId: number | null;
  source: 'auto' | 'added';
}

async function challengeLocations(userId: number): Promise<LocationRow[]> {
  return db.select({
    id: venues.id, name: venues.name, ownerId: venues.ownerId, isResidence: venues.isResidence,
    privacyTier: venues.privacyTier, showMachinesAndScores: venues.showMachinesAndScores, pinballMapId: venues.pinballMapId,
    source: userChallengeVenues.source,
  }).from(userChallengeVenues)
    .innerJoin(venues, eq(venues.id, userChallengeVenues.venueId))
    .where(eq(userChallengeVenues.userId, userId))
    .orderBy(asc(userChallengeVenues.createdAt), asc(userChallengeVenues.venueId));
}

/** What a machine at this venue is labelled for the viewer. See PRIVACY above. */
function locationLabel(v: LocationRow, playerId: number): string | null {
  if (!isPrivateVenue(v)) return v.name;
  return v.ownerId === playerId ? 'at home' : null;
}

/** Level 2: the machines at `playerId`'s challenge locations that `viewer` may know about. */
async function locationMachines(playerId: number, viewer: Viewer): Promise<ReachItem[]> {
  const locs = (await challengeLocations(playerId))
    .filter(v => !isPrivateVenue(v) || v.ownerId === playerId || canSeeVenueActivity(v, viewer));
  if (!locs.length) return [];
  const publicLocs = locs.filter(v => !isPrivateVenue(v));
  const privateIds = locs.filter(v => isPrivateVenue(v)).map(v => v.id);

  // 1. cached Pinball Map rosters, any age — a direct read of pm_location_cache, never a fetch.
  const pmLinked = publicLocs.filter(v => v.pinballMapId != null).map(v => v.id);
  const cached = pmLinked.length ? await db.select({ id: venues.id, roster: pmLocationCache.machines }).from(venues)
    .innerJoin(pmLocationCache, eq(pmLocationCache.pmLocationId, venues.pinballMapId))
    .where(inArray(venues.id, pmLinked)) : [];
  const rosterNames = new Map<number, string[]>();
  for (const c of cached) {
    rosterNames.set(c.id, (c.roster as PmLocationMachineXref[] ?? [])
      .map(x => String(x?.machine?.name ?? '').trim()).filter(Boolean));
  }
  const lowerNames = [...new Set([...rosterNames.values()].flat().map(n => n.toLowerCase()))];
  const byName = new Map<string, MachineRow>();
  if (lowerNames.length) {
    const rows = await db.select(machineCols).from(machines).where(inArray(sql`lower(${machines.name})`, lowerNames));
    for (const r of rows) byName.set(r.name.toLowerCase(), r);
  }

  // 2. machine history for public venues without a cached roster.
  const historyIds = publicLocs.filter(v => !rosterNames.has(v.id)).map(v => v.id);
  const history = historyIds.length ? await db.select({ venueId: venueMachineHistory.venueId, ...machineCols }).from(venueMachineHistory)
    .innerJoin(machines, eq(machines.id, venueMachineHistory.machineId))
    .where(and(inArray(venueMachineHistory.venueId, historyIds), isNull(venueMachineHistory.removedAt)))
    .orderBy(asc(machines.name)) : [];

  // 3. owner-managed inventory for private venues (the rows getInventory() reads, batched).
  const inventory = privateIds.length ? await db.select({ venueId: venueInventory.venueId, ...machineCols }).from(venueInventory)
    .innerJoin(machines, eq(machines.id, venueInventory.machineId))
    .where(and(inArray(venueInventory.venueId, privateIds), isNull(venueInventory.removedAt)))
    .orderBy(asc(machines.name)) : [];

  const out: ReachItem[] = [];
  for (const v of locs) {
    const label = locationLabel(v, playerId);
    const here: MachineRow[] = rosterNames.has(v.id)
      ? rosterNames.get(v.id)!.map(n => byName.get(n.toLowerCase())).filter((m): m is MachineRow => !!m)
        .sort((a, b) => a.name.localeCompare(b.name))
      : [...history, ...inventory].filter(r => r.venueId === v.id).map(({ venueId: _v, ...m }) => m);
    for (const m of here) out.push({ ...m, venueLabel: label });
  }
  return out;
}

/** Level 3: machines `playerId` scored on lately, as `viewer` may see those scores. No venue. */
async function recentMachines(playerId: number, viewer: Viewer, now: Date): Promise<ReachItem[]> {
  const rows = await db.select({ ...machineCols, playedAt: scores.playedAt }).from(scores)
    .innerJoin(machines, eq(machines.id, scores.machineId))
    .where(and(eq(scores.userId, playerId), gte(scores.playedAt, new Date(+now - RECENT_PLAY_DAYS * DAY_MS)), visibleScoreSql(viewer)));
  const per = new Map<number, { m: MachineRow; times: number[] }>();
  for (const { playedAt, ...m } of rows) {
    const e = per.get(m.machineId) ?? { m, times: [] };
    e.times.push(+playedAt);
    per.set(m.machineId, e);
  }
  const ranked = rankRecentPlay([...per.values()].map(({ m, times }) => {
    const sorted = times.sort((a, b) => a - b);
    return { m, visits: countVisits(sorted), lastPlayedAt: new Date(sorted[sorted.length - 1]) };
  }));
  return ranked.map(r => r.m);
}

/** All three levels of `player`'s reach, as `viewer` may see it. */
export async function reachOf(playerId: number, viewer: Viewer, now = new Date()): Promise<Reach> {
  const [level1, level2, level3] = await Promise.all([
    challengeMachines(playerId), locationMachines(playerId, viewer), recentMachines(playerId, viewer, now),
  ]);
  return { level1, level2, level3 };
}

// ── seeding + suggestions ────────────────────────────────────────────────────

/**
 * Venue ids a user plausibly can reach: up to 5 venues with ≥ 2 visits in the last 180 days (most
 * visits first, then most recent), plus their own residence when it has an inventory.
 */
export async function venueCandidates(userId: number, now = new Date()): Promise<number[]> {
  const rows = await db.select({ venueId: scores.venueId, playedAt: scores.playedAt }).from(scores)
    .where(and(eq(scores.userId, userId), isNotNull(scores.venueId), gte(scores.playedAt, new Date(+now - SEED_WINDOW_DAYS * DAY_MS))));
  const per = new Map<number, number[]>();
  for (const r of rows) (per.get(r.venueId!) ?? per.set(r.venueId!, []).get(r.venueId!)!).push(+r.playedAt);
  const visited = rankRecentPlay([...per.entries()].map(([venueId, times]) => {
    const sorted = times.sort((a, b) => a - b);
    return { venueId, visits: countVisits(sorted), lastPlayedAt: new Date(sorted[sorted.length - 1]) };
  })).filter(v => v.visits >= SEED_MIN_VISITS).slice(0, SEED_MAX_VENUES).map(v => v.venueId);

  const homes = await db.select({ id: venues.id }).from(venues).where(and(
    eq(venues.ownerId, userId), eq(venues.isResidence, true),
    sql`EXISTS (SELECT 1 FROM venue_inventory vi WHERE vi.venue_id = ${venues.id} AND vi.removed_at IS NULL)`,
  ));
  return [...new Set([...visited, ...homes.map(h => h.id)])];
}

/**
 * Seed a user's challenge locations from their history, once (users.challenge_venues_seeded_at).
 * Runs when the prefs are first read — by the user, or by a friend's recommendations request. After
 * that a removed venue stays removed; new candidates only appear as suggestions.
 */
export async function ensureSeeded(userId: number, now = new Date()): Promise<void> {
  await db.transaction(async tx => {
    const claimed = await tx.update(users).set({ challengeVenuesSeededAt: now })
      .where(and(eq(users.id, userId), isNull(users.challengeVenuesSeededAt)))
      .returning({ id: users.id });
    if (!claimed.length) return;
    const ids = await venueCandidates(userId, now);
    if (ids.length) {
      await tx.insert(userChallengeVenues).values(ids.map(venueId => ({ userId, venueId, source: 'auto' as const }))).onConflictDoNothing();
    }
  });
}

/** Candidates the user hasn't got in their list (any more). */
export async function suggestVenues(userId: number, now = new Date()): Promise<number[]> {
  const have = new Set((await db.select({ id: userChallengeVenues.venueId }).from(userChallengeVenues)
    .where(eq(userChallengeVenues.userId, userId))).map(r => r.id));
  return (await venueCandidates(userId, now)).filter(id => !have.has(id));
}

// ── preferences (GET / PUT /api/me/challenge-prefs) ──────────────────────────

export interface PrefMachine { id: number; name: string; variant: string | null; imageUrl: string | null; manufacturer: string | null; year: number | null }
/** A venue in your own list. Only ever shown to you: you scored there, own it, or it's public. */
export interface PrefVenue { id: number; name: string; isPrivate: boolean; isHome: boolean; source?: 'auto' | 'added' }
export interface ChallengePrefs {
  machines: PrefMachine[];
  venues: PrefVenue[];
  suggestions: PrefVenue[];
  limits: { machines: number; venues: number };
}

async function venueChips(userId: number, ids: number[]): Promise<PrefVenue[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: venues.id, name: venues.name, ownerId: venues.ownerId, isResidence: venues.isResidence, privacyTier: venues.privacyTier })
    .from(venues).where(inArray(venues.id, ids));
  const by = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => by.get(id)).filter((r): r is NonNullable<typeof r> => !!r)
    .map(r => ({ id: r.id, name: r.name, isPrivate: isPrivateVenue(r), isHome: r.ownerId === userId && r.isResidence }));
}

export async function getChallengePrefs(userId: number, now = new Date()): Promise<ChallengePrefs> {
  await ensureSeeded(userId, now);
  const ms = await db.select({
    id: machines.id, name: machines.name, variant: machines.variant, imageUrl: machines.imageUrl,
    manufacturer: machines.manufacturer, year: machines.year,
  }).from(userChallengeMachines)
    .innerJoin(machines, eq(machines.id, userChallengeMachines.machineId))
    .where(eq(userChallengeMachines.userId, userId))
    .orderBy(asc(userChallengeMachines.position), asc(userChallengeMachines.machineId));
  const locs = await challengeLocations(userId);
  const listed = await venueChips(userId, locs.map(l => l.id));
  const sources = new Map(locs.map(l => [l.id, l.source]));
  return {
    machines: ms,
    venues: listed.map(v => ({ ...v, source: sources.get(v.id) })),
    suggestions: await venueChips(userId, await suggestVenues(userId, now)),
    limits: { machines: MAX_CHALLENGE_MACHINES, venues: MAX_CHALLENGE_VENUES },
  };
}

function idList(raw: unknown, field: string): number[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ChallengeError(400, 'invalid_prefs', `${field} must be an array of ids`);
  const ids = raw.map(Number);
  if (ids.some(n => !Number.isInteger(n) || n <= 0)) throw new ChallengeError(400, 'invalid_prefs', `${field} must be an array of ids`);
  return [...new Set(ids)];
}

/**
 * PUT /api/me/challenge-prefs {machineIds?, venueIds?} — replaces whichever list is sent (an omitted
 * field is left alone). Machines: at most 3, and they must exist. Venues: must exist and be one you
 * may name — a public venue, your own, or one you've scored at (the same set suggestions come from),
 * so an id can't be used to learn a stranger's private venue name. Returns the new prefs.
 */
export async function updateChallengePrefs(userId: number, body: Record<string, unknown>, now = new Date()): Promise<{ prefs: ChallengePrefs; changed: { machineIds?: number[]; venueIds?: number[] } }> {
  const hasMachines = body.machineIds !== undefined;
  const hasVenues = body.venueIds !== undefined;
  const machineIds = idList(body.machineIds, 'machineIds');
  const venueIds = idList(body.venueIds, 'venueIds');
  if (machineIds.length > MAX_CHALLENGE_MACHINES) {
    throw new ChallengeError(400, 'too_many_machines', `Pick at most ${MAX_CHALLENGE_MACHINES} machines`);
  }
  if (venueIds.length > MAX_CHALLENGE_VENUES) {
    throw new ChallengeError(400, 'too_many_venues', `Pick at most ${MAX_CHALLENGE_VENUES} venues`);
  }
  if (machineIds.length) {
    const found = await db.select({ id: machines.id }).from(machines).where(inArray(machines.id, machineIds));
    if (found.length !== machineIds.length) throw new ChallengeError(400, 'machine_not_found', 'One of those machines isn’t on TiltTrack');
  }
  if (venueIds.length) {
    const found = await db.select({ id: venues.id }).from(venues).where(and(
      inArray(venues.id, venueIds),
      sql`((${venues.isResidence} = false AND ${venues.privacyTier} = 'full') OR ${venues.ownerId} = ${userId}
        OR EXISTS (SELECT 1 FROM scores s WHERE s.venue_id = ${venues.id} AND s.user_id = ${userId}))`,
    ));
    if (found.length !== venueIds.length) throw new ChallengeError(400, 'venue_not_found', 'One of those venues isn’t on TiltTrack');
  }

  await ensureSeeded(userId, now);
  await db.transaction(async tx => {
    if (hasMachines) {
      await tx.delete(userChallengeMachines).where(eq(userChallengeMachines.userId, userId));
      if (machineIds.length) {
        await tx.insert(userChallengeMachines).values(machineIds.map((machineId, position) => ({ userId, machineId, position })));
      }
    }
    if (hasVenues) {
      const keep = venueIds.length ? sql`${userChallengeVenues.venueId} NOT IN (${sql.join(venueIds.map(i => sql`${i}`), sql`, `)})` : sql`true`;
      await tx.delete(userChallengeVenues).where(and(eq(userChallengeVenues.userId, userId), keep));
      if (venueIds.length) {
        // Kept rows keep their source; new ones are hand-picked.
        await tx.insert(userChallengeVenues).values(venueIds.map(venueId => ({ userId, venueId, source: 'added' as const }))).onConflictDoNothing();
      }
    }
  });
  return {
    prefs: await getChallengePrefs(userId, now),
    changed: { ...(hasMachines ? { machineIds } : {}), ...(hasVenues ? { venueIds } : {}) },
  };
}

/** A venue search hit for the challenge-locations editor. */
export interface ChallengeVenueHit { id: number; name: string; city: string | null; state: string | null; isPrivate: boolean; isHome: boolean }
export const CHALLENGE_VENUE_SEARCH_LIMIT = 8;

/**
 * GET /api/me/challenge-venue-search?q= — any TiltTrack venue you could add as a challenge location,
 * matched on name (or address) words like the Add Score search. Reads our own venues table only: no
 * Pinball Map, no HERE. Only venues PUT would accept — public, your own, or one you've scored at —
 * so a stranger's private venue never appears. City/state only for a public venue or your own; a
 * private venue you merely scored at shows its name alone (as its chip already does). Venues already
 * in your list are left out.
 */
export async function searchChallengeVenues(userId: number, q: string): Promise<ChallengeVenueHit[]> {
  if (queryLength(q) < MIN_QUERY_CHARS) return [];
  const rows = await db.select({
    id: venues.id, name: venues.name, address: venues.address, city: venues.city, state: venues.state,
    ownerId: venues.ownerId, isResidence: venues.isResidence, privacyTier: venues.privacyTier,
  }).from(venues).where(and(
    sql`((${venues.isResidence} = false AND ${venues.privacyTier} = 'full') OR ${venues.ownerId} = ${userId}
      OR EXISTS (SELECT 1 FROM scores s WHERE s.venue_id = ${venues.id} AND s.user_id = ${userId}))`,
    sql`NOT EXISTS (SELECT 1 FROM user_challenge_venues ucv WHERE ucv.user_id = ${userId} AND ucv.venue_id = ${venues.id})`,
  ));
  return rows
    .map(v => {
      const priv = isPrivateVenue(v);
      const own = v.ownerId === userId;
      // Match a private venue on its name only — its address is not ours to search by.
      return { v, priv, own, score: matchScore(q, v.name, priv && !own ? null : v.address) };
    })
    .filter((r): r is typeof r & { score: number } => r.score != null)
    .sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name))
    .slice(0, CHALLENGE_VENUE_SEARCH_LIMIT)
    .map(({ v, priv, own }) => ({
      id: v.id, name: v.name,
      city: !priv || own ? v.city : null, state: !priv || own ? v.state : null,
      isPrivate: priv, isHome: own && v.isResidence,
    }));
}

// ── recommendations ──────────────────────────────────────────────────────────

async function areFriends(a: number, b: number): Promise<boolean> {
  const [pair] = await db.select({ id: friendships.id }).from(friendships).where(acceptedPairSql(a, b)).limit(1);
  return !!pair;
}

/** GET /api/users/:username's `challengeMe`: level 1 only, and only for an accepted friend. */
export async function challengeMeFor(targetId: number, viewerId: number | null | undefined): Promise<MachineRow[] | null> {
  if (!viewerId || viewerId === targetId || !(await areFriends(viewerId, targetId))) return null;
  return challengeMachines(targetId);
}

export interface RecommendationsView {
  user: UserRef;
  recommendations: Recommendation[];
}

/** GET /api/challenges/recommendations/:username — friends only (403 not_friends). */
export async function recommendationsFor(viewer: AppUser, username: string, now = new Date()): Promise<RecommendationsView> {
  const [target] = await db.select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users).where(eq(users.username, username)).limit(1);
  if (!target) throw new ChallengeError(404, 'user_not_found', 'User not found');
  if (target.id === viewer.id) throw new ChallengeError(400, 'cannot_challenge_self', 'You can’t challenge yourself');
  if (!(await areFriends(viewer.id, target.id))) throw new ChallengeError(403, 'not_friends', 'You can only challenge your friends');

  await Promise.all([ensureSeeded(target.id, now), ensureSeeded(viewer.id, now)]);
  const v: Viewer = { id: viewer.id, role: viewer.role };
  const [theirs, mine] = await Promise.all([reachOf(target.id, v, now), reachOf(viewer.id, v, now)]);
  const ids = [...reachIds(theirs)];
  const best = new Map<number, number>();
  if (ids.length) {
    const rows = await db.select({ machineId: scores.machineId, best: sql<number>`max(${scores.score})::float8` }).from(scores)
      .where(and(eq(scores.userId, viewer.id), inArray(scores.machineId, ids)))
      .groupBy(scores.machineId);
    for (const r of rows) best.set(r.machineId, Math.round(Number(r.best)));
  }
  return { user: target, recommendations: mergeRecommendations(theirs, reachIds(mine), best) };
}
