import { db, venues } from '@workspace/db';

// Guards the "Add a new venue" path against re-creating a venue that already exists.
//
// The unique index on `venues.here_id` was supposed to be the dedup mechanism, but it only covers
// venues the *upload* flow created — `POST /api/venues` never set a here_id, and Postgres treats
// NULL != NULL, so null-here_id rows can never conflict-match each other anyway. A second
// "headquarters" was created 92m from the real one with nothing to stop it.
//
// Matching on the address string would not have caught that case: the typed address geocoded to a
// street centroid ("W Institute Pl, Chicago, IL 60610") while the original holds a building address
// ("213 W Institute Pl, Chicago, IL 60610-0704"). Same place, different strings.

/** Metres. A same-named venue this close is the same venue with a sloppier geocode. */
const DUPLICATE_RADIUS_M = 250;

/**
 * Folds the cosmetic differences between two spellings of one venue: case, diacritics, punctuation,
 * and a leading "the". Deliberately does NOT strip anything meaningful — "Pinball Palace" and
 * "Pinball Palace North" stay distinct.
 */
export function normalizeVenueName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

export interface DuplicateCandidate {
  id: number;
  name: string;
  address: string | null;
  /** Null when either venue has no coordinates — the match was on name alone. */
  distance: number | null;
}

/**
 * Venues that look like the one about to be created.
 *
 * **Name and proximity together**, because each alone is wrong:
 * - Name alone would block a chain with branches in different cities — a second "Headquarters" in
 *   Boston is a different venue, not a duplicate.
 * - Proximity alone would block genuine neighbours. "The Alley Bar" and "Versus" sit 156m apart in
 *   this table and are unrelated.
 *
 * Requiring both catches the 92m same-name pair that prompted this and leaves the rest creatable.
 *
 * When the new venue couldn't be geocoded, this falls back to a name-only match. That's the
 * conservative direction: the caller surfaces candidates for confirmation rather than refusing, so a
 * false positive costs one extra click and a false negative costs a duplicate.
 */
export async function findDuplicateVenues(
  candidate: { name: string; latitude: number | null; longitude: number | null },
): Promise<DuplicateCandidate[]> {
  const target = normalizeVenueName(candidate.name);
  if (!target) return [];

  const all = await db
    .select({
      id: venues.id,
      name: venues.name,
      address: venues.address,
      latitude: venues.latitude,
      longitude: venues.longitude,
    })
    .from(venues);

  const matches: DuplicateCandidate[] = [];
  for (const v of all) {
    if (normalizeVenueName(v.name) !== target) continue;

    const bothPlaced =
      candidate.latitude != null && candidate.longitude != null &&
      v.latitude != null && v.longitude != null;

    if (!bothPlaced) {
      matches.push({ id: v.id, name: v.name, address: v.address, distance: null });
      continue;
    }

    const d = distanceM(candidate.latitude!, candidate.longitude!, v.latitude!, v.longitude!);
    if (d <= DUPLICATE_RADIUS_M) {
      matches.push({ id: v.id, name: v.name, address: v.address, distance: d });
    }
  }

  return matches.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}
