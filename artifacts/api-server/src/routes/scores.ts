import { Router } from 'express';
import { db, scores, users, machines, venues } from '@workspace/db';
import { eq, desc, sql } from 'drizzle-orm';
import { requireAppUser } from '../middleware/requireAuth.js';
import { canRepairVenue, rankRosterForName, retireMachineIfUnused } from '../lib/venueRepair.js';
import { upsertMachineByName } from '../lib/machineUpsert.js';
import { getVenueRoster } from '../lib/pmRosterCache.js';
import { pmLocationUrl, isPmConfigured, PmApiError } from '../lib/pinballmapApi.js';
import { redactScoreLocation } from '../lib/venuePrivacy.js';
import { getAuth } from '@clerk/express';

async function resolveMinedUserId(req: any): Promise<number | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user?.id;
}

// Optional — resolves the caller's app user + role, without requiring auth.
async function resolveRequester(req: any): Promise<{ id: number; role: string } | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [user] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user;
}

const router = Router();

// GET /api/scores — all scores, newest first; ?mine=true filters to caller
router.get('/', async (req, res) => {
  try {
    const userId = req.query.mine === 'true' ? await resolveMinedUserId(req) : undefined;
    const rows = await db
      .select({
        id: scores.id,
        score: scores.score,
        playedAt: scores.playedAt,
        type: scores.type,
        venueId: scores.venueId,
        venueName: scores.venueName,
        // A score is displayed on its venue's clock, not the viewer's — see lib/scoreTime.ts.
        venueTimezone: venues.timezone,
        latitude: scores.latitude,
        longitude: scores.longitude,
        photoUrl: scores.photoUrl,
        photoThumbnail: scores.photoThumbnail,
        machineId: scores.machineId,
        machineName: machines.name,
        machineImageUrl: machines.imageUrl,
        username: users.username,
        displayName: users.displayName,
        createdAt: scores.createdAt,
        venueOwnerId: venues.ownerId,
        venuePrivacyTier: venues.privacyTier,
        venueCity: venues.city,
        venueState: venues.state,
        venueCityLat: venues.cityLat,
        venueCityLng: venues.cityLng,
        venueIsResidence: venues.isResidence,
      })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .innerJoin(users, eq(scores.userId, users.id))
      .leftJoin(venues, eq(scores.venueId, venues.id))
      .where(userId !== undefined ? eq(scores.userId, userId) : undefined)
      .orderBy(desc(scores.createdAt), desc(scores.playedAt));

    // A score's own lat/lng comes from the photo's EXIF GPS, independent of the venue record — redact
    // it the same way the venue's own address/coordinates are redacted, so a residence's exact location
    // can't leak via the score's coordinates (e.g. on the Map page) even when the venue itself is hidden.
    const requester = await resolveRequester(req);
    const isAdmin = requester?.role === 'admin';
    const redacted = rows.map(({ venueOwnerId, venuePrivacyTier, venueCity, venueState, venueCityLat, venueCityLng, ...row }) => redactScoreLocation(
      row,
      row.venueId != null
        ? { ownerId: venueOwnerId, privacyTier: venuePrivacyTier ?? 'full', city: venueCity, state: venueState, cityLat: venueCityLat, cityLng: venueCityLng }
        : undefined,
      requester?.id,
      isAdmin,
    ));

    res.json(redacted);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

// POST /api/scores — create a score
router.post('/', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const { machineId, score, playedAt, type, venueName, venueId: rawVenueId, venueHereId, venueAddress, venueLat, venueLng, venueTimezone, venuePinballMapId, latitude, longitude, photoUrl, photoThumbnail } = req.body;

  if (!machineId || !score || !playedAt) {
    return res.status(400).json({ error: 'machineId, score, and playedAt are required' });
  }

  try {
    let resolvedVenueId: number | undefined = rawVenueId ? Number(rawVenueId) : undefined;
    let resolvedVenueName: string | undefined = venueName;

    // If a venue name was provided but no existing venueId, upsert a venue record
    if (venueName && !resolvedVenueId) {
      const [venue] = await db
        .insert(venues)
        .values({
          name: venueName,
          // prefer HERE's venue centroid; fall back to photo GPS
          latitude: venueLat ?? latitude ?? null,
          longitude: venueLng ?? longitude ?? null,
          address: venueAddress ?? null,
          hereId: venueHereId ?? null,
          // Comes free with the venue suggestions the upload response already returned, so a venue
          // born from a photo knows its zone without an extra lookup. Null for a venue the user
          // typed by hand with no HERE match — backfill-venue-timezones.ts catches those.
          timezone: venueTimezone ?? null,
          pinballMapId: venuePinballMapId ?? null,
          // Whoever logs the first score at a venue is its creator, and therefore the person allowed
          // to repair its HERE / Pinball Map linkage later without needing an admin.
          createdById: appUser.id,
        })
        .onConflictDoUpdate({
          target: venues.hereId,
          set: {
            name: sql`excluded.name`,
            pinballMapId: sql`COALESCE(excluded.pinball_map_id, venues.pinball_map_id)`,
            timezone: sql`COALESCE(venues.timezone, excluded.timezone)`,
          },
        })
        .returning();
      resolvedVenueId = venue?.id;
    } else if (resolvedVenueId) {
      // Backfill pinballMapId if we now know it and the venue didn't have it
      if (venuePinballMapId) {
        await db.update(venues)
          .set({ pinballMapId: venuePinballMapId })
          .where(eq(venues.id, resolvedVenueId));
      }
      const [venue] = await db.select().from(venues).where(eq(venues.id, resolvedVenueId)).limit(1);
      resolvedVenueName = venue?.name ?? venueName;
    }

    const [row] = await db.insert(scores).values({
      userId: appUser.id,
      machineId,
      score,
      playedAt: new Date(playedAt),
      type: type ?? 'casual',
      venueId: resolvedVenueId ?? null,
      venueName: resolvedVenueName ?? null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      photoUrl: photoUrl ?? null,
      photoThumbnail: photoThumbnail ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (err) {
    console.error('Create score error:', err);
    res.status(500).json({ error: 'Failed to create score' });
  }
});

// PATCH /api/scores/:id — the score's own author, or an admin. Mirrors DELETE below: a user who
// logged a score should be able to correct it (an AI-misread machine name, a wrong score) without
// needing an admin, which was the case before.
router.patch('/:id', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const id = Number(req.params.id);
  const { score, type, playedAt, machineId, venueId } = req.body;

  const [existing] = await db.select().from(scores).where(eq(scores.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Score not found' });
  if (existing.userId !== appUser.id && appUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const updates: Record<string, any> = {};
  if (score !== undefined) updates.score = Number(score);
  if (type !== undefined) updates.type = type;
  if (playedAt !== undefined) updates.playedAt = new Date(playedAt);
  if (machineId !== undefined) updates.machineId = Number(machineId);

  // Attaching a venue after the fact. The upload flow lets you skip the venue step (and used to be
  // the only way to set one), which left those scores permanently unlinkable — no venue means no
  // Pinball Map roster, so the machine can never be verified either.
  if (venueId !== undefined) {
    if (venueId === null) {
      updates.venueId = null;
      updates.venueName = null;
    } else {
      const [venue] = await db.select().from(venues).where(eq(venues.id, Number(venueId))).limit(1);
      if (!venue) return res.status(400).json({ error: 'Venue not found' });
      updates.venueId = venue.id;
      // venueName is a denormalized snapshot the score list renders directly — keep it in step.
      updates.venueName = venue.name;
    }
  }

  const [updated] = await db.update(scores).set(updates).where(eq(scores.id, id)).returning();
  res.json(updated);
});

// DELETE /api/scores/:id — owner or admin
router.delete('/:id', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const id = Number(req.params.id);

  const [existing] = await db.select().from(scores).where(eq(scores.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Score not found' });
  if (existing.userId !== appUser.id && appUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await db.delete(scores).where(eq(scores.id, id));
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Per-score repair
//
// The venue page repairs a venue and re-syncs every score at it. This is the same machinery scoped
// to one score, for the much more common case: you open a score, notice its machine is wrong, and
// want to fix that one record. The venue's HERE / Pinball Map linkage is a prerequisite — until the
// venue resolves to a Pinball Map location there is no roster to check the machine against — so the
// status this returns drives a step-gated UI rather than offering everything at once.
// ---------------------------------------------------------------------------

// GET /api/scores/:id/repair — linkage state for this score's venue, plus ranked machine candidates
// once the venue is linked. Read-only.
router.get('/:id/repair', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const id = Number(req.params.id);

  const [row] = await db
    .select({
      scoreId: scores.id,
      userId: scores.userId,
      machineId: scores.machineId,
      machineName: machines.name,
      venueId: scores.venueId,
      venueNameSnapshot: scores.venueName,
    })
    .from(scores)
    .innerJoin(machines, eq(scores.machineId, machines.id))
    .where(eq(scores.id, id))
    .limit(1);

  if (!row) return res.status(404).json({ error: 'Score not found' });

  const isAdmin = appUser.role === 'admin';
  const canRepairScore = isAdmin || row.userId === appUser.id;
  if (!canRepairScore) return res.status(403).json({ error: 'You can only repair your own scores' });

  const base = {
    scoreId: row.scoreId,
    machineId: row.machineId,
    machineName: row.machineName,
    canRepairScore,
    pmConfigured: isPmConfigured(),
  };

  // A score can predate any venue record at all (venueName was captured but never resolved).
  if (row.venueId == null) {
    return res.json({
      ...base,
      venue: null,
      venueNameSnapshot: row.venueNameSnapshot,
      canRepairVenue: false,
      suggestions: null,
      rosterCount: 0,
      pmError: null,
    });
  }

  const [venue] = await db.select().from(venues).where(eq(venues.id, row.venueId)).limit(1);
  if (!venue) {
    return res.json({
      ...base, venue: null, venueNameSnapshot: row.venueNameSnapshot,
      canRepairVenue: false, suggestions: null, rosterCount: 0, pmError: null,
    });
  }

  const canRepairVenueHere = canRepairVenue(venue, appUser);

  let suggestions: ReturnType<typeof rankRosterForName> | null = null;
  let rosterCount = 0;
  let pmError: string | null = null;

  if (venue.pinballMapId) {
    try {
      const { xrefs } = await getVenueRoster(venue.pinballMapId);
      rosterCount = xrefs.length;
      suggestions = rankRosterForName(row.machineName, xrefs);
    } catch (err) {
      if (!(err instanceof PmApiError)) throw err;
      pmError = err.message;
    }
  }

  res.json({
    ...base,
    venue: {
      id: venue.id,
      name: venue.name,
      address: venue.address,
      hereId: venue.hereId,
      pinballMapId: venue.pinballMapId,
      pmLocationUrl: venue.pinballMapId ? pmLocationUrl(venue.pinballMapId) : null,
    },
    venueNameSnapshot: row.venueNameSnapshot,
    canRepairVenue: canRepairVenueHere,
    suggestions,
    rosterCount,
    pmError,
  });
});

// POST /api/scores/:id/repair/machine — repoint this one score at the Pinball Map machine the user
// picked. Deliberately narrower than the venue page's bulk merge: it moves exactly one score, and
// only retires the old machine row if that leaves nothing referencing it.
router.post('/:id/repair/machine', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const id = Number(req.params.id);

  const pmName = typeof req.body.pmName === 'string' ? req.body.pmName.trim() : '';
  if (!pmName) return res.status(400).json({ error: 'pmName is required' });

  const [existing] = await db.select().from(scores).where(eq(scores.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Score not found' });
  if (existing.userId !== appUser.id && appUser.role !== 'admin') {
    return res.status(403).json({ error: 'You can only repair your own scores' });
  }

  try {
    const target = await upsertMachineByName(pmName, {
      manufacturer: typeof req.body.pmManufacturer === 'string' ? req.body.pmManufacturer : undefined,
      year: Number.isFinite(Number(req.body.pmYear)) ? Number(req.body.pmYear) : undefined,
    });

    const previousMachineId = existing.machineId;
    if (target.id === previousMachineId) {
      return res.json({ machineId: target.id, machineName: target.name, changed: false, previousRetired: false });
    }

    await db.update(scores).set({ machineId: target.id }).where(eq(scores.id, id));
    const previousRetired = await retireMachineIfUnused(previousMachineId);

    res.json({ machineId: target.id, machineName: target.name, changed: true, previousRetired });
  } catch (err) {
    console.error('Score machine repair error:', err);
    res.status(500).json({ error: 'Failed to repair this score' });
  }
});

export default router;
