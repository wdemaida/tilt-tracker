// Run: npx tsx --test src/lib/challengeRecs.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecommendations, mergeGroupRecommendations, rankRecentPlay, reachIds, viewerReachOf, REC_CAPS, GROUP_REC_CAP, type ReachItem, type Reach, type GroupRecommendation } from './challengeRecs.js';

const m = (machineId: number, venueLabel?: string | null): ReachItem => ({
  machineId, name: `M${machineId}`, variant: null, imageUrl: null, ...(venueLabel !== undefined ? { venueLabel } : {}),
});
const empty: Reach = { level1: [], level2: [], level3: [] };
const none = new Set<number>();
const noBest = new Map<number, number>();

test('a machine keeps only its highest level', () => {
  const recs = mergeRecommendations({ level1: [m(1)], level2: [m(1, 'Logan Arcade'), m(2, 'Logan Arcade')], level3: [m(1), m(2), m(3)] }, none, noBest);
  assert.deepEqual(recs.map(r => [r.machineId, r.level]), [[1, 1], [2, 2], [3, 3]]);
});

test('within a level: viewer can reach it, then viewer has a score, then the rest (stable)', () => {
  const recs = mergeRecommendations({ ...empty, level2: [m(1), m(2), m(3), m(4), m(5)] }, new Set([4]), new Map([[2, 900], [5, 100]]));
  assert.deepEqual(recs.map(r => r.machineId), [4, 2, 5, 1, 3]);
  assert.equal(recs[0].viewerCanReach, true);
  assert.equal(recs[1].viewerCanReach, false);
  assert.equal(recs[1].viewerBest, 900);
  assert.equal('viewerBest' in recs[3], false, 'no viewerBest when the viewer has no score');
});

test('caps per level: 3 / 8 / 5, applied after ranking', () => {
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => m(from + i));
  const recs = mergeRecommendations({ level1: many(100, 5), level2: many(200, 12), level3: many(300, 9) }, new Set([211]), noBest);
  const count = (l: number) => recs.filter(r => r.level === l).length;
  assert.equal(count(1), REC_CAPS[1]);
  assert.equal(count(2), REC_CAPS[2]);
  assert.equal(count(3), REC_CAPS[3]);
  assert.equal(recs.find(r => r.level === 2)?.machineId, 211, 'a reachable machine beyond the cap is ranked in first');
  assert.deepEqual(REC_CAPS, { 1: 3, 2: 8, 3: 5 });
});

test('levels come out in order 1, 2, 3', () => {
  const recs = mergeRecommendations({ level1: [m(3)], level2: [m(2)], level3: [m(1)] }, none, noBest);
  assert.deepEqual(recs.map(r => r.level), [1, 2, 3]);
});

test('machines you can both reach come first, across levels, then by level', () => {
  const recs = mergeRecommendations({ level1: [m(1), m(2)], level2: [m(3), m(4)], level3: [m(5), m(6)] }, new Set([6, 3]), noBest);
  assert.deepEqual(recs.map(r => [r.machineId, r.level]), [[3, 2], [6, 3], [1, 1], [2, 1], [4, 2], [5, 3]]);
  assert.deepEqual(recs.map(r => r.viewerCanReach), [true, true, false, false, false, false]);
});

test('both-reach first: the caps pick the same set as before, only the order changes', () => {
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => m(from + i));
  const reach: Reach = { level1: many(100, 5), level2: many(200, 12), level3: many(300, 9) };
  const viewerReach = new Set([104, 211, 203, 308, 301]);
  const recs = mergeRecommendations(reach, viewerReach, new Map([[102, 50]]));
  const count = (l: number) => recs.filter(r => r.level === l).length;
  assert.deepEqual([count(1), count(2), count(3)], [REC_CAPS[1], REC_CAPS[2], REC_CAPS[3]]);
  // Per level, the same picks in the same order as the per-level rank (reach, then best, then the rest).
  assert.deepEqual(recs.filter(r => r.level === 1).map(r => r.machineId), [104, 102, 100]);
  assert.deepEqual(recs.filter(r => r.level === 2).map(r => r.machineId), [203, 211, 200, 201, 202, 204, 205, 206]);
  assert.deepEqual(recs.filter(r => r.level === 3).map(r => r.machineId), [301, 308, 300, 302, 303]);
  assert.deepEqual(recs.map(r => r.machineId), [104, 203, 211, 301, 308, 102, 100, 200, 201, 202, 204, 205, 206, 300, 302, 303]);
});

test('both-reach first is stable: ties keep level order, then each level’s own order', () => {
  const recs = mergeRecommendations(
    { level1: [m(1), m(2)], level2: [m(3), m(4), m(5)], level3: [m(6), m(7)] },
    new Set([7, 5, 2, 4, 6]), new Map([[3, 10], [1, 20]]),
  );
  assert.deepEqual(recs.map(r => r.machineId), [2, 4, 5, 6, 7, 1, 3]);
  assert.equal(recs.at(-1)?.viewerBest, 10);
});

test('nobody overlaps → plain level order', () => {
  const recs = mergeRecommendations({ level1: [m(1)], level2: [m(2, 'at home')], level3: [m(3)] }, new Set([99]), noBest);
  assert.deepEqual(recs.map(r => r.machineId), [1, 2, 3]);
  assert.equal(recs[1].venueLabel, 'at home');
});

test('venue labels: level 2 only, a later copy fills a missing label, never an empty one', () => {
  const recs = mergeRecommendations({ level1: [m(9, 'nope')], level2: [m(1, null), m(1, 'Logan Arcade'), m(2, 'at home'), m(3, null)], level3: [m(4, 'x')] }, none, noBest);
  const by = new Map(recs.map(r => [r.machineId, r]));
  assert.equal(by.get(1)?.venueLabel, 'Logan Arcade');
  assert.equal(by.get(2)?.venueLabel, 'at home');
  assert.equal('venueLabel' in by.get(3)!, false, 'someone else’s private venue: no label at all');
  assert.equal('venueLabel' in by.get(9)!, false, 'level 1 never carries a label');
  assert.equal('venueLabel' in by.get(4)!, false, 'level 3 never carries a label');
});

test('duplicates within a level count once', () => {
  const recs = mergeRecommendations({ ...empty, level2: [m(1, 'A'), m(1, 'B'), m(2, 'A')] }, none, noBest);
  assert.deepEqual(recs.map(r => [r.machineId, r.venueLabel]), [[1, 'A'], [2, 'A']]);
});

test('empty reach → nothing', () => {
  assert.deepEqual(mergeRecommendations(empty, new Set([1]), new Map([[1, 5]])), []);
});

test('reachIds: every level', () => {
  assert.deepEqual([...reachIds({ level1: [m(1)], level2: [m(2), m(1)], level3: [m(3)] })].sort(), [1, 2, 3]);
});

test('reachIds: only the levels asked for', () => {
  const r: Reach = { level1: [m(1)], level2: [m(2)], level3: [m(3), m(2)] };
  assert.deepEqual([...reachIds(r, [1, 2])].sort(), [1, 2]);
  assert.deepEqual([...reachIds(r, [3])].sort(), [2, 3]);
  assert.deepEqual([...reachIds(r, [])], []);
});

// ── fix/both-reach (2026-10-02) ──────────────────────────────────────────────

test('viewerReachOf: reach = levels 1–2; lately = level 3 only, minus anything reachable', () => {
  const { reach, lately } = viewerReachOf({ level1: [m(1)], level2: [m(2)], level3: [m(2), m(3)] });
  assert.deepEqual([...reach].sort(), [1, 2]);
  assert.deepEqual([...lately], [3]);
});

test('Transformers regression: a machine the viewer only played lately (Chicago) is NOT "you can both reach"', () => {
  // collasta (Portland) can reach Transformers at Wedgehead (level 2); Will only scored on it in
  // Chicago in September (his level 3). Before the fix that made it "You can both reach".
  const TRANSFORMERS = 1147, SOLAR_CITY = 757;
  const collasta: Reach = { level1: [], level2: [m(TRANSFORMERS, 'Wedgehead'), m(42, 'Wedgehead')], level3: [] };
  const will: Reach = { level1: [], level2: [m(SOLAR_CITY, 'Poit’s')], level3: [m(TRANSFORMERS)] };
  const { reach, lately } = viewerReachOf(will);
  const recs = mergeRecommendations(collasta, reach, new Map([[TRANSFORMERS, 50_000_000]]), REC_CAPS, lately);
  const t = recs.find(r => r.machineId === TRANSFORMERS)!;
  assert.equal(t.viewerCanReach, false);
  assert.equal(t.viewerPlayedLately, true);
  assert.equal(recs.filter(r => r.viewerCanReach).length, 0, 'nothing is "you can both reach"');
  assert.equal(recs[0].machineId, TRANSFORMERS, 'played lately still ranks first within its level');
  assert.equal('viewerPlayedLately' in recs.find(r => r.machineId === 42)!, false);
});

test('within a level: reach, then played lately, then has a score, then the rest', () => {
  const recs = mergeRecommendations(
    { ...empty, level2: [m(1), m(2), m(3), m(4)] }, new Set([4]), new Map([[2, 10], [3, 10]]), REC_CAPS, new Set([3]),
  );
  assert.deepEqual(recs.map(r => r.machineId), [4, 3, 2, 1]);
  assert.deepEqual(recs.map(r => !!r.viewerPlayedLately), [false, true, false, false]);
});

test('a machine both reachable and played lately is just reachable', () => {
  const recs = mergeRecommendations({ ...empty, level1: [m(1)] }, new Set([1]), noBest, REC_CAPS, new Set([1]));
  assert.equal(recs[0].viewerCanReach, true);
  assert.equal('viewerPlayedLately' in recs[0], false);
});

test('group merge carries played-lately too, and passes it through for one target', () => {
  const bob: Reach = { level1: [m(1)], level2: [], level3: [] };
  const carol: Reach = { level1: [m(1)], level2: [m(2)], level3: [] };
  const recs = mergeGroupRecommendations([{ userId: 2, reach: bob }, { userId: 3, reach: carol }], new Set(), noBest, GROUP_REC_CAP, new Set([2])) as GroupRecommendation[];
  assert.equal(recs.find(r => r.machineId === 2)!.viewerPlayedLately, true);
  const one = mergeGroupRecommendations([{ userId: 2, reach: carol }], new Set(), noBest, GROUP_REC_CAP, new Set([2]));
  assert.deepEqual(one, mergeRecommendations(carol, new Set(), noBest, REC_CAPS, new Set([2])));
});

test('rankRecentPlay: visits, then most recent', () => {
  const d = (s: string) => new Date(s);
  const rows = [
    { id: 'a', visits: 1, lastPlayedAt: d('2026-09-20') },
    { id: 'b', visits: 3, lastPlayedAt: d('2026-08-01') },
    { id: 'c', visits: 1, lastPlayedAt: d('2026-09-25') },
    { id: 'd', visits: 3, lastPlayedAt: d('2026-09-01') },
  ];
  assert.deepEqual(rankRecentPlay(rows).map(r => r.id), ['d', 'b', 'c', 'a']);
});

// ── groups (feature/group-challenges) ────────────────────────────────────────

test('group merge with ONE target is exactly the single-friend list', () => {
  const reach: Reach = { level1: [m(1)], level2: [m(2, 'Logan Arcade'), m(3, 'at home')], level3: [m(4), m(1)] };
  const viewerReach = new Set([3]);
  const best = new Map([[4, 1000]]);
  assert.deepEqual(mergeGroupRecommendations([{ userId: 9, reach }], viewerReach, best), mergeRecommendations(reach, viewerReach, best));
  assert.deepEqual(mergeRecommendations(reach, viewerReach, best).map(r => r.machineId), [3, 1, 2, 4], 'both-reach first applies here too');
});

test('group merge (several targets) is untouched by both-reach-first: its own order stands', () => {
  // A viewer-reachable machine at level 3 for one friend only does NOT jump a 2-of-2 machine.
  const bob: Reach = { level1: [m(1)], level2: [m(2, 'Logan Arcade')], level3: [m(3), m(4)] };
  const carol: Reach = { level1: [], level2: [m(1)], level3: [m(2), m(5)] };
  const recs = mergeGroupRecommendations([{ userId: 2, reach: bob }, { userId: 3, reach: carol }], new Set([4, 5]), new Map([[3, 9]])) as GroupRecommendation[];
  assert.deepEqual(recs.map(r => [r.machineId, r.level, r.coverage, r.viewerCanReach]), [
    [1, 1, 2, false], [2, 2, 2, false], [4, 3, 1, true], [5, 3, 1, true], [3, 3, 1, false],
  ]);
});

test('group merge: coverage first, then viewer can reach it, then lowest level, then viewer best, then first seen', () => {
  const bob: Reach = { level1: [m(10)], level2: [m(20, 'Logan Arcade'), m(30)], level3: [m(40), m(50)] };
  const carol: Reach = { level1: [], level2: [m(30)], level3: [m(20), m(60), m(50)] };
  const dave: Reach = { level1: [], level2: [], level3: [m(30), m(70)] };
  const recs = mergeGroupRecommendations(
    [{ userId: 2, reach: bob }, { userId: 3, reach: carol }, { userId: 4, reach: dave }],
    new Set([50]), new Map([[60, 5], [70, 7]]),
  ) as GroupRecommendation[];
  assert.deepEqual(recs.map(r => r.machineId), [30, 50, 20, 10, 60, 70, 40]);
  const by = new Map(recs.map(r => [r.machineId, r]));
  assert.deepEqual([by.get(30)!.coverage, by.get(30)!.reachedBy], [3, [2, 3, 4]]);
  assert.equal(by.get(30)!.level, 2, 'the lowest level anyone has it at');
  assert.equal(by.get(50)!.viewerCanReach, true);
  assert.equal(by.get(20)!.venueLabel, 'Logan Arcade', 'a public venue keeps its name');
  assert.equal(by.get(20)!.level, 2);
  assert.equal(by.get(60)!.viewerBest, 5);
});

test('group merge: a target’s own home becomes atHomeOf, never "at home"; capped', () => {
  const bob: Reach = { level1: [], level2: [m(1, 'at home'), m(2, null)], level3: [] };
  const carol: Reach = { level1: [], level2: [m(1, 'at home')], level3: [] };
  const recs = mergeGroupRecommendations([{ userId: 2, reach: bob }, { userId: 3, reach: carol }], new Set(), new Map()) as GroupRecommendation[];
  const one = recs.find(r => r.machineId === 1)!;
  assert.deepEqual(one.atHomeOf, [2, 3]);
  assert.equal('venueLabel' in one, false);
  assert.equal('venueLabel' in recs.find(r => r.machineId === 2)!, false, 'someone else’s private venue: no label');
  assert.ok(!JSON.stringify(recs).includes('at home'));
  const many = (from: number) => Array.from({ length: 30 }, (_, i) => m(from + i));
  const big = mergeGroupRecommendations([{ userId: 2, reach: { ...empty, level3: many(100) } }, { userId: 3, reach: { ...empty, level3: many(100) } }], none, noBest);
  assert.equal(big.length, GROUP_REC_CAP);
  assert.equal(GROUP_REC_CAP, 16);
});
