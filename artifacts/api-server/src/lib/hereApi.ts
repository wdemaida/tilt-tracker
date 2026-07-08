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

export async function getNearbyVenues(lat: number, lng: number, limit = 8): Promise<Venue[]> {
  if (!HERE_API_KEY) return [];

  const url = new URL('https://browse.search.hereapi.com/v1/browse');
  url.searchParams.set('at', `${lat},${lng}`);
  // exclude transport (400), facilities (800), geographical features (900)
  url.searchParams.set('categories', '100,200,300,500,600,700');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('apiKey', HERE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items: Array<{ id: string; title: string; distance: number; position: { lat: number; lng: number }; address: { label: string } }>;
    };
    return data.items.map(item => ({
      name: item.title,
      address: item.address?.label ?? '',
      distance: Math.round(item.distance ?? 0),
      hereId: item.id ?? null,
      source: 'here',
      venueLat: item.position?.lat,
      venueLng: item.position?.lng,
    }));
  } catch {
    return [];
  }
}
