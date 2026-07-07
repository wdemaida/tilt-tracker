import { db, scores, machines, venues, stats, statHistory } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { computeCurrentMonthCounts, computeVisits, nyDateString } from './statsCalc.js';

// Site-wide daily snapshot of the raw counters behind the Stats page's "Totals" and
// "Monthly / Rates" cards. Upserts on (statId, periodDate) so a retry or a manual re-run on the
// same day overwrites rather than duplicating that day's row.
export async function captureStatSnapshot(now: Date = new Date()) {
  const allScores = await db.select({
    userId: scores.userId,
    playedAt: scores.playedAt,
    createdAt: scores.createdAt,
  }).from(scores);

  const monthCounts = computeCurrentMonthCounts(allScores, now);
  const periodDate = nyDateString(now);

  const [{ totalVenues }] = await db.select({ totalVenues: sql<number>`count(*)`.mapWith(Number) }).from(venues);
  const [{ totalMachines }] = await db.select({ totalMachines: sql<number>`count(*)`.mapWith(Number) }).from(machines);
  const [{ machinesWithScore }] = await db
    .select({ machinesWithScore: sql<number>`count(distinct ${scores.machineId})`.mapWith(Number) })
    .from(scores);

  const statDefs = await db.select().from(stats);
  const statByKey = new Map(statDefs.map(s => [s.key, s]));

  const values: Record<string, number> = {
    plays: monthCounts.plays,
    visits: monthCounts.visits,
    scores_submitted: monthCounts.scoresSubmitted,
    total_plays: allScores.length,
    total_visits: computeVisits(allScores),
    total_venues: totalVenues,
    machines_with_score: machinesWithScore,
    total_machines: totalMachines,
  };

  const written: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    const stat = statByKey.get(key);
    if (!stat) continue; // definition was renamed/deleted — skip rather than fail the whole snapshot
    await db.insert(statHistory)
      .values({ statId: stat.id, value, periodDate })
      .onConflictDoUpdate({
        target: [statHistory.statId, statHistory.periodDate],
        set: { value },
      });
    written[key] = value;
  }

  return { periodDate, values: written };
}
