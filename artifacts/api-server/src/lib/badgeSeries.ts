// Badge series — the pure rules (feature/badge-series, migrate25). Unit-tested in badgeSeries.test.ts;
// badges.ts and routes/adminBadges.ts load the rows and apply these.
//
// A series is a ladder of tiers ("Scores": First Ball 1 → Regular 10 → Centurion 100 → Wizard Mode
// 1,000). One ordering space holds whole series (badge_series.sort_order) and single badges
// (badges.sort_order); the profile shelf, the /badges catalog and /admin/badges all read it. Within a
// series the tiers order themselves: metric tiers by threshold, then rule/manual tiers by their own
// sort_order — never by the admin's drag (tiers aren't draggable).
//
//   orderBadges        every badge in the shared order, each series' tiers together (catalog, admin list)
//   topLevelOrder      the draggable items: every series (even an empty one) and every single badge
//   validateOrder      the reorder endpoint's body must be exactly that set, once each
//   collapseShelf      a profile: one item per series (its highest earned tier + pips) and each single
//   ladderOf           a series' tiers for one viewer: live tiers + any retired one they earned

export interface SeriesRef { id: number; key: string; name: string; color: string; sortOrder: number }

export interface OrderableBadge {
  id: number;
  seriesId: number | null;
  sortOrder: number;
  kind: string;
  threshold: number | null;
}

export type TopItem = { type: 'series'; id: number } | { type: 'badge'; id: number };

/** Tier order inside one series: metric tiers by threshold, then the rest by sort_order, then id. */
export function tierCompare(a: OrderableBadge, b: OrderableBadge): number {
  const am = a.kind === 'metric' && a.threshold != null, bm = b.kind === 'metric' && b.threshold != null;
  if (am !== bm) return am ? -1 : 1;
  if (am && bm && a.threshold !== b.threshold) return a.threshold! - b.threshold!;
  return a.sortOrder - b.sortOrder || a.id - b.id;
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

// ── admin input ──────────────────────────────────────────────────────────────

export const SERIES_LIMITS = { name: 60 } as const;
const COLOR_RE = /^#[0-9a-f]{6}$/;

/** Validate a series create (`partial` false) or PATCH body. */
export function normalizeSeriesInput(body: unknown, partial: boolean): { values: { name?: string; color?: string } } | { errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const v: { name?: string; color?: string } = {};
  const errors: Record<string, string> = {};
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
