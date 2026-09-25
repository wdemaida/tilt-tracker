import { sql, type SQL } from 'drizzle-orm';
import { scores } from '@workspace/db';
import { isPrivateTier } from './venuePrivacy.js';

// "Activity" = a venue's machine inventory and the scores logged there — everything the Edit Venue
// dialog's "Show my machines/scores publicly" switch covers. Location is a separate axis, still
// governed by the privacy tier (venuePrivacy.ts); this file never decides what address shows.
//
// The rules, in one place:
//  - The switch only takes effect on a PRIVATE venue (a residence, or a restricted tier). A public
//    venue's owner is often just whoever typed it in first, and must not be able to hide everyone's
//    scores at a bar. On a public venue the stored value is ignored.
//  - When it's off, only the venue's owner and admins see the inventory and the scores there.
//  - A score's own author always sees their own score, venue name and all — it's their record, and
//    hiding it from them in their own stats or profile would look like data loss.
//  - Everyone else doesn't see those scores anywhere (venue page, machine page, home feed, map,
//    profiles, machine leaderboards, site-wide stats). Hidden, not venue-anonymised: "a score at a
//    private venue" on a machine page would still tell people what the owner has at home.

export interface Viewer {
  id: number;
  role: string;
}

export interface ActivityVenue {
  ownerId: number | null;
  isResidence: boolean;
  privacyTier: 'full' | 'city_state' | 'hidden';
  showMachinesAndScores: boolean;
}

const isAdmin = (viewer?: Viewer) => viewer?.role === 'admin';
const isOwner = (venue: { ownerId: number | null }, viewer?: Viewer) =>
  !!viewer && venue.ownerId != null && venue.ownerId === viewer.id;

/** Whether the owner's switch is in force for this venue — off, and on a private venue. */
export function activityRestricted(venue: ActivityVenue): boolean {
  return isPrivateTier(venue) && !venue.showMachinesAndScores;
}

/** Whether this viewer may see the venue's inventory, machine count and (other people's) scores. */
export function canSeeVenueActivity(venue: ActivityVenue, viewer?: Viewer): boolean {
  return !activityRestricted(venue) || isAdmin(viewer) || isOwner(venue, viewer);
}

/** Whether this viewer may see one score. `venue` is the score's venue, or null for none. */
export function canSeeScore(score: { userId: number }, venue: ActivityVenue | null | undefined, viewer?: Viewer): boolean {
  if (!venue) return true;
  if (viewer && score.userId === viewer.id) return true;
  return canSeeVenueActivity(venue, viewer);
}

/**
 * Whether a venue's machines come from an owner-managed inventory rather than Pinball Map. Private
 * venues can't be linked to Pinball Map (linkage would publish where they are), so for them the
 * inventory is the roster.
 */
export function usesOwnerInventory(venue: { isResidence: boolean; privacyTier: 'full' | 'city_state' | 'hidden' }): boolean {
  return isPrivateTier(venue);
}

/** Who may add/remove machines: the venue's owner and admins, and only on a private venue. */
export function canManageInventory(
  venue: { ownerId: number | null; isResidence: boolean; privacyTier: 'full' | 'city_state' | 'hidden' },
  viewer?: Viewer,
): boolean {
  return usesOwnerInventory(venue) && (isAdmin(viewer) || isOwner(venue, viewer));
}

/**
 * Who may open the Edit Venue dialog — the same rule PATCH /api/venues/:id enforces. Sent to the
 * client as `canEdit` so the venue payloads no longer need to carry `ownerId`.
 */
export function canEditVenue(venue: { ownerId: number | null }, viewer?: Viewer): boolean {
  return isAdmin(viewer) || isOwner(venue, viewer);
}

/**
 * SQL twin of canSeeScore, for any query whose FROM includes `scores`. Keep the two in step — the
 * unit tests pin the JS rule and check this renders each branch.
 *
 * A score is visible when it has no venue, when the viewer wrote it, or when its venue is not a
 * private venue with the switch off that the viewer doesn't own. Admins see everything. Written as a
 * correlated NOT EXISTS so callers don't need to join venues (several already do, under their own
 * aliases).
 */
export function visibleScoreSql(viewer?: Viewer): SQL {
  if (isAdmin(viewer)) return sql`true`;
  const authorClause = viewer ? sql` OR ${scores.userId} = ${viewer.id}` : sql``;
  const ownerClause = viewer ? sql` AND hv.owner_id IS DISTINCT FROM ${viewer.id}` : sql``;
  return sql`(${scores.venueId} IS NULL${authorClause} OR NOT EXISTS (
    SELECT 1 FROM venues hv
    WHERE hv.id = ${scores.venueId}
      AND hv.show_machines_and_scores = false
      AND (hv.is_residence OR hv.privacy_tier <> 'full')${ownerClause}
  ))`;
}
