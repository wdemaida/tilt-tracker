import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUTURE_SKEW_MS, playedAfter } from './playedAtClock.js';
import { FUTURE_SKEW_MS as BADGE_SKEW } from './badgeRules.js';

const NOW = new Date('2026-09-30T13:37:00Z');

test('the 15-minute rule, shared with badges', () => {
  assert.equal(FUTURE_SKEW_MS, 15 * 60 * 1000);
  assert.equal(BADGE_SKEW, FUTURE_SKEW_MS);
});

test('playedAfter: more than 15 minutes ahead of the reference is the future', () => {
  assert.ok(!playedAfter(NOW, NOW));
  assert.ok(!playedAfter(new Date(+NOW - 86_400_000), NOW));
  assert.ok(!playedAfter(new Date(+NOW + FUTURE_SKEW_MS), NOW), 'exactly at the skew is still now');
  assert.ok(playedAfter(new Date(+NOW + FUTURE_SKEW_MS + 1), NOW));
  // Will's #1276: edited at 13:37Z to 23:30Z the same day.
  assert.ok(playedAfter(new Date('2026-09-30T23:30:00Z'), NOW));
});
