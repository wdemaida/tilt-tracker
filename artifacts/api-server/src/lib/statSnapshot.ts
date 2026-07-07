import { db, scores, stats, statHistory } from '@workspace/db';
import { computeCurrentMonthCounts, nyDateString } from './statsCalc.js';

// Site-wide daily snapshot of the raw counters behind the Stats page's "this month" figures.
// Upserts on (statId, periodDate) so a retry or a manual re-run on the same day overwrites
// rather than duplicating that day's row.
export async function captureStatSnapshot(now: Date = new Date()) {
  const allScores = await db.select({
    userId: scores.userId,
    playedAt: scores.playedAt,
    createdAt: scores.createdAt,
  }).from(scores);

  const counts = computeCurrentMonthCounts(allScores, now);
  const periodDate = nyDateString(now);

  const statDefs = await db.select().from(stats);
  const statByKey = new Map(statDefs.map(s => [s.key, s]));

  const values: Record<string, number> = {
    plays: counts.plays,
    visits: counts.visits,
    scores_submitted: counts.scoresSubmitted,
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
