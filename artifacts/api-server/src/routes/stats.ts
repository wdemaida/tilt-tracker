import { Router } from 'express';
import { db, scores, machines, users } from '@workspace/db';
import { eq, desc, max, count, sql } from 'drizzle-orm';
import { requireAppUser } from '../middleware/requireAuth.js';

const router = Router();

// GET /api/stats — stats for authenticated user (?mine=true, default) or site-wide (?mine=false)
router.get('/', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const mine = req.query.mine !== 'false';

  try {
    const allScores = await db
      .select({
        score: scores.score,
        type: scores.type,
        machineName: machines.name,
        venueName: scores.venueName,
      })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .where(mine ? eq(scores.userId, appUser.id) : undefined);

    const totalGames = allScores.length;
    const best = allScores.reduce((a, b) => (b.score > a.score ? b : a), allScores[0] ?? { score: 0, machineName: null, venueName: null });
    const casualCount = allScores.filter(s => s.type === 'casual').length;
    const tournamentCount = allScores.filter(s => s.type === 'tournament').length;

    const machineCounts: Record<string, number> = {};
    for (const s of allScores) {
      machineCounts[s.machineName] = (machineCounts[s.machineName] ?? 0) + 1;
    }
    const mostPlayed = Object.entries(machineCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, plays]) => ({ name, plays }));

    res.json({
      totalGames,
      allTimeHigh: { score: best.score, machineName: best.machineName, venueName: best.venueName },
      mostPlayed,
      playStyle: { casual: casualCount, tournament: tournamentCount },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
