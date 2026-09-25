// Which Pinball Map location a venue (a HERE place, or a TiltTrack venue) *is*.
//
// One rule, shared by every path that attaches a Pinball Map id automatically:
//  - the photo-GPS / "Use my current location" suggestions (`suggestVenuesNear()` in upload.ts),
//  - the Add Score venue step's lazy lookup when a HERE "Places" result (or a TiltTrack venue with
//    no Pinball Map link yet) is picked (`GET /api/venues/pm-match`).
// The id it produces is what the machine step reads the roster by, and what `POST /api/scores`
// stores on the venue, so a wrong match shows the wrong machines *and* links the wrong listing.
//
// No I/O — callers fetch the nearby PM locations (`findNearestPmLocations`) themselves. (The
// venueAddress import pulls in @workspace/db, which needs a DATABASE_URL at import time; the tests
// set a dummy one that is never dialled.)

import type { PmLocation } from './pinballmapApi.js';
import { linkageBlockedByPrivacy, type PrivacyFlags } from './venueAddress.js';
import type { RateWindow } from './nearbyLookup.js';

/** Metres. A Pinball Map location with an overlapping name this close is the same venue. */
export const PM_MATCH_RADIUS_M = 150;
/**
 * Metres. With no name overlap, only a location practically on top of the venue counts (the same
 * building / geocode) — HERE and Pinball Map name the same bar differently often enough ("Deep
 * Cuts" vs "Pop's Pinball") that requiring a name match would miss real ones. The old rule took the
 * nearest location within 150m whatever its name, which pinned a bar's roster onto the coffee shop
 * next door.
 */
export const PM_SAME_SPOT_M = 40;

// Words that say what kind of place it is, not which one — sharing "pinball" or "bar" is no evidence.
const GENERIC_WORDS = new Set([
  'the', 'and', 'pinball', 'arcade', 'arcades', 'bar', 'pub', 'tavern', 'lounge', 'club', 'games',
  'game', 'gaming', 'brewing', 'brewery', 'company', 'house', 'room', 'hall', 'grill', 'kitchen',
  'cafe', 'restaurant', 'taproom', 'beer', 'pizza', 'saloon', 'inn', 'bowl', 'bowling', 'center',
  'centre', 'amusements', 'amusement', 'family', 'fun',
]);

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['‘’`]/g, '');
}

/** Case, diacritics, punctuation and a leading "the" folded away — "The Wedge-Head" → "wedgehead". */
function compact(s: string): string {
  return fold(s).replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
}

function distinctiveWords(s: string): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));
}

/**
 * Whether two names plausibly name the same venue: one contains the other once folded
 * ("Pop's Pinball" ⊂ "Pop's Pinball - Deep Cuts"), or they share a distinctive word
 * ("Ground Kontrol Classic Arcade" / "Ground Kontrol").
 */
export function pmNamesOverlap(a: string, b: string): boolean {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const words = new Set(distinctiveWords(a));
  return distinctiveWords(b).some(w => words.has(w));
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export interface PmMatchSubject {
  name: string;
  lat?: number | null;
  lng?: number | null;
}

/**
 * The Pinball Map location `venue` is, from a list of locations near it, or null.
 *
 * With coordinates: the closest location within PM_MATCH_RADIUS_M whose name overlaps; failing
 * that, the closest within PM_SAME_SPOT_M whatever its name. Without coordinates (history venues
 * arrive without them): a name overlap alone. Pinball Map sends lat/lon as decimal strings, hence
 * the Number() calls.
 */
export function matchPmLocation<L extends Pick<PmLocation, 'id' | 'name' | 'lat' | 'lon'>>(
  venue: PmMatchSubject, pmLocations: L[],
): L | null {
  const usable = pmLocations.filter(l => l && Number(l.id) > 0 && typeof l.name === 'string');
  const lat = venue.lat;
  const lng = venue.lng;
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    return usable.find(l => pmNamesOverlap(venue.name, l.name)) ?? null;
  }
  let named: { l: L; d: number } | null = null;
  let sameSpot: { l: L; d: number } | null = null;
  for (const l of usable) {
    const pLat = Number(l.lat);
    const pLng = Number(l.lon);
    if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;
    const d = haversineM(lat, lng, pLat, pLng);
    if (d < PM_MATCH_RADIUS_M && pmNamesOverlap(venue.name, l.name) && (!named || d < named.d)) named = { l, d };
    if (d < PM_SAME_SPOT_M && (!sameSpot || d < sameSpot.d)) sameSpot = { l, d };
  }
  return named?.l ?? sameSpot?.l ?? null;
}

/**
 * Whether a Pinball Map id the client sent with a score may be written onto a venue: a positive
 * integer, the venue not private (private venues carry no linkage — linkageBlockedByPrivacy), and
 * the venue not already linked. An existing link is never overwritten here; changing one is the
 * repair panel's job, which verifies the listing first.
 */
export function pmIdToPersist(
  clientPmId: unknown,
  venue: ({ pinballMapId: number | null } & PrivacyFlags) | null,
): number | null {
  const id = parsePmId(clientPmId);
  if (id == null) return null;
  if (!venue) return id; // a brand-new venue
  if (linkageBlockedByPrivacy(venue)) return null;
  if (venue.pinballMapId != null) return null;
  return id;
}

/** A Pinball Map location id from untrusted input, or null. */
export function parsePmId(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * `GET /api/venues/pm-match` limits, per user. One call per venue *pick* (not per keystroke), so
 * these sit well above real use; they exist so the route can't be driven as a Pinball Map proxy.
 */
export const PM_MATCH_RATE_WINDOWS: RateWindow[] = [
  { ms: 60_000, max: 30 },
  { ms: 24 * 60 * 60_000, max: 500 },
];
