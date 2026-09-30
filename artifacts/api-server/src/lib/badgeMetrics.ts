import { sql, type SQL } from 'drizzle-orm';
import type { Executor } from './activity.js';
import { localParts } from './badgeRules.js';
import { FUTURE_SKEW_MS } from './playedAtClock.js';

// Badges — the metric library (feature/badges). A metric badge is "metric ≥ N" with an admin-set N,
// so "5 wins" and "50 wins" are two rows in `badges`, not two pieces of code. The admin form reads
// this registry through GET /api/admin/badges/metrics; adding a metric is one entry here.
//
// Two sources:
//   derived — computed from tables that are never purged (scores; challenges since phase 3)
//   marks   — COUNT(*) of user_metric_marks rows (migrate23), for events whose source rows get
//             deleted (unfriend deletes the friendship) or purged (activity_events retention). Each
//             mark's `ref` makes it idempotent: a login day's ref is the America/New_York date, a
//             friend request's is the recipient's id, a decline's is "<other id>:<decline number>".
//             Marks are written whatever the activity-retention settings say.
//
// Each metric's SQL is one GROUP BY user_id query that serves all three callers: a single user's
// value (userIds = [id]), the daily sweep's handful of users, and a retroactive backfill (every user,
// HAVING value ≥ threshold) — never a loop over users.

export type MetricSource = 'derived' | 'marks';
/** What changes a metric — which triggers re-check the badges on it. */
export type MetricTrigger = 'score' | 'friend' | 'login' | 'challenge' | 'sweep';

export interface MetricDef {
  key: string;
  label: string;
  description: string;
  source: MetricSource;
  triggers: MetricTrigger[];
  /** The catalog's requirement text for a threshold ("Post 100 scores"). */
  phrase: (n: number) => string;
  /** SELECT user_id, value … GROUP BY user_id, optionally limited to `userIds` / HAVING value ≥ `min`. */
  countSql: (opts: CountOpts) => SQL;
}

export interface CountOpts { userIds?: number[]; min?: number }

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function userFilter(col: SQL, userIds: number[] | undefined): SQL {
  if (!userIds) return sql``;
  return sql` AND ${col} IN (${sql.join(userIds.map(id => sql`${id}`), sql`, `)})`;
}
const having = (expr: SQL, min: number | undefined) => (min != null ? sql` HAVING ${expr} >= ${min}` : sql``);

/** A metric counted from user_metric_marks. */
function marksMetric(def: Omit<MetricDef, 'source' | 'countSql'>): MetricDef {
  return {
    ...def,
    source: 'marks',
    countSql: ({ userIds, min }) => sql`SELECT user_id, count(*)::int AS value FROM user_metric_marks
      WHERE metric = ${def.key}${userFilter(sql`user_id`, userIds)}
      GROUP BY user_id${having(sql`count(*)`, min)}`,
  };
}

/**
 * `played` is not more than FUTURE_SKEW_MS after `created` — the SQL twin of
 * `!playedAfter(playedAt, createdAt)` (playedAtClock.ts). Every score metric and loadRuleScores() use
 * it, so a legacy future-dated score earns no badge anywhere (Will, 2026-09-30).
 */
export function playedNotInFutureSql(played: SQL = sql`played_at`, created: SQL = sql`created_at`): SQL {
  return sql`${played} <= ${created} + (${FUTURE_SKEW_MS}::int * interval '1 millisecond')`;
}

/** A metric aggregated over `scores` — never counting a score played in the future of its posting. */
function scoresMetric(def: Omit<MetricDef, 'source' | 'countSql' | 'triggers'>, agg: SQL, where: SQL = sql``): MetricDef {
  return {
    ...def,
    source: 'derived',
    triggers: ['score', 'sweep'],
    countSql: ({ userIds, min }) => sql`SELECT user_id, ${agg}::int AS value FROM scores
      WHERE ${playedNotInFutureSql()}${where}${userFilter(sql`user_id`, userIds)}
      GROUP BY user_id${having(agg, min)}`,
  };
}

const BASE_METRICS: readonly MetricDef[] = [
  scoresMetric({
    key: 'scores_posted', label: 'Scores posted', description: 'How many scores the player has posted.',
    phrase: n => (n === 1 ? 'Post your first score' : `Post ${plural(n, 'score')}`),
  }, sql`count(*)`),
  scoresMetric({
    key: 'distinct_machines', label: 'Different machines', description: 'How many different machines the player has posted a score on.',
    phrase: n => `Post scores on ${plural(n, 'different machine')}`,
  }, sql`count(DISTINCT machine_id)`),
  scoresMetric({
    key: 'distinct_venues', label: 'Different venues', description: 'How many different venues the player has posted a score at.',
    phrase: n => `Post scores at ${plural(n, 'different venue')}`,
  }, sql`count(DISTINCT venue_id)`, sql` AND venue_id IS NOT NULL`),
  marksMetric({
    key: 'friend_requests_sent', label: 'Friend requests sent', description: 'Different people the player has sent a friend request to (re-sending to the same person counts once).',
    triggers: ['friend'], phrase: n => (n === 1 ? 'Send your first friend request' : `Send friend requests to ${plural(n, 'person', 'people')}`),
  }),
  marksMetric({
    key: 'friend_requests_accepted_by_you', label: 'Friend requests you accepted', description: 'Different people whose friend request the player accepted.',
    triggers: ['friend'], phrase: n => `Accept ${plural(n, 'friend request')}`,
  }),
  marksMetric({
    key: 'your_requests_accepted', label: 'Your requests accepted', description: 'Different people who accepted the player’s friend request.',
    triggers: ['friend'], phrase: n => `Have ${plural(n, 'friend request')} accepted`,
  }),
  marksMetric({
    key: 'friend_requests_declined_by_you', label: 'Friend requests you declined', description: 'Friend requests the player declined (each decline counts).',
    triggers: ['friend'], phrase: n => `Decline ${plural(n, 'friend request')}`,
  }),
  marksMetric({
    key: 'your_requests_declined', label: 'Your requests declined', description: 'The player’s friend requests that were declined (each decline counts).',
    triggers: ['friend'], phrase: n => `Have ${plural(n, 'friend request')} declined`,
  }),
  marksMetric({
    key: 'login_days', label: 'Days signed in', description: 'Distinct days (Eastern time) the player signed in.',
    triggers: ['login'], phrase: n => `Sign in on ${plural(n, 'different day')}`,
  }),
];

// ── challenge metrics (badges phase 3) ───────────────────────────────────────
//
// Every one is derived from durable challenge columns — never from activity events (retention can
// purge those): challenges.status / resolved_at / void / proposed_by_id / proposal_decided_at /
// countered_from_id and challenge_participants.response / decline_reason / outcome.
//
// RECORD metrics (wins, losses, ties, abandoned, the two streaks) are the SQL twin of computeRecord()
// (challengeRules.ts) over exactly the rows getRecord() feeds it: status 'resolved', the player's own
// row accepted with an outcome. The headline uses the player's own outcome, so in a group placing
// below 1st is a loss. An admin-voided challenge is status 'cancelled' with every outcome cleared
// (adminActions.voidChallenge), so it drops out of all of them — nothing is revoked (no automatic
// revocation), it just stops counting. Streaks are "best ever ≥ N": consecutive wins (losses) in
// (resolved_at, id) order; any other outcome ends a run, abandoned included, and a legacy void row
// (challenges.void — retired) neither extends nor breaks one. badgeMetrics.test.ts checks the SQL
// against computeRecord on random histories.
//
// PARTICIPANT metrics (declined, backed out, countered, can't reach, passed, missed) never count a
// PROPOSAL row (status proposed / rejected / lapsed): its participants are the proposer ('accepted' —
// not a real acceptance) and the challenger, whose row closes 'declined' (rejected) or 'missed'
// (lapsed) — her decision is the row's status, not a declined or missed challenge.
//
// PROPOSAL metrics (counters_accepted, counters_rejected) read the proposal rows themselves.

/** The rows computeRecord() sees for each player (getRecord's query), in its order. */
const RECORD_ROWS = sql`SELECT cp.user_id, c.id AS challenge_id, coalesce(c.resolved_at, 'epoch'::timestamp) AS resolved_at, c.void, cp.outcome
  FROM challenge_participants cp JOIN challenges c ON c.id = cp.challenge_id
  WHERE c.status = 'resolved' AND cp.response = 'accepted' AND cp.outcome IS NOT NULL`;

/** Proposal rows are never a participant fact (see above). */
const NOT_PROPOSAL = sql`c.status NOT IN ('proposed', 'rejected', 'lapsed')`;

const CHALLENGE_TRIGGERS: MetricTrigger[] = ['challenge', 'sweep'];

/** A count of the player's resolved challenges with this outcome (computeRecord's wins / losses / …). */
function outcomeMetric(def: Omit<MetricDef, 'source' | 'countSql' | 'triggers'>, outcome: string): MetricDef {
  return {
    ...def,
    source: 'derived',
    triggers: CHALLENGE_TRIGGERS,
    countSql: ({ userIds, min }) => sql`SELECT user_id, count(*)::int AS value FROM (${RECORD_ROWS}) r
      WHERE outcome = ${outcome}${userFilter(sql`user_id`, userIds)}
      GROUP BY user_id${having(sql`count(*)`, min)}`,
  };
}

/**
 * Best-ever run of `outcome` (computeRecord's bestStreak / bestLossStreak) — gaps and islands: within
 * a player's non-void rows in record order, row_number() minus row_number() per outcome is constant
 * along a run of the same outcome.
 */
function streakMetric(def: Omit<MetricDef, 'source' | 'countSql' | 'triggers'>, outcome: string): MetricDef {
  return {
    ...def,
    source: 'derived',
    triggers: CHALLENGE_TRIGGERS,
    countSql: ({ userIds, min }) => sql`SELECT user_id, max(run)::int AS value FROM (
        SELECT user_id, count(*) AS run FROM (
          SELECT user_id, outcome,
            row_number() OVER (PARTITION BY user_id ORDER BY resolved_at, challenge_id)
              - row_number() OVER (PARTITION BY user_id, outcome ORDER BY resolved_at, challenge_id) AS island
          FROM (${RECORD_ROWS}) r WHERE NOT void${userFilter(sql`user_id`, userIds)}
        ) x WHERE outcome = ${outcome} GROUP BY user_id, island
      ) runs GROUP BY user_id${having(sql`max(run)`, min)}`,
  };
}

/** A count of the player's participant rows matching `where` (proposal rows excluded). */
function participantMetric(def: Omit<MetricDef, 'source' | 'countSql' | 'triggers'>, where: SQL): MetricDef {
  return {
    ...def,
    source: 'derived',
    triggers: CHALLENGE_TRIGGERS,
    countSql: ({ userIds, min }) => sql`SELECT cp.user_id, count(*)::int AS value
      FROM challenge_participants cp JOIN challenges c ON c.id = cp.challenge_id
      WHERE ${NOT_PROPOSAL} AND ${where}${userFilter(sql`cp.user_id`, userIds)}
      GROUP BY cp.user_id${having(sql`count(*)`, min)}`,
  };
}

/** A count of challenges rows per `userCol` matching `where` (the proposal metrics). */
function challengeRowMetric(def: Omit<MetricDef, 'source' | 'countSql' | 'triggers'>, userCol: SQL, where: SQL): MetricDef {
  return {
    ...def,
    source: 'derived',
    triggers: CHALLENGE_TRIGGERS,
    countSql: ({ userIds, min }) => sql`SELECT user_id, count(*)::int AS value FROM (
        SELECT ${userCol} AS user_id FROM challenges c WHERE ${where}
      ) x WHERE user_id IS NOT NULL${userFilter(sql`user_id`, userIds)}
      GROUP BY user_id${having(sql`count(*)`, min)}`,
  };
}

const CHALLENGE_METRICS: readonly MetricDef[] = [
  outcomeMetric({
    key: 'challenge_wins', label: 'Challenges won', description: 'Resolved challenges the player won (1st place in a group).',
    phrase: n => (n === 1 ? 'Win your first challenge' : `Win ${plural(n, 'challenge')}`),
  }, 'win'),
  outcomeMetric({
    key: 'challenge_losses', label: 'Challenges lost', description: 'Resolved challenges the player lost (in a group, placing below 1st).',
    phrase: n => `Lose ${plural(n, 'challenge')}`,
  }, 'loss'),
  outcomeMetric({
    key: 'challenges_tied', label: 'Challenges tied', description: 'Resolved challenges the player tied.',
    phrase: n => (n === 1 ? 'Tie a challenge' : `Tie ${plural(n, 'challenge')}`),
  }, 'tie'),
  outcomeMetric({
    key: 'challenges_abandoned', label: 'Challenges abandoned', description: 'Resolved challenges the player was in that nobody finished.',
    phrase: n => `Be in ${plural(n, 'abandoned challenge')}`,
  }, 'abandoned'),
  streakMetric({
    key: 'win_streak_achieved', label: 'Best win streak', description: 'Longest run of consecutive challenge wins, ever (a streak once reached stays reached).',
    phrase: n => `Win ${plural(n, 'challenge')} in a row`,
  }, 'win'),
  streakMetric({
    key: 'loss_streak_achieved', label: 'Worst loss streak', description: 'Longest run of consecutive challenge losses, ever.',
    phrase: n => `Lose ${plural(n, 'challenge')} in a row`,
  }, 'loss'),
  participantMetric({
    key: 'challenges_declined', label: 'Challenges declined', description: 'Challenges the player declined outright (not counter-offers, not backing out after accepting).',
    phrase: n => `Decline ${plural(n, 'challenge')}`,
  }, sql`cp.response = 'declined' AND cp.decline_reason IS DISTINCT FROM 'backed_out'`),
  participantMetric({
    key: 'challenges_backed_out', label: 'Challenges backed out of', description: 'Group challenges the player accepted, then left before they started.',
    phrase: n => `Back out of ${plural(n, 'challenge')}`,
  }, sql`cp.response = 'declined' AND cp.decline_reason = 'backed_out'`),
  participantMetric({
    key: 'challenges_countered', label: 'Counter-offers made', description: 'Challenges the player answered with a counter-offer.',
    phrase: n => (n === 1 ? 'Make a counter-offer' : `Make ${plural(n, 'counter-offer')}`),
  }, sql`cp.response = 'countered'`),
  participantMetric({
    key: 'challenges_cant_reach', label: '"Can’t get there" answers', description: 'Declines or counter-offers because the player can’t reach the venue.',
    phrase: n => `Answer “can’t get there” ${plural(n, 'time')}`,
  }, sql`cp.decline_reason = 'cant_reach'`),
  participantMetric({
    key: 'challenges_passed', label: 'Challenges passed on', description: 'Declines with "no thanks".',
    phrase: n => `Pass on ${plural(n, 'challenge')}`,
  }, sql`cp.decline_reason = 'no_thanks'`),
  participantMetric({
    key: 'challenges_missed', label: 'Challenges missed', description: 'Challenges that started (or expired) before the player answered.',
    phrase: n => `Miss ${plural(n, 'challenge')}`,
  }, sql`cp.response = 'missed'`),
  challengeRowMetric({
    key: 'counters_accepted', label: 'Counter-offers accepted', description: 'The player’s counter-offers that the challenger took up.',
    phrase: n => (n === 1 ? 'Have a counter-offer accepted' : `Have ${plural(n, 'counter-offer')} accepted`),
  },
  // A proposal the challenger took (it's a normal challenge from then on), or a legacy counter row
  // (migrate22: created by the counterer, no proposed_by_id) that went ahead.
  sql`CASE WHEN c.proposed_by_id IS NOT NULL THEN c.proposed_by_id ELSE c.creator_id END`,
  sql`(c.proposed_by_id IS NOT NULL AND c.proposal_decided_at IS NOT NULL AND c.status NOT IN ('proposed', 'rejected', 'lapsed'))
    OR (c.proposed_by_id IS NULL AND c.countered_from_id IS NOT NULL AND c.status IN ('active', 'resolved'))`),
  challengeRowMetric({
    key: 'counters_rejected', label: 'Counter-offers turned down', description: 'The player’s counter-offers that closed untaken (kept the original, took another, or started without it).',
    phrase: n => `Have ${plural(n, 'counter-offer')} turned down`,
  }, sql`c.proposed_by_id`, sql`c.status = 'rejected'`),
];

export const METRICS: readonly MetricDef[] = [...BASE_METRICS, ...CHALLENGE_METRICS];

// Metrics the admin form lists but that can't be evaluated yet (none today — every challenge metric
// landed in phase 3). A badge on one can be saved as a draft; activateBadge refuses it
// (metric_unavailable) until it moves into METRICS.
export const PENDING_METRICS: ReadonlyArray<Pick<MetricDef, 'key' | 'label' | 'description'>> = [];

const BY_KEY = new Map(METRICS.map(m => [m.key, m]));

export function metricByKey(key: string | null | undefined): MetricDef | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

/** Metrics a given trigger can change. */
export function metricsFor(trigger: MetricTrigger): string[] {
  return METRICS.filter(m => m.triggers.includes(trigger)).map(m => m.key);
}

/** The registry as the admin form sees it — available metrics first, any pending ones flagged. */
export function metricCatalog() {
  return [
    ...METRICS.map(m => ({ key: m.key, label: m.label, description: m.description, source: m.source, triggers: m.triggers, available: true })),
    ...PENDING_METRICS.map(m => ({ ...m, source: 'derived' as const, triggers: ['challenge' as const], available: false })),
  ];
}

/** Requirement text for "metric ≥ n" ("Post 100 scores"); a pending metric gets a generic phrase. */
export function describeMetric(key: string, n: number): string {
  const m = metricByKey(key);
  if (m) return m.phrase(n);
  const p = PENDING_METRICS.find(x => x.key === key);
  return p ? `${p.label}: ${n.toLocaleString('en-US')}` : `${key} ≥ ${n}`;
}

/** Each user's value of `key` (users with no rows are absent — their value is 0). */
export async function metricCounts(ex: Executor, key: string, opts: CountOpts = {}): Promise<Map<number, number>> {
  const m = metricByKey(key);
  const out = new Map<number, number>();
  if (!m || (opts.userIds && !opts.userIds.length)) return out;
  const rows = await ex.execute(m.countSql(opts)) as unknown as Array<{ user_id: number; value: number }>;
  for (const r of rows) out.set(Number(r.user_id), Number(r.value));
  return out;
}

export async function readMetric(ex: Executor, key: string, userId: number): Promise<number> {
  return (await metricCounts(ex, key, { userIds: [userId] })).get(userId) ?? 0;
}

// ── marks ────────────────────────────────────────────────────────────────────

export interface MarkRow { userId: number; metric: string; ref: string }

/** The America/New_York calendar date of an instant — a login day's ref. */
export function easternDate(at: Date): string {
  return localParts(at, 'America/New_York').date;
}

export function loginMark(userId: number, at: Date): MarkRow {
  return { userId, metric: 'login_days', ref: easternDate(at) };
}

export type FriendEvent =
  | { kind: 'sent'; from: number; to: number }
  | { kind: 'accepted'; acceptor: number; requester: number }
  | { kind: 'declined'; decliner: number; requester: number; declineNumber: number };

/** The marks a friend event writes (both sides where there are two). Pure — unit-tested. */
export function friendMarks(ev: FriendEvent): MarkRow[] {
  switch (ev.kind) {
    case 'sent':
      return [{ userId: ev.from, metric: 'friend_requests_sent', ref: String(ev.to) }];
    case 'accepted':
      return [
        { userId: ev.acceptor, metric: 'friend_requests_accepted_by_you', ref: String(ev.requester) },
        { userId: ev.requester, metric: 'your_requests_accepted', ref: String(ev.acceptor) },
      ];
    case 'declined':
      return [
        { userId: ev.decliner, metric: 'friend_requests_declined_by_you', ref: `${ev.requester}:${ev.declineNumber}` },
        { userId: ev.requester, metric: 'your_requests_declined', ref: `${ev.decliner}:${ev.declineNumber}` },
      ];
  }
}

/** INSERT … ON CONFLICT DO NOTHING for marks; RETURNING the rows that were new. */
export function insertMarksSql(rows: MarkRow[], at: Date = new Date()): SQL {
  const values = sql.join(rows.map(r => sql`(${r.userId}, ${r.metric}, ${r.ref}, ${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`), sql`, `);
  return sql`INSERT INTO user_metric_marks (user_id, metric, ref, at) VALUES ${values}
    ON CONFLICT DO NOTHING RETURNING user_id, metric`;
}

/** Write marks; returns how many were new. Throws on DB errors (callers wrap it). */
export async function recordMarks(ex: Executor, rows: MarkRow[], at?: Date): Promise<number> {
  if (!rows.length) return 0;
  const inserted = await ex.execute(insertMarksSql(rows, at)) as unknown as unknown[];
  return inserted.length;
}
