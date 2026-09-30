// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/badgeSeries.test.ts   (from artifacts/api-server)
//
// Badge series, the pure rules: tier order, the shared shelf/catalog order, the reorder body's
// validation, collapsing a profile to one item per series with pips, series input and keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  tierCompare, orderBadges, topLevelOrder, tierNumbers, validateOrder, sortOrdersFor, nextSortOrder, collapseShelf, ladderOf,
  normalizeSeriesInput, seriesKeyFor,
} = await import('./badgeSeries.js');
const { normalizeBadgeInput } = await import('./badges.js');

const S = (id: number, sortOrder: number, extra: Partial<{ key: string; name: string; color: string }> = {}) =>
  ({ id, key: extra.key ?? `s${id}`, name: extra.name ?? `Series ${id}`, color: extra.color ?? '#22c55e', sortOrder });
const B = (id: number, o: Partial<{ seriesId: number | null; sortOrder: number; kind: string; threshold: number | null; status: string }> = {}) => ({
  id, seriesId: o.seriesId ?? null, sortOrder: o.sortOrder ?? 0, kind: o.kind ?? 'metric', threshold: o.threshold === undefined ? 1 : o.threshold, status: o.status ?? 'live',
});

// Scores series (1 / 10 / 100 / 1000) at 10; singles at 5 and 20; a Venues series at 30.
const scores = S(1, 10, { key: 'scores', name: 'Scores', color: '#22c55e' });
const venues = S(2, 30, { key: 'venues', name: 'Venues', color: '#14b8a6' });
const t1 = B(11, { seriesId: 1, threshold: 1, sortOrder: 99 });
const t10 = B(12, { seriesId: 1, threshold: 10, sortOrder: 1 });
const t100 = B(13, { seriesId: 1, threshold: 100 });
const t1000 = B(14, { seriesId: 1, threshold: 1000 });
const v5 = B(21, { seriesId: 2, threshold: 5 });
const v25 = B(22, { seriesId: 2, threshold: 25 });
const singleA = B(31, { kind: 'manual', threshold: null, sortOrder: 5 });
const singleB = B(32, { kind: 'rule', threshold: null, sortOrder: 20 });
const all = [t1000, singleB, v25, t10, singleA, t100, v5, t1];

test('tierCompare: metric tiers by threshold (not sort_order), then rule/manual tiers by sort_order', () => {
  assert.deepEqual([t1000, t10, t1, t100].sort(tierCompare).map(b => b.id), [11, 12, 13, 14]);
  const rule2 = B(41, { seriesId: 1, kind: 'rule', threshold: null, sortOrder: 20 });
  const rule1 = B(42, { seriesId: 1, kind: 'manual', threshold: null, sortOrder: 10 });
  assert.deepEqual([rule2, t100, rule1, t1].sort(tierCompare).map(b => b.id), [11, 13, 42, 41]);
});

test('orderBadges: one shared order — series as a unit at its sort_order, singles at theirs, tiers consecutive', () => {
  assert.deepEqual(orderBadges(all, [venues, scores]).map(b => b.id), [31, 11, 12, 13, 14, 32, 21, 22]);
  // A series and a single at the same number: the series first.
  const tie = B(33, { kind: 'manual', threshold: null, sortOrder: 10 });
  assert.deepEqual(orderBadges([tie, t1], [scores]).map(b => b.id), [11, 33]);
  // A badge pointing at a series we don't know is a single (nothing disappears).
  assert.deepEqual(orderBadges([B(50, { seriesId: 999, sortOrder: 1 }), t1], [scores]).map(b => b.id), [50, 11]);
});

test('topLevelOrder: every series (empty ones too) and every single; never a tier', () => {
  const empty = S(3, 40);
  assert.deepEqual(topLevelOrder(all, [scores, venues, empty]), [
    { type: 'badge', id: 31 }, { type: 'series', id: 1 }, { type: 'badge', id: 32 }, { type: 'series', id: 2 }, { type: 'series', id: 3 },
  ]);
});

test('tierNumbers: tier N of the ladder, among the badges given', () => {
  const live = [t1, t10, t100]; // Wizard Mode not live
  const n = tierNumbers(live);
  assert.deepEqual(n.get(12), { tier: 2, tierCount: 3 });
  assert.equal(n.get(31), undefined);
});

test('validateOrder: the full set exactly once; tiers, unknowns, duplicates and stale lists refused', () => {
  const current = topLevelOrder(all, [scores, venues]);
  const ok = validateOrder({ items: [...current].reverse() }, current);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(sortOrdersFor(ok.items).map(i => i.sortOrder), [10, 20, 30, 40]);
  const code = (body: unknown) => { const r = validateOrder(body, current); return r.ok ? 'ok' : r.code; };
  assert.equal(code(null), 'invalid_order');
  assert.equal(code({ items: 'x' }), 'invalid_order');
  assert.equal(code({ items: [{ type: 'tier', id: 1 }] }), 'invalid_order');
  assert.equal(code({ items: [{ type: 'badge', id: 1.5 }] }), 'invalid_order');
  assert.equal(code({ items: [...current, current[0]] }), 'duplicate_item');
  assert.equal(code({ items: [...current.slice(1), { type: 'badge', id: 12 }] }), 'unknown_item', 'a tier can’t be placed on its own');
  assert.equal(code({ items: [...current, { type: 'series', id: 77 }] }), 'unknown_item');
  assert.equal(code({ items: current.slice(1) }), 'order_stale');
});

test('nextSortOrder: after the last item, on the 10s', () => {
  assert.equal(nextSortOrder(null), 10);
  assert.equal(nextSortOrder(240), 250);
  assert.equal(nextSortOrder(245), 250);
  assert.equal(nextSortOrder(-5), 0);
});

const earned = (b: ReturnType<typeof B>, at = '2026-09-01') => ({ ...b, earnedAt: new Date(at) });

test('collapseShelf: a series shows once as its highest earned tier; pips count only live tiers', () => {
  const wizardDraft = { ...t1000, status: 'draft' };
  const tiers = [t1, t10, t100, wizardDraft];
  const items = collapseShelf([earned(t1), earned(t10), earned(singleA), earned(singleB)], tiers, [scores]);
  assert.deepEqual(items.map(i => i.type === 'badge' ? `b${i.badge.id}` : `s${i.series.id}`), ['b31', 's1', 'b32'], 'shared order, not earn order');
  const s = items[1];
  assert.ok(s.type === 'series');
  if (s.type !== 'series') return;
  assert.equal(s.top.id, 12, 'Regular, the highest earned');
  assert.equal(s.tier, 2);
  assert.equal(s.tierCount, 3, 'the draft Wizard Mode is not a pip');
  assert.equal(s.earnedCount, 2);
  assert.deepEqual(s.tiers.map(t => [t.badge.id, !!t.earned]), [[11, true], [12, true], [13, false]]);
  assert.equal(s.series.color, '#22c55e');
});

test('collapseShelf: an earned tier that was since retired still counts (filled), unearned retired ones don’t', () => {
  const retired100 = { ...t100, status: 'retired' };
  const retired1000 = { ...t1000, status: 'retired' };
  const [s] = collapseShelf([earned(t1), earned(retired100)], [t1, t10, retired100, retired1000], [scores]);
  assert.ok(s.type === 'series');
  if (s.type !== 'series') return;
  assert.deepEqual(s.tiers.map(t => t.badge.id), [11, 12, 13]);
  assert.equal(s.top.id, 13);
  assert.equal(s.tier, 3);
  assert.equal(s.earnedCount, 2);
});

test('collapseShelf: the highest earned tier wins even with a gap; an earned tier missing from `tiers` is still shown', () => {
  const [s] = collapseShelf([earned(t100), earned(t1)], [t1, t10, t1000], [scores]);
  assert.ok(s.type === 'series');
  if (s.type !== 'series') return;
  assert.equal(s.top.id, 13);
  assert.deepEqual(s.tiers.map(t => t.badge.id), [11, 12, 13, 14]);
  assert.equal(s.tier, 3);
  assert.equal(s.tierCount, 4);
});

test('collapseShelf: two series and singles interleave by sort_order; nothing earned = nothing shown', () => {
  const items = collapseShelf([earned(v5), earned(singleB), earned(t1), earned(singleA)], [t1, t10, v5, v25], [scores, venues]);
  assert.deepEqual(items.map(i => i.type === 'badge' ? `b${i.badge.id}` : `s${i.series.id}`), ['b31', 's1', 'b32', 's2']);
  assert.deepEqual(collapseShelf([], [t1], [scores]), []);
});

test('ladderOf: live tiers plus the retired ones this viewer earned', () => {
  const r = { ...t100, status: 'retired' };
  assert.deepEqual(ladderOf(1, [t10, r, t1], new Set()).map(b => b.id), [11, 12]);
  assert.deepEqual(ladderOf(1, [t10, r, t1], new Set([13])).map(b => b.id), [11, 12, 13]);
});

test('normalizeSeriesInput and seriesKeyFor', () => {
  assert.deepEqual(normalizeSeriesInput({ name: ' Win streaks ', color: '#EF4444' }, false), { values: { name: 'Win streaks', color: '#ef4444' } });
  const bad = normalizeSeriesInput({ name: '', color: 'red' }, false);
  assert.ok('errors' in bad && bad.errors.name && bad.errors.color);
  assert.deepEqual(normalizeSeriesInput({ color: '#000000' }, true), { values: { color: '#000000' } });
  assert.equal(seriesKeyFor('Win streaks', new Set()), 'win-streaks');
  assert.equal(seriesKeyFor('Win streaks', new Set(['win-streaks', 'win-streaks-2'])), 'win-streaks-3');
  assert.equal(seriesKeyFor('Pokémon!', new Set()), 'pokemon');
  assert.equal(seriesKeyFor('!!!', new Set()), 'series');
});

test('normalizeBadgeInput: seriesId and newSeries', () => {
  const a = normalizeBadgeInput({ seriesId: 3 }, true);
  assert.ok('values' in a && a.values.seriesId === 3);
  const none = normalizeBadgeInput({ seriesId: null }, true);
  assert.ok('values' in none && none.values.seriesId === null);
  const omitted = normalizeBadgeInput({ name: 'x' }, true);
  assert.ok('values' in omitted && !('seriesId' in omitted.values), 'omitted stays omitted (create defaults to the metric’s series)');
  const bad = normalizeBadgeInput({ seriesId: 'x' }, true);
  assert.ok('errors' in bad && bad.errors.seriesId);
  const ns = normalizeBadgeInput({ newSeries: { name: 'Pods', color: '#123456' } }, true);
  assert.ok('values' in ns && ns.values.newSeries?.name === 'Pods');
  const nsBad = normalizeBadgeInput({ newSeries: { name: '', color: 'x' } }, true);
  assert.ok('errors' in nsBad && nsBad.errors.seriesName && nsBad.errors.seriesColor);
  const both = normalizeBadgeInput({ seriesId: 2, newSeries: { name: 'Pods', color: '#123456' } }, true);
  assert.ok('errors' in both && both.errors.seriesId);
});
