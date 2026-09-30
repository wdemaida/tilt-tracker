// Run: npx tsx --test src/lib/badgeMetrics.test.ts   (from artifacts/api-server)
//
// The badge metric library. Pure helpers (refs, marks) plus each metric's SQL, rendered by drizzle's
// PgDialect and run against an in-process PGlite (real Postgres, WASM) — nothing is dialled; the
// dummy DATABASE_URL only satisfies @workspace/db's import-time check.
// TODO(phase 3): "the best-streak and abandoned counts come from computeRecord" lands with the
// challenge metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  METRICS, PENDING_METRICS, metricByKey, metricCatalog, metricsFor, describeMetric, easternDate, loginMark, friendMarks, insertMarksSql,
} = await import('./badgeMetrics.js');
const { PgDialect } = await import('drizzle-orm/pg-core');
const { PGlite } = await import('@electric-sql/pglite');

const pg = new PGlite();
await pg.exec(`
  CREATE TABLE user_metric_marks (user_id integer NOT NULL, metric text NOT NULL, ref text NOT NULL,
    at timestamp NOT NULL DEFAULT now(), PRIMARY KEY (user_id, metric, ref));
  CREATE TABLE scores (id serial PRIMARY KEY, user_id integer NOT NULL, machine_id integer NOT NULL, venue_id integer,
    played_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now());
`);
const dialect = new PgDialect();
async function run(q: any): Promise<any[]> {
  const { sql, params } = dialect.sqlToQuery(q);
  return (await pg.query(sql, params as any[])).rows as any[];
}
async function count(key: string, opts: { userIds?: number[]; min?: number } = {}): Promise<Map<number, number>> {
  const rows = await run(metricByKey(key)!.countSql(opts));
  return new Map(rows.map(r => [Number(r.user_id), Number(r.value)]));
}

test('two sign-ins on the same Eastern day make one login day', async () => {
  // 01:30 UTC on 9/29 is 21:30 on 9/28 in New York — same Eastern day as 18:00 Eastern on 9/28.
  const a = new Date('2026-09-28T22:00:00Z');
  const b = new Date('2026-09-29T01:30:00Z');
  assert.equal(easternDate(a), '2026-09-28');
  assert.equal(easternDate(b), '2026-09-28');
  assert.deepEqual(loginMark(7, a), loginMark(7, b));
  const first = await run(insertMarksSql([loginMark(7, a)], a));
  const second = await run(insertMarksSql([loginMark(7, b)], b));
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, 'the second is a no-op');
  assert.equal((await count('login_days')).get(7), 1);
  await run(insertMarksSql([loginMark(7, new Date('2026-09-29T14:00:00Z'))]));
  assert.equal((await count('login_days')).get(7), 2, 'the next Eastern day counts');
});

test('re-sending a request to the same person does not count twice', async () => {
  for (let i = 0; i < 3; i++) await run(insertMarksSql(friendMarks({ kind: 'sent', from: 1, to: 2 })));
  await run(insertMarksSql(friendMarks({ kind: 'sent', from: 1, to: 3 })));
  assert.equal((await count('friend_requests_sent')).get(1), 2);
});

test('accept and decline marks land on the right side', async () => {
  assert.deepEqual(friendMarks({ kind: 'accepted', acceptor: 5, requester: 6 }), [
    { userId: 5, metric: 'friend_requests_accepted_by_you', ref: '6' },
    { userId: 6, metric: 'your_requests_accepted', ref: '5' },
  ]);
  // Each decline of the pair counts (the decline number is in the ref); a retry of the same one doesn't.
  for (const n of [1, 2, 2]) await run(insertMarksSql(friendMarks({ kind: 'declined', decliner: 8, requester: 9, declineNumber: n })));
  assert.equal((await count('friend_requests_declined_by_you')).get(8), 2);
  assert.equal((await count('your_requests_declined')).get(9), 2);
  assert.equal((await count('your_requests_declined')).get(8), undefined);
});

test('score metrics: counts, distinct, user filter and threshold', async () => {
  await pg.exec(`INSERT INTO scores (user_id, machine_id, venue_id) VALUES
    (1, 1, 10), (1, 1, 10), (1, 2, NULL), (1, 3, 11),
    (2, 1, NULL)`);
  assert.deepEqual([...await count('scores_posted')].sort(), [[1, 4], [2, 1]]);
  assert.equal((await count('distinct_machines')).get(1), 3);
  assert.equal((await count('distinct_venues')).get(1), 2);
  assert.equal((await count('distinct_venues')).has(2), false, 'no venue → not counted at all');
  assert.deepEqual([...await count('scores_posted', { userIds: [2] })], [[2, 1]]);
  assert.deepEqual([...await count('scores_posted', { min: 2 })], [[1, 4]], 'HAVING value >= threshold (the backfill query)');
});

test('score metrics never count a score played more than 15 min after it was posted', async () => {
  // User 3: two ordinary scores, one at the skew boundary (counts), one a legacy future-dated row on
  // another machine at another venue (doesn't count toward any score metric, backfill included).
  await pg.exec(`INSERT INTO scores (user_id, machine_id, venue_id, played_at, created_at) VALUES
    (3, 1, 10, '2026-09-30 12:00:00', '2026-09-30 12:05:00'),
    (3, 1, 10, '2026-09-30 12:15:00', '2026-09-30 12:00:00'),
    (3, 9, 19, '2026-10-02 12:00:00', '2026-09-30 12:00:00'),
    (4, 9, 19, '2026-09-30 12:15:00.001', '2026-09-30 12:00:00')`);
  assert.equal((await count('scores_posted')).get(3), 2);
  assert.equal((await count('distinct_machines')).get(3), 1);
  assert.equal((await count('distinct_venues')).get(3), 1);
  assert.equal((await count('scores_posted')).has(4), false, '1 ms past the skew is out');
  assert.equal((await count('scores_posted', { min: 3 })).has(3), false, 'the backfill query agrees');
});

test('registry: every metric has a trigger, phase-3 metrics are flagged, keys are unique', () => {
  const keys = [...METRICS.map(m => m.key), ...PENDING_METRICS.map(m => m.key)];
  assert.equal(new Set(keys).size, keys.length);
  for (const m of METRICS) assert.ok(m.triggers.length, m.key);
  assert.deepEqual(metricsFor('score'), ['scores_posted', 'distinct_machines', 'distinct_venues']);
  assert.ok(metricsFor('friend').includes('friend_requests_sent'));
  assert.deepEqual(metricsFor('login'), ['login_days']);
  const cat = metricCatalog();
  assert.equal(cat.find(m => m.key === 'challenge_wins')?.available, false);
  assert.equal(cat.find(m => m.key === 'login_days')?.available, true);
  assert.equal(metricByKey('challenge_wins'), undefined, 'not evaluable until phase 3');
  assert.equal(describeMetric('scores_posted', 1), 'Post your first score');
  assert.equal(describeMetric('scores_posted', 1000), 'Post 1,000 scores');
  assert.equal(describeMetric('login_days', 7), 'Sign in on 7 different days');
});
