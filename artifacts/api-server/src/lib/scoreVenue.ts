// The venue a new score is filed under (`POST /api/scores`): an existing venue by id, or one
// upserted from what the venue step picked — a HERE place (conflict-matched on here_id) or a bare
// name. Also where a Pinball Map id resolved in the venue step (nearby suggestions, or the lazy
// lookup on a Places pick — `GET /api/venues/pm-match`) is stored, under pmIdToPersist's rules.
// Split out of the route so test-score-venue-pm.ts can exercise it against the dev database.

import { db, venues } from '@workspace/db';
import { eq, sql, and } from 'drizzle-orm';
import { mayRevealByLocation } from './venuePrivacy.js';
import { pmIdToPersist } from './pmMatch.js';

export interface ScoreVenueInput {
  venueName?: string;
  venueId?: number | string | null;
  venueHereId?: string | null;
  venueAddress?: string | null;
  venueLat?: number | null;
  venueLng?: number | null;
  venueTimezone?: string | null;
  venuePinballMapId?: unknown;
  /** The photo's GPS — the venue's position when HERE gave none. */
  latitude?: number | null;
  longitude?: number | null;
}

export async function resolveScoreVenue(
  input: ScoreVenueInput,
  appUser: { id: number; role: string },
): Promise<{ venueId: number | undefined; venueName: string | undefined }> {
  const {
    venueName, venueId: rawVenueId, venueHereId, venueAddress, venueLat, venueLng, venueTimezone, venuePinballMapId,
    latitude, longitude,
  } = input;
  let resolvedVenueId: number | undefined = rawVenueId ? Number(rawVenueId) : undefined;
  let resolvedVenueName: string | undefined = venueName;

  // If a venue name was provided but no existing venueId, upsert a venue record
  if (venueName && !resolvedVenueId) {
    // The upsert below conflict-matches on here_id: it would file this score under whatever venue
    // holds that HERE place, and rename it to what the client sent. The HERE id comes from HERE's
    // POIs around the user's photo, so landing on someone else's private venue that way would both
    // rename their home and reveal — by location — that it's there. A private venue can't normally
    // hold a HERE id (linking is refused, and switching to private clears it), but a legacy row
    // could. Then this becomes an ordinary new venue without the HERE id: nothing renamed, nothing
    // revealed. Logging at a private venue on purpose is still open to anyone — by its exact name.
    let hereIdForInsert: string | null = venueHereId ?? null;
    let holder: typeof venues.$inferSelect | undefined;
    if (venueHereId) {
      [holder] = await db.select().from(venues).where(eq(venues.hereId, venueHereId)).limit(1);
      if (holder && !mayRevealByLocation(holder, appUser)) hereIdForInsert = null;
    }
    // The Pinball Map id the venue step resolved (nearby suggestions, or the lazy lookup on a
    // Places pick — GET /api/venues/pm-match). A new venue is linked from day one; a venue that
    // already holds this HERE id keeps any link it has, and a private one never gets one.
    const pmIdForInsert = pmIdToPersist(venuePinballMapId, hereIdForInsert && holder ? holder : null);
    const [venue] = await db
      .insert(venues)
      .values({
        name: venueName,
        // prefer HERE's venue centroid; fall back to photo GPS
        latitude: venueLat ?? latitude ?? null,
        longitude: venueLng ?? longitude ?? null,
        address: venueAddress ?? null,
        hereId: hereIdForInsert,
        // Comes free with the venue suggestions the upload response already returned, so a venue
        // born from a photo knows its zone without an extra lookup. Null for a venue the user
        // typed by hand with no HERE match — backfill-venue-timezones.ts catches those.
        timezone: venueTimezone ?? null,
        pinballMapId: pmIdForInsert,
        // Whoever logs the first score at a venue is its creator, and therefore the person allowed
        // to repair its HERE / Pinball Map linkage later without needing an admin.
        createdById: appUser.id,
      })
      .onConflictDoUpdate({
        target: venues.hereId,
        set: {
          name: sql`excluded.name`,
          // Existing link first: a client-sent id fills a gap, never replaces a link.
          pinballMapId: sql`COALESCE(venues.pinball_map_id, excluded.pinball_map_id)`,
          timezone: sql`COALESCE(venues.timezone, excluded.timezone)`,
        },
      })
      .returning();
    resolvedVenueId = venue?.id;
  } else if (resolvedVenueId) {
    // Anyone may log at any venue, private ones included (the owner's rule for home venues).
    const [target] = await db.select().from(venues).where(eq(venues.id, resolvedVenueId)).limit(1);
    // Backfill pinballMapId if we now know it and the venue didn't have it — never onto a private
    // venue, which carries no Pinball Map linkage, and never over an existing link (pmIdToPersist).
    // It used to overwrite unconditionally, despite this comment. The IS NULL guard covers a link
    // made concurrently.
    const backfillPmId = target ? pmIdToPersist(venuePinballMapId, target) : null;
    if (backfillPmId != null) {
      await db.update(venues)
        .set({ pinballMapId: backfillPmId })
        .where(and(eq(venues.id, resolvedVenueId), sql`${venues.pinballMapId} is null`));
    }
    const [venue] = await db.select().from(venues).where(eq(venues.id, resolvedVenueId)).limit(1);
    resolvedVenueName = venue?.name ?? venueName;
  }

  return { venueId: resolvedVenueId, venueName: resolvedVenueName };
}
