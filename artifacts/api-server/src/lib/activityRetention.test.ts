// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/activityRetention.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ACTIVITY_TYPES } from './activity.js';
import {
  tierOf, typesInTier, unmappedCatalogTypes, TIER_BY_TYPE, DEFAULT_RETENTION, validateRetentionSettings,
  normalizeRetention, retentionDays, planRetention, runBatches, tierSql, naiveUtcToIso,
} from './activityRetention.js';

test('every catalogued activity type has an explicit retention tier', () => {
  assert.deepEqual(unmappedCatalogTypes(), []);
  for (const t of Object.values(ACTIVITY_TYPES).flat()) assert.ok(t in TIER_BY_TYPE, t);
});

test('tier mapping: the noisy types are high-volume, admin actions and sign-ups are admin, the rest standard', () => {
  assert.equal(tierOf('user.signed_in'), 'high_volume');
  assert.equal(tierOf('notification.sent'), 'high_volume');
  assert.equal(tierOf('system.challenge_sweep'), 'high_volume');
  assert.equal(tierOf('system.activity_retention'), 'high_volume');
  assert.equal(tierOf('user.signed_up'), 'admin');
  assert.equal(tierOf('user.clerk_deleted'), 'admin');
  for (const t of ACTIVITY_TYPES.admin) assert.equal(tierOf(t), 'admin', t);
  for (const t of [...ACTIVITY_TYPES.score, ...ACTIVITY_TYPES.friend, ...ACTIVITY_TYPES.pod, ...ACTIVITY_TYPES.challenge, ...ACTIVITY_TYPES.venue, ...ACTIVITY_TYPES.pm]) {
    assert.equal(tierOf(t), 'standard', t);
  }
  assert.equal(tierOf('user.first_setup'), 'standard');
});

test('tier mapping: unknown types default to standard, unknown admin.* to admin', () => {
  assert.equal(tierOf('something.new'), 'standard');
  assert.equal(tierOf(''), 'standard');
  assert.equal(tierOf('admin.some_future_action'), 'admin');
});

test('typesInTier partitions the explicit map', () => {
  const all = [...typesInTier('high_volume'), ...typesInTier('standard'), ...typesInTier('admin')].sort();
  assert.deepEqual(all, Object.keys(TIER_BY_TYPE).sort());
});

test('tierSql: built from the same lists (high = ANY list, admin = list or prefix, standard = neither)', () => {
  const dialect = new PgDialect();
  const high = dialect.sqlToQuery(tierSql('high_volume'));
  assert.match(high.sql, /type = ANY\(ARRAY\[/);
  assert.deepEqual(high.params, typesInTier('high_volume'));
  const admin = dialect.sqlToQuery(tierSql('admin'));
  assert.match(admin.sql, /LIKE/);
  assert.ok(admin.params.includes('admin.%'));
  for (const t of typesInTier('admin')) assert.ok(admin.params.includes(t), t);
  const std = dialect.sqlToQuery(tierSql('standard'));
  assert.match(std.sql, /NOT .*AND NOT/);
  for (const t of typesInTier('standard')) assert.ok(!std.params.includes(t), `standard SQL shouldn't list ${t}`);
});

test('validateRetentionSettings: defaults are valid', () => {
  const v = validateRetentionSettings({ ...DEFAULT_RETENTION });
  assert.ok(v.ok);
  if (v.ok) assert.deepEqual(v.value, { highVolumeDays: 90, standardDays: 365, adminDays: 0 });
});

test('validateRetentionSettings: bounds', () => {
  const ok = (b: object) => validateRetentionSettings({ ...DEFAULT_RETENTION, ...b }).ok;
  assert.ok(ok({ highVolumeDays: 7 }));
  assert.ok(ok({ highVolumeDays: 3650 }));
  assert.ok(!ok({ highVolumeDays: 6 }));
  assert.ok(!ok({ highVolumeDays: 3651 }));
  assert.ok(!ok({ highVolumeDays: 0 }), 'high-volume has no keep-forever');
  assert.ok(ok({ standardDays: 30 }));
  assert.ok(!ok({ standardDays: 29 }));
  assert.ok(!ok({ standardDays: 3651 }));
  assert.ok(!ok({ standardDays: 0 }));
  assert.ok(ok({ adminDays: 0 }));
  assert.ok(ok({ adminDays: 365 }));
  assert.ok(ok({ adminDays: 36500 }));
  assert.ok(!ok({ adminDays: 364 }));
  assert.ok(!ok({ adminDays: 1 }));
  assert.ok(!ok({ adminDays: 36501 }));
});

test('validateRetentionSettings: types, missing fields, garbage', () => {
  const bad = validateRetentionSettings({ highVolumeDays: '90', standardDays: 365.5, adminDays: null });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ['adminDays', 'highVolumeDays', 'standardDays']);
  const missing = validateRetentionSettings({ highVolumeDays: 90 });
  assert.ok(!missing.ok);
  if (!missing.ok) assert.match(missing.errors.standardDays!, /required/);
  assert.ok(!validateRetentionSettings(null).ok);
  assert.ok(!validateRetentionSettings('90').ok);
  assert.ok(!validateRetentionSettings({ highVolumeDays: NaN, standardDays: 365, adminDays: 0 }).ok);
  assert.ok(!validateRetentionSettings({ highVolumeDays: Infinity, standardDays: 365, adminDays: 0 }).ok);
});

test('normalizeRetention: empty = defaults; bad stored fields fall back one by one', () => {
  assert.deepEqual(normalizeRetention(undefined), DEFAULT_RETENTION);
  assert.deepEqual(normalizeRetention({}), DEFAULT_RETENTION);
  assert.deepEqual(normalizeRetention({ highVolumeDays: 30, standardDays: 1, adminDays: 'x' }), { highVolumeDays: 30, standardDays: 365, adminDays: 0 });
  assert.deepEqual(normalizeRetention({ highVolumeDays: 14, standardDays: 730, adminDays: 3650 }), { highVolumeDays: 14, standardDays: 730, adminDays: 3650 });
});

test('retentionDays / planRetention: 0 = keep forever (null), tiers in order', () => {
  assert.equal(retentionDays(DEFAULT_RETENTION, 'admin'), null);
  assert.equal(retentionDays(DEFAULT_RETENTION, 'high_volume'), 90);
  assert.deepEqual(planRetention(DEFAULT_RETENTION), [
    { tier: 'high_volume', days: 90 }, { tier: 'standard', days: 365 }, { tier: 'admin', days: null },
  ]);
  assert.deepEqual(planRetention({ highVolumeDays: 7, standardDays: 30, adminDays: 365 }).map(p => p.days), [7, 30, 365]);
});

test('runBatches: loops until a short batch', async () => {
  let remaining = 12_345;
  const calls: number[] = [];
  const r = await runBatches(async limit => { calls.push(limit); const n = Math.min(limit, remaining); remaining -= n; return n; }, 5_000, 200);
  assert.deepEqual(r, { deleted: 12_345, batches: 3, capped: false });
  assert.deepEqual(calls, [5_000, 5_000, 5_000]);
});

test('runBatches: an exact multiple needs one extra (empty) batch to know it is done', async () => {
  let remaining = 10_000;
  const r = await runBatches(async limit => { const n = Math.min(limit, remaining); remaining -= n; return n; }, 5_000, 200);
  assert.deepEqual(r, { deleted: 10_000, batches: 3, capped: false });
});

test('runBatches: nothing to delete = one batch', async () => {
  assert.deepEqual(await runBatches(async () => 0, 5_000, 200), { deleted: 0, batches: 1, capped: false });
});

test('runBatches: stops at the cap and says so', async () => {
  let calls = 0;
  const r = await runBatches(async limit => { calls++; return limit; }, 100, 4);
  assert.deepEqual(r, { deleted: 400, batches: 4, capped: true });
  assert.equal(calls, 4);
});

test('runBatches: an error propagates (the caller records it per tier)', async () => {
  let n = 0;
  await assert.rejects(runBatches(async limit => { if (++n === 2) throw new Error('boom'); return limit; }, 10, 5), /boom/);
});

test('naiveUtcToIso: naive DB strings are UTC; zoned strings and Dates pass through', () => {
  assert.equal(naiveUtcToIso('2026-09-26 12:34:56.789'), '2026-09-26T12:34:56.789Z');
  assert.equal(naiveUtcToIso('2026-09-26 12:34:56'), '2026-09-26T12:34:56.000Z');
  assert.equal(naiveUtcToIso('2026-09-26T12:34:56Z'), '2026-09-26T12:34:56.000Z');
  assert.equal(naiveUtcToIso('2026-09-26 08:34:56-04'), '2026-09-26T12:34:56.000Z');
  assert.equal(naiveUtcToIso(new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z');
  assert.equal(naiveUtcToIso(null), null);
});
