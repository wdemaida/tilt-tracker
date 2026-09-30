import { sql, type SQL } from 'drizzle-orm';
import type { Executor } from './activity.js';
import { localParts } from './badgeRules.js';

// Badges — the metric library (feature/badges). A metric badge is "metric ≥ N" with an admin-set N,
// so "5 wins" and "50 wins" are two rows in `badges`, not two pieces of code. The admin form reads
// this registry through GET /api/admin/badges/metrics; adding a metric is one entry here.
//
// Two sources:
//   derived — computed from tables that are never purged (scores today; challenges in phase 3)
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

/** A metric aggregated over `scores`. */
function scoresMetric(def: Omit<MetricDef, 'source' | 'countSql' | 'triggers'>, agg: SQL, where: SQL = sql``): MetricDef {
  return {
    ...def,
    source: 'derived',
    triggers: ['score', 'sweep'],
    countSql: ({ userIds, min }) => sql`SELECT user_id, ${agg}::int AS value FROM scores
      WHERE true${where}${userFilter(sql`user_id`, userIds)}
      GROUP BY user_id${having(agg, min)}`,
  };
}

export const METRICS: readonly MetricDef[] = [
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

// TODO(phase 3): the challenge-derived metrics. They read challenges.status,
// challenge_participants.response / decline_reason, challenges.countered_from_id and (group
// challenges, migrate24) challenges.proposed_by_id / proposal_decided_at. Implement each as a
// MetricDef with source 'derived', triggers ['challenge', 'sweep'] — wins/losses/ties/abandoned/
// streaks from computeRecord() (challengeRules.ts: bestStreak and bestLossStreak), the rest as
// GROUP BY queries that exclude proposal rows (status proposed / rejected / lapsed) — move it into
// METRICS, and delete it from this list. counters_accepted is now a proposal fact (proposed_by_id),
// not "challenges you created"; the exact SQL is in the badges plan's "Phase 3 notes".
// challenges_declined is a TRUE decline only: response 'declined' AND decline_reason IS DISTINCT FROM
// 'backed_out' (a counter is response 'countered', so it's excluded too). challenges_backed_out is
// response 'declined' AND decline_reason 'backed_out' — an accepted invitee who left a pending group
// (migrate24; the server sets that reason only on the back-out path). Both join challenges and skip
// proposal rows (status proposed / rejected / lapsed). Seeded badges
// on these metrics (migrate23) stay draft until then: activateBadge refuses an unavailable metric.
export const PENDING_METRICS: ReadonlyArray<Pick<MetricDef, 'key' | 'label' | 'description'>> = [
  { key: 'challenge_wins', label: 'Challenges won', description: 'Resolved challenges the player won.' },
  { key: 'challenge_losses', label: 'Challenges lost', description: 'Resolved challenges the player lost.' },
  { key: 'challenges_tied', label: 'Challenges tied', description: 'Resolved challenges that ended in a tie.' },
  { key: 'challenges_abandoned', label: 'Challenges abandoned', description: 'Challenges nobody finished.' },
  { key: 'win_streak_achieved', label: 'Best win streak', description: 'Longest run of consecutive challenge wins.' },
  { key: 'loss_streak_achieved', label: 'Worst loss streak', description: 'Longest run of consecutive challenge losses.' },
  { key: 'challenges_declined', label: 'Challenges declined', description: 'Challenges the player declined outright (not counter-offers, not backing out after accepting).' },
  { key: 'challenges_backed_out', label: 'Challenges backed out of', description: 'Group challenges the player accepted, then left before they started.' },
  { key: 'challenges_countered', label: 'Counter-offers made', description: 'Challenges the player answered with a counter-offer.' },
  { key: 'challenges_cant_reach', label: '"Can’t get there" answers', description: 'Declines or counters because the player can’t reach the venue.' },
  { key: 'challenges_passed', label: 'Challenges passed on', description: 'Declines with "no thanks".' },
  { key: 'counters_accepted', label: 'Counter-offers accepted', description: 'The player’s counter-offers that were taken up.' },
];

const BY_KEY = new Map(METRICS.map(m => [m.key, m]));

export function metricByKey(key: string | null | undefined): MetricDef | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

/** Metrics a given trigger can change. */
export function metricsFor(trigger: MetricTrigger): string[] {
  return METRICS.filter(m => m.triggers.includes(trigger)).map(m => m.key);
}

/** The registry as the admin form sees it — available metrics first, phase-3 ones flagged. */
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
