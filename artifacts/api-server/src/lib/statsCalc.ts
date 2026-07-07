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

// Raw counts for the current America/New_York calendar month, from a pre-filtered (mine or
// site-wide) score set. These are the literal month-to-date totals — not an extrapolated rate —
// so they reset at the start of each month.
export function computeCurrentMonthCounts(allScores: ScoreLike[], now: Date = new Date()) {
  const thisMonth = nyMonthString(now);

  const playsThisMonth = allScores.filter(s => nyMonthString(new Date(s.playedAt)) === thisMonth);
  const scoresSubmittedThisMonth = allScores.filter(s => nyMonthString(new Date(s.createdAt)) === thisMonth);

  const playedByUser: Record<string, number[]> = {};
  for (const s of playsThisMonth) {
    (playedByUser[s.userId] ??= []).push(new Date(s.playedAt).getTime());
  }
  let visits = 0;
  for (const ms of Object.values(playedByUser)) {
    visits += countVisits([...ms].sort((a, b) => a - b));
  }

  return {
    plays: playsThisMonth.length,
    visits,
    scoresSubmitted: scoresSubmittedThisMonth.length,
  };
}
