import { Router } from 'express';
import { db, machines, scores, users } from '@workspace/db';
import { eq, desc, max, count, sql } from 'drizzle-orm';
import { searchMachines, getAllMachines } from '../lib/pinballMap.js';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';

const router = Router();

// GET /api/machines — list with best score per machine
router.get('/', async (req, res) => {
  try {
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
      .innerJoin(scores, eq(scores.machineId, machines.id))
      .groupBy(machines.id, machines.name, machines.variant, machines.manufacturer, machines.year, machines.imageUrl)
      .orderBy(desc(max(scores.score)));
    res.json(rows);
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
        venueName: scores.venueName,
        photoUrl: scores.photoUrl,
        username: users.username,
      })
      .from(scores)
      .innerJoin(users, eq(scores.userId, users.id))
      .where(eq(scores.machineId, machine.id))
      .orderBy(desc(scores.playedAt));

    res.json({ machine, scores: scoreRows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch machine' });
  }
});

// POST /api/machines — upsert a machine, enriching with PM data
router.post('/', async (req, res) => {
  const { name, opdbId, ipdbId, variant } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    // Enrich from Pinball Map cache (non-blocking; ignore errors)
    const pmAll = await getAllMachines().catch(() => []);
    const pm = pmAll.find(m => m.name.toLowerCase() === name.toLowerCase());

    const [row] = await db
      .insert(machines)
      .values({
        name,
        opdbId: opdbId ?? pm?.opdb_id ?? null,
        ipdbId: ipdbId ?? null,
        variant: variant ?? null,
        manufacturer: pm?.manufacturer ?? null,
        year: pm?.year ?? null,
        imageUrl: pm?.opdb_img ?? null,
      })
      .onConflictDoUpdate({
        target: machines.name,
        set: {
          name: sql`excluded.name`,
          ...(opdbId !== undefined && { opdbId }),
          ...(ipdbId !== undefined && { ipdbId }),
          ...(variant !== undefined && { variant }),
          manufacturer: sql`COALESCE(machines.manufacturer, excluded.manufacturer)`,
          year: sql`COALESCE(machines.year, excluded.year)`,
          imageUrl: sql`COALESCE(machines.image_url, excluded.image_url)`,
        },
      })
      .returning();
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
