interface VenuePrivacyFields {
  ownerId: number | null;
  privacyTier: 'full' | 'city_state' | 'hidden';
  city: string | null;
  state: string | null;
  cityLat: number | null;
  cityLng: number | null;
}

export function canSeeFullVenue(venue: VenuePrivacyFields, requesterUserId: number | undefined, isAdmin: boolean): boolean {
  return isAdmin || (requesterUserId != null && requesterUserId === venue.ownerId);
}

// Redacts a venue's address/coordinates per its privacy tier, unless the requester is the owner or an admin.
// city_state swaps in a pre-resolved city/state centroid (never a truncated version of the precise coordinate);
// hidden strips address and coordinates entirely.
export function redactVenue<T extends VenuePrivacyFields & { address: string | null; latitude: number | null; longitude: number | null }>(
  venue: T,
  requesterUserId: number | undefined,
  isAdmin: boolean,
): T {
  if (venue.privacyTier === 'full' || canSeeFullVenue(venue, requesterUserId, isAdmin)) return venue;

  if (venue.privacyTier === 'city_state') {
    const label = [venue.city, venue.state].filter(Boolean).join(', ') || null;
    return { ...venue, address: label, latitude: venue.cityLat, longitude: venue.cityLng };
  }

  return { ...venue, address: null, latitude: null, longitude: null };
}

// A score's own latitude/longitude comes from the photo's EXIF GPS, independent of the venue record —
// redact it the same way whenever its venue restricts visibility, so the exact location can't leak via
// the score's coordinates even after the venue's own address/coordinates are redacted.
export function redactScoreLocation<T extends { latitude: number | null; longitude: number | null }>(
  score: T,
  venue: VenuePrivacyFields | undefined,
  requesterUserId: number | undefined,
  isAdmin: boolean,
): T {
  if (!venue || venue.privacyTier === 'full' || canSeeFullVenue(venue, requesterUserId, isAdmin)) return score;
  return { ...score, latitude: null, longitude: null };
}
