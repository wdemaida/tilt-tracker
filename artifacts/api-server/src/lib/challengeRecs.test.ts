// Run: npx tsx --test src/lib/challengeRecs.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecommendations, rankRecentPlay, reachIds, REC_CAPS, type ReachItem, type Reach } from './challengeRecs.js';

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
  const recs = mergeRecommendations({ level1: [m(3)], level2: [m(2)], level3: [m(1)] }, new Set([1]), noBest);
  assert.deepEqual(recs.map(r => r.level), [1, 2, 3]);
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
