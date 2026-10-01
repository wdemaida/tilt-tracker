// Run: npx tsx --test src/lib/challengeRules.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  opdbGroup, matchGroupFor, machineMatches, rosterHasMachine, exclusionReason, scoreCounts, baselineFrom, bestOnMachine,
  raceTarget, computeStanding, resolveChallenge, resolutionTrigger, raceWinner, projectedRanks,
  pendingExpired, canAccept, canDecline, canCounter, canCancel, canForfeit, phaseOf, validateCreate, computeRecord,
  parseDeclineReason, storedDeclineReason, saidNo,
  challengeStarted, scoreChallengeFits,
  pendingDue, afterAnswer, canStart, canDecideProposal, isProposalStatus, reinvitees, proposalClosure, parseInvitees, pairOutcome,
  MAX_WINDOW_DAYS, MIN_PLAYS, MAX_PLAYERS, MAX_INVITEES,
  type CandidateScore, type CountRule, type FitChallenge, type ChallengeType, type ParticipantState, type Standing,
} from './challengeRules.js';

const A = 1, B = 2, C = 3;
const H = 60 * 60 * 1000;
const DAY = 24 * H;
const T0 = new Date('2026-09-01T12:00:00Z');
const at = (h: number) => new Date(+T0 + h * H);

// The Munsters (Pro) = machine 22, group GbPde; a Premium model in the same group = 23; another game = 30.
const MUNSTERS_PRO = { id: 22, opdb: 'GbPde-M5Rkv' };
const MUNSTERS_PREM = { id: 23, opdb: 'GbPde-MXr9q-A1b2C' };
const OTHER = { id: 30, opdb: 'GrO7w-M9R03' };
const NO_OPDB = { id: 40, opdb: null };

let nextId = 100;
function sc(over: Partial<CandidateScore> & { userId: number; score: number }): CandidateScore {
  return {
    id: nextId++, machineId: MUNSTERS_PRO.id, opdbId: MUNSTERS_PRO.opdb, venueId: 7,
    playedAt: at(1), createdAt: at(1), hasPhoto: true, visibleToOthers: true, ...over,
  };
}

const gameRule: CountRule = { machineId: MUNSTERS_PRO.id, matchGroup: 'GbPde', venueId: null, startsAt: T0, endsAt: at(72) };
const exactRule: CountRule = { ...gameRule, matchGroup: null };

// ── machine matching ─────────────────────────────────────────────────────────

test('opdbGroup takes the part before the first dash, and only a G-prefixed id', () => {
  assert.equal(opdbGroup('GbPde-M5Rkv'), 'GbPde');
  assert.equal(opdbGroup('G43W4-MXrPx-AO6D9'), 'G43W4');
  assert.equal(opdbGroup('GbPde'), 'GbPde');
  assert.equal(opdbGroup(null), null);
  assert.equal(opdbGroup(''), null);
  assert.equal(opdbGroup('M5Rkv-GbPde'), null);
  assert.equal(opdbGroup('garbage id'), null);
});

test('matchGroupFor: game mode uses the group; exact mode and a missing opdb_id fall back to exact', () => {
  assert.equal(matchGroupFor('game', MUNSTERS_PRO.opdb), 'GbPde');
  assert.equal(matchGroupFor('exact', MUNSTERS_PRO.opdb), null);
  assert.equal(matchGroupFor('game', null), null);
});

test('game mode matches every model of the game; exact matches only that machine', () => {
  const pro = { machineId: MUNSTERS_PRO.id, opdbId: MUNSTERS_PRO.opdb };
  const prem = { machineId: MUNSTERS_PREM.id, opdbId: MUNSTERS_PREM.opdb };
  const other = { machineId: OTHER.id, opdbId: OTHER.opdb };
  const noOpdb = { machineId: NO_OPDB.id, opdbId: null };
  assert.ok(machineMatches(gameRule, pro));
  assert.ok(machineMatches(gameRule, prem));
  assert.ok(!machineMatches(gameRule, other));
  assert.ok(!machineMatches(gameRule, noOpdb));
  assert.ok(machineMatches(exactRule, pro));
  assert.ok(!machineMatches(exactRule, prem));
  // A machine with no opdb_id created in game mode falls back to exact via matchGroupFor → null.
  const fallback = { machineId: NO_OPDB.id, matchGroup: matchGroupFor('game', null) };
  assert.ok(machineMatches(fallback, noOpdb));
  assert.ok(!machineMatches(fallback, pro));
});

// ── venue lock: does a Pinball Map roster carry the machine? ─────────────────

test('rosterHasMachine: exact mode matches the machine by name, case-insensitively', () => {
  const roster = [{ machine: { id: 900, name: 'The Munsters (Pro)' } }, { machine: { id: 901, name: 'Godzilla (Premium)' } }];
  assert.ok(rosterHasMachine(roster, ['the munsters (pro) '], null));
  assert.ok(!rosterHasMachine(roster, ['The Munsters (Premium)'], null));
  assert.ok(!rosterHasMachine([], ['The Munsters (Pro)'], null));
});

test('rosterHasMachine: game mode matches another model of the game', () => {
  // The roster has only the Premium; the challenge is on the Pro. Its target names include every
  // TiltTrack model in the group...
  const roster = [{ machine: { id: 901, name: 'The Munsters (Premium)' } }];
  assert.ok(rosterHasMachine(roster, ['The Munsters (Pro)', 'The Munsters (Premium)'], 'GbPde'));
  // ...and a model TiltTrack has never seen matches through Pinball Map's catalog.
  const catalog = new Map<number, string | null>([[901, MUNSTERS_PREM.opdb], [902, OTHER.opdb]]);
  assert.ok(rosterHasMachine(roster, ['The Munsters (Pro)'], 'GbPde', catalog));
  assert.ok(!rosterHasMachine([{ machine: { id: 902, name: 'Something else' } }], ['The Munsters (Pro)'], 'GbPde', catalog));
  // Exact mode never consults the catalog.
  assert.ok(!rosterHasMachine(roster, ['The Munsters (Pro)'], null, catalog));
  // No catalog (Pinball Map unreachable): name match only.
  assert.ok(!rosterHasMachine(roster, ['The Munsters (Pro)'], 'GbPde'));
});

// ── what counts ──────────────────────────────────────────────────────────────

test('a score in the window, on the machine, with a photo, counts', () => {
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1 })), null);
  assert.ok(scoreCounts(gameRule, sc({ userId: A, score: 1, machineId: MUNSTERS_PREM.id, opdbId: MUNSTERS_PREM.opdb })));
});

test('photo required', () => {
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, hasPhoto: false })), 'no_photo');
});

test('backdated upload is excluded: played before the window, uploaded inside it', () => {
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, playedAt: at(-2), createdAt: at(1) })), 'played_outside_window');
});

test('both timestamps must be in the window: played inside but uploaded after the end is excluded', () => {
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, playedAt: at(70), createdAt: at(73) })), 'uploaded_outside_window');
});

test('window bounds are inclusive', () => {
  assert.ok(scoreCounts(gameRule, sc({ userId: A, score: 1, playedAt: T0, createdAt: T0 })));
  assert.ok(scoreCounts(gameRule, sc({ userId: A, score: 1, playedAt: at(72), createdAt: at(72) })));
  assert.ok(!scoreCounts(gameRule, sc({ userId: A, score: 1, playedAt: new Date(+T0 - 1), createdAt: T0 })));
});

test('venue lock: only scores at that venue count', () => {
  const locked = { ...gameRule, venueId: 7 };
  assert.ok(scoreCounts(locked, sc({ userId: A, score: 1, venueId: 7 })));
  assert.equal(exclusionReason(locked, sc({ userId: A, score: 1, venueId: 8 })), 'venue');
  assert.equal(exclusionReason(locked, sc({ userId: A, score: 1, venueId: null })), 'venue');
  // No lock: any venue, or none.
  assert.ok(scoreCounts(gameRule, sc({ userId: A, score: 1, venueId: null })));
});

test('wrong machine is excluded; exact mode excludes the other model', () => {
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, machineId: OTHER.id, opdbId: OTHER.opdb })), 'machine');
  assert.equal(exclusionReason(exactRule, sc({ userId: A, score: 1, machineId: MUNSTERS_PREM.id, opdbId: MUNSTERS_PREM.opdb })), 'machine');
});

test('a score the opponent may not see (hidden home-venue activity) does not count', () => {
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, visibleToOthers: false })), 'hidden');
});

test('a played time in the future (after it was logged, beyond 15 min of skew) never counts', () => {
  const MIN = 60_000;
  // Legacy dev score #1276: logged 13:09, played_at edited to 23:30 the same day.
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, playedAt: at(12), createdAt: at(2) })), 'played_in_future');
  // Just past the skew: out. At it (a phone clock 15 minutes fast): still counts.
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, playedAt: new Date(+at(2) + 15 * MIN + 1), createdAt: at(2) })), 'played_in_future');
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, playedAt: new Date(+at(2) + 15 * MIN), createdAt: at(2) })), null);
  // Checked before venue / photo: it's the reason the player should see.
  assert.equal(exclusionReason({ ...gameRule, venueId: 7 }, sc({ userId: A, score: 1, playedAt: at(12), createdAt: at(2), hasPhoto: false, venueId: 8 })), 'played_in_future');
  // Still 'machine' first — another game's score isn't reported at all.
  assert.equal(exclusionReason(gameRule, sc({ userId: A, score: 1, playedAt: at(12), createdAt: at(2), machineId: OTHER.id, opdbId: OTHER.opdb })), 'machine');
});

// ── scoreChallengeFits: the Add Score / edit summary ─────────────────────────

let nextChallenge = 500;
function fc(over: Partial<FitChallenge> & { score: CandidateScore }): FitChallenge {
  return {
    challengeId: nextChallenge++, machineName: 'The Munsters (Pro)', type: 'high_score', status: 'active',
    machineId: MUNSTERS_PRO.id, matchGroup: 'GbPde', venueId: null, venueName: null,
    startsAt: T0, endsAt: at(72), opponents: ['Bee'], locked: false, ...over,
  };
}
const NOW = at(10);

test('challengeStarted: active/resolved with a start that has passed', () => {
  assert.ok(challengeStarted({ status: 'active', startsAt: T0 }, NOW));
  assert.ok(challengeStarted({ status: 'resolved', startsAt: T0 }, NOW));
  assert.ok(!challengeStarted({ status: 'active', startsAt: at(20) }, NOW));
  assert.ok(!challengeStarted({ status: 'active', startsAt: null }, NOW));
  assert.ok(!challengeStarted({ status: 'pending', startsAt: T0 }, NOW));
});

test('scoreChallengeFits: an old photo (played before the start) is not counted in every matching challenge', () => {
  const score = sc({ userId: A, score: 1, playedAt: at(-24 * 120), createdAt: at(5) });
  const r = scoreChallengeFits([fc({ score }), fc({ score, matchGroup: null }), fc({ score, type: 'race' })], NOW);
  assert.equal(r.length, 3);
  for (const f of r) {
    assert.equal(f.status, 'not_counted');
    assert.equal(f.reason, 'played_before_start');
  }
  assert.deepEqual(r.map(f => f.type), ['high_score', 'high_score', 'race']);
});

test('scoreChallengeFits: counted, and each failing rule maps to its reason (same order as exclusionReason)', () => {
  const ok = sc({ userId: A, score: 1, playedAt: at(2), createdAt: at(3) });
  const one = (over: Partial<FitChallenge>, s: CandidateScore = ok) => scoreChallengeFits([fc({ score: s, ...over })], NOW)[0];
  assert.deepEqual([one({}).status, one({}).reason], ['counted', 'counted']);
  assert.equal(one({ venueId: 8, venueName: 'Arcade' }, { ...ok, venueId: 7 }).reason, 'wrong_venue');
  assert.equal(one({ venueId: 8 }, { ...ok, venueId: 7 }).venueName, null);
  assert.equal(one({}, { ...ok, hasPhoto: false }).reason, 'no_photo');
  assert.equal(one({}, { ...ok, playedAt: at(80), createdAt: at(80) }).reason, 'played_after_end');
  // (Played within the 15 minutes of skew after it was logged — any later is played_in_future.)
  assert.equal(one({}, { ...ok, playedAt: T0, createdAt: at(-0.1) }).reason, 'posted_before_start');
  assert.equal(one({}, { ...ok, playedAt: at(70), createdAt: at(73) }).reason, 'posted_after_end');
  assert.equal(one({}, { ...ok, visibleToOthers: false }).reason, 'not_visible');
  assert.deepEqual([one({}, { ...ok, playedAt: at(12) }).status, one({}, { ...ok, playedAt: at(12) }).reason], ['not_counted', 'played_in_future']);
  // First failing rule wins: no photo AND played before the start → no_photo (photo is checked first).
  assert.equal(one({}, { ...ok, hasPhoto: false, playedAt: at(-5) }).reason, 'no_photo');
});

test('scoreChallengeFits: a score on another machine lists nothing; game mode takes the other model', () => {
  const other = sc({ userId: A, score: 1, machineId: OTHER.id, opdbId: OTHER.opdb });
  assert.deepEqual(scoreChallengeFits([fc({ score: other }), fc({ score: other, matchGroup: null })], NOW), []);
  const prem = sc({ userId: A, score: 1, machineId: MUNSTERS_PREM.id, opdbId: MUNSTERS_PREM.opdb });
  const r = scoreChallengeFits([fc({ score: prem }), fc({ score: prem, matchGroup: null })], NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'counted');
});

test('scoreChallengeFits: pending, or active with a start ahead → not_started; other statuses are left out', () => {
  const score = sc({ userId: A, score: 1, playedAt: at(9), createdAt: at(9) });
  const r = scoreChallengeFits([
    fc({ score, status: 'pending', startsAt: null }),
    fc({ score, status: 'active', startsAt: at(20) }),
    fc({ score, status: 'cancelled' }),
  ], NOW);
  assert.deepEqual(r.map(f => [f.status, f.reason]), [['not_started', 'not_started'], ['not_started', 'not_started']]);
});

test('scoreChallengeFits: a locked score counted, whatever the rules say now (a race it just won)', () => {
  const score = sc({ userId: A, score: 1, playedAt: at(2), createdAt: at(3) });
  const [f] = scoreChallengeFits([fc({ score, status: 'resolved', locked: true, type: 'race' })], NOW);
  assert.equal(f.status, 'counted');
  assert.equal(f.challengeId > 0, true);
  assert.deepEqual(f.opponents, ['Bee']);
});

test('scoreChallengeFits: a played time in the future reads not counted even with a (legacy) lock row', () => {
  // Lock rows are append-only, so #1276's stay — but the standings dropped it, and so does the summary.
  const score = sc({ userId: A, score: 1, playedAt: at(12), createdAt: at(2) });
  const [f] = scoreChallengeFits([fc({ score, locked: true })], NOW);
  assert.deepEqual([f.status, f.reason], ['not_counted', 'played_in_future']);
});

// ── baseline / race target ───────────────────────────────────────────────────

test('baseline = best matching score played before the window (any venue, photo or not)', () => {
  const scores = [
    sc({ userId: A, score: 500, playedAt: at(-48), hasPhoto: false, venueId: 99 }),
    sc({ userId: A, score: 800, playedAt: at(-1), machineId: MUNSTERS_PREM.id, opdbId: MUNSTERS_PREM.opdb }),
    sc({ userId: A, score: 9000, playedAt: at(1) }),                                   // in the window
    sc({ userId: A, score: 7000, playedAt: at(-5), machineId: OTHER.id, opdbId: OTHER.opdb }), // other game
    sc({ userId: A, score: 6000, playedAt: at(-5), visibleToOthers: false }),          // hidden
  ];
  assert.equal(baselineFrom(gameRule, T0, scores), 800);
  assert.equal(baselineFrom(exactRule, T0, scores), 500);
  assert.equal(baselineFrom(gameRule, T0, []), null);
  assert.equal(baselineFrom(gameRule, T0, [sc({ userId: A, score: 5, playedAt: T0 })]), null, 'played exactly at the start is not "before"');
});

test('race target: explicit number wins, else the creator best, else nothing', () => {
  const scores = [sc({ userId: A, score: 300 }), sc({ userId: A, score: 900, playedAt: at(-100) }), sc({ userId: A, score: 5000, machineId: OTHER.id, opdbId: OTHER.opdb })];
  const best = bestOnMachine(gameRule, scores);
  assert.equal(best, 900);
  assert.equal(raceTarget(null, best), 900);
  assert.equal(raceTarget(123, best), 123);
  assert.equal(raceTarget(undefined, null), null);
});

// ── standings ────────────────────────────────────────────────────────────────

test('high_score standing = best score', () => {
  const s = computeStanding('high_score', A, [sc({ userId: A, score: 10 }), sc({ userId: A, score: 30 }), sc({ userId: A, score: 20 })]);
  assert.equal(s.bestScore, 30);
  assert.equal(s.resultValue, 30);
  assert.equal(s.countingCount, 3);
  assert.ok(s.qualified);
  assert.equal(s.scoreIds.length, 3);
  const none = computeStanding('high_score', A, []);
  assert.equal(none.qualified, false);
  assert.equal(none.resultValue, null);
});

test('race standing: qualified only when the target is beaten (> target); reachedTargetAt is the earliest upload that beat it', () => {
  const late = sc({ userId: A, score: 2000, createdAt: at(5) });
  const early = sc({ userId: A, score: 1001, createdAt: at(2) });
  const equal = sc({ userId: A, score: 1000, createdAt: at(1) });
  const s = computeStanding('race', A, [sc({ userId: A, score: 999, createdAt: at(1) }), equal, late, early], { targetScore: 1000 });
  assert.ok(s.qualified);
  assert.equal(+s.reachedTargetAt!, +at(2));
  assert.equal(s.reachedTargetScoreId, early.id);
  assert.equal(s.resultValue, 2000);
  const short = computeStanding('race', A, [sc({ userId: A, score: 999 })], { targetScore: 1000 });
  assert.equal(short.qualified, false);
  assert.equal(short.reachedTargetAt, null);
});

test('race standing: exactly equalling the target is not a finish', () => {
  const eq = computeStanding('race', A, [sc({ userId: A, score: 1000 }), sc({ userId: A, score: 1000 })], { targetScore: 1000 });
  assert.equal(eq.qualified, false);
  assert.equal(eq.reachedTargetAt, null);
  assert.equal(eq.reachedTargetScoreId, null);
  assert.equal(eq.resultValue, 1000, 'still shows as their best');
  const beat = computeStanding('race', A, [sc({ userId: A, score: 1001 })], { targetScore: 1000 });
  assert.ok(beat.qualified);
});

test('most_improved standing = % over baseline; no baseline = not qualified', () => {
  const s = computeStanding('most_improved', A, [sc({ userId: A, score: 150 }), sc({ userId: A, score: 120 })], { baseline: 100 });
  assert.equal(s.resultValue, 50);
  assert.ok(s.qualified);
  const worse = computeStanding('most_improved', A, [sc({ userId: A, score: 80 })], { baseline: 100 });
  assert.equal(worse.resultValue, -20);
  assert.ok(worse.qualified, 'a drop still ranks');
  const noBase = computeStanding('most_improved', A, [sc({ userId: A, score: 80 })], { baseline: null });
  assert.equal(noBase.qualified, false);
  assert.equal(noBase.resultValue, null);
});

test('average standing = mean of ALL counting scores; qualified at >= min plays', () => {
  const three = [10, 20, 60].map(v => sc({ userId: A, score: v }));
  const s = computeStanding('average', A, three, { minPlays: 3 });
  assert.equal(s.resultValue, 30);
  assert.ok(s.qualified);
  const short = computeStanding('average', A, three.slice(0, 2), { minPlays: 3 });
  assert.equal(short.resultValue, 15);
  assert.equal(short.qualified, false);
});

// ── resolution ───────────────────────────────────────────────────────────────

function state(type: ChallengeType, userId: number, values: number[], opts: { baseline?: number; target?: number; minPlays?: number; forfeited?: boolean; createdAt?: number[] } = {}): ParticipantState {
  const counting = values.map((v, i) => sc({ userId, score: v, createdAt: at(opts.createdAt?.[i] ?? 1) }));
  const standing: Standing = computeStanding(type, userId, counting, { baseline: opts.baseline, targetScore: opts.target, minPlays: opts.minPlays });
  return { userId, forfeited: !!opts.forfeited, standing };
}
const outcomes = (r: ReturnType<typeof resolveChallenge>) => Object.fromEntries(r.participants.map(p => [p.userId, p.outcome]));
const ranks = (r: ReturnType<typeof resolveChallenge>) => Object.fromEntries(r.participants.map(p => [p.userId, p.rank]));

test('high_score: best wins, other loses', () => {
  const r = resolveChallenge('high_score', [state('high_score', A, [100, 300]), state('high_score', B, [250])], 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'win', [B]: 'loss' });
  assert.deepEqual(ranks(r), { [A]: 1, [B]: 2 });
  assert.equal(r.void, false);
  assert.equal(r.abandoned, false);
});

test('high_score: equal bests tie, both rank 1', () => {
  const r = resolveChallenge('high_score', [state('high_score', A, [300]), state('high_score', B, [300, 10])], 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'tie', [B]: 'tie' });
  assert.deepEqual(ranks(r), { [A]: 1, [B]: 1 });
});

test('one posts, the other does not: poster wins, other no_show', () => {
  for (const type of ['high_score', 'most_improved'] as const) {
    const r = resolveChallenge(type, [state(type, A, [], { baseline: 10 }), state(type, B, [50], { baseline: 10 })], 'deadline');
    assert.deepEqual(outcomes(r), { [A]: 'no_show', [B]: 'win' }, type);
    assert.equal(r.void, false);
  }
});

test('nobody played, any type: abandoned for everyone, never void (void is retired)', () => {
  for (const type of ['high_score', 'race', 'most_improved', 'average'] as const) {
    const r = resolveChallenge(type, [state(type, A, [], { baseline: 10 }), state(type, B, [], { baseline: 10 })], 'deadline');
    assert.deepEqual(outcomes(r), { [A]: 'abandoned', [B]: 'abandoned' }, type);
    assert.deepEqual(ranks(r), { [A]: 1, [B]: 1 }, type);
    assert.equal(r.void, false, type);
    assert.equal(r.abandoned, true, `${type}: signed up and nobody played → abandoned`);
  }
});

test('nobody left in it played: abandoned, and a forfeiter who had played stays forfeit', () => {
  const r = resolveChallenge('high_score', [state('high_score', A, []), state('high_score', B, []), state('high_score', C, [900], { forfeited: true })], 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'abandoned', [B]: 'abandoned', [C]: 'forfeit' });
  assert.equal(r.abandoned, true);
  assert.equal(r.void, false);
});

test('forfeit: the other participant wins on the spot, whatever the scores', () => {
  const states = [state('high_score', A, [1_000_000], { forfeited: true }), state('high_score', B, [])];
  assert.equal(resolutionTrigger('high_score', at(72), at(2), states), 'forfeit');
  const r = resolveChallenge('high_score', states, 'forfeit');
  assert.deepEqual(outcomes(r), { [A]: 'forfeit', [B]: 'win' });
  assert.deepEqual(ranks(r), { [B]: 1, [A]: 2 });
  assert.equal(r.void, false);
});

test('forfeit in a group of 3 does not end it; the forfeiter ranks last at the deadline', () => {
  const states = [state('high_score', A, [500], { forfeited: true }), state('high_score', B, [100]), state('high_score', C, [200])];
  assert.equal(resolutionTrigger('high_score', at(72), at(2), states), null);
  const r = resolveChallenge('high_score', states, 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'forfeit', [B]: 'loss', [C]: 'win' });
  assert.deepEqual(ranks(r), { [C]: 1, [B]: 2, [A]: 3 });
});

test('group of 3 ranks N participants with competition ranking', () => {
  const r = resolveChallenge('high_score', [state('high_score', A, [100]), state('high_score', B, [300]), state('high_score', C, [300])], 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'loss', [B]: 'tie', [C]: 'tie' });
  assert.deepEqual(ranks(r), { [B]: 1, [C]: 1, [A]: 3 });
});

test('race: first to reach the target (by upload time) wins immediately; other loss', () => {
  const states = [
    state('race', A, [5000], { target: 1000, createdAt: [3] }),
    state('race', B, [1200], { target: 1000, createdAt: [2] }),
  ];
  assert.equal(raceWinner(states)!.userId, B);
  assert.equal(resolutionTrigger('race', at(72), at(4), states), 'race_target');
  const r = resolveChallenge('race', states, 'race_target');
  assert.deepEqual(outcomes(r), { [A]: 'loss', [B]: 'win' }, 'a bigger score later does not matter');
  assert.equal(r.void, false);
});

test('race: winner by target while the other never played → other no_show', () => {
  const states = [state('race', A, [1500], { target: 1000 }), state('race', B, [], { target: 1000 })];
  const r = resolveChallenge('race', states, 'race_target');
  assert.deepEqual(outcomes(r), { [A]: 'win', [B]: 'no_show' });
});

test('race: nobody beat the target by the deadline → abandoned for everyone (played or not), not void', () => {
  const states = [state('race', A, [900], { target: 1000 }), state('race', B, [], { target: 1000 })];
  assert.equal(resolutionTrigger('race', at(72), at(10), states), null, 'no winner yet, before the deadline');
  assert.equal(resolutionTrigger('race', at(72), at(73), states), 'deadline');
  const r = resolveChallenge('race', states, 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'abandoned', [B]: 'abandoned' });
  assert.deepEqual(ranks(r), { [A]: 1, [B]: 2 }, 'played ranks ahead of did not');
  assert.equal(r.void, false);
  assert.equal(r.abandoned, true);
  const both = resolveChallenge('race', [state('race', A, [900], { target: 1000 }), state('race', B, [10], { target: 1000 })], 'deadline');
  assert.deepEqual(outcomes(both), { [A]: 'abandoned', [B]: 'abandoned' });
  assert.equal(both.abandoned, true);
});

test('race: equalling the target never finishes it — no win on the spot, abandoned at the deadline', () => {
  const states = [state('race', A, [1000], { target: 1000, createdAt: [2] }), state('race', B, [1000], { target: 1000, createdAt: [3] })];
  assert.equal(raceWinner(states), null);
  assert.equal(resolutionTrigger('race', at(72), at(10), states), null, 'a tie-at-target does not end the race');
  const r = resolveChallenge('race', states, 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'abandoned', [B]: 'abandoned' });
  assert.equal(r.abandoned, true);
  // One point more does.
  const beat = [state('race', A, [1000], { target: 1000, createdAt: [2] }), state('race', B, [1001], { target: 1000, createdAt: [3] })];
  assert.equal(raceWinner(beat)!.userId, B);
  assert.deepEqual(outcomes(resolveChallenge('race', beat, 'race_target')), { [A]: 'loss', [B]: 'win' });
});

test('race abandoned: a forfeiter stays forfeit', () => {
  const states = [state('race', A, [900], { target: 1000 }), state('race', B, [], { target: 1000 }), state('race', C, [950], { target: 1000, forfeited: true })];
  const r = resolveChallenge('race', states, 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'abandoned', [B]: 'abandoned', [C]: 'forfeit' });
  assert.equal(r.abandoned, true);
});

test('most_improved: highest % wins even with the lower raw score', () => {
  const r = resolveChallenge('most_improved', [
    state('most_improved', A, [2_000_000], { baseline: 1_900_000 }), // +5.3%
    state('most_improved', B, [300_000], { baseline: 200_000 }),     // +50%
  ], 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'loss', [B]: 'win' });
});

test('average: highest qualified average wins; played but short of N loses when someone qualified', () => {
  const r = resolveChallenge('average', [
    state('average', A, [1000, 1000], { minPlays: 3 }),        // mean 1000, only 2 plays
    state('average', B, [100, 200, 300], { minPlays: 3 }),      // mean 200, qualified
    state('average', C, [], { minPlays: 3 }),
  ], 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'loss', [B]: 'win', [C]: 'no_show' });
  assert.deepEqual(ranks(r), { [B]: 1, [A]: 2, [C]: 3 });
});

test('average: nobody reached N → abandoned, like a race nobody finished', () => {
  const r = resolveChallenge('average', [state('average', A, [1000, 1000], { minPlays: 3 }), state('average', B, [5], { minPlays: 3 })], 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'abandoned', [B]: 'abandoned' });
  assert.equal(r.void, false);
  assert.equal(r.abandoned, true);
  const oneSided = resolveChallenge('average', [state('average', A, [1000, 1000], { minPlays: 3 }), state('average', B, [], { minPlays: 3 })], 'deadline');
  assert.deepEqual(outcomes(oneSided), { [A]: 'abandoned', [B]: 'abandoned' }, 'the one who never played is abandoned too');
});

test('average: equal qualified averages tie', () => {
  const r = resolveChallenge('average', [state('average', A, [100, 200, 300], { minPlays: 3 }), state('average', B, [200, 200, 200, 200], { minPlays: 3 })], 'deadline');
  assert.deepEqual(outcomes(r), { [A]: 'tie', [B]: 'tie' });
});

test('resolutionTrigger: deadline only strictly after ends_at', () => {
  const states = [state('high_score', A, [1]), state('high_score', B, [])];
  assert.equal(resolutionTrigger('high_score', at(72), at(72), states), null);
  assert.equal(resolutionTrigger('high_score', at(72), new Date(+at(72) + 1), states), 'deadline');
});

test('projectedRanks: live ranks if it ended now', () => {
  const m = projectedRanks('high_score', [state('high_score', A, [5]), state('high_score', B, [9])]);
  assert.equal(m.get(B), 1);
  assert.equal(m.get(A), 2);
});

test('projectedRanks: a player with no counting score is not ranked', () => {
  const m = projectedRanks('high_score', [state('high_score', A, []), state('high_score', B, [9]), state('high_score', C, [4])]);
  assert.equal(m.get(B), 1);
  assert.equal(m.get(C), 2);
  assert.equal(m.has(A), false);
  // Nobody posted: nobody ranked (not "1st of 2" each).
  const none = projectedRanks('high_score', [state('high_score', A, []), state('high_score', B, [])]);
  assert.equal(none.size, 0);
  // A race nobody has beaten yet: players who posted still rank, the one who hasn't doesn't.
  const race = projectedRanks('race', [state('race', A, [5]), state('race', B, [])]);
  assert.equal(race.get(A), 1);
  assert.equal(race.has(B), false);
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test('pending expires when its chosen start passes, or its end when it had none', () => {
  const base = { creatorId: A, status: 'pending' as const, startsAt: null, endsAt: at(72) };
  assert.ok(!pendingExpired(base, at(1)));
  assert.ok(pendingExpired(base, at(72)));
  assert.ok(pendingExpired({ ...base, startsAt: at(5) }, at(5)));
  assert.ok(!pendingExpired({ ...base, startsAt: at(5) }, at(4)));
  assert.ok(!pendingExpired({ ...base, status: 'active' }, at(100)));
});

test('who can do what', () => {
  const pending = { creatorId: A, status: 'pending' as const, startsAt: null, endsAt: at(72) };
  const inviteeP = { userId: B, response: 'pending' as const, outcome: null };
  const creatorP = { userId: A, response: 'accepted' as const, outcome: null };
  assert.ok(canAccept(pending, inviteeP));
  assert.ok(canDecline(pending, inviteeP));
  assert.ok(!canAccept(pending, creatorP), 'creator cannot accept own challenge');
  assert.ok(!canAccept(pending, undefined), 'a stranger cannot');
  assert.ok(canCancel(pending, A));
  assert.ok(!canCancel(pending, B));
  assert.ok(!canForfeit(pending, creatorP), 'no forfeiting before it is active (cancel/decline instead)');
  const active = { ...pending, status: 'active' as const };
  assert.ok(!canCancel(active, A), 'cancel is only before acceptance');
  assert.ok(canForfeit(active, creatorP));
  assert.ok(canForfeit(active, { userId: B, response: 'accepted', outcome: null }));
  assert.ok(!canForfeit(active, { userId: B, response: 'accepted', outcome: 'forfeit' }));
  assert.ok(!canAccept(active, inviteeP));
});

test('phaseOf', () => {
  const c = { creatorId: A, status: 'active' as const, startsAt: at(10), endsAt: at(72) };
  assert.equal(phaseOf(c, at(1)), 'scheduled');
  assert.equal(phaseOf(c, at(11)), 'live');
  assert.equal(phaseOf(c, at(73)), 'ended');
  assert.equal(phaseOf({ ...c, status: 'declined' }, at(1)), 'declined');
  assert.equal(phaseOf({ ...c, status: 'countered' }, at(1)), 'countered');
});

// ── declining / countering ───────────────────────────────────────────────────

test('canCounter: the invitee of a pending challenge, like a decline', () => {
  const pending = { creatorId: A, status: 'pending' as const, startsAt: null, endsAt: at(72) };
  const inviteeP = { userId: B, response: 'pending' as const, outcome: null };
  assert.ok(canCounter(pending, inviteeP));
  assert.ok(!canCounter(pending, { userId: A, response: 'accepted', outcome: null }), 'not the creator');
  assert.ok(!canCounter(pending, undefined), 'not a stranger');
  assert.ok(!canCounter({ ...pending, status: 'active' }, inviteeP), 'not once it is under way');
  assert.ok(!canCounter({ ...pending, status: 'countered' }, inviteeP), 'not twice');
  assert.ok(!canCounter(pending, { userId: B, response: 'countered', outcome: null }));
});

test('parseDeclineReason', () => {
  assert.equal(parseDeclineReason(undefined), null);
  assert.equal(parseDeclineReason({}), null);
  assert.equal(parseDeclineReason({ reason: '' }), null);
  assert.equal(parseDeclineReason({ reason: null }), null);
  assert.equal(parseDeclineReason({ reason: 'cant_reach' }), 'cant_reach');
  assert.equal(parseDeclineReason({ reason: 'no_thanks' }), 'no_thanks');
  assert.equal(parseDeclineReason({ reason: 'busy' }), 'invalid');
  assert.equal(parseDeclineReason({ reason: 1 }), 'invalid');
  assert.equal(parseDeclineReason({ reason: 'backed_out' }), 'invalid', 'only the back-out path sets backed_out — a client can’t send it');
});

test('storedDeclineReason: an accepted invitee declining is a back-out, whatever the body said', () => {
  assert.equal(storedDeclineReason('accepted', null), 'backed_out');
  assert.equal(storedDeclineReason('accepted', 'no_thanks'), 'backed_out');
  assert.equal(storedDeclineReason('accepted', 'cant_reach'), 'backed_out');
  assert.equal(storedDeclineReason('pending', 'no_thanks'), 'no_thanks');
  assert.equal(storedDeclineReason('pending', 'cant_reach'), 'cant_reach');
  assert.equal(storedDeclineReason('pending', null), null, 'an older client’s reasonless decline stays null');
});

test('saidNo: declined and countered participants are out', () => {
  assert.ok(saidNo('declined'));
  assert.ok(saidNo('countered'));
  assert.ok(!saidNo('pending'));
  assert.ok(!saidNo('accepted'));
});

// ── creation input ───────────────────────────────────────────────────────────

const now = T0;
const iso = (h: number) => at(h).toISOString();

test('validateCreate: a plain high_score with just an end date', () => {
  const r = validateCreate({ type: 'high_score', endsAt: iso(48) }, now);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.matchMode, 'game');
    assert.equal(r.value.startsAt, null, 'no start = starts when accepted');
    assert.equal(r.value.targetScore, null);
    assert.equal(r.value.minPlays, null);
  }
});

test('validateCreate: type and match mode', () => {
  assert.equal((validateCreate({ type: 'bogus', endsAt: iso(48) }, now) as any).code, 'invalid_type');
  assert.equal((validateCreate({ type: 'high_score', matchMode: 'fuzzy', endsAt: iso(48) }, now) as any).code, 'invalid_match_mode');
  const r = validateCreate({ type: 'high_score', matchMode: 'exact', endsAt: iso(48) }, now);
  assert.ok(r.ok && r.value.matchMode === 'exact');
});

test('validateCreate: race target optional but must be a positive whole number', () => {
  assert.ok(validateCreate({ type: 'race', endsAt: iso(48) }, now).ok);
  const r = validateCreate({ type: 'race', targetScore: '1500000', endsAt: iso(48) }, now);
  assert.ok(r.ok && r.value.targetScore === 1_500_000);
  for (const t of [0, -5, 1.5, 'abc', '1,000']) {
    assert.equal((validateCreate({ type: 'race', targetScore: t, endsAt: iso(48) }, now) as any).code, 'invalid_target', String(t));
  }
  // A target on a non-race type is ignored.
  const hs = validateCreate({ type: 'high_score', targetScore: 5, endsAt: iso(48) }, now);
  assert.ok(hs.ok && hs.value.targetScore === null);
});

test(`validateCreate: average needs min plays ${MIN_PLAYS.min}–${MIN_PLAYS.max}`, () => {
  assert.equal((validateCreate({ type: 'average', endsAt: iso(48) }, now) as any).code, 'invalid_min_plays');
  assert.equal((validateCreate({ type: 'average', minPlays: 2, endsAt: iso(48) }, now) as any).code, 'invalid_min_plays');
  assert.equal((validateCreate({ type: 'average', minPlays: 11, endsAt: iso(48) }, now) as any).code, 'invalid_min_plays');
  assert.equal((validateCreate({ type: 'average', minPlays: 3.5, endsAt: iso(48) }, now) as any).code, 'invalid_min_plays');
  const r = validateCreate({ type: 'average', minPlays: '5', endsAt: iso(48) }, now);
  assert.ok(r.ok && r.value.minPlays === 5);
});

test('validateCreate: window rules', () => {
  const code = (b: Record<string, unknown>) => (validateCreate({ type: 'high_score', ...b }, now) as any).code;
  assert.equal(code({}), 'invalid_window', 'end required');
  assert.equal(code({ endsAt: 'not a date' }), 'invalid_window');
  assert.equal(code({ endsAt: iso(0.5) }), 'invalid_window', 'at least an hour');
  assert.equal(code({ endsAt: iso(-1) }), 'invalid_window', 'end in the past');
  assert.equal(code({ endsAt: iso(MAX_WINDOW_DAYS * 24 + 1) }), 'invalid_window', 'too long');
  assert.ok(validateCreate({ type: 'high_score', endsAt: iso(MAX_WINDOW_DAYS * 24) }, now).ok);
  assert.equal(code({ startsAt: iso(-2), endsAt: iso(48) }), 'invalid_window', 'start in the past');
  assert.equal(code({ startsAt: iso(31 * 24), endsAt: iso(32 * 24) }), 'invalid_window', 'start too far ahead');
  // A zone-less instant is refused, not read in the server's zone (lib/instant.ts).
  assert.equal(code({ endsAt: iso(48).replace(/Z$/, '') }), 'invalid_window', 'zone-less end');
  assert.equal(code({ startsAt: iso(2).replace(/Z$/, ''), endsAt: iso(48) }), 'invalid_window', 'zone-less start');
  assert.equal(code({ endsAt: iso(48).slice(0, 10) }), 'invalid_window', 'date-only end');
  const offset = validateCreate({ type: 'high_score', endsAt: iso(48).replace('Z', '+00:00') }, now);
  assert.ok(offset.ok && +offset.value.endsAt === +at(48), 'an explicit +00:00 offset is fine');
  const ms = validateCreate({ type: 'high_score', endsAt: +at(48) }, now);
  assert.ok(ms.ok && +ms.value.endsAt === +at(48), 'epoch ms still accepted');
  assert.equal(code({ startsAt: iso(24), endsAt: iso(24.5) }), 'invalid_window', 'end must be an hour after a chosen start');
  assert.equal(code({ startsAt: iso(24), endsAt: iso(24 + MAX_WINDOW_DAYS * 24 + 1) }), 'invalid_window', '90 days counts from the start');
  const future = validateCreate({ type: 'high_score', startsAt: iso(24), endsAt: iso(48) }, now);
  assert.ok(future.ok && +future.value.startsAt! === +at(24));
  const skew = validateCreate({ type: 'high_score', startsAt: new Date(+now - 60_000).toISOString(), endsAt: iso(48) }, now);
  assert.ok(skew.ok && skew.value.startsAt === null, 'a start a minute ago is just "now"');
});

// ── records ──────────────────────────────────────────────────────────────────

test('computeRecord: totals, streaks, head-to-head; a legacy void counts as no-show and leaves streaks alone', () => {
  const e = (id: number, day: number, outcome: any, opp: number, isVoid = false) =>
    ({ challengeId: id, resolvedAt: new Date(+T0 + day * DAY), void: isVoid, outcome, opponentIds: [opp] });
  const rec = computeRecord([
    e(1, 1, 'win', B),
    e(2, 2, 'win', C),
    e(3, 3, 'no_show', B, true),   // void: doesn't break the run
    e(4, 4, 'win', B),
    e(5, 5, 'loss', C),
    e(6, 6, 'win', B),
    e(7, 7, 'tie', B),
    e(8, 8, 'win', C),
    e(9, 9, 'forfeit', B),
    e(10, 10, 'no_show', C),
    e(11, 11, 'win', B),
  ]);
  assert.equal(rec.played, 11);
  assert.equal(rec.wins, 6);
  assert.equal(rec.losses, 1);
  assert.equal(rec.ties, 1);
  assert.equal(rec.forfeits, 1);
  assert.equal(rec.noShows, 2);
  assert.equal(rec.voids, 1);
  assert.equal(rec.bestStreak, 3, 'wins 1, 2, (void), 4');
  assert.equal(rec.currentStreak, 1);
  const vsB = rec.headToHead.find(h => h.opponentId === B)!;
  assert.equal(rec.abandoned, 0);
  assert.deepEqual(vsB, { opponentId: B, played: 7, wins: 4, losses: 0, ties: 1, forfeits: 1, noShows: 1, abandoned: 0 });
  const vsC = rec.headToHead.find(h => h.opponentId === C)!;
  assert.deepEqual(vsC, { opponentId: C, played: 4, wins: 2, losses: 1, ties: 0, forfeits: 0, noShows: 1, abandoned: 0 });
  assert.equal(rec.headToHead[0].opponentId, B, 'most-played opponent first');
});

test('computeRecord: abandoned is its own count (not W/L/T/no-show) and breaks a streak; a legacy void does not', () => {
  const e = (id: number, day: number, outcome: any, opp: number, isVoid = false) =>
    ({ challengeId: id, resolvedAt: new Date(+T0 + day * DAY), void: isVoid, outcome, opponentIds: [opp] });
  const rec = computeRecord([
    e(1, 1, 'win', B),
    e(2, 2, 'win', B),
    e(3, 3, 'no_show', B, true),   // void: run continues
    e(4, 4, 'win', C),             // run = 3
    e(5, 5, 'abandoned', B),       // breaks it
    e(6, 6, 'win', B),
    e(7, 7, 'abandoned', C),       // breaks again
  ]);
  assert.equal(rec.played, 7);
  assert.equal(rec.wins, 4);
  assert.equal(rec.losses, 0);
  assert.equal(rec.ties, 0);
  assert.equal(rec.noShows, 1, 'only the void one');
  assert.equal(rec.abandoned, 2);
  assert.equal(rec.voids, 1);
  assert.equal(rec.bestStreak, 3, 'wins 1, 2, (void), 4');
  assert.equal(rec.currentStreak, 0, 'abandoned ended the last run');
  const vsB = rec.headToHead.find(h => h.opponentId === B)!;
  assert.deepEqual(vsB, { opponentId: B, played: 5, wins: 3, losses: 0, ties: 0, forfeits: 0, noShows: 1, abandoned: 1 });
  const vsC = rec.headToHead.find(h => h.opponentId === C)!;
  assert.deepEqual(vsC, { opponentId: C, played: 2, wins: 1, losses: 0, ties: 0, forfeits: 0, noShows: 0, abandoned: 1 });
  const voidLast = computeRecord([e(1, 1, 'win', B), e(2, 2, 'no_show', B, true)]);
  assert.equal(voidLast.currentStreak, 1, 'a trailing void leaves the run alone');
});

test('computeRecord: order is by resolution time, not input order; empty record is zeros', () => {
  const rec = computeRecord([
    { challengeId: 2, resolvedAt: at(2), void: false, outcome: 'win', opponentIds: [B] },
    { challengeId: 1, resolvedAt: at(1), void: false, outcome: 'loss', opponentIds: [B] },
  ]);
  assert.equal(rec.currentStreak, 1);
  const empty = computeRecord([]);
  assert.equal(empty.played, 0);
  assert.equal(empty.currentStreak, 0);
  assert.deepEqual(empty.headToHead, []);
});

// ── groups + proposals (feature/group-challenges) ───────────────────────────

const D = 4, E = 5;
type Resp = 'pending' | 'accepted' | 'declined' | 'countered' | 'missed';
const pp = (userId: number, response: Resp, declineReason: 'cant_reach' | 'no_thanks' | 'backed_out' | null = null) => ({ userId, response, outcome: null, declineReason });
const group = { creatorId: A, status: 'pending' as const, startsAt: null, endsAt: at(72) };

test('pendingDue truth table', () => {
  const ps = [pp(A, 'accepted'), pp(B, 'accepted'), pp(C, 'pending')];
  const none = [pp(A, 'accepted'), pp(B, 'pending'), pp(C, 'declined')];
  const fixed = { ...group, startsAt: at(5) };
  assert.equal(pendingDue(group, ps, at(1)), null, 'starts-when-accepted never starts on its own');
  assert.equal(pendingDue(group, ps, at(72)), 'expire', 'end passed');
  assert.equal(pendingDue(fixed, ps, at(4)), null, 'before the fixed start');
  assert.equal(pendingDue(fixed, ps, at(5)), 'start', 'fixed start, one accepted → starts with who is in');
  assert.equal(pendingDue(fixed, none, at(5)), 'expire', 'fixed start, nobody accepted → expires');
  assert.equal(pendingDue(fixed, ps, at(72)), 'expire', 'end passed beats the start');
  assert.equal(pendingDue({ ...group, status: 'active' }, ps, at(100)), null);
  const proposal = { creatorId: A, status: 'proposed' as const, startsAt: null, endsAt: at(48) };
  assert.equal(pendingDue(proposal, [], at(47)), null);
  assert.equal(pendingDue(proposal, [], at(48)), 'lapse', 'its own end passed');
  assert.equal(pendingDue({ ...proposal, startsAt: at(10) }, [], at(10)), 'lapse', 'its own start passed');
  assert.equal(pendingDue({ ...proposal, status: 'rejected' }, [], at(100)), null);
});

test('afterAnswer truth table (L / D / wait)', () => {
  const L = (ps: ReturnType<typeof pp>[], open = 0) => afterAnswer(group, ps, open);
  assert.equal(L([pp(A, 'accepted'), pp(B, 'accepted')]), 'active', '1:1 accepted');
  assert.equal(L([pp(A, 'accepted'), pp(B, 'declined')]), 'declined', '1:1 declined');
  assert.equal(L([pp(A, 'accepted'), pp(B, 'accepted'), pp(C, 'pending')]), null, 'someone still pending');
  assert.equal(L([pp(A, 'accepted'), pp(B, 'accepted'), pp(C, 'declined')]), 'active', 'one decline drops that player');
  assert.equal(L([pp(A, 'accepted'), pp(B, 'declined'), pp(C, 'declined', 'no_thanks')]), 'declined', 'nobody left');
  assert.equal(L([pp(A, 'accepted'), pp(B, 'accepted'), pp(C, 'countered')], 1), null, 'an open proposal blocks the start');
  assert.equal(L([pp(A, 'accepted'), pp(B, 'countered')], 1), null, 'an open proposal blocks declined too');
  assert.equal(L([pp(A, 'accepted'), pp(B, 'countered')], 0), 'declined', 'the counterer is out once their proposal closed');
  assert.equal(L([pp(A, 'accepted'), pp(B, 'accepted'), pp(C, 'countered')], 0), 'active');
  assert.equal(afterAnswer({ ...group, status: 'active' }, [pp(A, 'accepted'), pp(B, 'accepted')], 0), null, 'only a pending one');
});

test('group guards: back out, start with who is in, deciding a proposal', () => {
  const accepted = pp(B, 'accepted');
  assert.ok(canDecline(group, accepted), 'an accepted invitee may back out while pending');
  assert.ok(!canAccept(group, accepted), 'but not accept twice');
  assert.ok(!canCounter(group, accepted), 'nor counter once accepted');
  assert.ok(!canDecline({ ...group, status: 'active' }, accepted), 'no backing out once it started (forfeit instead)');
  assert.ok(!canDecline(group, pp(A, 'accepted')), 'the challenger cancels instead');
  assert.ok(!canDecline(group, pp(C, 'declined')));
  assert.ok(!canDecline(group, pp(C, 'missed')));
  const ps = [pp(A, 'accepted'), pp(B, 'accepted'), pp(C, 'pending')];
  assert.ok(canStart(group, ps, A), 'challenger + one accepted');
  assert.ok(!canStart(group, ps, B), 'only the challenger');
  assert.ok(!canStart(group, [pp(A, 'accepted'), pp(B, 'pending')], A), 'nobody accepted yet');
  assert.ok(!canStart({ ...group, status: 'active' }, ps, A));
  const proposal = { creatorId: A, status: 'proposed' as const, startsAt: null, endsAt: at(48) };
  const challenger = pp(A, 'pending'), proposer = pp(B, 'accepted');
  assert.ok(canDecideProposal(proposal, challenger));
  assert.ok(canAccept(proposal, challenger) && canDecline(proposal, challenger), 'accept = take it, decline = keep mine');
  assert.ok(!canAccept(proposal, proposer) && !canDecline(proposal, proposer), 'the proposer can’t decide (or withdraw) it');
  assert.ok(!canCounter(proposal, challenger), 'no counter-of-a-counter for the challenger');
  assert.ok(!canCancel(proposal, A), 'a proposal is not cancellable');
  assert.ok(!canDecideProposal({ ...proposal, status: 'rejected' }, challenger));
  assert.ok(!canDecideProposal(proposal, undefined));
  assert.ok(isProposalStatus('proposed') && isProposalStatus('rejected') && isProposalStatus('lapsed'));
  assert.ok(!isProposalStatus('pending') && !isProposalStatus('countered'));
});

test('reinvitees: everyone except the challenger, the proposer, no_thanks decliners and ex-friends', () => {
  const ps = [pp(A, 'accepted'), pp(B, 'countered', 'cant_reach'), pp(C, 'accepted'), pp(D, 'declined', 'no_thanks'), pp(E, 'declined', 'cant_reach'), pp(6, 'pending'), pp(7, 'countered', 'cant_reach'), pp(8, 'declined')];
  const friends = new Set([B, C, D, E, 6, 7, 8]);
  assert.deepEqual(reinvitees(group, ps, B, friends), [C, E, 6, 7, 8]);
  friends.delete(6);
  assert.deepEqual(reinvitees(group, ps, B, friends), [C, E, 7, 8], 'no longer the challenger’s friend → not re-invited');
  assert.deepEqual(reinvitees(group, [pp(A, 'accepted'), pp(B, 'countered')], B, new Set([B])), [], '1:1: nobody to re-invite');
  assert.deepEqual(reinvitees(group, [pp(A, 'accepted'), pp(B, 'countered', 'cant_reach'), pp(C, 'declined', 'backed_out')], B, new Set([B, C])), [C],
    'a player who backed out is asked again (only no_thanks is final)');
});

test('proposalClosure: status, notified reason and the challenger closing response per closing event', () => {
  assert.deepEqual(proposalClosure('rejected'), { status: 'rejected', notifyReason: 'rejected', challengerResponse: 'declined' });
  assert.deepEqual(proposalClosure('superseded'), { status: 'rejected', notifyReason: 'superseded', challengerResponse: 'declined' });
  assert.deepEqual(proposalClosure('started'), { status: 'rejected', notifyReason: 'started', challengerResponse: 'declined' });
  assert.deepEqual(proposalClosure('fixed_start'), { status: 'lapsed', notifyReason: 'started', challengerResponse: 'missed' });
  assert.deepEqual(proposalClosure('cancelled'), { status: 'lapsed', notifyReason: 'cancelled', challengerResponse: 'missed' });
  assert.deepEqual(proposalClosure('expired'), { status: 'lapsed', notifyReason: 'expired', challengerResponse: 'missed' });
});

test('phaseOf maps the new statuses onto old phases (old cached clients have no default branch)', () => {
  const c = { creatorId: A, status: 'proposed' as const, startsAt: null, endsAt: at(72) };
  assert.equal(phaseOf(c, at(1)), 'pending');
  assert.equal(phaseOf({ ...c, status: 'rejected' }, at(1)), 'declined');
  assert.equal(phaseOf({ ...c, status: 'lapsed' }, at(1)), 'expired');
  const old = ['pending', 'scheduled', 'live', 'ended', 'resolved', 'declined', 'cancelled', 'expired', 'countered'];
  for (const status of ['pending', 'active', 'resolved', 'declined', 'cancelled', 'expired', 'countered', 'proposed', 'rejected', 'lapsed'] as const) {
    assert.ok(old.includes(phaseOf({ ...c, status }, at(1))), status);
  }
});

test('saidNo: missed players are out too', () => {
  assert.ok(saidNo('missed'));
});

test('parseInvitees: ids, usernames, the 1:1 fields, the cap and repeats', () => {
  const ok = (b: Record<string, unknown>) => { const r = parseInvitees(b); assert.ok(r.ok, JSON.stringify(r)); return r.ok ? r.value : []; };
  const code = (b: Record<string, unknown>) => { const r = parseInvitees(b); return r.ok ? 'ok' : r.code; };
  assert.deepEqual(ok({ friendId: 5 }), [{ id: 5 }]);
  assert.deepEqual(ok({ friendId: '5' }), [{ id: 5 }]);
  assert.deepEqual(ok({ friendUsername: ' bob ' }), [{ username: 'bob' }]);
  assert.deepEqual(ok({ friendIds: [2, 3], friendUsernames: ['zed'] }), [{ id: 2 }, { id: 3 }, { username: 'zed' }]);
  assert.equal(code({}), 'invalid_user');
  assert.equal(code({ friendIds: [] }), 'invalid_user');
  assert.equal(code({ friendIds: 'bob' }), 'invalid_user');
  assert.equal(code({ friendIds: [1.5] }), 'invalid_user');
  assert.equal(code({ friendIds: [0] }), 'invalid_user');
  assert.equal(code({ friendId: 'x' }), 'invalid_user');
  assert.equal(code({ friendIds: [2, 2] }), 'duplicate_invitee');
  assert.equal(code({ friendIds: [2], friendId: 2 }), 'duplicate_invitee');
  assert.equal(code({ friendUsernames: ['Bob', 'bob'] }), 'duplicate_invitee');
  assert.equal(code({ friendIds: Array.from({ length: MAX_INVITEES }, (_, i) => i + 1) }), 'ok');
  assert.equal(code({ friendIds: Array.from({ length: MAX_INVITEES + 1 }, (_, i) => i + 1) }), 'too_many_players');
  assert.equal(MAX_PLAYERS, 8);
  assert.equal(MAX_INVITEES, 7);
});

test('pairOutcome matrix', () => {
  const P = (outcome: any, rank: number | null) => ({ outcome, rank });
  // my own bucket stays mine
  assert.equal(pairOutcome(P('forfeit', 4), P('win', 1)), 'forfeit');
  assert.equal(pairOutcome(P('no_show', 3), P('forfeit', 4)), 'no_show');
  assert.equal(pairOutcome(P('abandoned', 1), P('abandoned', 1)), 'abandoned');
  // they forfeited / didn't show → I win, whatever my headline outcome
  assert.equal(pairOutcome(P('loss', 2), P('forfeit', 4)), 'win');
  assert.equal(pairOutcome(P('loss', 2), P('no_show', 3)), 'win');
  assert.equal(pairOutcome(P('win', 1), P('forfeit', 2)), 'win');
  // otherwise by rank
  assert.equal(pairOutcome(P('loss', 2), P('loss', 3)), 'win', 'second beats third');
  assert.equal(pairOutcome(P('loss', 3), P('loss', 2)), 'loss');
  assert.equal(pairOutcome(P('loss', 2), P('loss', 2)), 'tie', 'level below first');
  assert.equal(pairOutcome(P('tie', 1), P('tie', 1)), 'tie');
  assert.equal(pairOutcome(P('win', 1), P('loss', 2)), 'win');
  assert.equal(pairOutcome(P('loss', 2), P('win', 1)), 'loss');
  assert.equal(pairOutcome(P('win', 1), P('abandoned', null)), 'win', 'missing rank falls back to my outcome');
});

test('pairOutcome agrees with the headline outcome in every 1:1 resolution', () => {
  const cases: Array<[ChallengeType, ParticipantState[], 'deadline' | 'race_target' | 'forfeit']> = [
    ['high_score', [state('high_score', A, [10]), state('high_score', B, [5])], 'deadline'],
    ['high_score', [state('high_score', A, [10]), state('high_score', B, [10])], 'deadline'],
    ['high_score', [state('high_score', A, [10]), state('high_score', B, [])], 'deadline'],
    ['high_score', [state('high_score', A, []), state('high_score', B, [])], 'deadline'],
    ['high_score', [state('high_score', A, [10]), state('high_score', B, [20], { forfeited: true })], 'forfeit'],
    ['race', [state('race', A, [2000], { target: 1000, createdAt: [2] }), state('race', B, [1500], { target: 1000, createdAt: [1] })], 'race_target'],
    ['race', [state('race', A, [500], { target: 1000 }), state('race', B, [], { target: 1000 })], 'deadline'],
    ['average', [state('average', A, [10, 10, 10], { minPlays: 3 }), state('average', B, [50], { minPlays: 3 })], 'deadline'],
    ['most_improved', [state('most_improved', A, [150], { baseline: 100 }), state('most_improved', B, [300], { baseline: 100 })], 'deadline'],
  ];
  for (const [type, states, reason] of cases) {
    const r = resolveChallenge(type, states, reason);
    const [pa, pb] = [r.participants.find(p => p.userId === A)!, r.participants.find(p => p.userId === B)!];
    assert.equal(pairOutcome(pa, pb), pa.outcome, `${type}/${reason}: A`);
    assert.equal(pairOutcome(pb, pa), pb.outcome, `${type}/${reason}: B`);
  }
});

test('computeRecord, groups: headline on outcome (below 1st = loss), head-to-head pairwise by rank, loss streaks', () => {
  const rec = computeRecord([
    // 4 players: A 2nd, B 1st, C 3rd, D no-show
    { challengeId: 1, resolvedAt: at(1), void: false, outcome: 'loss', rank: 2, opponents: [
      { userId: B, outcome: 'win', rank: 1 }, { userId: C, outcome: 'loss', rank: 3 }, { userId: D, outcome: 'no_show', rank: 4 },
    ] },
    // 3 players: A 3rd
    { challengeId: 2, resolvedAt: at(2), void: false, outcome: 'loss', rank: 3, opponents: [
      { userId: B, outcome: 'win', rank: 1 }, { userId: C, outcome: 'loss', rank: 2 },
    ] },
    // A wins
    { challengeId: 3, resolvedAt: at(3), void: false, outcome: 'win', rank: 1, opponents: [{ userId: C, outcome: 'loss', rank: 2 }] },
    // two losses in a row
    { challengeId: 4, resolvedAt: at(4), void: false, outcome: 'loss', rank: 2, opponents: [{ userId: B, outcome: 'win', rank: 1 }] },
    { challengeId: 5, resolvedAt: at(5), void: false, outcome: 'loss', rank: 2, opponents: [{ userId: B, outcome: 'win', rank: 1 }] },
  ]);
  assert.equal(rec.wins, 1);
  assert.equal(rec.losses, 4, 'second and third place are losses');
  assert.equal(rec.bestLossStreak, 2, 'challenges 1–2 and 4–5');
  assert.equal(rec.bestStreak, 1);
  assert.equal(rec.currentStreak, 0);
  const h = (id: number) => rec.headToHead.find(x => x.opponentId === id)!;
  assert.deepEqual(h(B), { opponentId: B, played: 4, wins: 0, losses: 4, ties: 0, forfeits: 0, noShows: 0, abandoned: 0 });
  assert.deepEqual(h(C), { opponentId: C, played: 3, wins: 2, losses: 1, ties: 0, forfeits: 0, noShows: 0, abandoned: 0 }, 'beat C as 2nd vs 3rd and 1st vs 2nd; lost as 3rd vs 2nd');
  assert.deepEqual(h(D), { opponentId: D, played: 1, wins: 1, losses: 0, ties: 0, forfeits: 0, noShows: 0, abandoned: 0 }, 'D did not show → my win');
});

test('computeRecord: bestLossStreak — any other outcome ends a run, a legacy void does not', () => {
  const e = (id: number, outcome: any, isVoid = false) => ({ challengeId: id, resolvedAt: at(id), void: isVoid, outcome, opponentIds: [B] });
  assert.equal(computeRecord([e(1, 'loss'), e(2, 'loss'), e(3, 'tie'), e(4, 'loss')]).bestLossStreak, 2);
  assert.equal(computeRecord([e(1, 'loss'), e(2, 'no_show', true), e(3, 'loss')]).bestLossStreak, 2, 'void neither extends nor breaks');
  assert.equal(computeRecord([e(1, 'loss'), e(2, 'abandoned'), e(3, 'loss')]).bestLossStreak, 1, 'abandoned breaks it');
  assert.equal(computeRecord([]).bestLossStreak, 0);
});
