// Giving an address to a venue that has none.
//
// A venue typed in by name during upload, with location services off, arrives with no address, no
// coordinates, no HERE id and no Pinball Map link. The HERE repair step can't start from nothing —
// it geocodes the venue's existing address — so this module is the step before it: find where the
// venue is (from a Pinball Map listing, a HERE place, or an address typed by hand) and write that
// onto the row. Everything here is pure so the rules can be unit-tested without a database or APIs.

import { canRepairVenue, type RepairActor, type RepairableVenue } from './venueRepair.js';
import type { PmLocation } from './pinballmapApi.js';

export interface AddressableVenue extends RepairableVenue {
  address: string | null;
  isResidence: boolean;
  privacyTier: 'full' | 'city_state' | 'hidden';
}

export type AddressBlocker = 'forbidden' | 'residence' | 'has_address';

/**
 * Why this actor may not resolve this venue's address, or null when they may.
 *
 * Residences are excluded outright, whatever their tier. A residence's location is the owner's to
 * disclose through the edit dialog (which is where the privacy tier is chosen); a repair flow that
 * lets an admin or a venue's creator look a home up by name and write its coordinates would put
 * a location on a row whose owner never typed one. `privacyTier !== 'full'` is checked too, as a
 * belt-and-braces guard for any row whose flags disagree.
 *
 * A venue that already has an address goes through the existing HERE step instead — this flow is
 * for the empty case only, so it can never silently move a venue someone already placed.
 */
export function addressResolutionBlocker(venue: AddressableVenue, actor: RepairActor): AddressBlocker | null {
  if (!canRepairVenue(venue, actor)) return 'forbidden';
  if (venue.isResidence || venue.privacyTier !== 'full') return 'residence';
  if (venue.address && venue.address.trim()) return 'has_address';
  return null;
}

/** Whether the "Needs address" state applies at all — the permission-free half of the rule above. */
export function venueNeedsAddress(venue: Pick<AddressableVenue, 'address' | 'isResidence' | 'privacyTier'>): boolean {
  return !venue.isResidence && venue.privacyTier === 'full' && !(venue.address && venue.address.trim());
}

/** Anything with the fields that decide whether a venue's identity/location may be shown to others. */
export interface PrivacyFlags {
  isResidence: boolean;
  privacyTier: 'full' | 'city_state' | 'hidden';
}

/** A residence, or any row whose tier restricts its location — the rows whose name must never be paired with a place. */
export function isPrivateVenue(v: PrivacyFlags): boolean {
  return v.isResidence || v.privacyTier !== 'full';
}

export interface HolderView {
  /** The other TiltTrack venue holding this HERE/PM id — only when it's a public venue. */
  linkedVenue: { id: number; name: string } | null;
  /** True whenever *any* other venue holds the id, including a private one we won't name. */
  linkedElsewhere: boolean;
}

/**
 * How to describe "another venue already holds this HERE/Pinball Map id" next to a candidate that
 * carries exact coordinates. A public venue is named, so the user can go and look. A residence (or
 * any restricted tier) is not: pairing its name with the candidate's position is precisely the
 * disclosure its privacy tier exists to prevent — e.g. an owner who linked Pinball Map and later
 * marked the venue a hidden residence. It still counts as taken, just anonymously.
 */
export function describeHolder(holder: ({ id: number; name: string } & PrivacyFlags) | null | undefined): HolderView {
  if (!holder) return { linkedVenue: null, linkedElsewhere: false };
  if (isPrivateVenue(holder)) return { linkedVenue: null, linkedElsewhere: true };
  return { linkedVenue: { id: holder.id, name: holder.name }, linkedElsewhere: true };
}

/**
 * Whether HERE / Pinball Map linkage may be written onto this venue. A restricted-tier venue is
 * refused: a Pinball Map id (and its public pmLocationUrl) or a HERE place id *is* a location, and
 * both go out unredacted on venue payloads — linking one would publish exactly what the tier hides.
 * A residence the owner chose to show in full has nothing hidden, so it's allowed.
 */
export function linkageBlockedByPrivacy(v: Pick<PrivacyFlags, 'privacyTier'>): boolean {
  return v.privacyTier !== 'full';
}

/**
 * Per-row flags the Venues list needs, computed server-side so the payload never has to carry
 * `createdById` for the client to work out who may fix a venue.
 */
export function venueListFlags(
  row: RepairableVenue & Pick<AddressableVenue, 'address' | 'isResidence' | 'privacyTier'>,
  requester: RepairActor | undefined,
): { canRepair: boolean; needsAddress: boolean } {
  return {
    canRepair: requester ? canRepairVenue(row, requester) : false,
    needsAddress: venueNeedsAddress(row),
  };
}

/** Postgres unique_violation (23505), whether postgres.js throws it directly or a wrapper nests it. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export interface ResolvedPlace {
  address: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
}

/**
 * A Pinball Map location as an address + coordinates. PM sends lat/lon as decimal strings and is
 * international (state is null for the Salisbury, UK listing), so both are handled here. Returns
 * null when the listing has no usable coordinates — an address without a position can't anchor the
 * HERE and Pinball Map steps that follow.
 */
export function pmLocationToPlace(loc: PmLocation): ResolvedPlace | null {
  const latitude = Number(loc.lat);
  const longitude = Number(loc.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude === 0 && longitude === 0) return null; // autocomplete's placeholder shape, not a place
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  return {
    address: formatPmAddress(loc),
    city: clean(loc.city),
    state: clean(loc.state),
    latitude,
    longitude,
  };
}

/** "15685 SW 116th Ave, King City, OR 97224" — country appended only when it isn't the US. */
export function formatPmAddress(loc: Pick<PmLocation, 'street' | 'city' | 'state' | 'zip' | 'country'>): string {
  const regionLine = [clean(loc.state), clean(loc.zip)].filter(Boolean).join(' ');
  const country = clean(loc.country);
  return [
    clean(loc.street),
    clean(loc.city),
    regionLine || null,
    country && country.toUpperCase() !== 'US' ? country : null,
  ].filter(Boolean).join(', ');
}

export interface ManualAddressParts {
  street?: unknown;
  city?: unknown;
  state?: unknown;
  postalCode?: unknown;
  country?: unknown;
}

export type ManualAddressResult =
  | { ok: true; query: string }
  | { ok: false; error: string };

/**
 * Validates the manual-entry form and joins it into one geocoding query. A street and a city are
 * both required: a city alone geocodes to its centroid, which is not the venue, and a street alone
 * is ambiguous across every town that has one.
 */
export function buildManualAddressQuery(parts: ManualAddressParts): ManualAddressResult {
  const street = str(parts.street);
  const city = str(parts.city);
  const state = str(parts.state);
  const postalCode = str(parts.postalCode);
  const country = str(parts.country);

  if (!street) return { ok: false, error: 'Enter a street address' };
  if (!city) return { ok: false, error: 'Enter a city' };
  const tooLong = [street, city, state, postalCode, country].some(p => p != null && p.length > 200);
  if (tooLong) return { ok: false, error: 'That address is too long' };

  const regionLine = [state, postalCode].filter(Boolean).join(' ');
  return { ok: true, query: [street, city, regionLine || null, country].filter(Boolean).join(', ') };
}

/** HERE result types precise enough to stand in for a venue's position. */
const PRECISE_RESULT_TYPES = new Set(['houseNumber', 'place', 'street', 'intersection', 'addressBlock']);

export function isPreciseGeocode(resultType: string | null | undefined): boolean {
  return !!resultType && PRECISE_RESULT_TYPES.has(resultType);
}

export interface HereCandidateLike {
  name: string;
  hereId: string | null;
  distance: number;
}

/**
 * The HERE place to attach without asking, or null when the user should choose.
 *
 * Extracted verbatim from the original `/repair/here` rule so both repair paths agree:
 * the closest result's name must overlap the venue's, it must be under 500m, and it must be either
 * the only candidate or under 100m. The 500m ceiling exists because "only one result" would
 * otherwise attach a match from the next town.
 */
export function pickConfidentHereMatch<T extends HereCandidateLike>(venueName: string, candidates: T[]): T | null {
  const best = candidates[0];
  if (!best || !best.hereId) return null;
  const a = best.name.toLowerCase();
  const b = venueName.toLowerCase();
  const nameMatches = a.includes(b) || b.includes(a);
  if (!nameMatches) return null;
  if (best.distance >= 500) return null;
  if (candidates.length !== 1 && best.distance >= 100) return null;
  return best;
}

/**
 * HERE labels a POI with its own name first ("Special When Lit Pinball, 15685 SW 116th Ave, …").
 * The venue already carries a name, so store the address part only — the same shape an address
 * geocode produces.
 */
export function stripPlaceNamePrefix(label: string, placeName: string): string {
  const prefix = `${placeName.trim()}, `;
  return placeName.trim() && label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

function clean(v: string | null | undefined): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? clean(v) : null;
}
