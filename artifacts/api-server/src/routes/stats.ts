import { Router } from 'express';
import { db, scores, machines, venues, stats, statHistory } from '@workspace/db';
import { and, eq, desc, count } from 'drizzle-orm';
import { visibleScoreSql, type Viewer } from '../lib/venueActivity.js';
import { requireAppUser } from '../middleware/requireAuth.js';
import { computeVisits, computeCurrentMonthCounts, computeLiveTrend, isLiveTrendKey } from '../lib/statsCalc.js';
import {
  parseComparisonScope, resolveComparisonScope, scopeFilterSql, scoreGroupSql, scopeView, scopeIsEveryone, POD_NOT_FOUND,
  type ResolvedScope, type ScoreGroup,
} from '../lib/comparisonScope.js';

const router = Router();

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Days between earliest/latest timestamp, floored at 1 day so rates never divide by ~0
function daySpan(msList: number[]): number {
  if (msList.length < 2) return 1;
  return Math.max((Math.max(...msList) - Math.min(...msList)) / MS_PER_DAY, 1);
}

const GROUPS: ScoreGroup[] = ['self', 'pod', 'friend', 'other'];

// Every score the Stats page aggregates under a scope. The scope filter and the privacy filter are
// both on this one query, which is the only score read either endpoint below makes — so no
// aggregate can see a score outside the scope, or one the viewer couldn't see anywhere else (a
// private venue's, with its owner's "Show my machines/scores publicly" off — the all-time high
// names its machine and venue). Your own scores are always yours; being in someone's pod reveals
// nothing extra — and neither does being someone's friend.
async function loadScopedScores(scope: ResolvedScope, viewer: Viewer) {
  return db
    .select({
      score: scores.score,
      type: scores.type,
      machineName: machines.name,
      venueName: scores.venueName,
      venueId: scores.venueId,
      userId: scores.userId,
      playedAt: scores.playedAt,
      createdAt: scores.createdAt,
      group: scoreGroupSql(scope, viewer),
    })
    .from(scores)
    .innerJoin(machines, eq(scores.machineId, machines.id))
    .where(and(visibleScoreSql(viewer), scopeFilterSql(scope)));
}

// GET /api/stats — aggregates over the comparison scope (see lib/comparisonScope.ts):
//   ?mine=true → just you · (nothing) or ?mine=false → everyone · ?pod=<id> → you + that pod's
//   members · ?pod=<id>&others=1 → everyone, with the per-group split · ?friends=1[&others=1] → you +
//   your friends (+ everyone else), the same way. A pod you don't own → 404.
router.get('/', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;

  try {
    const scope = await resolveComparisonScope(parseComparisonScope(req.query), appUser);
    if (!scope) return void res.status(404).json(POD_NOT_FOUND);

    const allScores = await loadScopedScores(scope, appUser);

    const totalGames = allScores.length;
    const best = allScores.reduce((a, b) => (b.score > a.score ? b : a), allScores[0] ?? { score: 0, machineName: null, venueName: null });
    const casualCount = allScores.filter(s => s.type === 'casual').length;
    const tournamentCount = allScores.filter(s => s.type === 'tournament').length;

    const machineCounts: Record<string, { plays: number; byGroup: Record<ScoreGroup, number> }> = {};
    for (const s of allScores) {
      const m = (machineCounts[s.machineName] ??= { plays: 0, byGroup: { self: 0, pod: 0, friend: 0, other: 0 } });
      m.plays++;
      m.byGroup[s.group]++;
    }
    const uniqueMachines = Object.keys(machineCounts).length;
    // Distinct venues with at least one in-scope score. Counted off the same privacy-filtered rows,
    // so a hidden home venue only counts for someone who can see a score there (its owner, an
    // admin, or a player counting their own score) — never because a pod member played there.
    // Not split by group: one venue can count for several groups, like uniqueMachines.
    const venuesPlayed = new Set(allScores.map(s => s.venueId).filter(id => id != null)).size;
    const mostPlayed = Object.entries(machineCounts)
      .sort((a, b) => b[1].plays - a[1].plays)
      .slice(0, 5)
      .map(([name, m]) => ({ name, plays: m.plays, byGroup: m.byGroup }));

    const totalVisits = computeVisits(allScores);
    const avgPlaysPerVisit = totalVisits ? totalGames / totalVisits : 0;

    const createdMs = allScores.map(s => new Date(s.createdAt).getTime());
    const avgScoresSubmittedPerDay = totalGames / daySpan(createdMs);

    // Literal current-calendar-month totals (America/New_York) — not an extrapolated rate, so
    // these reset at the start of each month rather than averaging over all-time history.
    const thisMonth = computeCurrentMonthCounts(allScores);

    // The same additive counts per group (you / the pod's members or your friends / everyone else), so the page can
    // show who a total is made of. Visits cluster per player, so they split cleanly by group;
    // distinct-machine counts overlap between groups and are deliberately not split.
    const split = Object.fromEntries(GROUPS.map(g => {
      const inGroup = allScores.filter(s => s.group === g);
      const month = computeCurrentMonthCounts(inGroup);
      return [g, { plays: inGroup.length, visits: computeVisits(inGroup), playsThisMonth: month.plays, visitsThisMonth: month.visits }];
    })) as Record<ScoreGroup, { plays: number; visits: number; playsThisMonth: number; visitsThisMonth: number }>;

    // Site-wide facts, independent of the comparison scope — a venue or machine roster isn't
    // anybody's, so these are the same number in every view.
    const [{ totalVenues }] = await db.select({ totalVenues: count() }).from(venues);
    const [{ totalMachinesInSystem }] = await db.select({ totalMachinesInSystem: count() }).from(machines);

    res.json({
      scope: scopeView(scope),
      totalGames,
      totalVisits,
      totalVenues,
      totalMachinesInSystem,
      allTimeHigh: { score: best.score, machineName: best.machineName, venueName: best.venueName },
      mostPlayed,
      uniqueMachines,
      venuesPlayed,
      playStyle: { casual: casualCount, tournament: tournamentCount },
      playHabits: {
        avgPlaysPerVisit,
        avgScoresSubmittedPerDay,
        playsThisMonth: thisMonth.plays,
        visitsThisMonth: thisMonth.visits,
        scoresSubmittedThisMonth: thisMonth.scoresSubmitted,
      },
      split,
    });
  } catch (err) {
    console.error('stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/stats/history/:key?days=90[&scope params] — daily series for one stat, for the trend
// chart modal. Takes the same scope params as GET /api/stats, and 404s a pod you don't own the
// same way whatever the key.
//  - All, pod + everyone else, or a site-wide key (total_venues, total_machines): the stat_history
//    snapshots, which are only ever captured site-wide (see captureStatSnapshot). `source:
//    'snapshot'`. Pod (or friends) + everyone else is every player, so it gets the same series as All.
//  - Mine / pod only / friends only, for a key that only counts scores: rebuilt live from the scope's visible
//    scores (computeLiveTrend). `source: 'live'`. Per-pod history is never stored.
router.get('/history/:key', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const days = Math.min(Number(req.query.days) || 90, 365);
  try {
    const scope = await resolveComparisonScope(parseComparisonScope(req.query), appUser);
    if (!scope) return void res.status(404).json(POD_NOT_FOUND);

    const [stat] = await db.select().from(stats).where(eq(stats.key, req.params.key)).limit(1);
    if (!stat) return void res.status(404).json({ error: 'Unknown stat key' });

    const everyone = scopeIsEveryone(scope);
    if (!everyone && isLiveTrendKey(stat.key)) {
      const scoped = await loadScopedScores(scope, appUser);
      const points = computeLiveTrend(stat.key, scoped, days);
      return void res.json({ label: stat.label, description: stat.description, source: 'live', scope: scopeView(scope), points });
    }

    const rows = await db
      .select({ periodDate: statHistory.periodDate, value: statHistory.value })
      .from(statHistory)
      .where(eq(statHistory.statId, stat.id))
      .orderBy(desc(statHistory.periodDate))
      .limit(days);

    res.json({ label: stat.label, description: stat.description, source: 'snapshot', scope: scopeView(scope), points: rows.reverse() });
  } catch (err) {
    console.error('stats/history error:', err);
    res.status(500).json({ error: 'Failed to fetch stat history' });
  }
});

export default router;
