// Run: npx tsx --test src/lib/statsCalc.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLiveTrend, isLiveTrendKey } from './statsCalc.js';

// All times are mid-afternoon UTC, so the New York calendar date is the same as the UTC one.
const at = (iso: string) => new Date(`${iso}T16:00:00Z`);
const score = (userId: number, created: string, played = created, machineName = 'Godzilla') =>
  ({ userId, machineName, createdAt: at(created), playedAt: at(played) });

const sample = [
  score(1, '2026-08-30', '2026-08-30', 'Godzilla'),
  score(1, '2026-09-02', '2026-09-02', 'Godzilla'),
  score(1, '2026-09-02', '2026-09-02', 'Elvira'),
  score(2, '2026-09-03', '2026-08-31', 'Elvira'), // submitted in September, played in August
];
const now = at('2026-09-04');

test('starts at the first submission and runs to today', () => {
  const pts = computeLiveTrend('total_plays', sample, 90, now);
  assert.equal(pts[0].periodDate, '2026-08-30');
  assert.equal(pts.at(-1)!.periodDate, '2026-09-04');
  assert.equal(pts.length, 6);
});

test('cumulative totals count by submission day', () => {
  const byDay = Object.fromEntries(computeLiveTrend('total_plays', sample, 90, now).map(p => [p.periodDate, p.value]));
  assert.deepEqual(byDay, { '2026-08-30': 1, '2026-08-31': 1, '2026-09-01': 1, '2026-09-02': 3, '2026-09-03': 4, '2026-09-04': 4 });
  const machines = computeLiveTrend('machines_with_score', sample, 90, now).map(p => p.value);
  assert.deepEqual(machines, [1, 1, 1, 2, 2, 2]);
  const visits = computeLiveTrend('total_visits', sample, 90, now).map(p => p.value);
  assert.deepEqual(visits, [1, 1, 1, 2, 3, 3]); // user 1: two outings; user 2: one
});

test('month counters reset on the 1st and use the played date', () => {
  const plays = computeLiveTrend('plays', sample, 90, now).map(p => p.value);
  // Aug 30–31: the Aug 30 play. Sep 1: nothing played in Sep yet. Sep 3: user 2's score was played in August.
  assert.deepEqual(plays, [1, 1, 0, 2, 2, 2]);
  const submitted = computeLiveTrend('scores_submitted', sample, 90, now).map(p => p.value);
  assert.deepEqual(submitted, [1, 1, 0, 2, 3, 3]);
});

test('capped at `days` points; empty in, empty out', () => {
  assert.equal(computeLiveTrend('total_plays', sample, 3, now).length, 3);
  assert.deepEqual(computeLiveTrend('total_plays', [], 90, now), []);
});

test('venue and machine-roster counts are not live keys', () => {
  assert.equal(isLiveTrendKey('total_venues'), false);
  assert.equal(isLiveTrendKey('total_machines'), false);
  assert.equal(isLiveTrendKey('total_plays'), true);
});
