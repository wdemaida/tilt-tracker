// Run: npx tsx --test src/lib/badgeMetrics.test.ts   (from artifacts/api-server)
//
// The badge metric library. Pure helpers (refs, marks) plus each metric's SQL, rendered by drizzle's
// PgDialect and run against an in-process PGlite (real Postgres, WASM) — nothing is dialled; the
// dummy DATABASE_URL only satisfies @workspace/db's import-time check.
// Challenge metrics (phase 3): the record metrics are checked against computeRecord() on random
// histories; the participant / proposal metrics against hand-built rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  METRICS, PENDING_METRICS, metricByKey, metricCatalog, metricsFor, describeMetric, easternDate, loginMark, friendMarks, insertMarksSql,
} = await import('./badgeMetrics.js');
const { computeRecord } = await import('./challengeRules.js');
const { PgDialect } = await import('drizzle-orm/pg-core');
const { PGlite } = await import('@electric-sql/pglite');

const pg = new PGlite();
await pg.exec(`
  CREATE TABLE user_metric_marks (user_id integer NOT NULL, metric text NOT NULL, ref text NOT NULL,
    at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, metric, ref));
  CREATE TABLE scores (id serial PRIMARY KEY, user_id integer NOT NULL, machine_id integer NOT NULL, venue_id integer,
    played_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE challenges (id integer PRIMARY KEY, creator_id integer NOT NULL, status text NOT NULL, void boolean NOT NULL DEFAULT false,
    resolved_at timestamptz, countered_from_id integer, proposed_by_id integer, proposal_decided_at timestamptz);
  CREATE TABLE challenge_participants (challenge_id integer NOT NULL, user_id integer NOT NULL, response text NOT NULL,
    decline_reason text, outcome text, rank integer, PRIMARY KEY (challenge_id, user_id));
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

const CHALLENGE_KEYS = [
  'challenge_wins', 'challenge_losses', 'challenges_tied', 'challenges_abandoned', 'win_streak_achieved', 'loss_streak_achieved',
  'challenges_declined', 'challenges_backed_out', 'challenges_countered', 'challenges_cant_reach', 'challenges_passed', 'challenges_missed',
  'counters_accepted', 'counters_rejected',
];

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

test('registry: every metric has a trigger, keys are unique, every challenge metric is available', () => {
  const keys = [...METRICS.map(m => m.key), ...PENDING_METRICS.map(m => m.key)];
  assert.equal(new Set(keys).size, keys.length);
  for (const m of METRICS) assert.ok(m.triggers.length, m.key);
  assert.deepEqual(metricsFor('score'), ['scores_posted', 'distinct_machines', 'distinct_venues']);
  assert.ok(metricsFor('friend').includes('friend_requests_sent'));
  assert.deepEqual(metricsFor('login'), ['login_days']);
  assert.deepEqual(metricsFor('challenge'), CHALLENGE_KEYS);
  for (const k of CHALLENGE_KEYS) assert.ok(metricsFor('sweep').includes(k), `${k} is re-checked by the daily sweep`);
  assert.equal(PENDING_METRICS.length, 0, 'nothing is pending since phase 3');
  const cat = metricCatalog();
  assert.ok(cat.every(m => m.available));
  assert.equal(cat.find(m => m.key === 'challenge_wins')?.source, 'derived');
  assert.equal(describeMetric('scores_posted', 1), 'Post your first score');
  assert.equal(describeMetric('scores_posted', 1000), 'Post 1,000 scores');
  assert.equal(describeMetric('login_days', 7), 'Sign in on 7 different days');
  assert.equal(describeMetric('challenge_wins', 1), 'Win your first challenge');
  assert.equal(describeMetric('challenge_wins', 25), 'Win 25 challenges');
  assert.equal(describeMetric('win_streak_achieved', 3), 'Win 3 challenges in a row');
  assert.equal(describeMetric('loss_streak_achieved', 10), 'Lose 10 challenges in a row');
  assert.equal(describeMetric('challenges_tied', 1), 'Tie a challenge');
  assert.equal(describeMetric('challenges_abandoned', 5), 'Be in 5 abandoned challenges');
});

// ── challenge metrics ────────────────────────────────────────────────────────

let nextChallengeId = 1000;
type Ch = { status: string; creator?: number; void?: boolean; resolvedAt?: string | null; counteredFrom?: number | null; proposedBy?: number | null; decidedAt?: string | null };
type Part = { user: number; response: string; reason?: string | null; outcome?: string | null; rank?: number | null };
async function challenge(c: Ch, parts: Part[]): Promise<number> {
  const id = nextChallengeId++;
  await pg.query(`INSERT INTO challenges (id, creator_id, status, void, resolved_at, countered_from_id, proposed_by_id, proposal_decided_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [id, c.creator ?? parts[0]?.user ?? 0, c.status, c.void ?? false, c.resolvedAt ?? null, c.counteredFrom ?? null, c.proposedBy ?? null, c.decidedAt ?? null]);
  for (const p of parts) {
    await pg.query(`INSERT INTO challenge_participants (challenge_id, user_id, response, decline_reason, outcome, rank) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, p.user, p.response, p.reason ?? null, p.outcome ?? null, p.rank ?? null]);
  }
  return id;
}
const single = async (key: string, u: number) => (await count(key, { userIds: [u] })).get(u) ?? 0;

test('record metrics and streaks match computeRecord on random histories (voids, abandoned, equal resolved_at)', async () => {
  // Users 101–108, one opponent row each (opponents don't matter to the headline or the streaks).
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const outcomes = ['win', 'win', 'win', 'loss', 'loss', 'tie', 'forfeit', 'no_show', 'abandoned'];
  const entries = new Map<number, Array<{ challengeId: number; resolvedAt: Date; void: boolean; outcome: any }>>();
  for (let u = 101; u <= 108; u++) {
    const n = 5 + Math.floor(rand() * 25);
    for (let i = 0; i < n; i++) {
      const isVoid = rand() < 0.08;
      const outcome = isVoid ? 'no_show' : outcomes[Math.floor(rand() * outcomes.length)];
      // Coarse times so some share a resolved_at (then challenge id breaks the tie); a few null.
      const resolvedAt = rand() < 0.05 ? null : new Date(Date.UTC(2026, 0, 1 + Math.floor(rand() * 20)));
      const id = await challenge({ status: 'resolved', void: isVoid, resolvedAt: resolvedAt?.toISOString() ?? null },
        [{ user: u, response: 'accepted', outcome }, { user: 999, response: 'accepted', outcome: 'loss' }]);
      entries.set(u, [...(entries.get(u) ?? []), { challengeId: id, resolvedAt: resolvedAt ?? new Date(0), void: isVoid, outcome }]);
    }
  }
  // Rows that must not count: an admin-voided one (cancelled, outcome cleared), a declined invitee
  // with a stray outcome, and one still active.
  await challenge({ status: 'cancelled' }, [{ user: 101, response: 'accepted', outcome: null }]);
  await challenge({ status: 'resolved', resolvedAt: '2026-01-05' }, [{ user: 102, response: 'declined', outcome: 'win' }]);
  await challenge({ status: 'active' }, [{ user: 103, response: 'accepted', outcome: 'win' }]);

  const all = Object.fromEntries(await Promise.all(['challenge_wins', 'challenge_losses', 'challenges_tied', 'challenges_abandoned', 'win_streak_achieved', 'loss_streak_achieved']
    .map(async k => [k, await count(k)])));
  for (const [u, es] of entries) {
    const rec = computeRecord(es);
    const expect = { challenge_wins: rec.wins, challenge_losses: rec.losses, challenges_tied: rec.ties, challenges_abandoned: rec.abandoned, win_streak_achieved: rec.bestStreak, loss_streak_achieved: rec.bestLossStreak };
    for (const [k, v] of Object.entries(expect)) {
      assert.equal(all[k].get(u) ?? 0, v, `${k} for ${u} (bulk)`);
      assert.equal(await single(k, u), v, `${k} for ${u} (single user)`);
      // The backfill form (HAVING value >= N) agrees with the single read at the boundary.
      if (v > 0) {
        assert.equal((await count(k, { min: v })).get(u), v, `${k} backfill at N = value`);
        assert.equal((await count(k, { min: v + 1 })).has(u), false, `${k} backfill at N = value + 1`);
      }
    }
  }
  assert.ok([...entries.keys()].some(u => (all.win_streak_achieved.get(u) ?? 0) >= 3), 'the random data has a real win streak');
});

test('streaks: abandoned breaks a run, a legacy void neither extends nor breaks it, best-ever stays', async () => {
  const u = 201;
  const seq: Array<[string, boolean?]> = [['win'], ['win'], ['no_show', true], ['win'], ['abandoned'], ['win'], ['loss'], ['loss'], ['tie'], ['loss']];
  for (const [i, [outcome, isVoid]] of seq.entries()) {
    await challenge({ status: 'resolved', void: !!isVoid, resolvedAt: `2026-02-${String(i + 1).padStart(2, '0')}` }, [{ user: u, response: 'accepted', outcome }]);
  }
  assert.equal(await single('win_streak_achieved', u), 3, 'win, win, (void), win = 3; abandoned ends it');
  assert.equal(await single('loss_streak_achieved', u), 2);
  assert.equal(await single('challenge_wins', u), 4);
  assert.equal(await single('challenges_abandoned', u), 1);
});

test('placing below 1st in a group is a loss; a tie at 1st is a tie', async () => {
  await challenge({ status: 'resolved', resolvedAt: '2026-03-01' }, [
    { user: 301, response: 'accepted', outcome: 'win', rank: 1 },
    { user: 302, response: 'accepted', outcome: 'loss', rank: 2 },
    { user: 303, response: 'accepted', outcome: 'loss', rank: 3 },
  ]);
  await challenge({ status: 'resolved', resolvedAt: '2026-03-02' }, [
    { user: 302, response: 'accepted', outcome: 'tie', rank: 1 }, { user: 303, response: 'accepted', outcome: 'tie', rank: 1 },
  ]);
  assert.deepEqual([await single('challenge_wins', 301), await single('challenge_losses', 302), await single('challenge_losses', 303)], [1, 1, 1]);
  assert.deepEqual([await single('challenges_tied', 302), await single('challenges_tied', 303)], [1, 1]);
});

test('participant metrics: true declines, back-outs, counters, reasons, missed — never a proposal row', async () => {
  const u = 401, creator = 400;
  // Real answers on ordinary challenges (any later status: declined, active, expired, countered…).
  await challenge({ status: 'declined', creator }, [{ user: creator, response: 'accepted' }, { user: u, response: 'declined', reason: null }]);
  await challenge({ status: 'active', creator }, [{ user: creator, response: 'accepted' }, { user: u, response: 'declined', reason: 'no_thanks' }]);
  await challenge({ status: 'expired', creator }, [{ user: creator, response: 'accepted' }, { user: u, response: 'declined', reason: 'cant_reach' }]);
  await challenge({ status: 'pending', creator }, [{ user: creator, response: 'accepted' }, { user: u, response: 'declined', reason: 'backed_out' }]);
  const orig = await challenge({ status: 'countered', creator }, [{ user: creator, response: 'accepted' }, { user: u, response: 'countered', reason: 'cant_reach' }]);
  await challenge({ status: 'active', creator }, [{ user: creator, response: 'accepted' }, { user: u, response: 'missed' }]);
  await challenge({ status: 'expired', creator }, [{ user: creator, response: 'accepted' }, { user: u, response: 'missed' }]);
  // Proposal rows where u is the CHALLENGER: her closed rows must not count as a decline or a miss.
  await challenge({ status: 'rejected', creator: u, proposedBy: 402, counteredFrom: orig, decidedAt: '2026-04-01' },
    [{ user: 402, response: 'accepted' }, { user: u, response: 'declined' }]);
  await challenge({ status: 'lapsed', creator: u, proposedBy: 402, counteredFrom: orig, decidedAt: '2026-04-01' },
    [{ user: 402, response: 'accepted' }, { user: u, response: 'missed' }]);
  await challenge({ status: 'proposed', creator: u, proposedBy: 402, counteredFrom: orig }, [{ user: 402, response: 'accepted' }, { user: u, response: 'pending' }]);

  assert.equal(await single('challenges_declined', u), 3, 'plain + no_thanks + cant_reach declines; not the back-out, the counter or the rejected proposal');
  assert.equal(await single('challenges_backed_out', u), 1);
  assert.equal(await single('challenges_countered', u), 1);
  assert.equal(await single('challenges_cant_reach', u), 2, 'a can’t-reach decline and the counter');
  assert.equal(await single('challenges_passed', u), 1);
  assert.equal(await single('challenges_missed', u), 2, 'not the lapsed proposal');
  assert.equal(await single('challenges_declined', 402), 0, 'the proposer’s "accepted" row on a proposal is nothing');
  for (const k of ['challenges_declined', 'challenges_missed', 'challenges_cant_reach']) {
    const v = await single(k, u);
    assert.equal((await count(k, { min: v })).get(u), v, `${k} backfill agrees`);
    assert.equal((await count(k, { min: v + 1 })).has(u), false);
  }
});

test('proposal metrics: counters accepted (incl. legacy counter rows) and rejected', async () => {
  const p = 501, challenger = 500;
  const orig = await challenge({ status: 'countered', creator: challenger }, [{ user: challenger, response: 'accepted' }, { user: p, response: 'countered', reason: 'cant_reach' }]);
  // Taken proposals — whatever happened to them afterwards — count; open / rejected / lapsed don't.
  for (const status of ['pending', 'active', 'resolved', 'cancelled']) {
    await challenge({ status, creator: challenger, proposedBy: p, counteredFrom: orig, decidedAt: '2026-05-01' }, []);
  }
  await challenge({ status: 'proposed', creator: challenger, proposedBy: p, counteredFrom: orig }, []);
  await challenge({ status: 'rejected', creator: challenger, proposedBy: p, counteredFrom: orig, decidedAt: '2026-05-01' }, []);
  await challenge({ status: 'rejected', creator: challenger, proposedBy: p, counteredFrom: orig, decidedAt: '2026-05-02' }, []);
  await challenge({ status: 'lapsed', creator: challenger, proposedBy: p, counteredFrom: orig, decidedAt: '2026-05-01' }, []);
  // Legacy (migrate22) counters: created by the counterer, no proposed_by_id — counted once they went ahead.
  await challenge({ status: 'active', creator: p, counteredFrom: orig }, []);
  await challenge({ status: 'resolved', creator: p, counteredFrom: orig }, []);
  await challenge({ status: 'pending', creator: p, counteredFrom: orig }, []);
  await challenge({ status: 'declined', creator: p, counteredFrom: orig }, []);

  assert.equal(await single('counters_accepted', p), 6, '4 taken + 2 legacy that went ahead');
  assert.equal(await single('counters_rejected', p), 2);
  assert.equal(await single('counters_accepted', challenger), 0, 'the challenger created the proposal rows but suggested nothing');
  assert.equal((await count('counters_accepted', { min: 6 })).get(p), 6);
  assert.equal((await count('counters_accepted', { min: 7 })).has(p), false);
});
