// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/badges.test.ts   (from artifacts/api-server)
//
// The engine's pure parts: admin input validation, the availability window, the activation blocker,
// the public shape, and the image re-encode (sharp, in memory). The DB paths are test-badges.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { normalizeBadgeInput, kindConsistencyError, windowOpen, activationBlocker, publicBadge, requirementText, processBadgeImage } = await import('./badges.js');

test('normalizeBadgeInput: a valid create', () => {
  const r = normalizeBadgeInput({
    key: ' Holiday-Champion-2026 ', name: ' Holiday Champion ', kind: 'rule', color: '#FF0000', icon: 'gift',
    rule: { localDate: { from: '2026-12-25', to: '2026-12-25' } }, availableFrom: '2026-12-24T00:00:00Z', availableTo: '2026-12-28T00:00:00Z',
  }, false);
  assert.ok('values' in r, JSON.stringify(r));
  if ('values' in r) {
    assert.equal(r.values.key, 'holiday-champion-2026');
    assert.equal(r.values.name, 'Holiday Champion');
    assert.equal(r.values.color, '#ff0000');
    assert.deepEqual(r.values.rule, { localDate: { from: '2026-12-25', to: '2026-12-25' } });
  }
});

test('normalizeBadgeInput: errors per field', () => {
  const r = normalizeBadgeInput({ key: 'A B', name: '', kind: 'metric', metric: 'nope', threshold: 0, color: 'red', icon: 'Bad Icon!', availableFrom: 'soon' }, false);
  assert.ok('errors' in r);
  if ('errors' in r) {
    for (const k of ['key', 'name', 'metric', 'threshold', 'color', 'icon', 'availableFrom']) assert.ok(r.errors[k], k);
  }
  const noRule = normalizeBadgeInput({ key: 'x-rule', name: 'X', kind: 'rule' }, false);
  assert.ok('errors' in noRule && noRule.errors.rule);
  const window = normalizeBadgeInput({ availableFrom: '2026-12-28T00:00:00Z', availableTo: '2026-12-24T00:00:00Z' }, true);
  assert.ok('errors' in window && window.errors.availableTo);
  const wins = normalizeBadgeInput({ key: 'wins-9', name: 'W', kind: 'metric', metric: 'challenge_wins', threshold: 9 }, false);
  assert.ok('values' in wins, 'a challenge metric is an ordinary metric since phase 3');
});

test('normalizeBadgeInput: a PATCH only carries what was sent', () => {
  const r = normalizeBadgeInput({ threshold: 25 }, true);
  assert.deepEqual('values' in r && r.values, { threshold: 25 });
  assert.equal(kindConsistencyError({ kind: 'metric', metric: null, threshold: 5, rule: null }), 'A metric badge needs a metric and a threshold');
  assert.equal(kindConsistencyError({ kind: 'manual', metric: null, threshold: null, rule: null }), null);
});

test('availability window', () => {
  const now = new Date('2026-12-25T12:00:00Z');
  assert.equal(windowOpen({ availableFrom: null, availableTo: null }, now), true);
  assert.equal(windowOpen({ availableFrom: new Date('2026-12-26T00:00:00Z'), availableTo: null }, now), false);
  assert.equal(windowOpen({ availableFrom: null, availableTo: new Date('2026-12-25T00:00:00Z') }, now), false);
  assert.equal(windowOpen({ availableFrom: new Date('2026-12-24T00:00:00Z'), availableTo: new Date('2026-12-26T00:00:00Z') }, now), true);
});

test('activationBlocker: unknown and invalid configurations; challenge metrics can go live', () => {
  assert.equal(activationBlocker({ kind: 'metric', metric: 'scores_posted', threshold: 10, rule: null }), null);
  for (const metric of ['challenge_wins', 'challenge_losses', 'challenges_tied', 'challenges_abandoned', 'win_streak_achieved', 'loss_streak_achieved', 'challenges_declined', 'challenges_backed_out', 'counters_accepted']) {
    assert.equal(activationBlocker({ kind: 'metric', metric, threshold: 1, rule: null }), null, metric);
  }
  assert.equal(activationBlocker({ kind: 'metric', metric: 'bogus', threshold: 1, rule: null })?.code, 'unknown_metric');
  assert.equal(activationBlocker({ kind: 'rule', metric: null, threshold: null, rule: {} })?.code, 'invalid_rule');
  assert.equal(activationBlocker({ kind: 'manual', metric: null, threshold: null, rule: null }), null);
});

test('publicBadge: no image → null version (icon fallback); no admin internals', () => {
  const row: any = {
    id: 3, key: 'k', name: 'N', description: 'D', icon: 'gift', color: '#ff0000', imageVersion: 4, hasImage: false,
    kind: 'rule', metric: null, threshold: null, rule: { localDate: { from: '2026-12-25', to: '2026-12-25' } }, retroactive: false,
    status: 'live', availableFrom: null, availableTo: null, activatedAt: null, sortOrder: 0, createdById: 1, createdAt: new Date(), updatedAt: new Date(),
  };
  const p = publicBadge(row);
  assert.equal(p.imageVersion, null);
  assert.equal(publicBadge({ ...row, hasImage: true }).imageVersion, 4);
  assert.deepEqual(p.localDate, { from: '2026-12-25', to: '2026-12-25' });
  assert.ok(!('rule' in p) && !('createdById' in p) && !('retroactive' in p));
  assert.equal(requirementText({ kind: 'manual', metric: null, threshold: null, rule: null }), 'Awarded by the TiltTrack team');
});

test('processBadgeImage re-encodes to a 256x256 WebP, padding non-square art', async () => {
  const png = await sharp({ create: { width: 600, height: 300, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const out = await processBadgeImage(png);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  assert.equal(meta.hasAlpha, true);
  await assert.rejects(processBadgeImage(Buffer.from('not an image')));
});
