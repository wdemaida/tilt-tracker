import { Router } from 'express';
import { db, scores, users, machines, venues } from '@workspace/db';
import { eq, desc, sql } from 'drizzle-orm';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';
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
    const redacted = rows.map(({ venueOwnerId, venuePrivacyTier, ...row }) => redactScoreLocation(
      row,
      row.venueId != null ? { ownerId: venueOwnerId, privacyTier: venuePrivacyTier ?? 'full', city: null, state: null, cityLat: null, cityLng: null } : undefined,
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
  const { machineId, score, playedAt, type, venueName, venueId: rawVenueId, venueHereId, venueAddress, venueLat, venueLng, venuePinballMapId, latitude, longitude, photoUrl, photoThumbnail } = req.body;

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
          pinballMapId: venuePinballMapId ?? null,
        })
        .onConflictDoUpdate({
          target: venues.hereId,
          set: {
            name: sql`excluded.name`,
            pinballMapId: sql`COALESCE(excluded.pinball_map_id, venues.pinball_map_id)`,
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

// PATCH /api/scores/:id — admin-only, edit score/type/playedAt
router.patch('/:id', requireAppUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { score, type, playedAt, machineId } = req.body;

  const [existing] = await db.select().from(scores).where(eq(scores.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Score not found' });

  const updates: Record<string, any> = {};
  if (score !== undefined) updates.score = Number(score);
  if (type !== undefined) updates.type = type;
  if (playedAt !== undefined) updates.playedAt = new Date(playedAt);
  if (machineId !== undefined) updates.machineId = Number(machineId);

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

export default router;
