// The Add Score wizard's venue search (`GET /api/venues/search`): one box, two sources.
//
//  - **On TiltTrack** — venues already in the database, matched on any word of the name (or the
//    address), case- and punctuation-insensitive, so "pop", "pops", "Pop's" and "deep cuts" all find
//    "Pop's Pinball - Deep Cuts". Only venues this requester may see by location: public ones, plus
//    their own private ones. Someone else's home venue is never in here — friends still find it by
//    its exact name through `GET /api/venues/exact`, which is a separate, rate-limited, name-only path.
//  - **Places** — HERE Autosuggest by name, biased to the best location the client has. A place that
//    is already a TiltTrack venue (same HERE id, or an overlapping name within ~150m) is shown once,
//    as that venue — the point of the whole thing is that picking it can't create a duplicate.
//
// Everything here is pure (no DB, no network) so it can be unit-tested; the route does the I/O.

import { normalizeVenueName, distanceM } from './venueDedup.js';
import { isPrivateTier, canSeeFullVenue } from './venuePrivacy.js';

/**
 * Words for matching: diacritics folded, lowercased, apostrophes *removed* (so "Pop's" is one word,
 * "pops", and "pop" is a prefix of it), every other non-alphanumeric run a word break.
 */
export function searchTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Minimum query length (letters/digits only) before anything is searched. */
export const MIN_QUERY_CHARS = 2;
/** HERE is only asked from this length on — "p" or "po" would just burn a request on noise. */
export const MIN_PLACE_QUERY_CHARS = 3;

export function queryLength(q: string): number {
  return searchTokens(q).join('').length;
}

/**
 * How well a venue matches a query, or null for no match. Higher is better:
 *  100  same name once punctuation/case are folded ("pops pinball deep cuts")
 *   90  every query word starts a word of the name, and the first one starts the name ("pop")
 *   80  every query word starts a word of the name, anywhere ("deep cuts", "pinball pop")
 *   60  the query, spaces ignored, runs from the start of a word of the name ("popspin", "pinballdeep")
 *   40  every query word starts a word of the name or address, at least one of them in the name
 *       ("pops medford")
 */
export function matchScore(query: string, name: string, address?: string | null): number | null {
  const q = searchTokens(query);
  if (q.length === 0) return null;
  const n = searchTokens(name);
  if (n.length === 0) return null;
  const compactQ = q.join('');

  if (compactQ === n.join('')) return 100;
  const inName = (t: string) => n.some(w => w.startsWith(t));
  if (q.every(inName)) return n[0].startsWith(q[0]) ? 90 : 80;
  if (compactQ.length >= 3 && n.some((_, i) => n.slice(i).join('').startsWith(compactQ))) return 60;
  if (address) {
    const a = searchTokens(address);
    if (q.some(inName) && q.every(t => inName(t) || a.some(w => w.startsWith(t)))) return 40;
  }
  return null;
}

export type Tier = 'full' | 'city_state' | 'hidden';

/** The venue columns search reads. */
export interface SearchableVenue {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  hereId: string | null;
  pinballMapId: number | null;
  timezone: string | null;
  ownerId: number | null;
  isResidence: boolean;
  privacyTier: Tier;
}

export interface Requester { id: number; role: string }

/**
 * Whether a venue may appear in this requester's search results at all: public venues, and private
 * ones only for their owner or an admin. Same boundary as `mayRevealByLocation` — search results
 * carry an address, coordinates and a distance from the requester's own position, so a private
 * venue in here would be exactly the proximity reveal that rule exists to prevent.
 */
export function searchableBy(v: SearchableVenue, requester: Requester | undefined): boolean {
  if (!isPrivateTier(v)) return true;
  return !!requester && canSeeFullVenue(
    { ownerId: v.ownerId, privacyTier: v.privacyTier, city: null, state: null, cityLat: null, cityLng: null },
    requester.id, requester.role === 'admin',
  );
}

export interface LatLng { lat: number; lng: number }

export interface VenueHit {
  id: number;
  name: string;
  address: string | null;
  venueLat: number | null;
  venueLng: number | null;
  hereId: string | null;
  pinballMapId: number | null;
  timezone: string | null;
  /** Metres from the client's location; null when the client sent none. */
  distance: number | null;
  /** One of the requester's own private venues (the only private venues search ever returns). */
  isPrivate: boolean;
  /** 'name' for a text match; 'place' when it's here because a HERE result resolved to it. */
  matchedBy: 'name' | 'place';
}

export interface PlaceHit {
  hereId: string;
  name: string;
  address: string;
  venueLat: number | null;
  venueLng: number | null;
  timezone: string | null;
  distance: number | null;
}

/** A HERE place as `autosuggestPlaces` returns it. */
export interface PlaceCandidate {
  hereId: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
}

function toHit(v: SearchableVenue, from: LatLng | null, matchedBy: VenueHit['matchedBy']): VenueHit {
  return {
    id: v.id,
    name: v.name,
    address: v.address,
    venueLat: v.latitude,
    venueLng: v.longitude,
    hereId: v.hereId,
    pinballMapId: v.pinballMapId,
    timezone: v.timezone,
    distance: from && v.latitude != null && v.longitude != null
      ? Math.round(distanceM(from.lat, from.lng, v.latitude, v.longitude))
      : null,
    isPrivate: isPrivateTier(v),
    matchedBy,
  };
}

/**
 * Text matches among the venues this requester may see, best match first; among equal matches the
 * closest to `from` (when the client sent a location), then by name.
 */
export function matchTiltTrackVenues(
  query: string, rows: SearchableVenue[], requester: Requester | undefined, from: LatLng | null, limit = 8,
): VenueHit[] {
  if (queryLength(query) < MIN_QUERY_CHARS) return [];
  return rows
    .filter(v => searchableBy(v, requester))
    .map(v => ({ v, score: matchScore(query, v.name, v.address) }))
    .filter((r): r is { v: SearchableVenue; score: number } => r.score != null)
    .map(r => ({ ...r, hit: toHit(r.v, from, 'name') }))
    .sort((a, b) =>
      b.score - a.score
      || (a.hit.distance ?? Infinity) - (b.hit.distance ?? Infinity)
      || a.v.name.localeCompare(b.v.name))
    .slice(0, limit)
    .map(r => r.hit);
}

/** Metres. A HERE place this close to a venue with an overlapping name *is* that venue. */
export const SAME_PLACE_RADIUS_M = 150;

/** One name contains the other once case and punctuation are folded ("Pop's Pinball" ⊂ "Pop's Pinball - Deep Cuts"). */
export function namesOverlap(a: string, b: string): boolean {
  const x = normalizeVenueName(a);
  const y = normalizeVenueName(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * The TiltTrack venue a HERE place already is, if the requester may see it: one holding that HERE
 * id, else one within SAME_PLACE_RADIUS_M whose name overlaps. The second rule matters — venue 19
 * "Pop's Pinball - Deep Cuts" is linked to HERE's "Deep Cuts" listing, and HERE also lists
 * "Pop's Pinball" at the same address under another id; without it that listing would be offered
 * as a new place and picking it would recreate the duplicate this search exists to prevent.
 */
export function venueForPlace(
  place: PlaceCandidate, visible: SearchableVenue[],
): SearchableVenue | undefined {
  const byId = visible.find(v => v.hereId != null && v.hereId === place.hereId);
  if (byId) return byId;
  if (place.lat == null || place.lng == null) return undefined;
  let best: { v: SearchableVenue; d: number } | undefined;
  for (const v of visible) {
    if (v.latitude == null || v.longitude == null) continue;
    const d = distanceM(place.lat, place.lng, v.latitude, v.longitude);
    if (d < SAME_PLACE_RADIUS_M && namesOverlap(v.name, place.name) && (!best || d < best.d)) best = { v, d };
  }
  return best?.v;
}

/**
 * The two result sections. HERE places that resolve to a visible TiltTrack venue are folded into
 * the TiltTrack section (appended when the text match didn't already find it) and dropped from
 * Places, so each real place appears once. A place whose HERE id belongs to a venue the requester
 * may *not* see (someone's private venue — a legacy row; linking one is refused now) stays a plain
 * place: nothing about the private venue is revealed, and `POST /api/scores` already refuses to file
 * a score under a private holder by HERE id.
 */
export function mergeSearchResults(args: {
  query: string;
  rows: SearchableVenue[];
  places: PlaceCandidate[];
  requester: Requester | undefined;
  /** The client's location, for distances. Null when it sent none (a fallback bias is not a location). */
  from: LatLng | null;
  /** Where HERE was biased (the client's location or a fallback). Places far from it are dropped. */
  bias?: LatLng | null;
  venueLimit?: number;
  placeLimit?: number;
}): { tiltTrack: VenueHit[]; places: PlaceHit[] } {
  const { query, rows, places, requester, from, bias = from, venueLimit = 8, placeLimit = 6 } = args;
  const visible = rows.filter(v => searchableBy(v, requester));
  const tiltTrack = matchTiltTrackVenues(query, visible, requester, from, venueLimit);
  const shown = new Set(tiltTrack.map(h => h.id));
  const seenHere = new Set<string>();
  const outPlaces: PlaceHit[] = [];

  for (const p of places) {
    if (seenHere.has(p.hereId)) continue;
    seenHere.add(p.hereId);
    const venue = venueForPlace(p, visible);
    if (venue) {
      if (!shown.has(venue.id) && tiltTrack.length < venueLimit + 3) {
        tiltTrack.push(toHit(venue, from, 'place'));
        shown.add(venue.id);
      }
      continue;
    }
    if (outPlaces.length >= placeLimit) continue;
    if (bias && !placeIsRelevant(query, p, bias)) continue;
    outPlaces.push({
      hereId: p.hereId,
      name: p.name,
      address: p.address,
      venueLat: p.lat,
      venueLng: p.lng,
      timezone: p.timezone,
      distance: from && p.lat != null && p.lng != null ? Math.round(distanceM(from.lat, from.lng, p.lat, p.lng)) : null,
    });
  }
  return { tiltTrack, places: outPlaces };
}

/** Metres. A place further than this from the bias is kept only if the query names its town. */
export const PLACE_MAX_DISTANCE_M = 150_000;

/**
 * Autosuggest's `at` is only a bias, so a thin local answer gets padded with same-named places a
 * continent away. Keep a place when it's within PLACE_MAX_DISTANCE_M of the bias — or when the
 * query names where it is (a word that isn't part of the place's name but starts a word of its
 * address: "pops medford" keeps Pop's Pinball in Medford even from Chicago).
 */
export function placeIsRelevant(query: string, place: PlaceCandidate, bias: LatLng): boolean {
  if (place.lat == null || place.lng == null) return true;
  if (distanceM(bias.lat, bias.lng, place.lat, place.lng) <= PLACE_MAX_DISTANCE_M) return true;
  const nameWords = searchTokens(place.name);
  const addressWords = searchTokens(place.address);
  return searchTokens(query).some(t =>
    t.length >= 3 && !nameWords.some(w => w.startsWith(t)) && addressWords.some(w => w.startsWith(t)));
}

/** Rate limits for the search route, per user. Typing is debounced client-side (~350ms). */
export const SEARCH_RATE_WINDOWS = [
  { ms: 60_000, max: 60 },
  { ms: 24 * 60 * 60_000, max: 1500 },
];
/** HERE answers are cached per (query, ~110m bias cell) for this long. */
export const PLACE_CACHE_TTL_MS = 10 * 60_000;

export function placeCacheKey(query: string, at: LatLng): string {
  return `${searchTokens(query).join(' ')}|${at.lat.toFixed(3)},${at.lng.toFixed(3)}`;
}
