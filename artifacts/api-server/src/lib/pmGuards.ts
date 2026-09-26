// Route-level guards for everything that can reach Pinball Map — the half of the standing rule that
// pmClient can't enforce by itself (see root CLAUDE.md, "Pinball Map API — standing rule"):
//
//  - per-user rate limits on every PM-touching route;
//  - a short-lived per-user allowlist of PM location ids, so `/api/venues/pm-machines/:pmId` only
//    reads ids that are linked to one of our venues or that we just handed this user;
//  - one shared per-cell cache for "PM locations near a point" (pm-match, nearby-venues, the photo
//    GPS path and the repair panel's nearby search all ask the same question);
//  - a 10-minute cache for the repair panel's searches.
//
// All in memory, per process — one Render instance. A restart forgets them, which errs toward
// allowing requests; pmClient's global limiter and breaker still hold regardless.

import type { Response } from 'express';
import { SlidingRateLimiter, TtlCache, coordCellKey, NEARBY_CACHE_TTL_MS, type RateDecision } from './nearbyLookup.js';
import { findNearestPmLocations, type PmLocation } from './pinballmapApi.js';

// ── Rate limits ───────────────────────────────────────────────────────────────────────────────────
/** GET /api/venues/pm-machines/:pmId — a roster read per venue pick in the Add Score wizard. */
export const pmMachinesLimiter = new SlidingRateLimiter([
  { ms: 60_000, max: 30 },
  { ms: 24 * 60 * 60_000, max: 300 },
]);
/** Venue / score repair routes that can reach Pinball Map. Counted only on a cache miss. */
export const repairPmLimiter = new SlidingRateLimiter([{ ms: 60 * 60_000, max: 20 }]);
/** POST /api/challenges with a venue lock — the roster check. Counted only when it would go live. */
export const challengePmLimiter = new SlidingRateLimiter([{ ms: 60 * 60_000, max: 20 }]);
/** POST /api/pinballmap/auth — keyed `u:<userId>` and `ip:<ip>`, both must have room. */
export const pmAuthLimiter = new SlidingRateLimiter([{ ms: 15 * 60_000, max: 5 }]);
/** POST /api/pinballmap/submit-score. PM's own limit is 80 per 2 min per IP — for all of us. */
export const pmSubmitLimiter = new SlidingRateLimiter([{ ms: 60_000, max: 10 }]);

setInterval(() => {
  pmMachinesLimiter.sweep(); repairPmLimiter.sweep(); challengePmLimiter.sweep(); pmAuthLimiter.sweep(); pmSubmitLimiter.sweep();
}, 10 * 60_000).unref();

/** Sends the standard 429 for a refused decision. Returns true when it did. */
export function refuseIfLimited(res: Response, decision: RateDecision, message: string): boolean {
  if (decision.ok) return false;
  res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
  res.status(429).json({ error: message, code: 'rate_limited' });
  return true;
}

// ── Per-user PM id allowlist ──────────────────────────────────────────────────────────────────────
export const PM_ALLOWLIST_TTL_MS = 30 * 60_000;
const allowlist = new TtlCache<true>(PM_ALLOWLIST_TTL_MS, 50_000);
setInterval(() => allowlist.sweep(), 10 * 60_000).unref();

/** Records PM ids we just returned to this user (pm-match, nearby suggestions, repair searches). */
export function allowPmIds(userKey: string | null | undefined, ids: Iterable<number | null | undefined>) {
  if (!userKey) return;
  for (const id of ids) {
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) allowlist.set(`${userKey}:${id}`, true);
  }
}

export function pmIdAllowedFor(userKey: string, id: number): boolean {
  return allowlist.get(`${userKey}:${id}`) === true;
}

// ── Shared "PM locations near a point" cache ─────────────────────────────────────────────────────
// One entry per ~110m cell for 10 minutes, in flight or finished. A failure is remembered for two
// minutes (negative cache) so a burst of taps during a PM outage doesn't each try again — pmClient's
// breaker would refuse them anyway, but this keeps them from even queueing.
const NEARBY_FAILURE_TTL_MS = 2 * 60_000;
const nearbyCells = new TtlCache<Promise<PmLocation[]>>(NEARBY_CACHE_TTL_MS);
const nearbyFailures = new TtlCache<Promise<PmLocation[]>>(NEARBY_FAILURE_TTL_MS);
setInterval(() => { nearbyCells.sweep(); nearbyFailures.sweep(); }, 10 * 60_000).unref();

export function pmLocationsNear(
  lat: number, lng: number,
  fetchNear: (lat: number, lng: number) => Promise<PmLocation[]> = findNearestPmLocations,
): Promise<PmLocation[]> {
  const key = coordCellKey(lat, lng);
  const failed = nearbyFailures.get(key);
  if (failed) return failed;
  const hit = nearbyCells.get(key);
  if (hit) return hit;
  const pending = fetchNear(lat, lng);
  nearbyCells.set(key, pending);
  pending.catch(() => {
    if (nearbyCells.get(key) === pending) nearbyCells.delete(key);
    nearbyFailures.set(key, pending);
  });
  return pending;
}

// ── Repair panel search cache ─────────────────────────────────────────────────────────────────────
/** place-search / pm-candidates results, keyed per (route, venue, query). 10 minutes. */
export const repairSearchCache = new TtlCache<unknown>(10 * 60_000, 2000);
setInterval(() => repairSearchCache.sweep(), 10 * 60_000).unref();
