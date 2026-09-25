// Run: npx tsx --test src/lib/nearbyLookup.test.ts   (from artifacts/api-server)
//
// Pure — no database, network or timers; every call takes an explicit `now`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SlidingRateLimiter, TtlCache, cachedByCell, coordCellKey, rateLimitMessage, NEARBY_RATE_WINDOWS, NEARBY_CACHE_TTL_MS,
} from './nearbyLookup.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

test('allows 10 per minute, refuses the 11th, and recovers once the oldest ages out', () => {
  const l = new SlidingRateLimiter(NEARBY_RATE_WINDOWS);
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) assert.equal(l.take('u1', t0 + i * 1000).ok, true, `hit ${i + 1}`);
  const refused = l.take('u1', t0 + 10_000);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.retryAfterMs > 0 && refused.retryAfterMs <= MIN);
  // First hit was at t0; one minute later it no longer counts.
  assert.equal(l.take('u1', t0 + MIN).ok, true);
});

test('a refused request is not recorded', () => {
  const l = new SlidingRateLimiter([{ ms: MIN, max: 1 }]);
  assert.equal(l.take('u', 0).ok, true);
  for (let i = 1; i < 50; i++) assert.equal(l.take('u', i).ok, false);
  // Only the one accepted hit counts, so the window reopens exactly a minute after it.
  assert.equal(l.take('u', MIN).ok, true);
});

test('keys are independent', () => {
  const l = new SlidingRateLimiter([{ ms: MIN, max: 1 }]);
  assert.equal(l.take('a', 0).ok, true);
  assert.equal(l.take('b', 0).ok, true);
  assert.equal(l.take('a', 1).ok, false);
});

test('caps at 100 per day even when spread under the per-minute limit', () => {
  const l = new SlidingRateLimiter(NEARBY_RATE_WINDOWS);
  let t = 0;
  for (let i = 0; i < 100; i++) { assert.equal(l.take('u', t).ok, true, `hit ${i + 1}`); t += 10 * MIN; }
  // t is now 1000 minutes in — well inside the day that started at 0.
  const refused = l.take('u', t);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.retryAfterMs > MIN, 'day window, not minute window');
  assert.match(rateLimitMessage(!refused.ok ? refused.retryAfterMs : 0), /today's location lookups/);
  assert.equal(l.take('u', DAY).ok, true, 'first hit at 0 has aged out of the day window');
});

test('sweep forgets idle keys', () => {
  const l = new SlidingRateLimiter([{ ms: MIN, max: 1 }]);
  l.take('u', 0);
  l.sweep(MIN + 1);
  assert.equal(l.take('u', MIN + 2).ok, true);
});

test('minute-window message', () => {
  assert.match(rateLimitMessage(30_000), /wait a minute/);
});

test('TtlCache expires after its TTL', () => {
  const c = new TtlCache<string>(NEARBY_CACHE_TTL_MS);
  c.set('k', 'v', 0);
  assert.equal(c.get('k', NEARBY_CACHE_TTL_MS - 1), 'v');
  assert.equal(c.get('k', NEARBY_CACHE_TTL_MS), undefined);
  assert.equal(c.size, 0, 'expired entry removed on read');
});

test('TtlCache delete, and bounded size evicts oldest', () => {
  const c = new TtlCache<number>(MIN, 2);
  c.set('a', 1, 0);
  c.set('b', 2, 0);
  c.set('c', 3, 0);
  assert.equal(c.get('a', 1), undefined);
  assert.equal(c.get('c', 1), 3);
  c.delete('c');
  assert.equal(c.get('c', 1), undefined);
});

test('cachedByCell: one upstream call per cell, shared by concurrent and repeat taps', async () => {
  let calls = 0;
  const lookup = cachedByCell(async (lat: number) => { calls++; return { lat, ok: true }; }, new TtlCache(NEARBY_CACHE_TTL_MS));
  const [a, b] = await Promise.all([lookup(41.88861, -87.63521), lookup(41.88869, -87.63529)]);
  assert.equal(calls, 1, 'concurrent taps in one cell share the in-flight call');
  assert.equal(a, b);
  await lookup(41.8887, -87.6353);
  assert.equal(calls, 1, 'repeat tap in the same cell hits the cache — no second Pinball Map call');
  await lookup(41.8950, -87.6353);
  assert.equal(calls, 2, 'a different cell fetches');
});

test('cachedByCell: failures and rejected results are not cached', async () => {
  let calls = 0;
  const failing = cachedByCell(async () => { calls++; throw new Error('down'); }, new TtlCache<Promise<never>>(MIN));
  await assert.rejects(failing(1, 1));
  await assert.rejects(failing(1, 1));
  assert.equal(calls, 2);

  let n = 0;
  const partial = cachedByCell(async () => ({ pmOk: ++n > 1 }), new TtlCache<Promise<{ pmOk: boolean }>>(MIN), r => r.pmOk);
  assert.equal((await partial(1, 1)).pmOk, false);
  await Promise.resolve();
  assert.equal((await partial(1, 1)).pmOk, true, 'partial failure was dropped, so the retry re-fetched');
  assert.equal((await partial(1, 1)).pmOk, true);
  assert.equal(n, 2, 'good result is cached');
});

test('coordCellKey rounds to 3 decimals and groups nearby points', () => {
  assert.equal(coordCellKey(41.88851, -87.63544), '41.889,-87.635');
  assert.equal(coordCellKey(41.8886, -87.6352), coordCellKey(41.8889, -87.6348));
  assert.notEqual(coordCellKey(41.8884, -87.635), coordCellKey(41.8896, -87.635));
  assert.equal(coordCellKey(-0.0001, 0.0001), '0.000,0.000', 'no -0 spelling');
});
