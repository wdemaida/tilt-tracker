// A played time can't be in the future. One rule, one constant, three users:
//  - POST /api/scores refuses a playedAt more than FUTURE_SKEW_MS after the server's clock, and
//    PATCH /api/scores/:id (admin corrections included) one more than FUTURE_SKEW_MS after the row's
//    created_at — you can't have played a game after you logged it (created_at <= now, so this is
//    the stricter of the two). 400 played_at_in_future either way.
//  - Challenges (challengeRules.exclusionReason) don't count a score whose played_at is more than
//    FUTURE_SKEW_MS after its created_at ('played_in_future') — legacy rows written before the
//    routes refused them (dev score #1276, 2026-09-30) included.
//  - Badges: no rule badge (badgeRules.scoreQualifies — every rule, posting window or not) and no
//    score metric (badgeMetrics.playedNotInFutureSql, also in loadRuleScores) counts a score whose
//    played_at is more than FUTURE_SKEW_MS after its created_at.
//
// Clock: the routes use the API server's clock; created_at is stamped by the DB clock. Neon's is
// ~1 s off ours, which is noise next to 15 minutes. The slack itself is for a phone's clock being a
// few minutes fast.
//
// No imports: challengeRules.ts and badgeRules.ts are pure and badgeRules imports challengeRules,
// so the constant lives here rather than in either.

/** A played_at this far after "now" (or after created_at) is still "now" — client clock skew. */
export const FUTURE_SKEW_MS = 15 * 60 * 1000;

/** Is `playedAt` more than FUTURE_SKEW_MS after `reference` (the server's now, or the row's created_at)? */
export function playedAfter(playedAt: Date, reference: Date): boolean {
  return +playedAt - +reference > FUTURE_SKEW_MS;
}

export const PLAYED_AT_IN_FUTURE = {
  error: "The played time can't be in the future",
  code: 'played_at_in_future',
} as const;

export const PLAYED_AT_AFTER_LOGGED = {
  error: "The played time can't be later than when the score was logged",
  code: 'played_at_in_future',
} as const;
