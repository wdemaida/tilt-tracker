// Challenge recommendations — the merge, as a pure function (feature/challenge-recs). No database
// here: challengeReach.ts works out which machines a player can reach (three levels, already
// filtered for what the viewer may see) and this decides what the create form recommends.
//
// The levels, most reliable first (Will, 2026-09-28):
//   1. "Challenge me on" — up to 3 exact machines the player picked themselves.
//   2. "Challenge locations" — the machines currently at venues the player says they can reach.
//   3. Recent play — machines the player scored on in the last 60 days. The noisiest: people travel.
//
// Rules:
//  - A machine keeps only its highest level (1 beats 2 beats 3).
//  - Within a level: machines the viewer can reach too (any of the viewer's own three levels) first,
//    then machines the viewer has a score on, then the rest — each group in the level's own order.
//  - Caps per level: 3 / 8 / 5.
//  - Exact machine, not the OPDB game group: a Pro and a Premium can play very differently, so the
//    create form turns a picked recommendation into matchMode 'exact'.

export type RecLevel = 1 | 2 | 3;

export const REC_CAPS: Record<RecLevel, number> = { 1: 3, 2: 8, 3: 5 };

/** One machine at one level, in that level's natural order (position / venue order / visits). */
export interface ReachItem {
  machineId: number;
  name: string;
  variant: string | null;
  imageUrl: string | null;
  /**
   * Level 2 only: where it is — a public venue's name, or 'at home' for the player's own private
   * venue. Never a private venue's name; null for someone else's private venue.
   */
  venueLabel?: string | null;
}

export interface Reach {
  level1: ReachItem[];
  level2: ReachItem[];
  level3: ReachItem[];
}

export interface Recommendation {
  machineId: number;
  name: string;
  variant: string | null;
  imageUrl: string | null;
  level: RecLevel;
  venueLabel?: string;
  /** The viewer can reach it too (their own levels 1–3). */
  viewerCanReach: boolean;
  /** The viewer's best score on this exact machine, when they have one. */
  viewerBest?: number;
}

/** Every machine id in a reach, whatever its level. */
export function reachIds(r: Reach): Set<number> {
  return new Set([...r.level1, ...r.level2, ...r.level3].map(m => m.machineId));
}

/** Deduplicate one level, keeping first-seen order; a later copy only contributes a missing label. */
function dedupe(items: ReachItem[]): ReachItem[] {
  const out = new Map<number, ReachItem>();
  for (const m of items) {
    const seen = out.get(m.machineId);
    if (!seen) out.set(m.machineId, { ...m });
    else if (!seen.venueLabel && m.venueLabel) seen.venueLabel = m.venueLabel;
  }
  return [...out.values()];
}

/**
 * The target's recommendations for this viewer, level by level (1, then 2, then 3), each ranked and
 * capped. `viewerReach` = machine ids the viewer can reach; `viewerBest` = the viewer's best score
 * per machine id.
 */
export function mergeRecommendations(
  target: Reach, viewerReach: Set<number>, viewerBest: Map<number, number>, caps: Record<RecLevel, number> = REC_CAPS,
): Recommendation[] {
  const taken = new Set<number>();
  const out: Recommendation[] = [];
  const levels: Array<[RecLevel, ReachItem[]]> = [[1, target.level1], [2, target.level2], [3, target.level3]];
  for (const [level, items] of levels) {
    const fresh = dedupe(items).filter(m => !taken.has(m.machineId));
    fresh.forEach(m => taken.add(m.machineId));
    const group = (m: ReachItem) => (viewerReach.has(m.machineId) ? 0 : viewerBest.has(m.machineId) ? 1 : 2);
    const ranked = fresh.map((m, i) => ({ m, i })).sort((a, b) => group(a.m) - group(b.m) || a.i - b.i).map(x => x.m);
    for (const m of ranked.slice(0, caps[level])) {
      const rec: Recommendation = {
        machineId: m.machineId, name: m.name, variant: m.variant, imageUrl: m.imageUrl, level,
        viewerCanReach: viewerReach.has(m.machineId),
      };
      if (level === 2 && m.venueLabel) rec.venueLabel = m.venueLabel;
      const best = viewerBest.get(m.machineId);
      if (best != null) rec.viewerBest = best;
      out.push(rec);
    }
  }
  return out;
}

/**
 * Level 3's order: most visits first (a visit = a cluster of plays with no gap over 6h, the app's
 * usual rule), then the most recently played. Input: per machine, its visit count and last play.
 */
export function rankRecentPlay<T extends { visits: number; lastPlayedAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.visits - a.visits || +b.lastPlayedAt - +a.lastPlayedAt);
}

// ── groups (feature/group-challenges) ────────────────────────────────────────

/** A group recommendation: which of the invited players can reach it, and how many. */
export interface GroupRecommendation extends Recommendation {
  /** User ids of the targets who can reach this machine (any of their three levels). */
  reachedBy: number[];
  /** reachedBy.length — the create form groups by it ("all 3 can reach", "2 of 3"…). */
  coverage: number;
  /** Targets whose own private venue has it — shown as "at @name's", never the venue's name. */
  atHomeOf?: number[];
}

/** The overall cap for a group's list (the three per-level caps together). */
export const GROUP_REC_CAP = REC_CAPS[1] + REC_CAPS[2] + REC_CAPS[3];

/**
 * Recommendations for challenging several friends at once. Ranked by how many of them can reach the
 * machine, then whether the viewer can too, then the lowest (most reliable) level any of them has it
 * at, then whether the viewer has a score on it, then first-seen order (targets in the order given,
 * each level by level). A machine keeps the lowest level anyone has it at; `venueLabel` is only ever
 * a public venue's name, and a target's own private venue becomes `atHomeOf` instead of 'at home'
 * (whose home would be ambiguous in a group). Capped at GROUP_REC_CAP. With ONE target the output is
 * exactly mergeRecommendations() — today's single-friend list.
 */
export function mergeGroupRecommendations(
  targets: Array<{ userId: number; reach: Reach }>, viewerReach: Set<number>, viewerBest: Map<number, number>,
  cap = GROUP_REC_CAP,
): Recommendation[] | GroupRecommendation[] {
  if (targets.length === 1) return mergeRecommendations(targets[0].reach, viewerReach, viewerBest);
  interface Acc { item: ReachItem; level: RecLevel; reachedBy: Set<number>; atHomeOf: Set<number>; label?: string; order: number }
  const acc = new Map<number, Acc>();
  let order = 0;
  for (const t of targets) {
    const levels: Array<[RecLevel, ReachItem[]]> = [[1, t.reach.level1], [2, t.reach.level2], [3, t.reach.level3]];
    for (const [level, items] of levels) {
      for (const m of items) {
        const a = acc.get(m.machineId) ?? { item: m, level, reachedBy: new Set<number>(), atHomeOf: new Set<number>(), order: order++ };
        a.reachedBy.add(t.userId);
        if (level < a.level) a.level = level;
        if (level === 2 && m.venueLabel === 'at home') a.atHomeOf.add(t.userId);
        else if (level === 2 && m.venueLabel && !a.label) a.label = m.venueLabel;
        acc.set(m.machineId, a);
      }
    }
  }
  const ranked = [...acc.values()].sort((a, b) =>
    b.reachedBy.size - a.reachedBy.size
    || Number(viewerReach.has(b.item.machineId)) - Number(viewerReach.has(a.item.machineId))
    || a.level - b.level
    || Number(viewerBest.has(b.item.machineId)) - Number(viewerBest.has(a.item.machineId))
    || a.order - b.order);
  return ranked.slice(0, cap).map(a => {
    const rec: GroupRecommendation = {
      machineId: a.item.machineId, name: a.item.name, variant: a.item.variant, imageUrl: a.item.imageUrl, level: a.level,
      viewerCanReach: viewerReach.has(a.item.machineId),
      reachedBy: [...a.reachedBy], coverage: a.reachedBy.size,
    };
    if (a.label) rec.venueLabel = a.label;
    if (a.atHomeOf.size) rec.atHomeOf = [...a.atHomeOf];
    const best = viewerBest.get(a.item.machineId);
    if (best != null) rec.viewerBest = best;
    return rec;
  });
}
