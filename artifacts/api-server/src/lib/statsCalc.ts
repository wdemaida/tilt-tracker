export const VISIT_GAP_MS = 6 * 3600 * 1000; // 6-hour gap = new visit
export const NY_TZ = 'America/New_York';

// Number of visits in a sorted-by-time-asc series of timestamps for one player
export function countVisits(sortedMs: number[]): number {
  if (!sortedMs.length) return 0;
  let visits = 1;
  for (let i = 1; i < sortedMs.length; i++) {
    if (sortedMs[i] - sortedMs[i - 1] > VISIT_GAP_MS) visits++;
  }
  return visits;
}

// "YYYY-MM-DD" for a given instant, in the America/New_York calendar day
export function nyDateString(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// "YYYY-MM" for a given instant, in the America/New_York calendar month
function nyMonthString(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NY_TZ, year: 'numeric', month: '2-digit' }).format(d);
}

interface ScoreLike {
  playedAt: string | Date;
  createdAt: string | Date;
  userId: number;
}

// Visits are clustered per-player (gap > 6h = new visit), then summed — pooling timestamps
// across players before clustering would merge unrelated outings.
export function computeVisits(scoreList: Pick<ScoreLike, 'playedAt' | 'userId'>[]): number {
  const playedByUser: Record<string, number[]> = {};
  for (const s of scoreList) {
    (playedByUser[s.userId] ??= []).push(new Date(s.playedAt).getTime());
  }
  let visits = 0;
  for (const ms of Object.values(playedByUser)) {
    visits += countVisits([...ms].sort((a, b) => a - b));
  }
  return visits;
}

// Raw counts for the current America/New_York calendar month, from a pre-filtered (mine or
// site-wide) score set. These are the literal month-to-date totals — not an extrapolated rate —
// so they reset at the start of each month.
export function computeCurrentMonthCounts(allScores: ScoreLike[], now: Date = new Date()) {
  const thisMonth = nyMonthString(now);

  const playsThisMonth = allScores.filter(s => nyMonthString(new Date(s.playedAt)) === thisMonth);
  const scoresSubmittedThisMonth = allScores.filter(s => nyMonthString(new Date(s.createdAt)) === thisMonth);

  return {
    plays: playsThisMonth.length,
    visits: computeVisits(playsThisMonth),
    scoresSubmitted: scoresSubmittedThisMonth.length,
  };
}

// Stat keys whose history can be rebuilt live from a score set (anything that only counts scores).
// The others — total_venues, total_machines — count rows that don't belong to a player, so they
// are site-wide facts and only ever come from the daily stat_history snapshots.
export const LIVE_TREND_KEYS = ['total_plays', 'total_visits', 'machines_with_score', 'plays', 'visits', 'scores_submitted'] as const;
export type LiveTrendKey = typeof LIVE_TREND_KEYS[number];
export const isLiveTrendKey = (k: string): k is LiveTrendKey => (LIVE_TREND_KEYS as readonly string[]).includes(k);

interface TrendScore extends ScoreLike {
  machineName: string;
}

/**
 * Daily series for one stat, rebuilt from a (scope-filtered) score set rather than read from the
 * site-wide stat_history snapshots — so Mine and pod views can show a trend of their own.
 *
 * Day D's value is what captureStatSnapshot would have written at the end of D had only these
 * scores existed: every score *submitted* (createdAt) by the end of D in America/New_York, with the
 * month counters taken for D's month. Deleted scores are gone, so unlike the snapshots this can't
 * show history that was later removed. Starts at the first submission, capped at `days` points.
 */
export function computeLiveTrend(key: LiveTrendKey, scoreList: TrendScore[], days: number, now: Date = new Date()) {
  const tagged = scoreList
    .map(s => ({ s, day: nyDateString(new Date(s.createdAt)) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (!tagged.length) return [] as { periodDate: string; value: number }[];

  // Calendar days as noon UTC (07:00/08:00 in New York), so stepping by a day never lands on the
  // wrong NY date across a DST change.
  const [y, m, d] = nyDateString(now).split('-').map(Number);
  const dayList: { periodDate: string; anchor: Date }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const anchor = new Date(Date.UTC(y, m - 1, d - i, 12));
    const periodDate = nyDateString(anchor);
    if (periodDate >= tagged[0].day) dayList.push({ periodDate, anchor });
  }

  const points: { periodDate: string; value: number }[] = [];
  const upTo: TrendScore[] = [];
  let next = 0;
  for (const { periodDate, anchor } of dayList) {
    while (next < tagged.length && tagged[next].day <= periodDate) upTo.push(tagged[next++].s);
    let value: number;
    switch (key) {
      case 'total_plays': value = upTo.length; break;
      case 'total_visits': value = computeVisits(upTo); break;
      case 'machines_with_score': value = new Set(upTo.map(s => s.machineName)).size; break;
      case 'plays': value = computeCurrentMonthCounts(upTo, anchor).plays; break;
      case 'visits': value = computeCurrentMonthCounts(upTo, anchor).visits; break;
      case 'scores_submitted': value = computeCurrentMonthCounts(upTo, anchor).scoresSubmitted; break;
    }
    points.push({ periodDate, value });
  }
  return points;
}
