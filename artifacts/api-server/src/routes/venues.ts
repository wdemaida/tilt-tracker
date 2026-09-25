import { Router } from 'express';
import { db, scores, venues, machines, users } from '@workspace/db';
import { eq, desc, count, sql, and, max, inArray } from 'drizzle-orm';
import {
  findNearestPmLocations, searchPmLocationsByName, searchPmLocationsWithAddress, getPmLocation,
  pmLocationUrl, isPmConfigured, PmApiError, type PmLocation,
} from '../lib/pinballmapApi.js';
import { syncVenueMachineHistory, getFormerMachines } from '../lib/venueHistory.js';
import {
  geocodeAddress, autosuggestAddress, findVenueByName, resolveTimezone, lookupHerePlace, type Venue as HereVenue,
} from '../lib/hereApi.js';
import { redactVenue, canSeeFullVenue, canSeeVenueLinkage } from '../lib/venuePrivacy.js';
import { canRepairVenue, buildResyncPreview, applyResync, reenrichMachines } from '../lib/venueRepair.js';
import {
  addressResolutionBlocker, pmLocationToPlace, formatPmAddress, buildManualAddressQuery,
  isPreciseGeocode, pickConfidentHereMatch, stripPlaceNamePrefix, venueListFlags, describeHolder,
  linkageBlockedByPrivacy, isUniqueViolation, type AddressBlocker, type HolderView, type PrivacyFlags,
} from '../lib/venueAddress.js';
import { getVenueRoster } from '../lib/pmRosterCache.js';
import { findDuplicateVenues, partitionDuplicates } from '../lib/venueDedup.js';
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
        // Read only to compute `canRepair` below — stripped before the row goes out.
        createdById: venues.createdById,
        isResidence: venues.isResidence,
        privacyTier: venues.privacyTier,
        city: venues.city,
        state: venues.state,
        cityLat: venues.cityLat,
        cityLng: venues.cityLng,
        timezone: venues.timezone,
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
    // needsAddress is computed from the unredacted row, and is always false for a residence — a
    // hidden-tier home legitimately shows no address and is not something to "fix".
    // `canRepair` is decided here rather than by shipping createdById to every client: who added a
    // venue is nobody else's business, and the client only ever needed the yes/no.
    const redacted = rows.map(r => {
      const { createdById: _createdById, ...pub } = toPublicVenue(redactVenue(r, requester?.id, isAdmin));
      return { ...pub, ...venueListFlags(r, requester) };
    });

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
      const matches = await findDuplicateVenues({
        name,
        latitude: geocoded?.lat ?? null,
        longitude: geocoded?.lng ?? null,
      });
      // Private matches (someone else's residence) are reported only as a flag — no id, name,
      // address or distance, and nothing the client could attach a score to. See partitionDuplicates.
      const { candidates: duplicates, privateNearby } = partitionDuplicates(matches, appUser.id, appUser.role === 'admin');
      if (duplicates.length > 0 || privateNearby) {
        return res.status(409).json({
          error: duplicates.length === 0
            ? 'A private venue with this name already exists nearby. You can still add yours.'
            : duplicates.length === 1
              ? `"${duplicates[0].name}" already exists${duplicates[0].distance != null ? ` ${duplicates[0].distance}m away` : ''}.`
              : `${duplicates.length} venues with this name already exist nearby.`,
          code: 'duplicate_venue',
          candidates: duplicates,
          privateNearby,
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
      // Scores here render in this zone, and an uploaded photo's zone-less EXIF clock is read in it.
      timezone: geocoded?.timezone ?? null,
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
    // A restricted-tier venue's roster (and its former machines) identifies the Pinball Map listing,
    // i.e. where it is — only its owner and admins get it, matching redactVenue's linkage stripping.
    const linkageVisible = canSeeVenueLinkage(venue, appUserId, isAdmin);
    if (venue.pinballMapId && linkageVisible) {
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
      pmLocationUrl: venue.pinballMapId && linkageVisible ? pmLocationUrl(venue.pinballMapId) : null,
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

// Searches HERE by venue name around a point and attaches the result only on an unambiguous hit (see
// pickConfidentHereMatch). Anything less goes back to the user as a list to pick from, since hereId
// is a unique column — attaching the wrong one is annoying to undo. Returns the column updates rather
// than writing them, so each caller folds them into its own single UPDATE.
async function confidentHereAttachment(venueId: number, venueName: string, lat: number, lng: number) {
  const candidates = await findVenueByName(venueName, lat, lng);
  const updates: Record<string, any> = {};
  const best = pickConfidentHereMatch(venueName, candidates);
  if (!best?.hereId) return { candidates, attached: null, updates };

  // hereId is unique across venues — don't steal it from another row.
  const [clash] = await db.select({ id: venues.id }).from(venues).where(eq(venues.hereId, best.hereId)).limit(1);
  if (clash && clash.id !== venueId) return { candidates, attached: null, updates };

  updates.hereId = best.hereId;
  if (best.venueLat != null) updates.latitude = best.venueLat;
  if (best.venueLng != null) updates.longitude = best.venueLng;
  if (best.timezone) updates.timezone = best.timezone;
  return { candidates, attached: best, updates };
}

// A restricted-tier venue never gets HERE / Pinball Map linkage — see linkageBlockedByPrivacy().
// Responds and returns true when refused.
function refuseRestrictedLinkage(venue: { privacyTier: 'full' | 'city_state' | 'hidden' }, res: any): boolean {
  if (!linkageBlockedByPrivacy(venue)) return false;
  res.status(409).json({
    error: 'This venue’s address is private, so it can’t be linked to HERE or Pinball Map — both would publish where it is',
    code: 'venue_private',
  });
  return true;
}

// 409 for a HERE place another venue already holds. The holder is named only when it's a public
// venue (describeHolder) — a residence's name must not be paired with the place being linked.
// With no holder (a unique-index race), it's reported anonymously.
function hereIdTaken(res: any, holder?: { id: number; name: string } & PrivacyFlags) {
  const { linkedVenue } = describeHolder(holder);
  return res.status(409).json({
    error: linkedVenue ? `"${linkedVenue.name}" is already linked to that HERE place` : 'Another venue is already linked to that HERE place',
    code: 'here_id_taken',
    linkedVenue,
    linkedElsewhere: true,
  });
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

  // Repairers are admins, owners and creators; a creator who isn't the owner of a private venue
  // gets the same redacted view as anyone else. A no-op for everyone else.
  const shown = redactVenue(venue, appUser.id, appUser.role === 'admin');

  res.json({
    venueId: venue.id,
    name: venue.name,
    address: shown.address,
    latitude: shown.latitude,
    longitude: shown.longitude,
    hereId: shown.hereId,
    pinballMapId: shown.pinballMapId,
    pmMachineCount: shown.pmMachineCount,
    pmLocationUrl: shown.pinballMapId ? pmLocationUrl(shown.pinballMapId) : null,
    pmConfigured: isPmConfigured(),
    isAdmin: appUser.role === 'admin',
    scoreCount: Number(total),
    myScoreCount: Number(mine),
    isResidence: venue.isResidence,
    // True when the venue has no address and the address-less resolution flow applies to it (not a
    // residence). The panel swaps step 1's "Find in HERE" button for a place search when it is.
    needsAddress: addressResolutionBlocker(venue, appUser) === null,
    // A restricted-tier venue can't be linked to HERE / Pinball Map at all (linkageBlockedByPrivacy);
    // the panel says so instead of offering buttons that would 409.
    linkageBlocked: linkageBlockedByPrivacy(venue),
  });
});

// POST /api/venues/:id/repair/here — re-run the HERE lookup for a venue whose address was filled in
// after the fact. Geocodes the address for coordinates, then searches HERE by venue name anchored at
// those coordinates to recover the hereId the upload flow failed to attach.
router.post('/:id/repair/here', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;

  // Whitespace counts as no address, matching addressResolutionBlocker — otherwise a "   " address
  // is refused by both this step and the address-less flow, and the venue is stuck again.
  if (!venue.address?.trim()) {
    return res.status(400).json({ error: 'Add an address to this venue first — HERE needs somewhere to search from' });
  }
  if (refuseRestrictedLinkage(venue, res)) return;

  const appUser = (req as any).appUser;

  try {
    const geocoded = await geocodeAddress(venue.address);
    const lat = geocoded?.lat ?? venue.latitude;
    const lng = geocoded?.lng ?? venue.longitude;
    if (lat == null || lng == null) {
      return res.status(422).json({ error: `HERE could not geocode "${venue.address}"` });
    }

    const updates: Record<string, any> = {};
    if (geocoded) {
      updates.address = geocoded.label;
      updates.latitude = geocoded.lat;
      updates.longitude = geocoded.lng;
      updates.city = geocoded.city;
      updates.state = geocoded.state;
      if (geocoded.timezone) updates.timezone = geocoded.timezone;
    }

    const { candidates, attached, updates: hereUpdates } = await confidentHereAttachment(venue.id, venue.name, lat, lng);
    Object.assign(updates, hereUpdates);

    let updated = venue;
    if (Object.keys(updates).length) {
      try {
        [updated] = await db.update(venues).set(updates).where(eq(venues.id, venue.id)).returning();
      } catch (err) {
        if (isUniqueViolation(err)) return hereIdTaken(res);
        throw err;
      }
    }

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

  if (refuseRestrictedLinkage(venue, res)) return;
  const appUser = (req as any).appUser;
  const hereId = typeof req.body.hereId === 'string' ? req.body.hereId : null;
  if (!hereId) return res.status(400).json({ error: 'hereId is required' });

  const [clash] = await db.select({ id: venues.id, name: venues.name, isResidence: venues.isResidence, privacyTier: venues.privacyTier })
    .from(venues).where(eq(venues.hereId, hereId)).limit(1);
  if (clash && clash.id !== venue.id) return hereIdTaken(res, clash);

  const updates: Record<string, any> = { hereId };
  if (typeof req.body.latitude === 'number') updates.latitude = req.body.latitude;
  if (typeof req.body.longitude === 'number') updates.longitude = req.body.longitude;

  // Attaching can move the venue, and it's the one place a venue gets coordinates without a geocode
  // to carry the zone along. Resolve from the final position rather than trusting the client.
  const lat = updates.latitude ?? venue.latitude;
  const lng = updates.longitude ?? venue.longitude;
  if (lat != null && lng != null) {
    const tz = await resolveTimezone(lat, lng);
    if (tz) updates.timezone = tz;
  }

  let updated;
  try {
    [updated] = await db.update(venues).set(updates).where(eq(venues.id, venue.id)).returning();
  } catch (err) {
    if (isUniqueViolation(err)) return hereIdTaken(res);
    console.error('Venue HERE attach error:', err);
    return res.status(500).json({ error: 'Failed to link that HERE place' });
  }
  res.json(toPublicVenue(redactVenue(updated, appUser.id, appUser.role === 'admin')));
});

// ---------------------------------------------------------------------------
// Address-less venues
//
// A venue typed in by name at upload with location services off has no address and no coordinates,
// so the HERE step above has nothing to geocode and nowhere to search from. These two routes are the
// step before it: search for the place by name (Pinball Map first — its listings carry street,
// city, zip and coordinates, and it's the directory a pinball venue is most likely to be in), pick
// one or type an address, and write it onto the row. The existing Pinball Map link and re-sync steps
// then work unchanged, because the venue finally has coordinates to search from.
// ---------------------------------------------------------------------------

const ADDRESS_BLOCKER_MESSAGES: Record<Exclude<AddressBlocker, 'forbidden'>, string> = {
  residence: 'This is a residence — its owner sets its address from the Edit Venue dialog, where its privacy is chosen',
  has_address: 'This venue already has an address — use "Find in HERE" instead',
};

/** Rejects residences and already-placed venues. Returns false after responding. */
function ensureAddressResolvable(venue: any, appUser: any, res: any): boolean {
  const blocker = addressResolutionBlocker(venue, appUser);
  if (blocker == null) return true;
  if (blocker === 'forbidden') {
    res.status(403).json({ error: 'Only an admin, the venue owner, or whoever added this venue can repair it' });
  } else {
    res.status(409).json({ error: ADDRESS_BLOCKER_MESSAGES[blocker], code: `venue_${blocker}` });
  }
  return false;
}

/** Other venues already holding these HERE ids / Pinball Map ids, so the UI can flag likely duplicates. */
// Each value is already passed through describeHolder(): residences / restricted tiers come back as
// an anonymous `linkedElsewhere` with no name or id, since these sit next to exact coordinates.
async function venuesHolding(venueId: number, hereIds: string[], pmIds: number[]) {
  const byHere = new Map<string, HolderView>();
  const byPm = new Map<number, HolderView>();
  const cols = { id: venues.id, name: venues.name, isResidence: venues.isResidence, privacyTier: venues.privacyTier };
  if (hereIds.length) {
    const rows = await db.select({ ...cols, hereId: venues.hereId })
      .from(venues).where(inArray(venues.hereId, hereIds));
    for (const r of rows) if (r.hereId && r.id !== venueId) byHere.set(r.hereId, describeHolder(r));
  }
  if (pmIds.length) {
    const rows = await db.select({ ...cols, pinballMapId: venues.pinballMapId })
      .from(venues).where(inArray(venues.pinballMapId, pmIds));
    for (const r of rows) if (r.pinballMapId && r.id !== venueId) byPm.set(r.pinballMapId, describeHolder(r));
  }
  return { byHere, byPm };
}

const NOT_HELD: HolderView = { linkedVenue: null, linkedElsewhere: false };

/** City-level anchors spread wider than an address — King City, OR sits ~15km from Portland's centroid. */
const NEAR_ANCHOR_RADIUS_M = 50_000;
/** At most this many Pinball Map hits are used as HERE anchors when the user gave no city. */
const MAX_PM_ANCHORS = 3;

// GET /api/venues/:id/repair/place-search?q=<name>&near=<city or address> — candidates for where an
// address-less venue actually is. Read-only.
//
// HERE is only ever searched *anchored* (discover with `at`, filtered by distance) — never globally,
// per the HERE notes in CLAUDE.md. The anchor is the geocoded `near` text when given; otherwise each
// of the top Pinball Map hits' own coordinates, which is what makes HERE useful even when the user
// knows nothing but the name.
router.get('/:id/repair/place-search', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;
  const appUser = (req as any).appUser;
  if (!ensureAddressResolvable(venue, appUser, res)) return;

  const q = (typeof req.query.q === 'string' ? req.query.q.trim() : '') || venue.name;
  const near = typeof req.query.near === 'string' ? req.query.near.trim() : '';
  if (q.length < 2) return res.status(400).json({ error: 'Search for at least two characters' });
  if (q.length > 200 || near.length > 200) return res.status(400).json({ error: 'That search is too long' });

  try {
    let pmLocations: PmLocation[] = [];
    let pmError: string | null = null;
    if (isPmConfigured()) {
      try {
        pmLocations = await searchPmLocationsWithAddress(q);
      } catch (err) {
        if (!(err instanceof PmApiError)) throw err;
        pmError = err.message;
      }
    } else {
      pmError = 'Pinball Map is not configured on the server';
    }

    const pm = pmLocations
      .map(loc => ({ loc, place: pmLocationToPlace(loc) }))
      .filter(r => r.place != null)
      .map(({ loc, place }) => ({
        pinballMapId: loc.id,
        name: loc.name,
        address: place!.address,
        latitude: place!.latitude,
        longitude: place!.longitude,
        machineCount: loc.num_machines ?? loc.machine_count ?? null,
        url: pmLocationUrl(loc.id),
      }));

    let nearResolved: string | null = null;
    let hereNote: string | null = null;
    const anchors: Array<{ lat: number; lng: number; radius: number }> = [];
    if (near) {
      const g = await geocodeAddress(near);
      if (g) {
        nearResolved = g.label;
        anchors.push({ lat: g.lat, lng: g.lng, radius: NEAR_ANCHOR_RADIUS_M });
      } else {
        hereNote = `HERE couldn't find "${near}".`;
      }
    } else {
      for (const c of pm.slice(0, MAX_PM_ANCHORS)) anchors.push({ lat: c.latitude, lng: c.longitude, radius: 2000 });
      if (anchors.length === 0) hereNote = 'Add a city or address to search HERE — it needs somewhere to look.';
    }

    const seen = new Set<string>();
    const hereHits: HereVenue[] = [];
    for (const a of anchors) {
      for (const hit of await findVenueByName(q, a.lat, a.lng, 5, a.radius)) {
        if (!hit.hereId || seen.has(hit.hereId) || hit.venueLat == null || hit.venueLng == null) continue;
        seen.add(hit.hereId);
        hereHits.push(hit);
      }
    }

    const { byHere, byPm } = await venuesHolding(venue.id, hereHits.map(h => h.hereId!), pm.map(p => p.pinballMapId));

    res.json({
      query: q,
      near: near || null,
      nearResolved,
      pm: pm.map(p => ({ ...p, ...(byPm.get(p.pinballMapId) ?? NOT_HELD) })),
      here: hereHits.map(h => ({
        hereId: h.hereId,
        name: h.name,
        address: stripPlaceNamePrefix(h.address, h.name),
        latitude: h.venueLat,
        longitude: h.venueLng,
        ...(byHere.get(h.hereId!) ?? NOT_HELD),
      })),
      pmError,
      hereNote,
    });
  } catch (err) {
    console.error('Venue place search error:', err);
    res.status(500).json({ error: 'Failed to search for this venue' });
  }
});

// POST /api/venues/:id/repair/place — give an address-less venue its address and coordinates.
// Body is one of:
//   { source: 'pm', pinballMapId }                 — a Pinball Map listing (re-read server-side)
//   { source: 'here', hereId }                     — a HERE place (re-read server-side via Lookup)
//   { source: 'manual', street, city, state?, postalCode?, country?, confirm? }
//       — geocoded through HERE. Without `confirm: true` nothing is written and the geocode comes
//         back as a preview, so the user sees where HERE put it before it's saved.
// The client never supplies coordinates or an address string — both are re-derived here.
router.post('/:id/repair/place', requireAppUser, async (req, res) => {
  const venue = await loadRepairableVenue(req, res);
  if (!venue) return;
  const appUser = (req as any).appUser;
  if (!ensureAddressResolvable(venue, appUser, res)) return;

  const source = req.body?.source;
  const updates: Record<string, any> = {};
  let pmPreselect: { pinballMapId: number; name: string; address: string; machineCount: number | null; distance: null; url: string } | null = null;
  let tryHere = true;

  try {
    if (source === 'pm') {
      const pinballMapId = Number(req.body.pinballMapId);
      if (!Number.isInteger(pinballMapId) || pinballMapId <= 0) {
        return res.status(400).json({ error: 'A numeric pinballMapId is required' });
      }
      let loc: PmLocation | null;
      try {
        loc = await getPmLocation(pinballMapId);
      } catch (err) {
        return pmFailure(res, err, 'Failed to read that Pinball Map location');
      }
      if (!loc) return res.status(404).json({ error: `Pinball Map has no location with id ${pinballMapId}` });
      const place = pmLocationToPlace(loc);
      if (!place) return res.status(422).json({ error: `Pinball Map's listing for "${loc.name}" has no coordinates` });

      Object.assign(updates, {
        address: place.address, city: place.city, state: place.state,
        latitude: place.latitude, longitude: place.longitude,
      });
      // Handed back so step 2 opens with this location already offered — linking stays an explicit
      // click through the existing pm-link route, which verifies it and seeds machine history.
      pmPreselect = {
        pinballMapId: loc.id, name: loc.name, address: formatPmAddress(loc),
        machineCount: loc.num_machines ?? loc.machine_count ?? null, distance: null, url: pmLocationUrl(loc.id),
      };
    } else if (source === 'here') {
      const hereId = typeof req.body.hereId === 'string' ? req.body.hereId.trim() : '';
      if (!hereId) return res.status(400).json({ error: 'hereId is required' });

      const [clash] = await db.select({ id: venues.id, name: venues.name, isResidence: venues.isResidence, privacyTier: venues.privacyTier })
        .from(venues).where(eq(venues.hereId, hereId)).limit(1);
      if (clash && clash.id !== venue.id) return hereIdTaken(res, clash);
      const place = await lookupHerePlace(hereId);
      if (!place) return res.status(422).json({ error: 'HERE could not find that place any more — search again' });

      Object.assign(updates, {
        hereId: place.hereId,
        address: stripPlaceNamePrefix(place.label, place.name),
        city: place.city, state: place.state,
        latitude: place.lat, longitude: place.lng,
      });
      if (place.timezone) updates.timezone = place.timezone;
      tryHere = false; // this *is* the HERE place
    } else if (source === 'manual') {
      const built = buildManualAddressQuery(req.body ?? {});
      if (!built.ok) return res.status(400).json({ error: built.error });

      const geocoded = await geocodeAddress(built.query);
      if (!geocoded) return res.status(422).json({ error: `HERE could not find "${built.query}"` });

      const preview = {
        query: built.query,
        label: geocoded.label,
        latitude: geocoded.lat,
        longitude: geocoded.lng,
        resultType: geocoded.resultType ?? null,
        precise: isPreciseGeocode(geocoded.resultType),
      };
      if (req.body.confirm !== true) return res.json({ preview, venue: null });
      // A city-centroid (or other coarse) match is not the venue. The UI warns on the preview; the
      // server insists the user saw that warning rather than trusting the client to have shown it.
      if (!preview.precise && req.body.acceptImprecise !== true) {
        return res.status(422).json({
          error: `HERE only matched "${built.query}" approximately (${preview.resultType ?? 'unknown'}) — check the street and number, or confirm the approximate position`,
          code: 'imprecise_geocode',
          preview,
        });
      }

      Object.assign(updates, {
        address: geocoded.label, city: geocoded.city, state: geocoded.state,
        latitude: geocoded.lat, longitude: geocoded.lng,
      });
      if (geocoded.timezone) updates.timezone = geocoded.timezone;
    } else {
      return res.status(400).json({ error: "source must be 'pm', 'here' or 'manual'" });
    }

    // With coordinates in hand, try the same confident-only HERE attachment the HERE step uses.
    // This can nudge the coordinates onto HERE's position for the place, exactly as that step does.
    let attached: HereVenue | null = null;
    if (tryHere) {
      const result = await confidentHereAttachment(venue.id, venue.name, updates.latitude, updates.longitude);
      Object.assign(updates, result.updates);
      attached = result.attached;
    }
    if (!updates.timezone) {
      const tz = await resolveTimezone(updates.latitude, updates.longitude);
      if (tz) updates.timezone = tz;
    }

    // Guard against a concurrent resolve: only write if the row is still address-less.
    let updated;
    try {
      [updated] = await db.update(venues).set(updates)
        .where(and(eq(venues.id, venue.id), sql`(${venues.address} IS NULL OR btrim(${venues.address}) = '')`))
        .returning();
    } catch (err) {
      // Another venue took this hereId between our clash check and the write.
      if (isUniqueViolation(err)) return hereIdTaken(res);
      throw err;
    }
    if (!updated) return res.status(409).json({ error: 'This venue was given an address in the meantime — reload the page' });

    // Not a block — the venue may genuinely be a second listing — but worth saying before the user
    // links Pinball Map and starts re-syncing scores onto what might be a duplicate row.
    const nearbySameName = (await findDuplicateVenues({ name: venue.name, latitude: updated.latitude, longitude: updated.longitude }))
      .filter(d => d.id !== venue.id && d.distance != null);
    // Not partitionDuplicates(): this sits next to exact coordinates, so even an admin gets the
    // describeHolder treatment (a residence is never named here), matching the candidate lists.
    const { byPm } = await venuesHolding(venue.id, [], pmPreselect ? [pmPreselect.pinballMapId] : []);
    // Same rule as the candidates: a private venue counts, but is never named next to this position.
    const nearbyViews = nearbySameName.length
      ? (await db.select({ id: venues.id, name: venues.name, isResidence: venues.isResidence, privacyTier: venues.privacyTier })
          .from(venues).where(inArray(venues.id, nearbySameName.map(d => d.id)))).map(describeHolder)
      : [];
    const holders = [...nearbyViews, ...byPm.values()];
    const possibleDuplicates: Array<{ id: number; name: string }> = [];
    for (const h of holders) {
      if (h.linkedVenue && !possibleDuplicates.some(d => d.id === h.linkedVenue!.id)) possibleDuplicates.push(h.linkedVenue);
    }
    const privateDuplicate = holders.some(h => h.linkedElsewhere && !h.linkedVenue);

    res.json({
      venue: toPublicVenue(redactVenue(updated, appUser.id, appUser.role === 'admin')),
      attachedHere: attached ? { name: attached.name, hereId: attached.hereId, distance: attached.distance } : null,
      pmPreselect,
      possibleDuplicates,
      /** Another venue matches too, but it's private, so it isn't named. */
      privateDuplicate,
    });
  } catch (err) {
    console.error('Venue place resolve error:', err);
    res.status(500).json({ error: 'Failed to set this venue’s address' });
  }
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

  if (refuseRestrictedLinkage(venue, res)) return;
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
