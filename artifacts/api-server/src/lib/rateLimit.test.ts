// Run: npx tsx --test src/lib/rateLimit.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './rateLimit.js';

test('allows up to the limit per window, then refuses with a retry hint', () => {
  let t = 1_000_000;
  const rl = createRateLimiter({ limit: 30, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 30; i++) assert.equal(rl.hit(7).allowed, true, `hit ${i}`);
  const refused = rl.hit(7);
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterMs, 60_000);
  t += 30_000;
  assert.equal(rl.hit(7).allowed, false);
  assert.equal(rl.hit(7).retryAfterMs, 30_000);
});

test('window slides: old hits expire', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  rl.hit('a'); t = 500; rl.hit('a');
  assert.equal(rl.hit('a').allowed, false);
  t = 1000; // first hit has aged out
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, false);
});

test('keys are independent, and refused hits do not extend the window', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
  assert.equal(rl.hit(1).allowed, true);
  assert.equal(rl.hit(2).allowed, true);
  for (let i = 0; i < 5; i++) { t += 100; assert.equal(rl.hit(1).allowed, false); }
  t = 1000;
  assert.equal(rl.hit(1).allowed, true);
});
