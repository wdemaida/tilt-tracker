import { Router } from 'express';
import { db, scores, venues, machines, users } from '@workspace/db';
import { eq, desc, count, sql, and } from 'drizzle-orm';
import { getPmMachinesAtLocation } from '../lib/pinballmapApi.js';
import { syncVenueMachineHistory, getFormerMachines } from '../lib/venueHistory.js';
import { geocodeAddress } from '../lib/hereApi.js';
import { redactVenue, canSeeFullVenue } from '../lib/venuePrivacy.js';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';
import { getAuth } from '@clerk/express';

async function resolveMinedUserId(req: any): Promise<number | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user?.id;
}

// Optional — resolves the caller's app user + role for privacy redaction, without requiring auth.
async function resolveRequester(req: any): Promise<{ id: number; role: string } | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [user] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user;
}

// Strips the redaction-only fields (city/state/cityLat/cityLng) before a venue goes out over the wire —
// they exist purely to compute the redacted address/coordinates server-side and shouldn't leak beyond that.
function toPublicVenue<T extends { city?: unknown; state?: unknown; cityLat?: unknown; cityLng?: unknown }>(venue: T) {
  const { city, state, cityLat, cityLng, ...rest } = venue;
  return rest;
}

const router = Router();

// GET /api/venues — all venues with score/machine counts; ?mine=true filters to caller
router.get('/', async (req, res) => {
  try {
    const userId = req.query.mine === 'true' ? await resolveMinedUserId(req) : undefined;
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        address: venues.address,
        latitude: venues.latitude,
        longitude: venues.longitude,
        pinballMapId: venues.pinballMapId,
        pmMachineCount: venues.pmMachineCount,
        ownerId: venues.ownerId,
        isResidence: venues.isResidence,
        privacyTier: venues.privacyTier,
        city: venues.city,
        state: venues.state,
        cityLat: venues.cityLat,
        cityLng: venues.cityLng,
        scoreCount: count(scores.id),
        machineCount: sql<number>`count(distinct ${scores.machineId})`,
      })
      .from(venues)
      .leftJoin(scores, eq(scores.venueId, venues.id))
      .where(userId !== undefined ? eq(scores.userId, userId) : undefined)
      .groupBy(venues.id)
      .orderBy(desc(count(scores.id)));

    const requester = await resolveRequester(req);
    const isAdmin = requester?.role === 'admin';
    const redacted = rows.map(r => toPublicVenue(redactVenue(r, requester?.id, isAdmin)));

    res.json(redacted);
  } catch (err) {
    console.error('Venues list error:', err);
    res.status(500).json({ error: 'Failed to fetch venues' });
  }
});

// POST /api/venues — create a venue upfront (used by the "Add custom venue" flow, e.g. a residence)
router.post('/', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const { name, address, isResidence, privacyTier } = req.body;

  if (!name || !address) {
    return res.status(400).json({ error: 'name and address are required' });
  }
  const tier = ['full', 'city_state', 'hidden'].includes(privacyTier) ? privacyTier : 'full';

  try {
    const geocoded = await geocodeAddress(address);
    let cityLat: number | null = null;
    let cityLng: number | null = null;
    if (tier === 'city_state' && geocoded?.city && geocoded?.state) {
      const cityGeocode = await geocodeAddress(`${geocoded.city}, ${geocoded.state}`);
      cityLat = cityGeocode?.lat ?? null;
      cityLng = cityGeocode?.lng ?? null;
    }

    const [venue] = await db.insert(venues).values({
      name,
      address: geocoded?.label ?? address,
      latitude: geocoded?.lat ?? null,
      longitude: geocoded?.lng ?? null,
      city: geocoded?.city ?? null,
      state: geocoded?.state ?? null,
      cityLat,
      cityLng,
      ownerId: appUser.id,
      isResidence: !!isResidence,
      privacyTier: tier,
    }).returning();

    // Requester is the owner — return the full, unredacted row.
    res.status(201).json(toPublicVenue(venue));
  } catch (err) {
    console.error('Create venue error:', err);
    res.status(500).json({ error: 'Failed to create venue' });
  }
});

// GET /api/venues/pm-machines/:pmId — PM machine list without needing a DB venue record
router.get('/pm-machines/:pmId', async (req, res) => {
  const pmId = Number(req.params.pmId);
  if (!pmId) return res.status(400).json({ error: 'Invalid pmId' });
  try {
    const xrefs = await getPmMachinesAtLocation(pmId);
    const pmMachines = xrefs.map(x => ({
      xrefId: x.id,
      id: x.machine.id,
      name: x.machine.name,
      manufacturer: x.machine.manufacturer,
      year: x.machine.year,
    }));
    res.json({ pmMachines });
  } catch (err) {
    console.error('PM machines by pmId error:', err);
    res.status(500).json({ error: 'Failed to fetch PM machines' });
  }
});

// GET /api/venues/:id/machines — machines at a venue (ours + Pinball Map)
router.get('/:id/machines', async (req, res) => {
  const id = Number(req.params.id);
  const { userId: clerkId } = getAuth(req);
  try {
    const [venue] = await db.select().from(venues).where(eq(venues.id, id)).limit(1);
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    // Resolve current user (optional — for per-user play counts and privacy redaction)
    let appUserId: number | undefined;
    let isAdmin = false;
    if (clerkId) {
      const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
      appUserId = u?.id;
      isAdmin = u?.role === 'admin';
    }

    // Machines played at this venue by the current user (for play count badge)
    const ownMachines = await db
      .select({
        id: machines.id,
        name: machines.name,
        manufacturer: machines.manufacturer,
        year: machines.year,
        bestScore: sql<number>`max(${scores.score})`,
        playCount: count(scores.id),
      })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .where(appUserId
        ? and(eq(scores.venueId, id), eq(scores.userId, appUserId))
        : eq(scores.venueId, id))
      .groupBy(machines.id, machines.name, machines.manufacturer, machines.year)
      .orderBy(desc(sql<number>`max(${scores.score})`));

    // All machine names played at this venue by anyone (for TT tag)
    const ttRows = await db
      .select({ name: machines.name })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .where(eq(scores.venueId, id))
      .groupBy(machines.name);
    const ttMachineNames = ttRows.map(r => r.name);

    let pmMachines: Array<{ xrefId: number; id: number; name: string; manufacturer?: string; year?: number }> = [];
    let formerMachines: Awaited<ReturnType<typeof getFormerMachines>> = [];
    if (venue.pinballMapId) {
      const xrefs = await getPmMachinesAtLocation(venue.pinballMapId);
      pmMachines = xrefs.map(x => ({
        xrefId: x.id,
        id: x.machine.id,
        name: x.machine.name,
        manufacturer: x.machine.manufacturer,
        year: x.machine.year,
      }));
      if (venue.pmMachineCount !== pmMachines.length) {
        await db.update(venues).set({ pmMachineCount: pmMachines.length }).where(eq(venues.id, id));
      }
      // Best-effort — a history sync failure shouldn't break the machine list the page needs
      await syncVenueMachineHistory(id, xrefs).catch(err => console.error('Venue history sync error:', err));
      formerMachines = await getFormerMachines(id);
    }

    const redactedVenue = toPublicVenue(redactVenue(venue, appUserId, isAdmin));
    res.json({ venue: redactedVenue, ownMachines, pmMachines, ttMachineNames, formerMachines });
  } catch (err) {
    console.error('Venue machines error:', err);
    res.status(500).json({ error: 'Failed to fetch venue machines' });
  }
});

// GET /api/venues/:id/scores — all individual score entries at a venue
router.get('/:id/scores', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [venue] = await db.select({
      id: venues.id,
      name: venues.name,
      address: venues.address,
      latitude: venues.latitude,
      longitude: venues.longitude,
      ownerId: venues.ownerId,
      isResidence: venues.isResidence,
      privacyTier: venues.privacyTier,
      city: venues.city,
      state: venues.state,
      cityLat: venues.cityLat,
      cityLng: venues.cityLng,
    }).from(venues).where(eq(venues.id, id)).limit(1);
    if (!venue) return void res.status(404).json({ error: 'Venue not found' });

    const rows = await db
      .select({
        id: scores.id,
        score: scores.score,
        playedAt: scores.playedAt,
        type: scores.type,
        machineName: machines.name,
        username: users.username,
        displayName: users.displayName,
      })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .innerJoin(users, eq(scores.userId, users.id))
      .where(eq(scores.venueId, id))
      .orderBy(desc(scores.playedAt));

    const requester = await resolveRequester(req);
    const isAdmin = requester?.role === 'admin';
    res.json({ venue: toPublicVenue(redactVenue(venue, requester?.id, isAdmin)), scores: rows });
  } catch (err) {
    console.error('Venue scores error:', err);
    res.status(500).json({ error: 'Failed to fetch venue scores' });
  }
});

// PATCH /api/venues/:id — admin, or the venue's owner editing their own venue
router.patch('/:id', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const id = Number(req.params.id);
  const { name, address, isResidence, privacyTier } = req.body;

  const [existing] = await db.select().from(venues).where(eq(venues.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Venue not found' });

  const isAdmin = appUser.role === 'admin';
  const isOwner = existing.ownerId != null && existing.ownerId === appUser.id;
  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'Not authorized to edit this venue' });
  }

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (isResidence !== undefined) updates.isResidence = !!isResidence;
  if (privacyTier !== undefined && ['full', 'city_state', 'hidden'].includes(privacyTier)) {
    updates.privacyTier = privacyTier;
  }

  const addressChanged = address !== undefined && address !== existing.address;
  if (addressChanged) updates.address = address === '' ? null : address;

  const nextTier = updates.privacyTier ?? existing.privacyTier;
  const needsCityCentroid = nextTier === 'city_state' && existing.cityLat == null;

  try {
    if (address && (addressChanged || needsCityCentroid)) {
      // Address changed (or we're missing a city centroid this venue never needed before) — re-geocode.
      const geocoded = await geocodeAddress(address);
      if (geocoded) {
        updates.address = geocoded.label;
        updates.latitude = geocoded.lat;
        updates.longitude = geocoded.lng;
        updates.city = geocoded.city;
        updates.state = geocoded.state;
        if (nextTier === 'city_state' && geocoded.city && geocoded.state) {
          const cityGeocode = await geocodeAddress(`${geocoded.city}, ${geocoded.state}`);
          updates.cityLat = cityGeocode?.lat ?? null;
          updates.cityLng = cityGeocode?.lng ?? null;
        }
      }
    } else if (needsCityCentroid && existing.city && existing.state) {
      // Tier flipped to city_state with no address change — resolve a centroid from the city/state on file.
      const cityGeocode = await geocodeAddress(`${existing.city}, ${existing.state}`);
      updates.cityLat = cityGeocode?.lat ?? null;
      updates.cityLng = cityGeocode?.lng ?? null;
    }

    const [updated] = await db.update(venues).set(updates).where(eq(venues.id, id)).returning();
    res.json(toPublicVenue(redactVenue(updated, appUser.id, isAdmin)));
  } catch (err) {
    console.error('Update venue error:', err);
    res.status(500).json({ error: 'Failed to update venue' });
  }
});

// DELETE /api/venues/:id — admin-only, blocked if venue has scores
router.delete('/:id', requireAppUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  const [existing] = await db.select().from(venues).where(eq(venues.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Venue not found' });

  const [{ total }] = await db.select({ total: count() }).from(scores).where(eq(scores.venueId, id));
  if (total > 0) {
    return res.status(409).json({ error: `Cannot delete — ${total} score${total === 1 ? '' : 's'} are logged at this venue` });
  }

  await db.delete(venues).where(eq(venues.id, id));
  res.status(204).send();
});

export default router;
