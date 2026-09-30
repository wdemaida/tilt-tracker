// Whether an Add Score venue pick needs a Pinball Map match, and how to ask (pure — no DOM,
// unit-tested in pmLookup.test.ts). AddScorePage feeds the result to `api.venues.pmMatch` once per
// pick (never per search result).
//
// A pick that already carries a Pinball Map id uses it. A pick without one gets exactly one
// pm-match, wherever it came from — the search, or the nearby list (photo GPS / "Use my current
// location"). A nearby place with no id is NOT "already checked": the nearby lookup asks Pinball
// Map for 1 mile around the photo / device point (closest_by_lat_lon, max_distance=1), while HERE's
// nearby places reach further, so a place a few miles out comes back with no id even when it's on
// Pinball Map. (Same bug as ChallengeMeCard's Near me, fixed 2026-09-30 — Land Ho, 4.7 mi out.)
// Private venues carry no Pinball Map link, so there's nothing to look up.

export interface PmLookupPick {
  venueId?: number;
  name?: string;
  venueLat?: number;
  venueLng?: number;
  pinballMapId?: number | null;
  isPrivate?: boolean;
}

export type PmLookup = { venueId: number } | { lat: number; lng: number; name: string };

export function pmLookupFor(v: PmLookupPick | null | undefined): PmLookup | null {
  if (!v || v.pinballMapId != null || v.isPrivate) return null;
  // By id even for a nearby suggestion: history venues are matched by name only there, and the
  // server answers from the venue's stored link without calling Pinball Map when it has one.
  if (v.venueId != null) return { venueId: v.venueId };
  // A place (search or nearby): at its own coordinates, so the 1-mile nearby radius doesn't matter.
  if (v.venueLat != null && v.venueLng != null && v.name) return { lat: v.venueLat, lng: v.venueLng, name: v.name };
  return null;
}
