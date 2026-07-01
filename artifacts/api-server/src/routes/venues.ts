import { Router } from 'express';
import { db, scores, venues, machines, users } from '@workspace/db';
import { eq, desc, count, sql, and } from 'drizzle-orm';
import { getPmMachinesAtLocation } from '../lib/pinballmapApi.js';
import { syncVenueMachineHistory, getFormerMachines } from '../lib/venueHistory.js';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';
import { getAuth } from '@clerk/express';

async function resolveMinedUserId(req: any): Promise<number | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user?.id;
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
        scoreCount: count(scores.id),
        machineCount: sql<number>`count(distinct ${scores.machineId})`,
      })
      .from(venues)
      .leftJoin(scores, eq(scores.venueId, venues.id))
      .where(userId !== undefined ? eq(scores.userId, userId) : undefined)
      .groupBy(venues.id)
      .orderBy(desc(count(scores.id)));

    res.json(rows);
  } catch (err) {
    console.error('Venues list error:', err);
    res.status(500).json({ error: 'Failed to fetch venues' });
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

    // Resolve current user (optional — for per-user play counts)
    let appUserId: number | undefined;
    if (clerkId) {
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
      appUserId = u?.id;
    }

    // Machines played at this venue by the current user (for play count badge)
    const ownMachines = await db
      .select({
        id: machines.id,
        name: machines.name,
        bestScore: sql<number>`max(${scores.score})`,
        playCount: count(scores.id),
      })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .where(appUserId
        ? and(eq(scores.venueId, id), eq(scores.userId, appUserId))
        : eq(scores.venueId, id))
      .groupBy(machines.id, machines.name)
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

    res.json({ venue, ownMachines, pmMachines, ttMachineNames, formerMachines });
  } catch (err) {
    console.error('Venue machines error:', err);
    res.status(500).json({ error: 'Failed to fetch venue machines' });
  }
});

// GET /api/venues/:id/scores — all individual score entries at a venue
router.get('/:id/scores', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [venue] = await db.select({ id: venues.id, name: venues.name, address: venues.address })
      .from(venues).where(eq(venues.id, id)).limit(1);
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

    res.json({ venue, scores: rows });
  } catch (err) {
    console.error('Venue scores error:', err);
    res.status(500).json({ error: 'Failed to fetch venue scores' });
  }
});

// PATCH /api/venues/:id — admin-only
router.patch('/:id', requireAppUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, address } = req.body;

  const [existing] = await db.select().from(venues).where(eq(venues.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Venue not found' });

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (address !== undefined) updates.address = address === '' ? null : address;

  const [updated] = await db.update(venues).set(updates).where(eq(venues.id, id)).returning();
  res.json(updated);
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
