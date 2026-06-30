import { Router } from 'express';
import { db, scores, machines, users } from '@workspace/db';
import { eq, desc, max, count, sql } from 'drizzle-orm';
import { requireAppUser } from '../middleware/requireAuth.js';

const router = Router();

const VISIT_GAP_MS = 6 * 3600 * 1000; // 6-hour gap = new visit
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 30.44;

// Number of visits in a sorted-by-time-asc series of timestamps for one player
function countVisits(sortedMs: number[]): number {
  if (!sortedMs.length) return 0;
  let visits = 1;
  for (let i = 1; i < sortedMs.length; i++) {
    if (sortedMs[i] - sortedMs[i - 1] > VISIT_GAP_MS) visits++;
  }
  return visits;
}

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

    const playedMs = allScores.map(s => new Date(s.playedAt).getTime());
    const createdMs = allScores.map(s => new Date(s.createdAt).getTime());
    const monthSpanPlayed = daySpan(playedMs) / DAYS_PER_MONTH;
    const avgPlaysPerMonth = totalGames / monthSpanPlayed;
    const avgVisitsPerMonth = totalVisits / monthSpanPlayed;
    const avgScoresSubmittedPerDay = totalGames / daySpan(createdMs);

    res.json({
      totalGames,
      allTimeHigh: { score: best.score, machineName: best.machineName, venueName: best.venueName },
      mostPlayed,
      uniqueMachines,
      playStyle: { casual: casualCount, tournament: tournamentCount },
      playHabits: {
        avgPlaysPerVisit,
        avgPlaysPerMonth,
        avgVisitsPerMonth,
        avgScoresSubmittedPerDay,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
