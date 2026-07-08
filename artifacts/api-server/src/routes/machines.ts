import { Router } from 'express';
import { db, machines, scores, users, venues } from '@workspace/db';
import { eq, desc, max, count, isNotNull } from 'drizzle-orm';
import { searchMachines } from '../lib/pinballMap.js';
import { upsertMachineByName } from '../lib/machineUpsert.js';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';
import { getAuth } from '@clerk/express';

async function resolveMinedUserId(req: any): Promise<number | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user?.id;
}

const router = Router();

// GET /api/machines — list with best score per machine; ?mine=true filters to caller
router.get('/', async (req, res) => {
  try {
    const userId = req.query.mine === 'true' ? await resolveMinedUserId(req) : undefined;
    const rows = await db
      .select({
        id: machines.id,
        name: machines.name,
        variant: machines.variant,
        manufacturer: machines.manufacturer,
        year: machines.year,
        imageUrl: machines.imageUrl,
        bestScore: max(scores.score),
        playCount: count(scores.id),
        lastPlayed: max(scores.playedAt),
      })
      .from(machines)
      .leftJoin(scores, eq(scores.machineId, machines.id))
      .where(userId !== undefined ? eq(scores.userId, userId) : undefined)
      .groupBy(machines.id, machines.name, machines.variant, machines.manufacturer, machines.year, machines.imageUrl)
      .orderBy(desc(max(scores.score)));

    // Who holds the top score per machine — pointless to show when already scoped to "mine"
    let topScorerByMachineId = new Map<number, string>();
    if (userId === undefined) {
      const topScorers = await db
        .selectDistinctOn([scores.machineId], {
          machineId: scores.machineId,
          username: users.username,
        })
        .from(scores)
        .innerJoin(users, eq(scores.userId, users.id))
        .orderBy(scores.machineId, desc(scores.score), scores.playedAt);
      topScorerByMachineId = new Map(topScorers.map(t => [t.machineId, t.username]));
    }

    res.json(rows.map(r => ({ ...r, topScorerUsername: topScorerByMachineId.get(r.id) ?? null })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch machines' });
  }
});

// GET /api/machines/search?q=... — Pinball Map typeahead
router.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '');
  if (!q) return res.json([]);
  try {
    const results = await searchMachines(q, 10);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/machines/:name — detail with all scores
router.get('/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  try {
    const [machine] = await db.select().from(machines).where(eq(machines.name, name)).limit(1);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const scoreRows = await db
      .select({
        id: scores.id,
        score: scores.score,
        playedAt: scores.playedAt,
        type: scores.type,
        venueId: scores.venueId,
        venueName: scores.venueName,
        venueIsResidence: venues.isResidence,
        photoUrl: scores.photoUrl,
        username: users.username,
        displayName: users.displayName,
      })
      .from(scores)
      .innerJoin(users, eq(scores.userId, users.id))
      .leftJoin(venues, eq(scores.venueId, venues.id))
      .where(eq(scores.machineId, machine.id))
      .orderBy(desc(scores.score));

    res.json({ machine, scores: scoreRows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch machine' });
  }
});

// POST /api/machines — upsert a machine, enriching with PM data
router.post('/', async (req, res) => {
  const { name, opdbId, ipdbId, variant, manufacturer, year } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const row = await upsertMachineByName(name, { opdbId, ipdbId, variant, manufacturer, year });
    res.status(201).json(row);
  } catch (err) {
    console.error('Upsert machine error:', err);
    res.status(500).json({ error: 'Failed to upsert machine' });
  }
});

// PATCH /api/machines/:id — admin-only
router.patch('/:id', requireAppUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, manufacturer, year } = req.body;

  const [existing] = await db.select().from(machines).where(eq(machines.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Machine not found' });

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (manufacturer !== undefined) updates.manufacturer = manufacturer;
  if (year !== undefined) updates.year = year === '' ? null : Number(year);

  const [updated] = await db.update(machines).set(updates).where(eq(machines.id, id)).returning();
  res.json(updated);
});

// DELETE /api/machines/:id — admin-only, blocked if machine has scores
router.delete('/:id', requireAppUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  const [existing] = await db.select().from(machines).where(eq(machines.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: 'Machine not found' });

  const [{ total }] = await db.select({ total: count() }).from(scores).where(eq(scores.machineId, id));
  if (total > 0) {
    return res.status(409).json({ error: `Cannot delete — ${total} score${total === 1 ? '' : 's'} reference this machine` });
  }

  await db.delete(machines).where(eq(machines.id, id));
  res.status(204).send();
});

export default router;
