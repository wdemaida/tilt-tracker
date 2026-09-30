// Badge series — the pure rules (feature/badge-series, migrate25). Unit-tested in badgeSeries.test.ts;
// badges.ts and routes/adminBadges.ts load the rows and apply these.
//
// A series is a ladder of tiers ("Scores": First Ball 1 → Regular 10 → Centurion 100 → Wizard Mode
// 1,000). One ordering space holds whole series (badge_series.sort_order) and single badges
// (badges.sort_order); the profile shelf, the /badges catalog and /admin/badges all read it.
//
// Inside a series there is ONE ordering key too: each tier's badges.sort_order (10, 20, 30, … within
// the series). A tier with a threshold (a metric tier) is *placed* by it — creating it, changing its
// N or moving it into a series slots it just before the first sibling with a higher N (placeTier) —
// and the in-series reorder refuses any order that puts a higher N before a lower one
// (validateTierOrder). A tier without one (rule/manual) goes wherever the admin drags it, so a mixed
// ladder can read "1 → 10 → Holiday special → 100". migrate25 renumbered the existing series once,
// into the order they showed before this rule (metric tiers by threshold, then the rest).
//
//   placeTier / validateTierOrder / tierSortOrders   the in-series order (above)
//   renderTemplate / deriveTemplate                  badge_series.description_template ("Posted {N} scores.")
//   nextThreshold / newTierDraft                     "Add tier": the new tier's prefill
//   seriesMetric / checkSeriesMetric                 one metric per series (400 series_metric_mismatch)
//   seriesMetricConflict                             existing data that disagrees → admin warning
//
//   orderBadges        every badge in the shared order, each series' tiers together (catalog, admin list)
//   topLevelOrder      the draggable items: every series (even an empty one) and every single badge
//   validateOrder      the reorder endpoint's body must be exactly that set, once each
//   collapseShelf      a profile: one item per series (its highest earned tier + pips) and each single
//   ladderOf           a series' tiers for one viewer: live tiers + any retired one they earned

export interface SeriesRef { id: number; key: string; name: string; color: string; sortOrder: number; descriptionTemplate?: string | null }

export interface OrderableBadge {
  id: number;
  seriesId: number | null;
  sortOrder: number;
  kind: string;
  threshold: number | null;
}

export type TopItem = { type: 'series'; id: number } | { type: 'badge'; id: number };

/** A tier ordered by its N: a metric badge with a threshold. Rule/manual tiers are placed by hand. */
export const hasThreshold = (b: Pick<OrderableBadge, 'kind' | 'threshold'>): boolean => b.kind === 'metric' && b.threshold != null;

/** Tier order inside one series: the one key, sort_order (then id). Writes keep N-tiers ascending. */
export function tierCompare(a: OrderableBadge, b: OrderableBadge): number {
  return a.sortOrder - b.sortOrder || a.id - b.id;
}

/**
 * Where a tier goes when it joins a series or its N changes: the series' tier ids in their new order.
 * A tier with a threshold goes just before the first sibling with a higher N (so after any equal
 * one); with no higher sibling, or no threshold, it goes last. The caller renumbers 10, 20, 30, …
 */
export function placeTier(siblings: OrderableBadge[], badge: Pick<OrderableBadge, 'id' | 'kind' | 'threshold'>): number[] {
  const rest = siblings.filter(t => t.id !== badge.id).sort(tierCompare);
  let at = rest.length;
  if (hasThreshold(badge)) {
    const i = rest.findIndex(t => hasThreshold(t) && t.threshold! > badge.threshold!);
    if (i >= 0) at = i;
  }
  const ids = rest.map(t => t.id);
  ids.splice(at, 0, badge.id);
  return ids;
}

export type TierOrderCheck = { ok: true; ids: number[] } | { ok: false; code: string; error: string };

/**
 * The body of PUT /badge-series/:id/order: `{ ids }`, every tier of the series exactly once, and the
 * tiers with a threshold still in ascending N (the others can go anywhere).
 */
export function validateTierOrder(body: unknown, tiers: Array<Pick<OrderableBadge, 'id' | 'kind' | 'threshold'> & { name?: string }>): TierOrderCheck {
  const raw = (body && typeof body === 'object' ? (body as any).ids : undefined) as unknown;
  if (!Array.isArray(raw) || raw.length > 1000 || !raw.every(id => Number.isSafeInteger(id) && id > 0)) {
    return { ok: false, code: 'invalid_order', error: 'Send { ids: [badgeId, …] } — every tier of the series, in the new order' };
  }
  const ids = raw as number[];
  const byId = new Map(tiers.map(t => [t.id, t]));
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) return { ok: false, code: 'duplicate_item', error: `Badge ${id} is listed twice` };
    seen.add(id);
    if (!byId.has(id)) return { ok: false, code: 'unknown_item', error: `Badge ${id} isn’t a tier of this series` };
  }
  if (seen.size !== byId.size) return { ok: false, code: 'order_stale', error: 'The list is missing tiers — reload and try again' };
  let last: { threshold: number; name?: string } | null = null;
  for (const id of ids) {
    const t = byId.get(id)!;
    if (!hasThreshold(t)) continue;
    if (last && t.threshold! < last.threshold) {
      return {
        ok: false, code: 'threshold_order',
        error: `Tiers with a threshold stay in N order — “${t.name ?? `badge ${t.id}`}” (${formatN(t.threshold!)}) can’t come after “${last.name ?? 'a tier'}” (${formatN(last.threshold)})`,
      };
    }
    last = { threshold: t.threshold!, name: t.name };
  }
  return { ok: true, ids };
}

/** sort_order values for a series' tiers, in order: 10, 20, 30, … */
export function tierSortOrders(ids: number[]): Array<{ id: number; sortOrder: number }> {
  return ids.map((id, i) => ({ id, sortOrder: (i + 1) * 10 }));
}

interface Slot { type: 'series' | 'badge'; id: number; sortOrder: number }

/** Top-level order: sort_order, then a series before a single at the same number, then id. */
function slotCompare(a: Slot, b: Slot): number {
  return a.sortOrder - b.sortOrder || (a.type === b.type ? 0 : a.type === 'series' ? -1 : 1) || a.id - b.id;
}

/**
 * A badge whose series isn't in `series` (a dangling id — shouldn't happen with the FK) is treated as
 * a single, so nothing ever disappears from a list.
 */
function slotsOf<B extends OrderableBadge>(badges: B[], series: SeriesRef[], includeEmptySeries: boolean): Slot[] {
  const known = new Map(series.map(s => [s.id, s]));
  const used = new Set<number>();
  const slots: Slot[] = [];
  for (const b of badges) {
    if (b.seriesId != null && known.has(b.seriesId)) used.add(b.seriesId);
    else slots.push({ type: 'badge', id: b.id, sortOrder: b.sortOrder });
  }
  for (const s of series) if (includeEmptySeries || used.has(s.id)) slots.push({ type: 'series', id: s.id, sortOrder: s.sortOrder });
  return slots.sort(slotCompare);
}

/** The draggable items of /admin/badges, in order: every series (empty ones too) and every single. */
export function topLevelOrder<B extends OrderableBadge>(badges: B[], series: SeriesRef[]): TopItem[] {
  return slotsOf(badges, series, true).map(s => ({ type: s.type, id: s.id }) as TopItem);
}

/** Every badge in the shared order, each series' tiers consecutive and in tier order. */
export function orderBadges<B extends OrderableBadge>(badges: B[], series: SeriesRef[]): B[] {
  const known = new Set(series.map(s => s.id));
  const bySeries = new Map<number, B[]>();
  const byId = new Map(badges.map(b => [b.id, b]));
  for (const b of badges) {
    if (b.seriesId != null && known.has(b.seriesId)) bySeries.set(b.seriesId, [...(bySeries.get(b.seriesId) ?? []), b]);
  }
  const out: B[] = [];
  for (const slot of slotsOf(badges, series, false)) {
    if (slot.type === 'badge') out.push(byId.get(slot.id)!);
    else out.push(...(bySeries.get(slot.id) ?? []).sort(tierCompare));
  }
  return out;
}

/** Tier numbers (1-based) and the ladder length for each badge in a series, among `badges` only. */
export function tierNumbers<B extends OrderableBadge>(badges: B[]): Map<number, { tier: number; tierCount: number }> {
  const bySeries = new Map<number, B[]>();
  for (const b of badges) if (b.seriesId != null) bySeries.set(b.seriesId, [...(bySeries.get(b.seriesId) ?? []), b]);
  const out = new Map<number, { tier: number; tierCount: number }>();
  for (const list of bySeries.values()) {
    list.sort(tierCompare).forEach((b, i) => out.set(b.id, { tier: i + 1, tierCount: list.length }));
  }
  return out;
}

export type OrderCheck = { ok: true; items: TopItem[] } | { ok: false; code: string; error: string };

/**
 * The reorder body must list every top-level item exactly once — no unknown ids, no duplicates, no
 * omissions (a list from a stale page is refused rather than half-applied). Tiers can't be listed:
 * they follow the series.
 */
export function validateOrder(body: unknown, current: TopItem[]): OrderCheck {
  const raw = (body && typeof body === 'object' ? (body as any).items : undefined) as unknown;
  if (!Array.isArray(raw) || raw.length > 10_000) return { ok: false, code: 'invalid_order', error: 'Send { items: [{ type, id }] } in the new order' };
  const items: TopItem[] = [];
  for (const it of raw) {
    const type = it && typeof it === 'object' ? (it as any).type : undefined;
    const id = it && typeof it === 'object' ? (it as any).id : undefined;
    if ((type !== 'series' && type !== 'badge') || !Number.isSafeInteger(id) || id <= 0) {
      return { ok: false, code: 'invalid_order', error: 'Each item is { type: "series" | "badge", id }' };
    }
    items.push({ type, id });
  }
  const k = (i: TopItem) => `${i.type}:${i.id}`;
  const want = new Set(current.map(k));
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(k(i))) return { ok: false, code: 'duplicate_item', error: `${i.type} ${i.id} is listed twice` };
    seen.add(k(i));
    if (!want.has(k(i))) {
      return i.type === 'badge'
        ? { ok: false, code: 'unknown_item', error: `Badge ${i.id} doesn’t exist or is a tier of a series (tiers follow their series)` }
        : { ok: false, code: 'unknown_item', error: `Series ${i.id} doesn’t exist` };
    }
  }
  if (seen.size !== want.size) return { ok: false, code: 'order_stale', error: 'The list is missing badges — reload and try again' };
  return { ok: true, items };
}

/** sort_order values for a validated order: 10, 20, 30, … */
export function sortOrdersFor(items: TopItem[]): Array<TopItem & { sortOrder: number }> {
  return items.map((it, i) => ({ ...it, sortOrder: (i + 1) * 10 }));
}

/** Where a new single (or a new series) goes: after the last item. */
export function nextSortOrder(maxExisting: number | null): number {
  return maxExisting == null ? 10 : Math.floor(maxExisting / 10) * 10 + 10;
}

// ── the profile shelf ────────────────────────────────────────────────────────

export interface LadderBadge extends OrderableBadge { status: string }

/** A series' tiers as one viewer sees them: the live tiers plus any other tier they earned (a retired one). */
export function ladderOf<B extends LadderBadge>(seriesId: number, tiers: B[], earned: Set<number>): B[] {
  return tiers.filter(t => t.seriesId === seriesId && (t.status === 'live' || earned.has(t.id))).sort(tierCompare);
}

export type ShelfItem<E, B> =
  | { type: 'badge'; badge: E }
  | {
    type: 'series';
    series: Omit<SeriesRef, 'sortOrder'>;
    /** The highest tier they've earned (what the shelf draws). */
    top: E;
    /** 1-based position of `top` in the ladder, and the ladder's length ("Tier 2 of 4"). */
    tier: number;
    tierCount: number;
    /** Pips: filled = earned tiers, hollow = the remaining live tiers. */
    earnedCount: number;
    /** The whole ladder, lowest first, each with the viewer's earn date (null = not yet). */
    tiers: Array<{ badge: B; earned: E | null }>;
  };

/**
 * Collapse a user's earned badges for the profile: a series shows once, as its highest earned tier
 * with pips, in the shared order; singles as they are. `earned` = their awards (badge rows with the
 * earn fields); `tiers` = every badge of the series they've earned anything in (any status); a
 * tier's ladder position counts only live tiers and the ones they earned.
 */
export function collapseShelf<E extends OrderableBadge, B extends LadderBadge>(earned: E[], tiers: B[], series: SeriesRef[]): Array<ShelfItem<E, B>> {
  const byId = new Map(series.map(s => [s.id, s]));
  const earnedIds = new Set(earned.map(e => e.id));
  const earnedById = new Map(earned.map(e => [e.id, e]));
  const inSeries = new Map<number, E[]>();
  const slots: Array<{ slot: Slot; item: ShelfItem<E, B> }> = [];
  for (const e of earned) {
    if (e.seriesId != null && byId.has(e.seriesId)) inSeries.set(e.seriesId, [...(inSeries.get(e.seriesId) ?? []), e]);
    else slots.push({ slot: { type: 'badge', id: e.id, sortOrder: e.sortOrder }, item: { type: 'badge', badge: e } });
  }
  for (const [sid, mine] of inSeries) {
    const s = byId.get(sid)!;
    // The ladder always includes what they earned, even if `tiers` came back without it.
    const pool = new Map<number, B | E>(tiers.filter(t => t.seriesId === sid).map(t => [t.id, t]));
    for (const e of mine) if (!pool.has(e.id)) pool.set(e.id, e);
    const ladder = [...pool.values()]
      .filter(t => earnedIds.has(t.id) || (t as LadderBadge).status === 'live')
      .sort(tierCompare) as B[];
    let topIdx = -1;
    ladder.forEach((t, i) => { if (earnedIds.has(t.id)) topIdx = i; });
    const top = earnedById.get(ladder[topIdx].id)!;
    slots.push({
      slot: { type: 'series', id: sid, sortOrder: s.sortOrder },
      item: {
        type: 'series',
        series: { id: s.id, key: s.key, name: s.name, color: s.color },
        top,
        tier: topIdx + 1,
        tierCount: ladder.length,
        earnedCount: ladder.filter(t => earnedIds.has(t.id)).length,
        tiers: ladder.map(t => ({ badge: t, earned: earnedById.get(t.id) ?? null })),
      },
    });
  }
  return slots.sort((a, b) => slotCompare(a.slot, b.slot)).map(x => x.item);
}

// ── description templates + "Add tier" ──────────────────────────────────────

/** The placeholder in badge_series.description_template. */
export const N_TOKEN = '{N}';

/** A tier's N as descriptions write it: 1,000 (en-US thousands separators). */
export const formatN = (n: number): string => n.toLocaleString('en-US');

/** "Posted {N} scores." + 1000 → "Posted 1,000 scores." */
export function renderTemplate(template: string, n: number): string {
  return template.split(N_TOKEN).join(formatN(n));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A template from one tier's description: its threshold, written "1,000" or "1000", replaced by {N}
 * — only when the number appears exactly once as a whole number ("Posted 10 scores." at N=1 has no
 * match; "10 of 10" is ambiguous). null = no clean match.
 */
export function deriveTemplate(description: string, threshold: number): string | null {
  if (!description || description.includes(N_TOKEN) || !Number.isSafeInteger(threshold) || threshold < 1) return null;
  const forms = [...new Set([formatN(threshold), String(threshold)])].map(escapeRe).join('|');
  const re = new RegExp(`(?<![\\d.,])(?:${forms})(?![\\d]|[.,]\\d)`, 'g');
  const hits = description.match(re);
  return hits?.length === 1 ? description.replace(re, N_TOKEN) : null;
}

/**
 * A series' template from its tiers: the lowest tier with a threshold whose description yields one
 * (deriveTemplate). The lowest usually does; "Posted your first score." (N=1) doesn't, so the next
 * one ("Posted 10 scores.") is used. null = none of them do.
 */
export function deriveSeriesTemplate(tiers: Array<Pick<OrderableBadge, 'kind' | 'threshold'> & { description: string }>): string | null {
  const byN = tiers.filter(hasThreshold).sort((a, b) => a.threshold! - b.threshold!);
  for (const t of byN) {
    const tpl = deriveTemplate(t.description, t.threshold!);
    if (tpl) return tpl;
  }
  return null;
}

const NICE_MANTISSAS = [1, 2, 2.5, 5];

/**
 * A suggested N for the next tier above `thresholds` (a ladder's Ns). Keep the ladder's last step:
 * ratio = highest / second-highest, clamped to 1.5×–10× (one tier: ×10 above 1, else ×2); aim for
 * highest × ratio, rounded to the nearest "nice" number (1, 2, 2.5 or 5 × a power of ten, whole
 * numbers only) on a log scale, always above the highest. 1/10/100/1,000 → 10,000; 5/25 → 100
 * (×5 = 125 ≈ 100); 10/50/100 → 200; 3/10/25 → 50; 7/30/100 → 250. null = nothing above `max`.
 */
export function nextThreshold(thresholds: number[], max = 1_000_000): number | null {
  const t = [...new Set(thresholds.filter(n => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
  if (!t.length) return null;
  const top = t[t.length - 1];
  if (top >= max) return null;
  const prev = t.length > 1 ? t[t.length - 2] : null;
  const ratio = Math.min(10, Math.max(1.5, prev ? top / prev : top === 1 ? 10 : 2));
  const target = top * ratio;
  const nice: number[] = [];
  for (let p = 1; p <= max * 10; p *= 10) {
    for (const m of NICE_MANTISSAS) {
      const v = m * p;
      if (Number.isInteger(v) && v > top && v <= max) nice.push(v);
    }
  }
  if (!nice.length) return max;
  return nice.reduce((best, v) => (Math.abs(Math.log(v / target)) < Math.abs(Math.log(best / target)) ? v : best));
}

export interface TierBasis extends OrderableBadge {
  key: string; metric: string | null; rule: unknown; icon: string; description: string;
}

export interface NewTierDraft {
  seriesId: number;
  /** null = an empty series: nothing to copy, the editor keeps its defaults. */
  kind: 'metric' | 'rule' | 'manual' | null;
  metric: string | null;
  threshold: number | null;
  rule: unknown;
  icon: string | null;
  color: string;
  description: string;
  /** Where `description` came from: the series template with the new N, a tier's copy, or nothing. */
  descriptionFrom: 'template' | 'copied' | 'none';
  /** Suggested from the base tier's key ("venues-25" → "venues-100") when free; else ''. */
  key: string;
  /** The N the suggestion stepped up from (the base metric's tiers), for the editor's hint. */
  basedOn: number[];
}

/**
 * "Add tier" on a series: the new badge's prefill. Kind + metric from the series' tiers — when it has
 * tiers with a threshold, a metric tier on the metric most of them use (a tie → the highest tier's),
 * N = nextThreshold of that metric's Ns; otherwise its top tier's kind (+ rule shape for a rule). Icon
 * from the top tier (the last in tier order), color = the series color, description = the template
 * with the new N, else the base tier's description copied. Name is left for the admin.
 */
export function newTierDraft(
  series: { id: number; color: string; descriptionTemplate: string | null },
  tiers: TierBasis[],
  takenKeys: Set<string>,
  maxThreshold = 1_000_000,
): NewTierDraft {
  const ordered = tiers.filter(t => t.seriesId === series.id).sort(tierCompare);
  const top = ordered[ordered.length - 1];
  const draft: NewTierDraft = {
    seriesId: series.id, kind: null, metric: null, threshold: null, rule: null, icon: top?.icon ?? null, color: series.color,
    description: '', descriptionFrom: 'none', key: '', basedOn: [],
  };
  if (!top) return draft;
  const withN = ordered.filter(hasThreshold);
  const metric = seriesMetric(ordered);
  if (withN.length && metric) {
    // One metric per series (checkSeriesMetric): the new tier counts the series' metric.
    const base = withN.filter(t => t.metric === metric);
    const baseTop = base.reduce((a, b) => (b.threshold! >= a.threshold! ? b : a));
    const n = nextThreshold(base.map(t => t.threshold!), maxThreshold);
    Object.assign(draft, { kind: 'metric', metric, threshold: n, basedOn: base.map(t => t.threshold!).sort((a, b) => a - b) });
    if (n != null && series.descriptionTemplate?.includes(N_TOKEN)) {
      Object.assign(draft, { description: renderTemplate(series.descriptionTemplate, n), descriptionFrom: 'template' });
    } else if (baseTop.description) {
      Object.assign(draft, { description: baseTop.description, descriptionFrom: 'copied' });
    }
    const suffix = `-${baseTop.threshold}`;
    if (n != null && baseTop.key.endsWith(suffix)) {
      const key = `${baseTop.key.slice(0, -suffix.length)}-${n}`;
      if (!takenKeys.has(key)) draft.key = key;
    }
    return draft;
  }
  Object.assign(draft, {
    kind: top.kind as NewTierDraft['kind'], rule: top.kind === 'rule' ? top.rule ?? null : null,
    description: top.description, descriptionFrom: top.description ? 'copied' : 'none',
  });
  return draft;
}

// ── one metric per series ───────────────────────────────────────────────────
//
// Every tier with a threshold in a series counts the SAME metric (Will, 2026-09-30 — dev's
// "Traveler" (venues-12) sat in Venues but counted scores_posted). The series' metric is the metric
// of its metric tiers; a series with none accepts any metric for its first one. Rule/manual tiers
// have no threshold and are unaffected. Create/PATCH refuse a metric tier whose metric differs
// (400 series_metric_mismatch — checkSeriesMetric); data that already disagrees is never changed
// automatically, only reported (seriesMetricConflict → the admin list's warning).

export interface MetricTier extends OrderableBadge { metric: string | null; name?: string }

/**
 * The metric a series' tiers count: the metric of its tiers with a threshold, excluding `excludeId`
 * (the badge being checked, so its own current metric never decides). When they already disagree
 * (data from before the rule), the one most of them use, a tie → the highest tier's (the last in
 * tier order) — the same pick as "Add tier". null = no metric tier (any metric may be first).
 */
export function seriesMetric(tiers: MetricTier[], excludeId?: number): string | null {
  const withN = tiers.filter(t => t.id !== excludeId && hasThreshold(t) && t.metric).sort(tierCompare);
  if (!withN.length) return null;
  const count = new Map<string, number>();
  for (const t of withN) count.set(t.metric!, (count.get(t.metric!) ?? 0) + 1);
  const most = Math.max(...count.values());
  return [...withN].reverse().find(t => count.get(t.metric!) === most)!.metric!;
}

export interface SeriesMetricMismatch {
  code: 'series_metric_mismatch';
  error: string;
  seriesMetric: string;
  seriesMetricLabel: string;
}

/**
 * Whether `badge` may be a tier of the series whose tiers are `tiers` (its own row, if listed, is
 * ignored). null = fine: it has no threshold, the series has no metric tier yet, or it counts the
 * series' metric. `label` turns a metric key into its admin label.
 */
export function checkSeriesMetric(
  tiers: MetricTier[],
  badge: Pick<MetricTier, 'id' | 'kind' | 'threshold' | 'metric'>,
  seriesName: string,
  label: (metric: string) => string = m => m,
): SeriesMetricMismatch | null {
  if (!hasThreshold(badge)) return null;
  const want = seriesMetric(tiers, badge.id);
  if (want == null || want === badge.metric) return null;
  const have = badge.metric ? label(badge.metric) : 'no metric';
  return {
    code: 'series_metric_mismatch',
    error: `All tiers in “${seriesName}” count ${label(want)} — this one counts ${have}. Pick ${label(want)}, or put it in another series (or none).`,
    seriesMetric: want,
    seriesMetricLabel: label(want),
  };
}

export interface SeriesMetricConflict {
  /** The metric the series goes by (seriesMetric) — what the other tiers should change to. */
  seriesMetric: string;
  seriesMetricLabel: string;
  /** Every metric its tiers with a threshold count, most-used first, with those tiers. */
  metrics: Array<{ metric: string; label: string; badges: Array<{ id: number; name: string }> }>;
  /** The tiers that don't count seriesMetric — the ones to fix. */
  offenders: Array<{ id: number; name: string; metric: string; label: string }>;
  /** One line for the admin list. */
  message: string;
}

/**
 * A series whose tiers with a threshold already count different metrics (created before the rule),
 * or null. Reported, never fixed automatically: the admin changes the odd tier's metric (if nobody
 * has it yet) or moves it out of the series.
 */
export function seriesMetricConflict(tiers: MetricTier[], seriesName: string, label: (metric: string) => string = m => m): SeriesMetricConflict | null {
  const withN = tiers.filter(t => hasThreshold(t) && t.metric).sort(tierCompare);
  const byMetric = new Map<string, Array<{ id: number; name: string }>>();
  for (const t of withN) byMetric.set(t.metric!, [...(byMetric.get(t.metric!) ?? []), { id: t.id, name: t.name ?? `badge ${t.id}` }]);
  if (byMetric.size < 2) return null;
  const main = seriesMetric(tiers)!;
  const metrics = [...byMetric.entries()]
    .map(([metric, badges]) => ({ metric, label: label(metric), badges }))
    .sort((a, b) => (a.metric === main ? -1 : b.metric === main ? 1 : b.badges.length - a.badges.length));
  const offenders = withN.filter(t => t.metric !== main).map(t => ({ id: t.id, name: t.name ?? `badge ${t.id}`, metric: t.metric!, label: label(t.metric!) }));
  const names = offenders.map(o => `“${o.name}” (${o.label})`).join(', ');
  return {
    seriesMetric: main, seriesMetricLabel: label(main), metrics, offenders,
    message: `Tiers in “${seriesName}” count different metrics — it goes by ${label(main)}, but ${names} ${offenders.length === 1 ? 'doesn’t' : 'don’t'}. Change ${offenders.length === 1 ? 'its' : 'their'} metric to ${label(main)} (possible while nobody has the badge), or move ${offenders.length === 1 ? 'it' : 'them'} out of the series.`,
  };
}

// ── admin input ──────────────────────────────────────────────────────────────

/** Matches BADGE_LIMITS.description — a template renders into a badge description. */
export const SERIES_LIMITS = { name: 60, descriptionTemplate: 300 } as const;
const COLOR_RE = /^#[0-9a-f]{6}$/;

export interface SeriesValues { name?: string; color?: string; descriptionTemplate?: string | null }

/** Validate a series create (`partial` false) or PATCH body. `descriptionTemplate` is optional on both. */
export function normalizeSeriesInput(body: unknown, partial: boolean): { values: SeriesValues } | { errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const v: SeriesValues = {};
  const errors: Record<string, string> = {};
  if (b.descriptionTemplate !== undefined) {
    const t = b.descriptionTemplate === null ? '' : typeof b.descriptionTemplate === 'string' ? b.descriptionTemplate.trim() : null;
    if (t === null) errors.descriptionTemplate = 'Description template: text with {N}';
    else if (t.length > SERIES_LIMITS.descriptionTemplate) errors.descriptionTemplate = `Description template: up to ${SERIES_LIMITS.descriptionTemplate} characters`;
    else if (t && !t.includes(N_TOKEN)) errors.descriptionTemplate = `Put ${N_TOKEN} where the tier’s number goes (e.g. “Posted ${N_TOKEN} scores.”)`;
    else v.descriptionTemplate = t || null;
  }
  if (b.name !== undefined || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > SERIES_LIMITS.name) errors.name = `Series name: 1–${SERIES_LIMITS.name} characters`;
    else v.name = name;
  }
  if (b.color !== undefined || !partial) {
    const c = typeof b.color === 'string' ? b.color.trim().toLowerCase() : '';
    if (!COLOR_RE.test(c)) errors.color = 'Series color: #rrggbb';
    else v.color = c;
  }
  return Object.keys(errors).length ? { errors } : { values: v };
}

/** A series key from its name: "Win streaks" → "win-streaks", made unique against `taken`. */
export function seriesKeyFor(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'series';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
