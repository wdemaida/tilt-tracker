// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/activityRetention.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ACTIVITY_TYPES, logActivity } from './activity.js';
import {
  tierOf, typesInTier, unmappedCatalogTypes, TIER_BY_TYPE, DEFAULT_RETENTION, RETENTION_LIMITS, validateRetentionSettings,
  normalizeRetention, retentionDays, isTierRecorded, planRetention, runBatches, tierSql, naiveUtcToIso,
  setRetentionLoaderForTests, primeRetentionCache, cachedRetentionSettings, isTypeRecorded, type RetentionSettings,
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
  if (v.ok) assert.deepEqual(v.value, { highVolumeDays: 90, standardDays: 365, adminDays: -1 });
});

test('validateRetentionSettings: bounds', () => {
  const ok = (b: object) => validateRetentionSettings({ ...DEFAULT_RETENTION, ...b }).ok;
  for (const f of ['highVolumeDays', 'standardDays', 'adminDays']) {
    assert.ok(ok({ [f]: -1 }), `${f}: -1 = keep forever`);
    assert.ok(ok({ [f]: 0 }), `${f}: 0 = don't record`);
    assert.ok(ok({ [f]: 1 }), `${f}: 1 day`);
    assert.ok(ok({ [f]: 36500 }), `${f}: max`);
    assert.ok(!ok({ [f]: -2 }), `${f}: below -1`);
    assert.ok(!ok({ [f]: -100 }), `${f}: very negative`);
    assert.ok(!ok({ [f]: 36501 }), `${f}: over max`);
    assert.ok(!ok({ [f]: 1.5 }), `${f}: fractional`);
    const bad = validateRetentionSettings({ ...DEFAULT_RETENTION, [f]: -2 });
    assert.ok(!bad.ok);
    if (!bad.ok) assert.match(bad.errors[f as keyof RetentionSettings]!, /-1 \(keep forever\), 0 \(don't record\)/);
  }
});

test('RETENTION_LIMITS describes every tier the same way (the UI reads it)', () => {
  for (const lim of Object.values(RETENTION_LIMITS)) assert.deepEqual({ ...lim }, { min: 1, max: 36500, forever: -1, off: 0 });
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
  assert.ok(!validateRetentionSettings({ highVolumeDays: NaN, standardDays: 365, adminDays: -1 }).ok);
  assert.ok(!validateRetentionSettings({ highVolumeDays: Infinity, standardDays: 365, adminDays: -1 }).ok);
  assert.ok(!validateRetentionSettings({ highVolumeDays: -Infinity, standardDays: 365, adminDays: -1 }).ok);
});

test('normalizeRetention: empty = defaults; bad stored fields fall back one by one', () => {
  assert.deepEqual(normalizeRetention(undefined), DEFAULT_RETENTION);
  assert.deepEqual(normalizeRetention({}), DEFAULT_RETENTION);
  assert.deepEqual(normalizeRetention({ highVolumeDays: 30, standardDays: -2, adminDays: 'x' }), { highVolumeDays: 30, standardDays: 365, adminDays: -1 });
  assert.deepEqual(normalizeRetention({ highVolumeDays: 36501, standardDays: 12.5, adminDays: null }), DEFAULT_RETENTION);
  assert.deepEqual(normalizeRetention({ highVolumeDays: '0', standardDays: '7' }), DEFAULT_RETENTION, 'strings are not numbers');
  assert.deepEqual(normalizeRetention({ highVolumeDays: 14, standardDays: 730, adminDays: 3650 }), { highVolumeDays: 14, standardDays: 730, adminDays: 3650 });
  assert.deepEqual(normalizeRetention({ highVolumeDays: 0, standardDays: 1, adminDays: 0 }), { highVolumeDays: 0, standardDays: 1, adminDays: 0 }, '0 and 1 are valid stored values');
  assert.deepEqual(normalizeRetention({ highVolumeDays: -1, standardDays: -1, adminDays: -1 }), { highVolumeDays: -1, standardDays: -1, adminDays: -1 });
  assert.deepEqual(normalizeRetention('junk'), DEFAULT_RETENTION);
});

test('retentionDays / planRetention: -1 = keep forever (null, skipped), 0 = delete all (cutoff now), N = days', () => {
  assert.equal(retentionDays(DEFAULT_RETENTION, 'admin'), null);
  assert.equal(retentionDays(DEFAULT_RETENTION, 'high_volume'), 90);
  assert.deepEqual(planRetention(DEFAULT_RETENTION), [
    { tier: 'high_volume', days: 90 }, { tier: 'standard', days: 365 }, { tier: 'admin', days: null },
  ]);
  assert.deepEqual(planRetention({ highVolumeDays: 7, standardDays: 30, adminDays: 365 }).map(p => p.days), [7, 30, 365]);
  assert.deepEqual(planRetention({ highVolumeDays: 0, standardDays: -1, adminDays: 0 }).map(p => p.days), [0, null, 0]);
  assert.deepEqual(planRetention({ highVolumeDays: -1, standardDays: 0, adminDays: 1 }).map(p => p.days), [null, 0, 1]);
});

test('isTierRecorded: only 0 turns recording off', () => {
  const s = { highVolumeDays: 0, standardDays: -1, adminDays: 1 };
  assert.equal(isTierRecorded(s, 'high_volume'), false);
  assert.equal(isTierRecorded(s, 'standard'), true);
  assert.equal(isTierRecorded(s, 'admin'), true);
  for (const t of ['high_volume', 'standard', 'admin'] as const) assert.equal(isTierRecorded(DEFAULT_RETENTION, t), true);
});

// -- the settings cache + logActivity's gate ----------------------------------

// A drizzle-executor stand-in (as in activity.test.ts): records inserted rows.
function recordingExecutor() {
  const inserted: any[] = [];
  const ex: any = {
    insert: () => ({ values: (row: any) => ({ onConflictDoNothing: () => ({ returning: async () => { inserted.push(row); return [{ id: inserted.length }]; } }) }) }),
    transaction: async (fn: (sp: any) => Promise<unknown>) => fn(ex),
  };
  return { ex, inserted };
}

test('settings cache: one load per TTL window, shared by concurrent misses; prime replaces it', async () => {
  let loads = 0;
  setRetentionLoaderForTests(async () => { loads++; return { highVolumeDays: 30, standardDays: 0, adminDays: -1 }; });
  try {
    const [a, b] = await Promise.all([cachedRetentionSettings(), cachedRetentionSettings()]);
    assert.deepEqual(a, { highVolumeDays: 30, standardDays: 0, adminDays: -1 });
    assert.equal(a, b);
    await cachedRetentionSettings();
    assert.equal(loads, 1);
    primeRetentionCache({ highVolumeDays: 7, standardDays: 7, adminDays: 7 });
    assert.deepEqual(await cachedRetentionSettings(), { highVolumeDays: 7, standardDays: 7, adminDays: 7 });
    assert.equal(loads, 1, 'primed, not re-read');
  } finally {
    setRetentionLoaderForTests(null);
  }
});

test('settings cache: a failing read falls back to the defaults (record everything), never throws', async () => {
  const warn = console.warn;
  console.warn = () => {};
  setRetentionLoaderForTests(async () => { throw new Error('db down'); });
  try {
    assert.deepEqual(await cachedRetentionSettings(), DEFAULT_RETENTION);
    assert.equal(await isTypeRecorded('score.created'), true);
  } finally {
    console.warn = warn;
    setRetentionLoaderForTests(null);
  }
});

test('logActivity skips events whose tier is set to 0 (and writes the others)', async () => {
  let loads = 0;
  setRetentionLoaderForTests(async () => { loads++; return { highVolumeDays: 90, standardDays: 0, adminDays: -1 }; });
  try {
    const f = recordingExecutor();
    await logActivity({ type: 'score.created' }, { tx: f.ex });            // standard -> off
    await logActivity({ type: 'friend.request_sent' }, { tx: f.ex });      // standard -> off
    await logActivity({ type: 'user.signed_in' }, { tx: f.ex });           // high-volume -> 90 days
    await logActivity({ type: 'admin.user_disabled' }, { tx: f.ex });      // admin -> forever
    assert.deepEqual(f.inserted.map(r => r.type), ['user.signed_in', 'admin.user_disabled']);
    assert.equal(loads, 1, 'one settings read for four events');
    assert.equal(await isTypeRecorded('zz.unknown'), false, 'unknown types are standard, so off too');

    await logActivity({ type: 'score.created' }, { tx: f.ex, always: true });
    assert.equal(f.inserted.at(-1).type, 'score.created', '`always` bypasses the gate');

    primeRetentionCache({ highVolumeDays: 0, standardDays: 365, adminDays: 0 });
    await logActivity({ type: 'score.created' }, { tx: f.ex });
    await logActivity({ type: 'notification.sent' }, { tx: f.ex });
    await logActivity({ type: 'admin.settings_changed' }, { tx: f.ex });
    assert.deepEqual(f.inserted.slice(3).map(r => r.type), ['score.created'], 'a primed change applies at once');
  } finally {
    setRetentionLoaderForTests(null);
  }
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
