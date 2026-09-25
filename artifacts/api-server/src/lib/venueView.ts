import { redactVenue, canSeeFullVenue, isPrivateTier } from './venuePrivacy.js';
import { venueListFlags } from './venueAddress.js';
import { canSeeVenueActivity, canEditVenue, usesOwnerInventory, type Viewer } from './venueActivity.js';

// What a venue looks like on the wire, per requester. Two shapes:
//  - someone else's private (home) venue — the minimum its card needs: name, whatever address the
//    tier allows ("City, ST" for city_state, nothing for hidden), and counts. No ownerId, privacy
//    tier, timezone, last-played time or linkage: the venues list goes to anyone, signed out
//    included, and none of those are needed to render the card.
//  - everything else — the redacted row as before, minus ownerId/createdById (the client gets
//    `canEdit` / `canRepair` instead) and the city-centroid fields redaction works from.

type Tier = 'full' | 'city_state' | 'hidden';

interface VenueRow {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  pinballMapId: number | null;
  pmMachineCount: number | null;
  ownerId: number | null;
  createdById: number | null;
  isResidence: boolean;
  privacyTier: Tier;
  city: string | null;
  state: string | null;
  cityLat: number | null;
  cityLng: number | null;
  timezone: string | null;
  showMachinesAndScores: boolean;
}

export interface MachineCounts {
  /** Distinct machines among the scores this requester can see there. */
  playedMachineCount: number;
  /** Machines currently in the owner-managed inventory. */
  inventoryCount: number;
  /** Whether the owner has ever managed the inventory (any row, current or removed). */
  inventoryManaged: boolean;
}

/**
 * The machine count a venue shows. Public venues: machines with TiltTrack scores there (the "X" of
 * "X/Y", Y being Pinball Map's roster). A private venue's roster is its owner-managed inventory, so
 * once the owner has started one it *is* the count — "1 Machine" the day a Theater of Magic arrives,
 * scores or not. A machine that was scored there but isn't in the inventory (sold, or logged by a
 * friend before it was listed) doesn't count, the same way a machine gone from Pinball Map's roster
 * drops out of Y; it still shows under the scores. A home venue whose owner has never touched the
 * inventory keeps counting played machines as before, rather than suddenly reading "0".
 */
export function displayedMachineCount(v: { isResidence: boolean; privacyTier: Tier } & MachineCounts): number {
  return usesOwnerInventory(v) && v.inventoryManaged ? v.inventoryCount : v.playedMachineCount;
}

/** Flags every venue payload carries, computed for this requester. */
function venueFlags(v: VenueRow & MachineCounts, requester: Viewer | undefined) {
  const activityVisible = canSeeVenueActivity(v, requester);
  return {
    canEdit: canEditVenue(v, requester),
    isPrivate: isPrivateTier(v),
    ownerInventory: usesOwnerInventory(v),
    /** The owner switched "Show my machines/scores publicly" off and this requester isn't exempt. */
    activityHidden: !activityVisible,
    machineCount: activityVisible ? displayedMachineCount(v) : null,
  };
}

function isOthersPrivate(v: VenueRow, requester: Viewer | undefined): boolean {
  return isPrivateTier(v) && !canSeeFullVenue(v, requester?.id, requester?.role === 'admin');
}

function fullView(v: VenueRow, requester: Viewer | undefined) {
  const {
    ownerId: _o, createdById: _c, city: _ci, state: _s, cityLat: _la, cityLng: _ln, showMachinesAndScores, ...rest
  } = redactVenue(v, requester?.id, requester?.role === 'admin');
  return {
    ...rest,
    // A private venue's machines don't come from Pinball Map, so there's no "of Y" to show.
    pmMachineCount: usesOwnerInventory(v) ? null : rest.pmMachineCount,
    // Only editors need the switch's stored value (to seed the Edit Venue dialog).
    ...(canEditVenue(v, requester) ? { showMachinesAndScores } : {}),
  };
}

/** One row of GET /api/venues. */
export function venueListRow(
  r: VenueRow & MachineCounts & { scoreCount: number; lastPlayedAt: Date | string | null },
  requester: Viewer | undefined,
) {
  const flags = venueFlags(r, requester);
  const listFlags = venueListFlags(r, requester);
  const scoreCount = Number(r.scoreCount);
  if (isOthersPrivate(r, requester)) {
    const red = redactVenue(r, requester?.id, false);
    return {
      id: r.id,
      name: r.name,
      address: red.address,
      isResidence: r.isResidence,
      pinballMapId: red.pinballMapId,
      pmMachineCount: null,
      scoreCount,
      ...flags,
      ...listFlags,
    };
  }
  const { playedMachineCount: _p, inventoryCount: _i, inventoryManaged: _m, scoreCount: _sc, lastPlayedAt, ...row } = r;
  return { ...fullView(row, requester), scoreCount, lastPlayedAt, ...flags, ...listFlags };
}

/**
 * The venue object on GET /api/venues/:id/machines. Someone else's private venue gets only what the
 * machines modal and the score wizard read: name, and the tier-redacted address/position/zone.
 * Everyone else gets the redacted row as before, minus ownerId/createdById.
 */
export function venueMachinesView<T extends VenueRow & { createdAt?: unknown }>(v: T, requester: Viewer | undefined) {
  if (isOthersPrivate(v, requester)) {
    const red = redactVenue(v, requester?.id, false);
    return {
      id: v.id, name: v.name, address: red.address, latitude: red.latitude, longitude: red.longitude,
      timezone: red.timezone, isResidence: v.isResidence,
    };
  }
  const {
    ownerId: _o, createdById: _c, city: _ci, state: _s, cityLat: _la, cityLng: _ln, ...rest
  } = redactVenue(v, requester?.id, requester?.role === 'admin');
  return rest;
}

/** The venue object on GET /api/venues/:id/scores (the venue detail page). */
export function venueDetailView(v: VenueRow & MachineCounts, requester: Viewer | undefined) {
  const flags = venueFlags(v, requester);
  if (isOthersPrivate(v, requester)) {
    const red = redactVenue(v, requester?.id, false);
    return {
      id: v.id,
      name: v.name,
      address: red.address,
      // The map thumbnail: the city centroid for city_state, nothing for hidden — as before.
      latitude: red.latitude,
      longitude: red.longitude,
      timezone: red.timezone,
      isResidence: v.isResidence,
      pinballMapId: red.pinballMapId,
      pmMachineCount: null,
      ...flags,
    };
  }
  const { playedMachineCount: _p, inventoryCount: _i, inventoryManaged: _m, ...row } = v;
  return { ...fullView(row, requester), ...flags };
}
