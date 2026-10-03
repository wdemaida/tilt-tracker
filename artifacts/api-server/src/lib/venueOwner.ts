import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { isPrivateTier } from './venuePrivacy.js';
import { canSeeVenueActivity, type ActivityVenue, type Viewer } from './venueActivity.js';
import { visibleVenueActivitySql } from './machineVenues.js';

// `ownerUsername` — the owner's @handle shown next to a private venue's name, so two people's
// "HOME" read as "HOME (@collasta)" and "HOME (@helmhead)" (Will, 2026-10-03).
//
// The rule, in one place:
//  - Only PRIVATE venues (a residence, or a restricted tier) carry it. A public venue's ownerId is
//    often just whoever typed it in first — it isn't "theirs", and naming them would be wrong.
//  - Only when the viewer may see the venue's activity (canSeeVenueActivity: the owner's "Show my
//    machines/scores publicly" switch is on, or the viewer is the owner or an admin). With the
//    switch off the owner has chosen not to have their home's activity shown to others; tying the
//    home to a person would reveal more than that choice allows. Others then get null and see just
//    the name.
//  - A disabled owner still gets their handle. Users are never deleted, a username is never reused,
//    their scores keep showing their @handle, and their profile page still resolves — the handle is
//    the only thing that tells two "HOME"s apart. Disabling an account is about signing in, not
//    about anonymising what they logged.
//
// Everything else is null. Owner and admin get the handle too; the client shows the viewer's own
// home as "HOME (you)" by comparing it with the signed-in username.

/** The JS rule, for code that already has the venue row and its owner's username. */
export function venueOwnerUsername(
  v: ActivityVenue & { ownerUsername?: string | null },
  viewer: Viewer | undefined,
): string | null {
  if (v.ownerId == null || !isPrivateTier(v)) return null;
  if (!canSeeVenueActivity(v, viewer)) return null;
  return v.ownerUsername ?? null;
}

/** The owner's username, unconditionally — only to feed venueOwnerUsername(); never sent as-is. */
export const ownerUsernameOfVenueSql = (ownerIdCol: SQLWrapper): SQL<string | null> =>
  sql<string | null>`(SELECT ou.username FROM users ou WHERE ou.id = ${ownerIdCol})`;

/**
 * SQL twin of venueOwnerUsername for a query that only has a venue id (score rows, challenge venue
 * labels): the owner's username when that venue is private and its activity is visible to the
 * viewer, else NULL. A correlated subquery, so callers needn't join venues or users.
 */
export function venueOwnerUsernameSql(viewer: Viewer | undefined, venueIdCol: SQLWrapper): SQL<string | null> {
  return sql<string | null>`(SELECT ou.username FROM venues ov JOIN users ou ON ou.id = ov.owner_id
    WHERE ov.id = ${venueIdCol} AND (ov.is_residence OR ov.privacy_tier <> 'full')
      AND ${visibleVenueActivitySql(viewer, 'ov')})`;
}
