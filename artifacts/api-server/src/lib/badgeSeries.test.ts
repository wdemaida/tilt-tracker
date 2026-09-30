// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/badgeSeries.test.ts   (from artifacts/api-server)
//
// Badge series, the pure rules: tier order (one key, N-tiers seated by threshold), the shared
// shelf/catalog order, both reorder bodies' validation, collapsing a profile to one item per series
// with pips, description templates, "Add tier" prefill, one metric per series, series input and keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  tierCompare, orderBadges, topLevelOrder, tierNumbers, validateOrder, sortOrdersFor, nextSortOrder, collapseShelf, ladderOf,
  normalizeSeriesInput, seriesKeyFor, placeTier, validateTierOrder, tierSortOrders, hasThreshold,
  formatN, renderTemplate, deriveTemplate, deriveSeriesTemplate, nextThreshold, newTierDraft,
  seriesMetric, checkSeriesMetric, seriesMetricConflict,
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
const t1 = B(11, { seriesId: 1, threshold: 1, sortOrder: 10 });
const t10 = B(12, { seriesId: 1, threshold: 10, sortOrder: 20 });
const t100 = B(13, { seriesId: 1, threshold: 100, sortOrder: 30 });
const t1000 = B(14, { seriesId: 1, threshold: 1000, sortOrder: 40 });
const v5 = B(21, { seriesId: 2, threshold: 5, sortOrder: 10 });
const v25 = B(22, { seriesId: 2, threshold: 25, sortOrder: 20 });
const singleA = B(31, { kind: 'manual', threshold: null, sortOrder: 5 });
const singleB = B(32, { kind: 'rule', threshold: null, sortOrder: 20 });
const all = [t1000, singleB, v25, t10, singleA, t100, v5, t1];

test('tierCompare: one key — sort_order, then id — for every kind of tier', () => {
  assert.deepEqual([t1000, t10, t1, t100].sort(tierCompare).map(b => b.id), [11, 12, 13, 14]);
  // A rule tier dragged between 10 and 100 stays there: the mixed ladder reads 1 → 10 → rule → 100.
  const rule = B(41, { seriesId: 1, kind: 'rule', threshold: null, sortOrder: 25 });
  const manual = B(42, { seriesId: 1, kind: 'manual', threshold: null, sortOrder: 5 });
  assert.deepEqual([rule, t100, manual, t1, t10].sort(tierCompare).map(b => b.id), [42, 11, 12, 41, 13]);
  assert.deepEqual([B(2, { sortOrder: 10 }), B(1, { sortOrder: 10 })].sort(tierCompare).map(b => b.id), [1, 2], 'tie → id');
  assert.equal(hasThreshold({ kind: 'metric', threshold: 5 }), true);
  assert.equal(hasThreshold({ kind: 'metric', threshold: null }), false);
  assert.equal(hasThreshold({ kind: 'rule', threshold: 5 }), false);
});

test('placeTier: an N-tier seats before the first higher N; no threshold (or nothing higher) → last', () => {
  const rule = B(41, { seriesId: 1, kind: 'rule', threshold: null, sortOrder: 25 });
  const ladder = [t1, t10, rule, t100, t1000]; // 1, 10, rule, 100, 1000
  assert.deepEqual(placeTier(ladder, { id: 50, kind: 'metric', threshold: 50 }), [11, 12, 41, 50, 13, 14], 'before 100 — after the rule tier between');
  assert.deepEqual(placeTier(ladder, { id: 50, kind: 'metric', threshold: 5 }), [11, 50, 12, 41, 13, 14]);
  assert.deepEqual(placeTier(ladder, { id: 50, kind: 'metric', threshold: 10 }), [11, 12, 41, 50, 13, 14], 'equal N → after it, just before the next higher N');
  assert.deepEqual(placeTier(ladder, { id: 50, kind: 'metric', threshold: 5000 }), [11, 12, 41, 13, 14, 50]);
  assert.deepEqual(placeTier(ladder, { id: 50, kind: 'rule', threshold: null }), [11, 12, 41, 13, 14, 50], 'a rule tier joins at the end');
  assert.deepEqual(placeTier([], { id: 50, kind: 'metric', threshold: 3 }), [50]);
  // Re-seating an existing tier whose N changed (it's in siblings already): moved, not duplicated.
  assert.deepEqual(placeTier(ladder, { id: 12, kind: 'metric', threshold: 500 }), [11, 41, 13, 12, 14]);
  // Unsorted input is fine — siblings are read in tier order.
  assert.deepEqual(placeTier([t1000, rule, t1], { id: 50, kind: 'metric', threshold: 100 }), [11, 41, 50, 14]);
  assert.deepEqual(tierSortOrders([11, 41, 50]), [{ id: 11, sortOrder: 10 }, { id: 41, sortOrder: 20 }, { id: 50, sortOrder: 30 }]);
});

test('validateTierOrder: every tier once; rule/manual anywhere; N-tiers must stay ascending', () => {
  const rule = { ...B(41, { seriesId: 1, kind: 'rule', threshold: null }), name: 'Holiday' };
  const tiers = [{ ...t1, name: 'Ball 1' }, { ...t10, name: 'Regular' }, rule, { ...t100, name: 'Centurion' }];
  const code = (ids: unknown) => { const r = validateTierOrder({ ids }, tiers); return r.ok ? 'ok' : r.code; };
  assert.equal(code([41, 11, 12, 13]), 'ok', 'a rule tier first');
  assert.equal(code([11, 12, 13, 41]), 'ok', 'a rule tier last');
  assert.equal(code([11, 41, 12, 13]), 'ok');
  assert.equal(code([12, 11, 41, 13]), 'threshold_order');
  const r = validateTierOrder({ ids: [11, 13, 41, 12] }, tiers);
  assert.ok(!r.ok && /Regular/.test(r.error) && /Centurion/.test(r.error) && /100/.test(r.error), 'names the tiers');
  assert.equal(code([11, 12, 13]), 'order_stale');
  assert.equal(code([11, 12, 13, 41, 41]), 'duplicate_item');
  assert.equal(code([11, 12, 13, 41, 99]), 'unknown_item');
  assert.equal(code('x'), 'invalid_order');
  assert.equal(code([11, 12, 13, 1.5]), 'invalid_order');
  assert.equal(validateTierOrder(null, tiers).ok, false);
  // Two tiers at the same N may swap.
  const twin = { ...B(15, { seriesId: 1, threshold: 10, sortOrder: 21 }), name: 'Twin' };
  assert.equal(validateTierOrder({ ids: [11, 15, 12, 41, 13] }, [...tiers, twin]).ok, true);
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

test('renderTemplate / deriveTemplate: {N} with thousands separators; one clean match or null', () => {
  assert.equal(formatN(1000), '1,000');
  assert.equal(renderTemplate('Posted {N} scores.', 1000), 'Posted 1,000 scores.');
  assert.equal(renderTemplate('Posted scores at {N} venues.', 50), 'Posted scores at 50 venues.');
  assert.equal(renderTemplate('{N} of {N}', 2500), '2,500 of 2,500');
  assert.equal(deriveTemplate('Posted scores at 5 venues.', 5), 'Posted scores at {N} venues.');
  assert.equal(deriveTemplate('Posted 1,000 scores.', 1000), 'Posted {N} scores.');
  assert.equal(deriveTemplate('Posted 1000 scores.', 1000), 'Posted {N} scores.');
  assert.equal(deriveTemplate('Posted your first score.', 1), null, 'no number');
  assert.equal(deriveTemplate('Posted 10 scores.', 1), null, '1 inside 10 is not a match');
  assert.equal(deriveTemplate('Posted 10 scores.', 0), null);
  assert.equal(deriveTemplate('10 scores at 10 venues', 10), null, 'ambiguous');
  assert.equal(deriveTemplate('Won 5.5 games', 5), null, 'part of a decimal');
  assert.equal(deriveTemplate('Hit 25.', 25), 'Hit {N}.', 'a full stop after the number is fine');
  assert.equal(deriveTemplate('Lost 10 challenges in a row — and came back.', 10), 'Lost {N} challenges in a row — and came back.');
  assert.equal(deriveTemplate('Already {N} and 5', 5), null, 'already a template');
  const tiers = [
    { kind: 'metric', threshold: 10, description: 'Posted 10 scores.' },
    { kind: 'metric', threshold: 1, description: 'Posted your first score.' },
    { kind: 'rule', threshold: null, description: 'Posted 3 on Christmas' },
  ];
  assert.equal(deriveSeriesTemplate(tiers), 'Posted {N} scores.', 'the lowest tier with a clean match');
  assert.equal(deriveSeriesTemplate([{ kind: 'metric', threshold: 5, description: 'Posted scores at 5 venues.' }, { kind: 'metric', threshold: 25, description: 'Globetrotter: 25 venues' }]), 'Posted scores at {N} venues.', 'the lowest wins');
  assert.equal(deriveSeriesTemplate([{ kind: 'rule', threshold: null, description: 'x 5' }]), null);
});

test('nextThreshold: keep the ladder’s last step, rounded to a nice number above the top', () => {
  assert.equal(nextThreshold([1, 10, 100, 1000]), 10_000);
  assert.equal(nextThreshold([5, 25]), 100, '×5 = 125 → 100');
  assert.equal(nextThreshold([10, 50, 100]), 200);
  assert.equal(nextThreshold([3, 10, 25]), 50, '×2.5 = 62.5 → 50');
  assert.equal(nextThreshold([7, 30, 100]), 250);
  assert.equal(nextThreshold([1]), 10, 'one tier at 1 → ×10');
  assert.equal(nextThreshold([25]), 50, 'one tier → ×2');
  assert.equal(nextThreshold([99, 100]), 200, 'a tiny step is clamped to ×1.5 → 150 ≈ 200');
  assert.equal(nextThreshold([1, 1000]), 10_000, 'a huge step is clamped to ×10');
  assert.equal(nextThreshold([2]), 5, 'whole numbers only (no 2.5)');
  assert.equal(nextThreshold([]), null);
  assert.equal(nextThreshold([500_000, 1_000_000]), null, 'nothing above the max');
  assert.equal(nextThreshold([100_000, 600_000]), 1_000_000, 'capped at the max');
  assert.equal(nextThreshold([10, 10, 5]), 20, 'duplicates and order don’t matter');
});

test('newTierDraft: metric series → next N, template description, key; icon from the top tier; rule series → copy', () => {
  const T = (id: number, o: Record<string, any>) => ({ id, seriesId: 3, sortOrder: id * 10, kind: 'metric', threshold: null, key: 'k' + id, metric: 'distinct_venues', rule: null, icon: 'award', description: '', ...o });
  const venuesSeries = { id: 3, color: '#14b8a6', descriptionTemplate: 'Posted scores at {N} venues.' };
  const tiers = [
    T(1, { threshold: 5, key: 'venues-5', icon: 'map-pin', description: 'Posted scores at 5 venues.' }),
    T(2, { threshold: 12, key: 'venues-12', metric: 'scores_posted', description: 'Custom' }), // an odd one out
    T(3, { threshold: 25, key: 'venues-25', icon: 'globe', description: 'Posted scores at 25 venues.' }),
  ];
  const d = newTierDraft(venuesSeries, tiers, new Set(['venues-5', 'venues-25']));
  assert.equal(d.kind, 'metric');
  assert.equal(d.metric, 'distinct_venues', 'the metric most tiers use');
  assert.deepEqual(d.basedOn, [5, 25]);
  assert.equal(d.threshold, 100);
  assert.equal(d.description, 'Posted scores at 100 venues.');
  assert.equal(d.descriptionFrom, 'template');
  assert.equal(d.key, 'venues-100');
  assert.equal(d.icon, 'globe', 'the top tier’s icon');
  assert.equal(d.color, '#14b8a6');
  assert.equal(newTierDraft(venuesSeries, tiers, new Set(['venues-100'])).key, '', 'a taken key is left blank');
  // No template → the base top tier's description, copied.
  const noTpl = newTierDraft({ ...venuesSeries, descriptionTemplate: null }, tiers, new Set());
  assert.equal(noTpl.description, 'Posted scores at 25 venues.');
  assert.equal(noTpl.descriptionFrom, 'copied');
  // A thousands N renders with separators.
  const scores = newTierDraft({ id: 3, color: '#000000', descriptionTemplate: 'Posted {N} scores.' },
    [T(1, { threshold: 100, metric: 'scores_posted', key: 'scores-100' }), T(2, { threshold: 1000, metric: 'scores_posted', key: 'scores-1000' })], new Set());
  assert.equal(scores.threshold, 10_000);
  assert.equal(scores.description, 'Posted 10,000 scores.');
  assert.equal(scores.key, 'scores-10000');
  // A rule series: kind + rule shape + description from its top tier.
  const rule = { machine: { machineId: 7, matchMode: 'group' }, count: 3 };
  const r = newTierDraft({ id: 3, color: '#123456', descriptionTemplate: null },
    [T(1, { kind: 'rule', rule: { count: 1 }, icon: 'gift', description: 'One' }), T(2, { kind: 'rule', rule, icon: 'star', description: 'Three on it' })], new Set());
  assert.deepEqual([r.kind, r.rule, r.icon, r.description, r.threshold, r.metric], ['rule', rule, 'star', 'Three on it', null, null]);
  // A mixed series with a rule tier on top: the metric tiers set kind/N, the top tier the icon.
  const mixed = newTierDraft(venuesSeries, [...tiers, T(9, { kind: 'rule', rule: {}, icon: 'gift', description: 'Holiday' })], new Set());
  assert.equal(mixed.kind, 'metric');
  assert.equal(mixed.icon, 'gift');
  // An empty series: nothing to copy.
  const empty = newTierDraft(venuesSeries, [], new Set());
  assert.deepEqual([empty.kind, empty.icon, empty.description, empty.color], [null, null, '', '#14b8a6']);
  // Tiers of another series passed in are ignored.
  assert.equal(newTierDraft({ ...venuesSeries, id: 4 }, tiers, new Set()).kind, null);
});

test('seriesMetric: the metric tiers’ metric; excludes the badge checked; rule/manual tiers don’t count', () => {
  const M = (id: number, metric: string | null, o: Partial<{ kind: string; threshold: number | null; sortOrder: number }> = {}) =>
    ({ id, seriesId: 5, sortOrder: o.sortOrder ?? id * 10, kind: o.kind ?? 'metric', threshold: o.threshold === undefined ? id : o.threshold, metric, name: `T${id}` });
  assert.equal(seriesMetric([]), null, 'an empty series has no metric');
  assert.equal(seriesMetric([M(1, null, { kind: 'rule', threshold: null }), M(2, null, { kind: 'manual', threshold: null })]), null, 'only rule/manual tiers → none');
  assert.equal(seriesMetric([M(1, 'distinct_venues'), M(2, 'distinct_venues')]), 'distinct_venues');
  assert.equal(seriesMetric([M(1, 'distinct_venues')], 1), null, 'its only metric tier, excluded → any metric may be first');
  // Existing disagreement: the majority, a tie → the highest tier's (last in tier order).
  assert.equal(seriesMetric([M(1, 'distinct_venues'), M(2, 'scores_posted'), M(3, 'distinct_venues')]), 'distinct_venues');
  assert.equal(seriesMetric([M(1, 'distinct_venues'), M(2, 'scores_posted')]), 'scores_posted');
  assert.equal(seriesMetric([M(1, 'distinct_venues', { sortOrder: 20 }), M(2, 'scores_posted', { sortOrder: 10 })]), 'distinct_venues', 'tier order, not id');
});

test('checkSeriesMetric: refuses a metric tier on another metric; rule/manual and first tiers pass', () => {
  const M = (id: number, metric: string | null, o: Partial<{ kind: string; threshold: number | null }> = {}) =>
    ({ id, seriesId: 5, sortOrder: id * 10, kind: o.kind ?? 'metric', threshold: o.threshold === undefined ? id * 5 : o.threshold, metric, name: `T${id}` });
  const venuesTiers = [M(1, 'distinct_venues'), M(2, 'distinct_venues'), M(3, null, { kind: 'rule', threshold: null })];
  const label = (m: string) => ({ distinct_venues: 'Different venues', scores_posted: 'Scores posted' } as Record<string, string>)[m] ?? m;
  // New tier (id 99), same metric → fine; another metric → refused, naming the series' metric.
  assert.equal(checkSeriesMetric(venuesTiers, { id: 99, kind: 'metric', threshold: 100, metric: 'distinct_venues' }, 'Venues', label), null);
  const bad = checkSeriesMetric(venuesTiers, { id: 99, kind: 'metric', threshold: 12, metric: 'scores_posted' }, 'Venues', label);
  assert.ok(bad);
  assert.equal(bad!.code, 'series_metric_mismatch');
  assert.equal(bad!.seriesMetric, 'distinct_venues');
  assert.equal(bad!.seriesMetricLabel, 'Different venues');
  assert.match(bad!.error, /All tiers in “Venues” count Different venues — this one counts Scores posted/);
  // Rule / manual tiers (no threshold) are unaffected.
  assert.equal(checkSeriesMetric(venuesTiers, { id: 99, kind: 'rule', threshold: null, metric: null }, 'Venues'), null);
  assert.equal(checkSeriesMetric(venuesTiers, { id: 99, kind: 'manual', threshold: null, metric: null }, 'Venues'), null);
  // A series with no metric tier accepts any metric for its first one.
  assert.equal(checkSeriesMetric([M(3, null, { kind: 'rule', threshold: null })], { id: 99, kind: 'metric', threshold: 1, metric: 'login_days' }, 'Holidays'), null);
  assert.equal(checkSeriesMetric([], { id: 99, kind: 'metric', threshold: 1, metric: 'login_days' }, 'Empty'), null);
  // Editing a tier already in the series: its own row is ignored. The only metric tier may change
  // metric; one of two may not.
  assert.equal(checkSeriesMetric([M(1, 'distinct_venues')], { id: 1, kind: 'metric', threshold: 5, metric: 'scores_posted' }, 'Venues'), null);
  assert.ok(checkSeriesMetric(venuesTiers, { id: 1, kind: 'metric', threshold: 5, metric: 'scores_posted' }, 'Venues'));
  // Fixing dev's Traveler: its siblings all count distinct_venues → switching it to that passes.
  const withTraveler = [...venuesTiers, M(4, 'scores_posted')];
  assert.equal(checkSeriesMetric(withTraveler, { id: 4, kind: 'metric', threshold: 12, metric: 'distinct_venues' }, 'Venues'), null);
  assert.ok(checkSeriesMetric(withTraveler, { id: 4, kind: 'metric', threshold: 12, metric: 'scores_posted' }, 'Venues'));
});

test('seriesMetricConflict: reports tiers that already disagree, with the fix; consistent series → null', () => {
  const M = (id: number, metric: string | null, name: string, o: Partial<{ kind: string; threshold: number | null }> = {}) =>
    ({ id, seriesId: 5, sortOrder: id * 10, kind: o.kind ?? 'metric', threshold: o.threshold === undefined ? id * 5 : o.threshold, metric, name });
  const label = (m: string) => ({ distinct_venues: 'Different venues', scores_posted: 'Scores posted' } as Record<string, string>)[m] ?? m;
  assert.equal(seriesMetricConflict([], 'Empty'), null);
  assert.equal(seriesMetricConflict([M(1, 'distinct_venues', 'A'), M(2, 'distinct_venues', 'B'), M(3, null, 'Holiday', { kind: 'rule', threshold: null })], 'Venues'), null);
  const c = seriesMetricConflict([M(1, 'distinct_venues', 'Explorer'), M(2, 'scores_posted', 'Traveler'), M(3, 'distinct_venues', 'Globetrotter')], 'Venues', label);
  assert.ok(c);
  assert.equal(c!.seriesMetric, 'distinct_venues');
  assert.deepEqual(c!.offenders, [{ id: 2, name: 'Traveler', metric: 'scores_posted', label: 'Scores posted' }]);
  assert.deepEqual(c!.metrics.map(m => [m.metric, m.badges.map(b => b.name)]), [['distinct_venues', ['Explorer', 'Globetrotter']], ['scores_posted', ['Traveler']]]);
  assert.match(c!.message, /goes by Different venues, but “Traveler” \(Scores posted\) doesn’t\. Change its metric to Different venues/);
  assert.match(c!.message, /move it out of the series/);
});

test('newTierDraft follows seriesMetric (one metric per series)', () => {
  const T = (id: number, o: Record<string, any>) => ({ id, seriesId: 3, sortOrder: id * 10, kind: 'metric', threshold: null, key: 'k' + id, metric: 'distinct_venues', rule: null, icon: 'award', description: '', ...o });
  const tiers = [T(1, { threshold: 5 }), T(2, { threshold: 12, metric: 'scores_posted' }), T(3, { threshold: 25 })];
  assert.equal(newTierDraft({ id: 3, color: '#000000', descriptionTemplate: null }, tiers, new Set()).metric, seriesMetric(tiers));
});

test('normalizeSeriesInput and seriesKeyFor', () => {
  assert.deepEqual(normalizeSeriesInput({ name: ' Win streaks ', color: '#EF4444' }, false), { values: { name: 'Win streaks', color: '#ef4444' } });
  const bad = normalizeSeriesInput({ name: '', color: 'red' }, false);
  assert.ok('errors' in bad && bad.errors.name && bad.errors.color);
  assert.deepEqual(normalizeSeriesInput({ color: '#000000' }, true), { values: { color: '#000000' } });
  assert.deepEqual(normalizeSeriesInput({ descriptionTemplate: ' Posted {N} scores. ' }, true), { values: { descriptionTemplate: 'Posted {N} scores.' } });
  assert.deepEqual(normalizeSeriesInput({ descriptionTemplate: '' }, true), { values: { descriptionTemplate: null } }, 'empty clears it');
  assert.deepEqual(normalizeSeriesInput({ descriptionTemplate: null }, true), { values: { descriptionTemplate: null } });
  const noN = normalizeSeriesInput({ descriptionTemplate: 'Posted scores.' }, true);
  assert.ok('errors' in noN && /\{N\}/.test(noN.errors.descriptionTemplate));
  const long = normalizeSeriesInput({ descriptionTemplate: '{N}' + 'x'.repeat(300) }, true);
  assert.ok('errors' in long && long.errors.descriptionTemplate);
  const nonString = normalizeSeriesInput({ descriptionTemplate: 5 }, true);
  assert.ok('errors' in nonString && nonString.errors.descriptionTemplate);
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
