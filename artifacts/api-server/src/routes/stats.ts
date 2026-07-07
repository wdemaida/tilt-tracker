import { Router } from 'express';
import { db, scores, machines, users } from '@workspace/db';
import { eq, desc, max, count, sql } from 'drizzle-orm';
import { requireAppUser } from '../middleware/requireAuth.js';
import { countVisits, computeCurrentMonthCounts } from '../lib/statsCalc.js';

const router = Router();

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Days between earliest/latest timestamp, floored at 1 day so rates never divide by ~0
function daySpan(msList: number[]): number {
  if (msList.length < 2) return 1;
  return Math.max((Math.max(...msList) - Math.min(...msList)) / MS_PER_DAY, 1);
}

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
        userId: scores.userId,
        playedAt: scores.playedAt,
        createdAt: scores.createdAt,
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
    const uniqueMachines = Object.keys(machineCounts).length;
    const mostPlayed = Object.entries(machineCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, plays]) => ({ name, plays }));

    // Visits are clustered per-player (gap > 6h = new visit), then summed —
    // pooling timestamps across players before clustering would merge unrelated outings.
    const playedByUser: Record<string, number[]> = {};
    for (const s of allScores) {
      (playedByUser[s.userId] ??= []).push(new Date(s.playedAt).getTime());
    }
    let totalVisits = 0;
    for (const ms of Object.values(playedByUser)) {
      totalVisits += countVisits([...ms].sort((a, b) => a - b));
    }
    const avgPlaysPerVisit = totalVisits ? totalGames / totalVisits : 0;

    const createdMs = allScores.map(s => new Date(s.createdAt).getTime());
    const avgScoresSubmittedPerDay = totalGames / daySpan(createdMs);

    // Literal current-calendar-month totals (America/New_York) — not an extrapolated rate, so
    // these reset at the start of each month rather than averaging over all-time history.
    const thisMonth = computeCurrentMonthCounts(allScores);

    res.json({
      totalGames,
      allTimeHigh: { score: best.score, machineName: best.machineName, venueName: best.venueName },
      mostPlayed,
      uniqueMachines,
      playStyle: { casual: casualCount, tournament: tournamentCount },
      playHabits: {
        avgPlaysPerVisit,
        avgScoresSubmittedPerDay,
        playsThisMonth: thisMonth.plays,
        visitsThisMonth: thisMonth.visits,
        scoresSubmittedThisMonth: thisMonth.scoresSubmitted,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
