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
