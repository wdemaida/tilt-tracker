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
export function redactVenue<T extends VenuePrivacyFields & { address: string | null; latitude: number | null; longitude: number | null; timezone?: string | null }>(
  venue: T,
  requesterUserId: number | undefined,
  isAdmin: boolean,
): T {
  if (venue.privacyTier === 'full' || canSeeFullVenue(venue, requesterUserId, isAdmin)) return venue;

  // Both restricted tiers drop their HERE / Pinball Map linkage. A HERE place id resolves to an exact
  // position through HERE's Lookup endpoint, and a Pinball Map id resolves to a public listing with a
  // street address — either would undo the redaction below. Linking is refused for these tiers
  // (linkageBlockedByPrivacy), but a venue can be linked first and made private afterwards, so this
  // is the backstop. Only keys the row already carries are touched, so no caller's shape changes.
  venue = stripLinkage(venue);

  if (venue.privacyTier === 'city_state') {
    const label = [venue.city, venue.state].filter(Boolean).join(', ') || null;
    return { ...venue, address: label, latitude: venue.cityLat, longitude: venue.cityLng };
  }

  // `hidden` also drops the timezone. It's far coarser than an address, but it still narrows where
  // someone lives, and this tier's promise is that nothing locational goes out. Scores at a venue
  // with no visible zone fall back to the viewer's clock, which reads identically to anyone in the
  // same zone — i.e. to almost everyone who would notice.
  return { ...venue, address: null, latitude: null, longitude: null, timezone: null };
}

const LINKAGE_KEYS = ['hereId', 'pinballMapId', 'pmMachineCount', 'pmLocationUrl'] as const;

function stripLinkage<T extends object>(venue: T): T {
  const out = { ...venue } as Record<string, unknown>;
  for (const k of LINKAGE_KEYS) if (k in out) out[k] = null;
  return out as T;
}

/**
 * Whether this requester may see a venue's HERE / Pinball Map linkage (and the roster behind it).
 * Mirrors redactVenue: public venues always, restricted ones only for their owner or an admin.
 */
export function canSeeVenueLinkage(venue: VenuePrivacyFields, requesterUserId: number | undefined, isAdmin: boolean): boolean {
  return venue.privacyTier === 'full' || canSeeFullVenue(venue, requesterUserId, isAdmin);
}

/**
 * Whether a venue may be surfaced to this user through anything *location-derived* — nearby
 * suggestions, a HERE place id from their photo's surroundings, a proximity duplicate match.
 *
 * The owner's rule for home venues: anyone may log a score at one, and friends find it by typing its
 * exact name. What must never happen is a private venue turning up because of *where* someone is,
 * because the coordinates behind those paths come from the client — any proximity reveal is a
 * scanning oracle for where people live. Public venues always; private ones only for their owner
 * and admins.
 */
export function mayRevealByLocation(
  venue: VenuePrivacyFields & { isResidence: boolean },
  user: { id: number; role: string } | undefined,
): boolean {
  const isPrivate = venue.isResidence || venue.privacyTier !== 'full';
  return !isPrivate || (!!user && canSeeFullVenue(venue, user.id, user.role === 'admin'));
}

/**
 * The one comparison exact-name discovery uses: trimmed, case-insensitive, nothing else. Not
 * normalizeVenueName — folding punctuation and "the" would make it a fuzzy search, and a fuzzy
 * search over private venues is a way to enumerate them.
 */
export function exactVenueNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Private in the sense the location rules care about: a residence, or any restricted tier. */
export function isPrivateTier(venue: { isResidence: boolean; privacyTier: 'full' | 'city_state' | 'hidden' }): boolean {
  return venue.isResidence || venue.privacyTier !== 'full';
}

/**
 * Column updates for a venue edit that leaves it private. A HERE place id or Pinball Map id *is* a
 * location, so a venue that becomes (or stays) private drops them in the same UPDATE — owner decision
 * 2026-09-25. They are not restored on switching back to public; the owner relinks from the repair
 * panel if they want them. `pmMachineCount` goes too, since it's derived from the Pinball Map link.
 */
export function linkageClearedForPrivacy(
  next: { isResidence: boolean; privacyTier: 'full' | 'city_state' | 'hidden' },
): { hereId: null; pinballMapId: null; pmMachineCount: null } | Record<string, never> {
  return isPrivateTier(next) ? { hereId: null, pinballMapId: null, pmMachineCount: null } : {};
}

// A score's own latitude/longitude comes from the photo's EXIF GPS, independent of the venue record —
// redact it the same way whenever its venue restricts visibility, so the exact location can't leak via
// the score's coordinates even after the venue's own address/coordinates are redacted.
export function redactScoreLocation<T extends { latitude: number | null; longitude: number | null; venueTimezone?: string | null }>(
  score: T,
  venue: VenuePrivacyFields | undefined,
  requesterUserId: number | undefined,
  isAdmin: boolean,
): T {
  if (!venue || venue.privacyTier === 'full' || canSeeFullVenue(venue, requesterUserId, isAdmin)) return score;
  if (venue.privacyTier === 'city_state') {
    return { ...score, latitude: venue.cityLat, longitude: venue.cityLng };
  }
  return { ...score, latitude: null, longitude: null, venueTimezone: null };
}
