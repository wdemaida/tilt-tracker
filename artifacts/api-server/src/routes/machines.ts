import { Router } from 'express';
import { db, machines, scores, users, venues, challenges } from '@workspace/db';
import { eq, desc, max, count, isNotNull, sql, and } from 'drizzle-orm';
import { searchMachines } from '../lib/pinballMap.js';
import { upsertMachineByName } from '../lib/machineUpsert.js';
import { getMachineScoreStats } from '../lib/machineScoreStats.js';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';
import { getAuth } from '@clerk/express';
import { visibleScoreSql } from '../lib/venueActivity.js';
import { machineInInventory } from '../lib/venueInventory.js';
import {
  parseComparisonScope, resolveComparisonScope, scopeFilterSql, scoreGroupSql, scopeView, POD_NOT_FOUND,
} from '../lib/comparisonScope.js';

// Optional — the caller's app user + role, for score visibility. Undefined when signed out.
async function resolveRequester(req: any): Promise<{ id: number; role: string } | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [user] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user;
}

const router = Router();

// GET /api/machines — list with best score per machine; ?mine=true filters to caller
router.get('/', async (req, res) => {
  try {
    const requester = await resolveRequester(req);
    const userId = req.query.mine === 'true' ? requester?.id : undefined;
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
      // Best score / play count / top scorer count only scores this requester may see — a home
      // venue's owner can keep the scores there private (venueActivity.ts).
      .leftJoin(scores, and(eq(scores.machineId, machines.id), visibleScoreSql(requester)))
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
        .where(visibleScoreSql(requester))
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

// GET /api/machines/score-stats?machineId=&name= — count + median of recorded scores on a machine.
// Feeds the add-score "this score may be missing digits" check once the user has picked a machine
// (the upload route runs the same check itself against the AI-read name). Registered before /:name,
// which would otherwise swallow it. Read-only.
router.get('/score-stats', async (req, res) => {
  const machineId = req.query.machineId != null ? Number(req.query.machineId) : undefined;
  const name = typeof req.query.name === 'string' ? req.query.name : undefined;
  if (machineId == null && !name) return res.status(400).json({ error: 'machineId or name is required' });
  try {
    res.json(await getMachineScoreStats({ machineId, name }));
  } catch (err) {
    console.error('Machine score stats error:', err);
    res.status(500).json({ error: 'Failed to fetch machine score stats' });
  }
});

// GET /api/machines/:name — detail with all scores. Comparison scope (lib/comparisonScope.ts):
// ?mine=true → only the caller's; ?pod=<id>[&others=1] → the caller + that pod's members (+ everyone
// else); ?friends=1[&others=1] → the caller + their accepted friends (+ everyone else). Each row
// carries `group` ('self' | 'pod' | 'friend' | 'other') so the chart can split its series.
router.get('/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  try {
    const requester = await resolveRequester(req);
    // Scope before the machine lookup, so a bad pod id is the same 404 whichever machine it names.
    const scope = await resolveComparisonScope(parseComparisonScope(req.query), requester);
    if (!scope) return res.status(404).json(POD_NOT_FOUND);

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
        venueTimezone: sql<string | null>`CASE WHEN ${venues.privacyTier} = 'hidden' THEN NULL ELSE ${venues.timezone} END`,
        venueIsResidence: venues.isResidence,
        photoUrl: scores.photoUrl,
        username: users.username,
        displayName: users.displayName,
        group: scoreGroupSql(scope, requester),
      })
      .from(scores)
      .innerJoin(users, eq(scores.userId, users.id))
      .leftJoin(venues, eq(scores.venueId, venues.id))
      // Scores at a home venue whose owner turned "Show my machines/scores publicly" off are only
      // listed for the owner, admins and whoever posted them. The scope filter only narrows on top
      // of that — pod membership never widens what the caller may see.
      .where(and(eq(scores.machineId, machine.id), visibleScoreSql(requester), scopeFilterSql(scope)))
      .orderBy(desc(scores.score));

    res.json({ machine, scores: scoreRows, scope: scopeView(scope) });
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
  if (await machineInInventory(id)) {
    return res.status(409).json({ error: 'Cannot delete — a home venue lists this machine in its inventory' });
  }
  const [{ challengeRefs }] = await db.select({ challengeRefs: count() }).from(challenges).where(eq(challenges.machineId, id));
  if (challengeRefs > 0) {
    return res.status(409).json({ error: 'Cannot delete — a challenge is played on this machine' });
  }

  await db.delete(machines).where(eq(machines.id, id));
  res.status(204).send();
});

export default router;
