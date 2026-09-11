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
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  city: string | null;
  state: string | null;
  label: string;
}

// Resolves a free-text address (e.g. a manually-entered home address) to coordinates + city/state.
// Distinct from getNearbyVenues (browse endpoint, searches POIs near a point) — this hits HERE's
// Geocode endpoint, which resolves an address string to a single best-match location.
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!HERE_API_KEY || !address.trim()) return null;

  const url = new URL('https://geocode.search.hereapi.com/v1/geocode');
  url.searchParams.set('q', address);
  url.searchParams.set('limit', '1');
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items: Array<{
        position: { lat: number; lng: number };
        address: { label: string; city?: string; state?: string };
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
  };
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
export async function findVenueByName(name: string, lat: number, lng: number, limit = 10): Promise<Venue[]> {
  if (!HERE_API_KEY || !name.trim()) return [];

  const url = new URL('https://discover.search.hereapi.com/v1/discover');
  url.searchParams.set('q', name);
  url.searchParams.set('at', `${lat},${lng}`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as { items: HereBrowseItem[] };
    // discover will happily return same-name POIs in other cities; keep only genuinely nearby hits.
    return (data.items ?? [])
      .filter(item => (item.distance ?? Infinity) < 2000)
      .map(toVenue);
  } catch {
    return [];
  }
}
