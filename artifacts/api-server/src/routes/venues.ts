import { Router } from 'express';
import { db, scores, venues, machines, users } from '@workspace/db';
import { eq, desc, count, sql, and, max } from 'drizzle-orm';
import {
  findNearestPmLocations, searchPmLocationsByName, getPmLocation,
  pmLocationUrl, isPmConfigured, PmApiError, type PmLocation,
} from '../lib/pinballmapApi.js';
import { syncVenueMachineHistory, getFormerMachines } from '../lib/venueHistory.js';
import { geocodeAddress, autosuggestAddress, findVenueByName } from '../lib/hereApi.js';
import { redactVenue, canSeeFullVenue } from '../lib/venuePrivacy.js';
import { canRepairVenue, buildResyncPreview, applyResync, reenrichMachines } from '../lib/venueRepair.js';
import { getVenueRoster } from '../lib/pmRosterCache.js';
import { findDuplicateVenues } from '../lib/venueDedup.js';
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
        // When anyone last *played* here, not when the score was uploaded — a batch of old photos
        // shouldn't make a venue look recently visited. ScoreVenuePicker sorts on this; the list
        // itself stays ordered by play count, which is what the Venues page wants.
        lastPlayedAt: max(scores.playedAt),
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
  const { name, address, isResidence, privacyTier, allowDuplicate } = req.body;

  if (!name || !address) {
    return res.status(400).json({ error: 'name and address are required' });
  }
  const tier = ['full', 'city_state', 'hidden'].includes(privacyTier) ? privacyTier : 'full';

  try {
    const geocoded = await geocodeAddress(address);

    // Nothing stopped a second "headquarters" being created 92m from the real one: the unique index
    // on here_id only covers upload-flow venues, and this route never set one. Answering with the
    // candidates rather than refusing keeps genuine same-name venues (a chain's other branch) creatable —
    // the client re-submits with allowDuplicate once the user confirms. See venueDedup.ts.
    if (!allowDuplicate) {
      const duplicates = await findDuplicateVenues({
        name,
        latitude: geocoded?.lat ?? null,
        longitude: geocoded?.lng ?? null,
      });
      if (duplicates.length > 0) {
        return res.status(409).json({
          error: duplicates.length === 1
            ? `"${duplicates[0].name}" already exists${duplicates[0].distance != null ? ` ${duplicates[0].distance}m away` : ''}.`
            : `${duplicates.length} venues with this name already exist nearby.`,
          code: 'duplicate_venue',
          candidates: duplicates,
        });
      }
    }

    let cityLat: number | null = null;
    let cityLng: number | null = null;
    if (tier === 'city_state' && geocoded?.city && geocoded?.state) {
      const cityGeocode = await geocodeAddress(`${geocoded.city}, ${geocoded.state}`);
      cityLat = cityGeocode?.lat ?? null;
      cityLng = cityGeocode?.lng ?? null;
    }

    // Resolve a real HERE place so the venue carries a here_id from birth. Without one the unique
    // index can never fire for it (Postgres treats NULL != NULL), which is half of why duplicates
    // were possible at all. Best-effort: a venue with no HERE match is still worth creating, and the
    // name+proximity check above remains the guard that actually holds.
    let hereId: string | null = null;
    if (geocoded) {
      const [match] = await findVenueByName(name, geocoded.lat, geocoded.lng, 5);
      // Only adopt a close, confidently-matched place — a 1.5km "nearby" hit is a different venue.
      if (match?.hereId && match.distance < 250) {
        const existing = await db.select({ id: venues.id }).from(venues)
          .where(eq(venues.hereId, match.hereId)).limit(1);
        if (existing.length === 0) hereId = match.hereId;
      }
    }

    const [venue] = await db.insert(venues).values({
      name,
      address: geocoded?.label ?? address,
      latitude: geocoded?.lat ?? null,
      longitude: geocoded?.lng ?? null,
      hereId,
      city: geocoded?.city ?? null,
      state: geocoded?.state ?? null,
      cityLat,
      cityLng,
      ownerId: appUser.id,
      createdById: appUser.id,
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

// GET /api/venues/address-autocomplete?q=... — address-as-you-type suggestions for the "Add custom
// venue" form. Optional lat/lng bias the results toward the caller's current location.
router.get('/address-autocomplete', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const lat = req.query.lat ? Number(req.query.lat) : undefined;
  const lng = req.query.lng ? Number(req.query.lng) : undefined;
  try {
    const suggestions = await autosuggestAddress(q, lat != null && lng != null ? { lat, lng } : undefined);
    res.json(suggestions);
  } catch (err) {
    console.error('Address autocomplete error:', err);
    res.status(500).json({ error: 'Failed to fetch address suggestions' });
  }
});

// GET /api/venues/pm-machines/:pmId — PM machine list without needing a DB venue record
router.get('/pm-machines/:pmId', async (req, res) => {
  const pmId = Number(req.params.pmId);
  if (!pmId) return res.status(400).json({ error: 'Invalid pmId' });
  try {
    const { xrefs } = await getVenueRoster(pmId);
    const pmMachines = xrefs.map(x => ({
      xrefId: x.id,
      id: x.machine.id,
      name: x.machine.name,
      manufacturer: x.machine.manufacturer,
      year: x.machine.year,
    }));
    res.json({ pmMachines });
  } catch (err) {
    if (err instanceof PmApiError) {
      console.error('PM machines by pmId error:', err.kind, err.message);
      return res.status(502).json({ error: err.message, code: `PM_${err.kind.toUpperCase()}` });
    }
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
    // Surfaced to the client so the UI can say "Pinball Map is unreachable" rather than implying the
    // venue has no machines — the silent `return []` this used to rely on is exactly what hid the
    // API-token cutover for as long as it did.
    let pmError: string | null = null;
    if (venue.pinballMapId) {
      try {
        const roster = await getVenueRoster(venue.pinballMapId);
        const xrefs = roster.xrefs;
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
        // Only advance machine history when the roster is genuinely new. A cache hit carries no new
        // information, and re-running the diff on every page view would churn lastSeenAt timestamps
        // (and re-upsert every machine row) for no gain.
        if (!roster.fromCache) {
          // Best-effort — a history sync failure shouldn't break the machine list the page needs
          await syncVenueMachineHistory(id, xrefs).catch(err => console.error('Venue history sync error:', err));
        }
        if (roster.stale) {
          pmError = 'Pinball Map is unreachable — showing the last roster we saw.';
        }
      } catch (err) {
        if (!(err instanceof PmApiError)) throw err;
        console.error('PM machine fetch failed:', err.kind, err.message);
        pmError = err.message;
      }
      formerMachines = await getFormerMachines(id);
    }

    const redactedVenue = toPublicVenue(redactVenue(venue, appUserId, isAdmin));
    res.json({
      venue: redactedVenue, ownMachines, pmMachines, ttMachineNames, formerMachines, pmError,
      pmLocationUrl: venue.pinballMapId ? pmLocationUrl(venue.pinballMapId) : null,
    });
  } catch (err) {
    console.error('Venue machines error:', err);
    res.status(500).json({ error: 'Failed to fetch venue machines' });
  }
});

// GET /api/venues/:id/scores — all individual score entries at a venue; ?mine=true filters to caller
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
      pmMachineCount: venues.pmMachineCount,
    }).from(venues).where(eq(venues.id, id)).limit(1);
    if (!venue) return void res.status(404).json({ error: 'Venue not found' });

    const mineUserId = req.query.mine === 'true' ? await resolveMinedUserId(req) : undefined;
    const rows = await db
      .select({
        id: scores.id,
        score: scores.score,
        playedAt: scores.playedAt,
        type: scores.type,
        machineId: scores.machineId,
        machineName: machines.name,
        username: users.username,
        displayName: users.displayName,
      })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .innerJoin(users, eq(scores.userId, users.id))
      .where(mineUserId !== undefined ? and(eq(scores.venueId, id), eq(scores.userId, mineUserId)) : eq(scores.venueId, id))
      .orderBy(desc(scores.playedAt));

    const requester = await resolveRequester(req);
    const isAdmin = requester?.role === 'admin';
    const machineCount = new Set(rows.map(r => r.machineId)).size;
    res.json({ venue: { ...toPublicVenue(redactVenue(venue, requester?.id, isAdmin)), machineCount }, scores: rows });
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

// ---------------------------------------------------------------------------
// Venue repair
//
// Covers the case where a venue never resolved on upload — no hereId, no Pinball Map link — and the
// score rows behind it are consequently pointing at unenriched machine names. Each step is manual
// and idempotent so it can be retried: resolve the address in HERE, link Pinball Map, then re-sync
// the scores already logged there.
// ---------------------------------------------------------------------------

// Loads the venue and checks the caller may repair it. Returns null after responding on failure.
async function loadRepairableVenue(req: any, res: any) {
  const appUser = req.appUser;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid venue id' });
    return null;
  }
  const [venue] = await db.select().from(venues).where(eq(venues.id, id)).limit(1);
  if (!venue) {
    res.status(404).json({ error: 'Venue not found' });
    return null;
  }
  if (!canRepairVenue(venue, appUser)) {
    res.status(403).json({ error: 'Only an admin, the venue owner, or whoever added this venue can repair it' });
    return null;
  }
  return venue;
}

function pmFailure(res: any, err: unknown, fallback: string) {
  if (err instanceof PmApiError) {
    return res.status(502).json({ error: err.message, code: `PM_${err.kind.toUpperCase()}` });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

// GET /api/venues/:id/repair — what the repair panel needs to render: current linkage state, who may
// act, and whether the Pinball Map integration is even configured on this server.
router.get('/:id/repair', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;

  const appUser = (req as any).appUser;
  const [{ total }] = await db.select({ total: count() }).from(scores).where(eq(scores.venueId, venue.id));
  const [{ mine }] = await db
    .select({ mine: count() })
    .from(scores)
    .where(and(eq(scores.venueId, venue.id), eq(scores.userId, appUser.id)));

  res.json({
    venueId: venue.id,
    name: venue.name,
    address: venue.address,
    latitude: venue.latitude,
    longitude: venue.longitude,
    hereId: venue.hereId,
    pinballMapId: venue.pinballMapId,
    pmMachineCount: venue.pmMachineCount,
    pmLocationUrl: venue.pinballMapId ? pmLocationUrl(venue.pinballMapId) : null,
    pmConfigured: isPmConfigured(),
    isAdmin: appUser.role === 'admin',
    scoreCount: Number(total),
    myScoreCount: Number(mine),
  });
});

// POST /api/venues/:id/repair/here — re-run the HERE lookup for a venue whose address was filled in
// after the fact. Geocodes the address for coordinates, then searches HERE by venue name anchored at
// those coordinates to recover the hereId the upload flow failed to attach.
router.post('/:id/repair/here', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;

  if (!venue.address) {
    return res.status(400).json({ error: 'Add an address to this venue first — HERE needs somewhere to search from' });
  }

  const appUser = (req as any).appUser;

  try {
    const geocoded = await geocodeAddress(venue.address);
    const lat = geocoded?.lat ?? venue.latitude;
    const lng = geocoded?.lng ?? venue.longitude;
    if (lat == null || lng == null) {
      return res.status(422).json({ error: `HERE could not geocode "${venue.address}"` });
    }

    const candidates = await findVenueByName(venue.name, lat, lng);

    const updates: Record<string, any> = {};
    if (geocoded) {
      updates.address = geocoded.label;
      updates.latitude = geocoded.lat;
      updates.longitude = geocoded.lng;
      updates.city = geocoded.city;
      updates.state = geocoded.state;
    }

    // Auto-attach only on an unambiguous hit: a single nearby POI, or a clear closest match whose
    // name lines up. Anything less goes back to the user as a list to pick from, since hereId is a
    // unique column — attaching the wrong one is annoying to undo.
    const best = candidates[0];
    const nameMatches = !!best && (
      best.name.toLowerCase().includes(venue.name.toLowerCase()) ||
      venue.name.toLowerCase().includes(best.name.toLowerCase())
    );
    let attached: typeof best | null = null;
    // A lone candidate may sit further out than a contested one (large sites geocode to a centroid),
    // but never further than 500m — otherwise "only one result" attaches a match from the next town.
    if (best && nameMatches && best.hereId && best.distance < 500 && (candidates.length === 1 || best.distance < 100)) {
      // hereId is unique across venues — don't steal it from another row.
      const [clash] = await db.select({ id: venues.id }).from(venues).where(eq(venues.hereId, best.hereId)).limit(1);
      if (!clash || clash.id === venue.id) {
        updates.hereId = best.hereId;
        if (best.venueLat != null) updates.latitude = best.venueLat;
        if (best.venueLng != null) updates.longitude = best.venueLng;
        attached = best;
      }
    }

    const [updated] = Object.keys(updates).length
      ? await db.update(venues).set(updates).where(eq(venues.id, venue.id)).returning()
      : [venue];

    res.json({
      attached: attached ? { name: attached.name, hereId: attached.hereId, distance: attached.distance } : null,
      candidates: candidates.map(c => ({ name: c.name, address: c.address, distance: c.distance, hereId: c.hereId, latitude: c.venueLat ?? null, longitude: c.venueLng ?? null })),
      venue: toPublicVenue(redactVenue(updated, appUser.id, appUser.role === 'admin')),
    });
  } catch (err) {
    console.error('Venue HERE repair error:', err);
    res.status(500).json({ error: 'Failed to re-resolve this venue in HERE' });
  }
});

// POST /api/venues/:id/repair/here/attach — pick one of the candidates above by hand.
router.post('/:id/repair/here/attach', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;

  const appUser = (req as any).appUser;
  const hereId = typeof req.body.hereId === 'string' ? req.body.hereId : null;
  if (!hereId) return res.status(400).json({ error: 'hereId is required' });

  const [clash] = await db.select({ id: venues.id, name: venues.name }).from(venues).where(eq(venues.hereId, hereId)).limit(1);
  if (clash && clash.id !== venue.id) {
    return res.status(409).json({ error: `"${clash.name}" is already linked to that HERE place` });
  }

  const updates: Record<string, any> = { hereId };
  if (typeof req.body.latitude === 'number') updates.latitude = req.body.latitude;
  if (typeof req.body.longitude === 'number') updates.longitude = req.body.longitude;

  const [updated] = await db.update(venues).set(updates).where(eq(venues.id, venue.id)).returning();
  res.json(toPublicVenue(redactVenue(updated, appUser.id, appUser.role === 'admin')));
});

// GET /api/venues/:id/repair/pm-candidates?q=... — Pinball Map locations to link this venue to.
// Searches by name when `q` is given, otherwise by proximity to the venue's coordinates.
router.get('/:id/repair/pm-candidates', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  try {
    let nearby: PmLocation[] = [];
    let named: PmLocation[] = [];

    if (!q && venue.latitude != null && venue.longitude != null) {
      nearby = await findNearestPmLocations(venue.latitude, venue.longitude, 1);
    }
    if (q || nearby.length === 0) {
      named = await searchPmLocationsByName(q || venue.name);
    }

    const seen = new Set<number>();
    const candidates = [...nearby, ...named]
      .filter(l => !!l.id && !seen.has(l.id) && seen.add(l.id))
      .map(l => ({
        pinballMapId: l.id,
        name: l.name,
        address: [l.street, l.city, l.state].filter(Boolean).join(', '),
        machineCount: l.num_machines ?? l.machine_count ?? null,
        distance: l.distance ?? null,
        url: pmLocationUrl(l.id),
      }));

    res.json({ candidates, searchedFor: q || venue.name });
  } catch (err) {
    return pmFailure(res, err, 'Failed to search Pinball Map');
  }
});

// POST /api/venues/:id/repair/pm-link — attach a Pinball Map location id. Verifies the id resolves
// before storing it, so a typo fails loudly here instead of quietly producing an empty machine list.
router.post('/:id/repair/pm-link', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;

  const appUser = (req as any).appUser;
  const pinballMapId = Number(req.body.pinballMapId);
  if (!pinballMapId || Number.isNaN(pinballMapId)) {
    return res.status(400).json({ error: 'A numeric pinballMapId is required' });
  }

  try {
    const pmLocation = await getPmLocation(pinballMapId);
    if (!pmLocation) {
      return res.status(404).json({ error: `Pinball Map has no location with id ${pinballMapId}` });
    }

    const { xrefs } = await getVenueRoster(pinballMapId, { force: true });
    const [updated] = await db
      .update(venues)
      .set({ pinballMapId, pmMachineCount: xrefs.length })
      .where(eq(venues.id, venue.id))
      .returning();

    // Seed machine history now that we finally know the roster.
    await syncVenueMachineHistory(venue.id, xrefs).catch(err => console.error('Venue history sync error:', err));

    res.json({
      venue: toPublicVenue(redactVenue(updated, appUser.id, appUser.role === 'admin')),
      pmLocation: { id: pmLocation.id, name: pmLocation.name, url: pmLocationUrl(pmLocation.id) },
      machineCount: xrefs.length,
    });
  } catch (err) {
    return pmFailure(res, err, 'Failed to link this venue to Pinball Map');
  }
});

// GET /api/venues/:id/repair/resync-preview — proposed machine remapping for scores already logged
// here. Nothing is written. Non-admins see only their own scores.
router.get('/:id/repair/resync-preview', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;

  if (!venue.pinballMapId) {
    return res.status(400).json({ error: 'Link this venue to Pinball Map first' });
  }

  const appUser = (req as any).appUser;
  const scopeUserId = appUser.role === 'admin' ? null : appUser.id;

  try {
    const { xrefs } = await getVenueRoster(venue.pinballMapId, { force: true });
    const proposals = await buildResyncPreview(venue.id, xrefs, scopeUserId);
    res.json({
      proposals,
      scope: scopeUserId == null ? 'all' : 'mine',
      pmMachineCount: xrefs.length,
      pmLocationUrl: pmLocationUrl(venue.pinballMapId),
    });
  } catch (err) {
    return pmFailure(res, err, 'Failed to build the re-sync preview');
  }
});

// POST /api/venues/:id/repair/resync-apply — perform the approved merges. Body: { merges: [...] }.
router.post('/:id/repair/resync-apply', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;

  if (!venue.pinballMapId) {
    return res.status(400).json({ error: 'Link this venue to Pinball Map first' });
  }

  const rawMerges = Array.isArray(req.body.merges) ? req.body.merges : [];
  const merges = rawMerges
    .filter((m: any) => Number(m?.fromMachineId) && typeof m?.pmName === 'string' && m.pmName.trim())
    .map((m: any) => ({
      fromMachineId: Number(m.fromMachineId),
      pmName: String(m.pmName).trim(),
      pmManufacturer: typeof m.pmManufacturer === 'string' ? m.pmManufacturer : undefined,
      pmYear: Number.isFinite(Number(m.pmYear)) ? Number(m.pmYear) : undefined,
    }));

  const appUser = (req as any).appUser;
  const scopeUserId = appUser.role === 'admin' ? null : appUser.id;

  try {
    const applied = await applyResync(venue.id, merges, scopeUserId);

    // Whether or not anything merged, refresh metadata on the machines still in play here — rows
    // created while Pinball Map was unreachable went in with null manufacturer/year.
    // Reuses the roster the preview just cached — the user is applying what they were shown.
    const { xrefs } = await getVenueRoster(venue.pinballMapId);
    await syncVenueMachineHistory(venue.id, xrefs).catch(err => console.error('Venue history sync error:', err));

    const remaining = await db
      .selectDistinct({ machineId: scores.machineId })
      .from(scores)
      .where(scopeUserId != null
        ? and(eq(scores.venueId, venue.id), eq(scores.userId, scopeUserId))
        : eq(scores.venueId, venue.id));
    const machinesEnriched = await reenrichMachines(remaining.map(r => r.machineId));

    await db.update(venues).set({ pmMachineCount: xrefs.length }).where(eq(venues.id, venue.id));

    res.json({
      applied,
      scoresMoved: applied.reduce((sum, a) => sum + a.scoresMoved, 0),
      machinesEnriched,
      scope: scopeUserId == null ? 'all' : 'mine',
    });
  } catch (err) {
    return pmFailure(res, err, 'Failed to apply the re-sync');
  }
});

export default router;
