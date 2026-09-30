// Run: npx tsx --test src/lib/badgeRules.test.ts   (from artifacts/api-server)
//
// The badge rule vocabulary (badgeRules.ts) — pure, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreQualifies, ruleSatisfied, normalizeRule, describeRule, localParts, FUTURE_SKEW_MS, type BadgeRule, type RuleScore } from './badgeRules.js';

let nextId = 1;
function score(over: Partial<RuleScore> = {}): RuleScore {
  const playedAt = over.playedAt ?? new Date('2026-12-25T18:00:00Z');
  return {
    id: nextId++, machineId: 1, opdbId: 'GbPde-M5Rkv', venueId: 10, venueCity: 'Boston', venueState: 'MA',
    venueTimezone: 'America/New_York', score: 1_000_000, type: 'casual', hasPhoto: true,
    playedAt, createdAt: over.createdAt ?? new Date(+playedAt + 60_000),
    ...over,
  };
}

const xmas: BadgeRule = { localDate: { from: '2026-12-25', to: '2026-12-25' } };

test('11pm Pacific on 12/25 counts, though it is 12/26 in UTC', () => {
  const s = score({ playedAt: new Date('2026-12-26T07:00:00Z'), venueTimezone: 'America/Los_Angeles' });
  assert.equal(localParts(s.playedAt, 'UTC').date, '2026-12-26');
  assert.equal(scoreQualifies(xmas, s), true);
});

test('1am Eastern on 12/26 does not count', () => {
  const s = score({ playedAt: new Date('2026-12-26T06:00:00Z'), venueTimezone: 'America/New_York' });
  assert.equal(scoreQualifies(xmas, s), false);
});

test('no venue zone falls back to America/New_York', () => {
  // 03:30Z on 12/26 = 22:30 on 12/25 in New York, 19:30 in LA
  const s = score({ playedAt: new Date('2026-12-26T03:30:00Z'), venueTimezone: null });
  assert.equal(scoreQualifies(xmas, s), true);
  assert.equal(scoreQualifies(xmas, score({ playedAt: new Date('2026-12-26T06:00:00Z'), venueTimezone: 'Not/AZone' })), false, 'bad zone → NY → 1am 12/26');
});

test('a score posted 12/30 fails the grace window (no backdating)', () => {
  const s = score({ playedAt: new Date('2026-12-25T20:00:00Z'), createdAt: new Date('2026-12-30T12:00:00Z') });
  assert.equal(scoreQualifies(xmas, s), false);
  assert.equal(scoreQualifies(xmas, score({ playedAt: new Date('2026-12-25T20:00:00Z'), createdAt: new Date('2026-12-27T19:00:00Z') })), true, '47h later is inside the default 48h');
  assert.equal(scoreQualifies({ ...xmas, postedWithinHours: 2 }, score({ playedAt: new Date('2026-12-25T20:00:00Z'), createdAt: new Date('2026-12-25T23:00:00Z') })), false, 'custom window');
});

test('a play date in the future of its posting is refused (beyond 15 min skew)', () => {
  const s = score({ playedAt: new Date('2026-12-25T20:00:00Z'), createdAt: new Date('2026-12-24T20:00:00Z') });
  assert.equal(scoreQualifies(xmas, s), false);
  assert.equal(scoreQualifies(xmas, score({ playedAt: new Date('2026-12-25T20:00:00Z'), createdAt: new Date('2026-12-25T19:50:00Z') })), true);
});

test('every rule ignores a played time more than 15 min after posting — no posting window needed', () => {
  // Legacy rows (before the routes refused them) can have played_at far after created_at.
  const future = score({ playedAt: new Date('2026-12-25T20:00:00Z'), createdAt: new Date('2026-12-24T20:00:00Z') });
  for (const rule of [{ minScore: 5 }, { requiresPhoto: true }, { venueId: 10 }, { daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }, { localTime: { from: '00:00', to: '23:59' } }] as BadgeRule[]) {
    assert.equal(scoreQualifies(rule, future), false, JSON.stringify(rule));
  }
  // The skew boundary is FUTURE_SKEW_MS exactly: 15 min after posting still counts, 15 min + 1 ms doesn't.
  const at = new Date('2026-12-25T20:00:00Z');
  assert.equal(scoreQualifies({ minScore: 5 }, score({ playedAt: new Date(+at + FUTURE_SKEW_MS), createdAt: at })), true);
  assert.equal(scoreQualifies({ minScore: 5 }, score({ playedAt: new Date(+at + FUTURE_SKEW_MS + 1), createdAt: at })), false);
  // …and a future-dated score never counts toward a count / distinct rule either.
  const ok = score({ machineId: 1 });
  const bad = score({ machineId: 2, playedAt: new Date('2027-01-01T00:00:00Z'), createdAt: new Date('2026-12-25T00:00:00Z') });
  assert.deepEqual(ruleSatisfied({ minScore: 5, count: 2 }, [ok, bad]), { met: false, sourceScoreId: null, progress: 1 });
  assert.deepEqual(ruleSatisfied({ minScore: 5, count: 2, distinct: 'machine' }, [ok, bad]), { met: false, sourceScoreId: null, progress: 1 });
});

test('without a date condition there is no grace window unless asked', () => {
  const old = score({ playedAt: new Date('2025-01-01T20:00:00Z'), createdAt: new Date('2026-06-01T12:00:00Z') });
  assert.equal(scoreQualifies({ minScore: 5 }, old), true);
  assert.equal(scoreQualifies({ minScore: 5, postedWithinHours: 48 }, old), false);
});

test('group vs exact machine matching', () => {
  const pro = score({ machineId: 1, opdbId: 'GbPde-M5Rkv' });
  const premium = score({ machineId: 2, opdbId: 'GbPde-MxYz1' });
  const other = score({ machineId: 3, opdbId: 'G43W4-MXrPx' });
  const group: BadgeRule = { machine: { machineId: 1, matchMode: 'group', matchGroup: 'GbPde' } };
  const exact: BadgeRule = { machine: { machineId: 1, matchMode: 'exact', matchGroup: 'GbPde' } };
  assert.deepEqual([pro, premium, other].map(s => scoreQualifies(group, s)), [true, true, false]);
  assert.deepEqual([pro, premium, other].map(s => scoreQualifies(exact, s)), [true, false, false], 'exact ignores a stored group');
});

test('distinct counting: machine, venue, none', () => {
  const rule = (distinct: BadgeRule['distinct'], count: number): BadgeRule => ({ minScore: 1, count, distinct });
  const t0 = +new Date('2026-06-01T12:00:00Z');
  const list = [
    score({ machineId: 1, venueId: 10, createdAt: new Date(t0 + 1), playedAt: new Date(t0) }),
    score({ machineId: 1, venueId: 11, createdAt: new Date(t0 + 2), playedAt: new Date(t0) }),
    score({ machineId: 2, venueId: 11, createdAt: new Date(t0 + 3), playedAt: new Date(t0) }),
    score({ machineId: 2, venueId: null, createdAt: new Date(t0 + 4), playedAt: new Date(t0) }),
  ];
  assert.equal(ruleSatisfied(rule('none', 4), list).met, true);
  const m = ruleSatisfied(rule('machine', 2), list);
  assert.equal(m.met, true);
  assert.equal(m.sourceScoreId, list[2].id, 'the score that completed the count');
  assert.equal(ruleSatisfied(rule('machine', 3), list).met, false);
  assert.equal(ruleSatisfied(rule('venue', 2), list).met, true);
  assert.equal(ruleSatisfied(rule('venue', 3), list).met, false, 'a score with no venue never counts toward distinct venues');
  assert.equal(ruleSatisfied(rule('venue', 3), list).progress, 2);
});

test('the other per-score conditions', () => {
  const s = score({ score: 500, type: 'casual', hasPhoto: false, venueCity: 'Boston', venueState: 'MA', venueId: 10 });
  assert.equal(scoreQualifies({ minScore: 501 }, s), false);
  assert.equal(scoreQualifies({ scoreType: 'tournament' }, s), false);
  assert.equal(scoreQualifies({ requiresPhoto: true }, s), false);
  assert.equal(scoreQualifies({ city: ' boston ', state: 'ma' }, s), true);
  assert.equal(scoreQualifies({ venueId: 11 }, s), false);
  // Friday 2026-12-25 18:00Z = 13:00 Eastern, a Friday
  assert.equal(scoreQualifies({ daysOfWeek: [5] }, s), true);
  assert.equal(scoreQualifies({ daysOfWeek: [0, 6] }, s), false);
  assert.equal(scoreQualifies({ localTime: { from: '12:00', to: '14:00' } }, s), true);
  assert.equal(scoreQualifies({ localTime: { from: '22:00', to: '02:00' } }, s), false);
  assert.equal(scoreQualifies({ localTime: { from: '22:00', to: '02:00' } }, score({ playedAt: new Date('2026-12-26T04:30:00Z') })), true, 'wraps midnight (23:30 Eastern)');
});

test('normalizeRule: canonical form, errors, at least one condition', () => {
  const ok = normalizeRule({ localDate: { from: '2026-12-25', to: '2026-12-25' }, count: 1, distinct: 'none', junk: 1, machine: { machineId: 4, matchMode: 'group', matchGroup: 'Gevil', name: 'x' } });
  assert.ok('rule' in ok);
  if ('rule' in ok) {
    assert.deepEqual(ok.rule, { localDate: { from: '2026-12-25', to: '2026-12-25' }, machine: { machineId: 4, matchMode: 'group', matchGroup: null } }, 'unknown keys and defaults dropped; matchGroup never trusted from input');
  }
  const bad = normalizeRule({ localDate: { from: '2026-02-30', to: '2026-03-01' }, daysOfWeek: [7], localTime: { from: '25:00', to: '01:00' }, count: 0 });
  assert.ok('errors' in bad && bad.errors.length === 4, JSON.stringify(bad));
  assert.ok('errors' in normalizeRule({}), 'empty rule refused');
  assert.ok('errors' in normalizeRule({ count: 5 }), 'count alone is not a condition');
  assert.ok('errors' in normalizeRule({ localDate: { from: '2026-12-26', to: '2026-12-25' } }), 'from after to');
});

test('describeRule reads like a requirement', () => {
  assert.equal(describeRule(xmas), 'Post a score on Dec 25, 2026 (posted within 48 hours of playing)');
  assert.equal(describeRule({ minScore: 1000000, count: 3, distinct: 'machine' }), 'Post scores on 3 different machines of at least 1,000,000');
});
