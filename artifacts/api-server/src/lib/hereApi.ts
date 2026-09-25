const HERE_API_KEY = process.env.HERE_API_KEY;

export interface Venue {
  name: string;
  address: string;
  distance: number;
  hereId: string | null;
  source: 'history' | 'here';
  venueId?: number;
  venueLat?: number;
  venueLng?: number;
  pinballMapId?: number;
  /** IANA zone name, e.g. "America/Chicago". See SHOW_TZ below. */
  timezone?: string | null;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  city: string | null;
  state: string | null;
  label: string;
  /** IANA zone name, e.g. "America/Chicago". See SHOW_TZ below. */
  timezone: string | null;
  /**
   * How precisely HERE matched: "houseNumber" / "place" / "street" are a real spot, "locality"
   * (a city centroid) is not. The manual-address repair shows this before the user confirms, so a
   * typo that silently resolved to the middle of town isn't saved as the venue's position.
   */
  resultType?: string | null;
}

/**
 * HERE reports a place's timezone on every search endpoint, but only when asked. Verified against
 * geocode, browse, revgeocode and discover — each answers with
 * `timeZone: { name: "America/Chicago", utcOffset: "-05:00" }`.
 *
 * Always read `.name`, never `.utcOffset`: the offset is a snapshot that's wrong for half the year,
 * while the zone name carries its own DST rules.
 */
const SHOW_TZ = 'tz';

interface HereTimeZone { name?: string; utcOffset?: string }

// Resolves a free-text address (e.g. a manually-entered home address) to coordinates + city/state.
// Distinct from getNearbyVenues (browse endpoint, searches POIs near a point) — this hits HERE's
// Geocode endpoint, which resolves an address string to a single best-match location.
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!HERE_API_KEY || !address.trim()) return null;

  const url = new URL('https://geocode.search.hereapi.com/v1/geocode');
  url.searchParams.set('q', address);
  url.searchParams.set('limit', '1');
  url.searchParams.set('show', SHOW_TZ);
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items: Array<{
        resultType?: string;
        position: { lat: number; lng: number };
        address: { label: string; city?: string; state?: string };
        timeZone?: HereTimeZone;
      }>;
    };
    const item = data.items?.[0];
    if (!item) return null;
    return {
      lat: item.position.lat,
      lng: item.position.lng,
      city: item.address?.city ?? null,
      state: item.address?.state ?? null,
      label: item.address?.label ?? address,
      timezone: item.timeZone?.name ?? null,
      resultType: item.resultType ?? null,
    };
  } catch {
    return null;
  }
}

export interface AddressSuggestion {
  id: string;
  label: string;
  lat: number | null;
  lng: number | null;
}

// Address-as-you-type suggestions for manual venue entry (e.g. adding a residence). Distinct from
// geocodeAddress (resolves one complete address string) and getNearbyVenues (POI search near a
// point) — this hits HERE's Autosuggest endpoint, built specifically for incremental typeahead.
export async function autosuggestAddress(query: string, at?: { lat: number; lng: number }): Promise<AddressSuggestion[]> {
  if (!HERE_API_KEY || query.trim().length < 3) return [];

  const url = new URL('https://autosuggest.search.hereapi.com/v1/autosuggest');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '5');
  url.searchParams.set('apiKey', HERE_API_KEY);
  // Autosuggest requires an `at`/`in` location bias (a plain country filter like `in=countryCode:`
  // isn't accepted here, unlike other HERE endpoints) — use the caller's coordinates when known (more
  // relevant results), otherwise bias toward the northeast US, this app's primary user base.
  const bias = at ?? { lat: 42.36, lng: -71.06 }; // Boston, MA
  url.searchParams.set('at', `${bias.lat},${bias.lng}`);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items: Array<{ id: string; address?: { label: string }; position?: { lat: number; lng: number } }>;
    };
    // Some result types (categoryQuery, chainQuery) are query refinements, not addresses — skip them.
    return data.items
      .filter((item): item is typeof item & { address: { label: string } } => !!item.address?.label)
      .map(item => ({
        id: item.id,
        label: item.address.label,
        lat: item.position?.lat ?? null,
        lng: item.position?.lng ?? null,
      }));
  } catch {
    return [];
  }
}

export interface PlaceSuggestion {
  hereId: string;
  name: string;
  /** The address part of HERE's label (the place's own name prefix stripped). */
  address: string;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
}

// Places by name for the Add Score venue search — Autosuggest again, but keeping only `place`
// results (streets, chain/category refinements dropped). Chosen over Discover because it's built
// for partial input: verified 2026-09-25 that "pop" near Medford returns Pop's Pinball first, and
// "pop's pinball medford" finds it even when biased to Chicago, so a typed town works as a location
// when the client has none. `at` is required by the endpoint and is a bias, not a filter.
// Returns [] on any failure, like the other lookups here — the TiltTrack half of the search still works.
export async function autosuggestPlaces(query: string, at: { lat: number; lng: number }, limit = 10): Promise<PlaceSuggestion[]> {
  if (!HERE_API_KEY || query.trim().length < 3) return [];

  const url = new URL('https://autosuggest.search.hereapi.com/v1/autosuggest');
  url.searchParams.set('q', query);
  url.searchParams.set('at', `${at.lat},${at.lng}`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('show', SHOW_TZ);
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: Array<{
        id?: string; title?: string; resultType?: string;
        address?: { label?: string }; position?: { lat: number; lng: number }; timeZone?: HereTimeZone;
        categories?: Array<{ id?: string }>;
      }>;
    };
    // HERE's text relevance order is kept, except that arcades and bars (tiers 0-1, see
    // CATEGORY_TIERS) move ahead of everything else — "versus" should offer the arcade bar before a
    // jiu-jitsu gym. A stable sort, so each group keeps HERE's order.
    return (data.items ?? [])
      .filter(item => item.resultType === 'place' && !!item.id && !!item.title)
      .map((item, i) => ({ item, i, group: Math.min(categoryTier(item.categories), 2) }))
      .sort((a, b) => a.group - b.group || a.i - b.i)
      .map(({ item }) => {
        const name = item.title!;
        const label = item.address?.label ?? '';
        const prefix = `${name}, `;
        return {
          hereId: item.id!,
          name,
          address: label.startsWith(prefix) ? label.slice(prefix.length) : label,
          lat: item.position?.lat ?? null,
          lng: item.position?.lng ?? null,
          timezone: item.timeZone?.name ?? null,
        };
      });
  } catch {
    return [];
  }
}

// HERE's browse ranking is distance-first with an arbitrary tiebreak, which falls apart inside a
// dense mixed-use building: at 213 W Institute Pl, Chicago every tenant geocodes to the same point,
// so a dozen law offices and a pharmacy tied at 18m sorted ahead of the barcade that was actually
// there. Rather than raise the page size and hope, pull a full page and re-rank by how plausible
// each category is as a place with a pinball machine, then by distance within a tier.
//
// Category ids verified empirically against Logan Arcade and Headquarters Beercade — both carry
// `200-2000-0017 Video Arcade-Game Room` alongside `200-2000-0011 Bar or Pub`.
const CATEGORY_TIERS: Array<{ test: (id: string) => boolean; tier: number }> = [
  { test: id => id.startsWith('200-2000-0017'), tier: 0 }, // video arcade / game room
  { test: id => id.startsWith('200-2000'), tier: 1 },      // bar, pub, brewery, nightlife
  { test: id => id.startsWith('200-'), tier: 2 },          // other going-out: casino, cinema, theatre
  { test: id => id.startsWith('100-'), tier: 2 },          // eat & drink
  { test: id => id.startsWith('300-') || id.startsWith('500-'), tier: 3 },
];
const WORST_TIER = 4;

function categoryTier(categories: Array<{ id?: string }> | undefined): number {
  if (!categories?.length) return WORST_TIER;
  let best = WORST_TIER;
  for (const c of categories) {
    if (!c.id) continue;
    for (const rule of CATEGORY_TIERS) {
      if (rule.test(c.id) && rule.tier < best) best = rule.tier;
    }
  }
  return best;
}

interface HereBrowseItem {
  id: string;
  title: string;
  distance?: number;
  position?: { lat: number; lng: number };
  address?: { label?: string };
  categories?: Array<{ id?: string; name?: string }>;
  timeZone?: HereTimeZone;
}

function toVenue(item: HereBrowseItem): Venue {
  return {
    name: item.title,
    address: item.address?.label ?? '',
    distance: Math.round(item.distance ?? 0),
    hereId: item.id ?? null,
    source: 'here',
    venueLat: item.position?.lat,
    venueLng: item.position?.lng,
    timezone: item.timeZone?.name ?? null,
  };
}

/**
 * The IANA zone for a point, via reverse geocoding.
 *
 * Every other HERE call in this file already carries `show=tz`, so this is only for the cases where
 * all we have is coordinates: backfilling venues that predate the column, and topping up a venue
 * whose linkage was repaired by hand. One request, no dependency on the venue having an address.
 */
export async function resolveTimezone(lat: number, lng: number): Promise<string | null> {
  if (!HERE_API_KEY) return null;

  const url = new URL('https://revgeocode.search.hereapi.com/v1/revgeocode');
  url.searchParams.set('at', `${lat},${lng}`);
  url.searchParams.set('limit', '1');
  url.searchParams.set('show', SHOW_TZ);
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: Array<{ timeZone?: HereTimeZone }> };
    return data.items?.[0]?.timeZone?.name ?? null;
  } catch {
    return null;
  }
}

export async function getNearbyVenues(lat: number, lng: number, limit = 8): Promise<Venue[]> {
  if (!HERE_API_KEY) return [];

  const url = new URL('https://browse.search.hereapi.com/v1/browse');
  url.searchParams.set('at', `${lat},${lng}`);
  // exclude transport (400), facilities (800), geographical features (900)
  url.searchParams.set('categories', '100,200,300,500,600,700');
  // Deliberately over-fetch (100 is HERE's per-page maximum) and narrow to `limit` after re-ranking.
  // This is one request either way, so the only cost is response size.
  url.searchParams.set('limit', '100');
  url.searchParams.set('show', SHOW_TZ);
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as { items: HereBrowseItem[] };
    return (data.items ?? [])
      .map(item => ({ item, tier: categoryTier(item.categories), distance: item.distance ?? 0 }))
      .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.distance - b.distance))
      .slice(0, limit)
      .map(r => toVenue(r.item));
  } catch {
    return [];
  }
}

// Name-targeted lookup for the venue repair flow: given a venue we already have (its name, and
// coordinates from its address), find the matching HERE POI so we can store a hereId. Uses the
// discover endpoint, which is free-text — safe here, unlike the bare global search the api-server
// CLAUDE.md warns about, because `at` anchors it to the venue's own coordinates.
//
// `maxDistanceM` defaults to 2km — right when the anchor is the venue's own address. The
// address-less repair anchors on a *city* the user typed instead, and a venue can sit well outside
// the centroid of the city it's known by (King City vs Portland, OR), so that caller widens it.
export async function findVenueByName(name: string, lat: number, lng: number, limit = 10, maxDistanceM = 2000): Promise<Venue[]> {
  if (!HERE_API_KEY || !name.trim()) return [];

  const url = new URL('https://discover.search.hereapi.com/v1/discover');
  url.searchParams.set('q', name);
  url.searchParams.set('at', `${lat},${lng}`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('show', SHOW_TZ);
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as { items: HereBrowseItem[] };
    // discover will happily return same-name POIs in other cities; keep only genuinely nearby hits.
    return (data.items ?? [])
      .filter(item => (item.distance ?? Infinity) < maxDistanceM)
      .map(toVenue);
  } catch {
    return [];
  }
}

export interface HerePlace {
  hereId: string;
  name: string;
  label: string;
  lat: number;
  lng: number;
  city: string | null;
  state: string | null;
  timezone: string | null;
}

// One HERE place by id, via the Lookup endpoint. Used when a user picks a HERE candidate for an
// address-less venue: the server re-reads the place itself rather than trusting coordinates and an
// address string the client echoed back.
export async function lookupHerePlace(hereId: string): Promise<HerePlace | null> {
  if (!HERE_API_KEY || !hereId.trim()) return null;

  const url = new URL('https://lookup.search.hereapi.com/v1/lookup');
  url.searchParams.set('id', hereId);
  url.searchParams.set('show', SHOW_TZ);
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const item = (await res.json()) as {
      id?: string;
      title?: string;
      position?: { lat: number; lng: number };
      address?: { label?: string; city?: string; state?: string };
      timeZone?: HereTimeZone;
    };
    if (!item?.id || !item.position) return null;
    return {
      hereId: item.id,
      name: item.title ?? '',
      label: item.address?.label ?? item.title ?? '',
      lat: item.position.lat,
      lng: item.position.lng,
      city: item.address?.city ?? null,
      state: item.address?.state ?? null,
      timezone: item.timeZone?.name ?? null,
    };
  } catch {
    return null;
  }
}
