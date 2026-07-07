import { Router } from 'express';
import { db, scores, machines, venues, users, stats, statHistory } from '@workspace/db';
import { eq, desc, count } from 'drizzle-orm';
import { requireAppUser } from '../middleware/requireAuth.js';
import { computeVisits, computeCurrentMonthCounts } from '../lib/statsCalc.js';

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

    const totalVisits = computeVisits(allScores);
    const avgPlaysPerVisit = totalVisits ? totalGames / totalVisits : 0;

    const createdMs = allScores.map(s => new Date(s.createdAt).getTime());
    const avgScoresSubmittedPerDay = totalGames / daySpan(createdMs);

    // Literal current-calendar-month totals (America/New_York) — not an extrapolated rate, so
    // these reset at the start of each month rather than averaging over all-time history.
    const thisMonth = computeCurrentMonthCounts(allScores);

    // Site-wide facts, independent of the mine/site-wide toggle — a venue or machine roster
    // isn't "yours", so these are the same number in both views.
    const [{ totalVenues }] = await db.select({ totalVenues: count() }).from(venues);
    const [{ totalMachinesInSystem }] = await db.select({ totalMachinesInSystem: count() }).from(machines);

    res.json({
      totalGames,
      totalVisits,
      totalVenues,
      totalMachinesInSystem,
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

// GET /api/stats/history/:key?days=90 — site-wide StatHistory time series for one stat, for the
// trend chart modal. Always site-wide regardless of the mine/site-wide toggle, since StatHistory
// itself is only ever captured site-wide (see captureStatSnapshot).
router.get('/history/:key', requireAppUser, async (req, res) => {
  const days = Math.min(Number(req.query.days) || 90, 365);
  try {
    const [stat] = await db.select().from(stats).where(eq(stats.key, req.params.key)).limit(1);
    if (!stat) return void res.status(404).json({ error: 'Unknown stat key' });

    const rows = await db
      .select({ periodDate: statHistory.periodDate, value: statHistory.value })
      .from(statHistory)
      .where(eq(statHistory.statId, stat.id))
      .orderBy(desc(statHistory.periodDate))
      .limit(days);

    res.json({ label: stat.label, description: stat.description, points: rows.reverse() });
  } catch (err) {
    console.error('stats/history error:', err);
    res.status(500).json({ error: 'Failed to fetch stat history' });
  }
});

export default router;
