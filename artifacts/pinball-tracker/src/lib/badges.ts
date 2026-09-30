import { useAuth } from '@clerk/clerk-react';
import { useMemo } from 'react';
import { request } from './api';

// Badges — the public side (catalog, profile shelf, images). Badges are public on every profile:
// these calls work signed out, and send the token when there is one only so the catalog can mark
// your own earned badges. Admin calls are in adminApi.ts.

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

/** Where a tier sits in its series: "Tier 2 of 4" (live tiers + the ones this viewer earned). */
export interface BadgeSeriesRef {
  id: number;
  key: string;
  name: string;
  /** The series' one color — every tier is drawn in it (already applied to the badge's `color`). */
  color: string;
  tier: number;
  tierCount: number;
}

/** A badge as the server's publicBadge() shapes it. `imageVersion` null = no image → lucide icon. */
export interface Badge {
  id: number;
  key: string;
  name: string;
  description: string;
  icon: string;
  /** The color to draw it in — the series' color for a tier. */
  color: string;
  imageVersion: number | null;
  seriesId?: number | null;
  /** Set on catalog/shelf entries that are a tier of a series. */
  series?: BadgeSeriesRef | null;
  /** What earns it, in plain English ("Post 100 scores"). */
  requirement: string;
  availableFrom: string | null;
  availableTo: string | null;
  /** A date rule's venue-local play-date window, YYYY-MM-DD. */
  localDate: { from: string; to: string } | null;
  retired: boolean;
}

export interface CatalogBadge extends Badge { earnedCount: number; earnedAt: string | null }

export interface ShelfBadge extends Badge {
  earnedAt: string;
  earnedCount: number;
  granted: boolean;
  note: string | null;
  sourceScore: { id: number; score: number; machineName: string } | null;
  sourceChallengeId: number | null;
}

/**
 * The shelf as the profile draws it (server-collapsed, in the shared sort order): a series once, as
 * its highest earned tier with pips and the whole ladder; a single as itself.
 */
export type ShelfItem =
  | { type: 'badge'; badge: ShelfBadge }
  | {
    type: 'series';
    series: { id: number; key: string; name: string; color: string };
    /** The highest tier they've earned. */
    top: ShelfBadge;
    tier: number;
    tierCount: number;
    /** Filled pips; tierCount − earnedCount hollow ones (remaining live tiers). */
    earnedCount: number;
    tiers: Array<{ badge: Badge; earnedAt: string | null }>;
  };

export interface BadgeShelfData {
  user: { id: number; username: string; displayName: string };
  isSelf: boolean;
  /** Every earned badge, flat, in the shared order. */
  badges: ShelfBadge[];
  /** Absent from an api-server older than badge series — fall back to one item per badge. */
  items?: ShelfItem[];
}

/** The shelf items, or (an older server) one per badge. */
export function shelfItems(data: BadgeShelfData): ShelfItem[] {
  return data.items ?? data.badges.map(badge => ({ type: 'badge' as const, badge }));
}

/** The catalog grouped for display: a series' consecutive tiers become one ladder. */
export type CatalogGroup =
  | { type: 'badge'; badge: CatalogBadge }
  | { type: 'series'; series: BadgeSeriesRef; tiers: CatalogBadge[] };

export function groupCatalog(items: CatalogBadge[]): CatalogGroup[] {
  const out: CatalogGroup[] = [];
  for (const b of items) {
    const last = out[out.length - 1];
    if (b.series && last?.type === 'series' && last.series.id === b.series.id) last.tiers.push(b);
    else if (b.series) out.push({ type: 'series', series: b.series, tiers: [b] });
    else out.push({ type: 'badge', badge: b });
  }
  return out;
}

/** The image URL — the version is in the query so each upload is a new, immutably cached URL. */
export function badgeImageUrl(id: number, version: number): string {
  return `${BASE}/badges/${id}/image?v=${version}`;
}

export function createBadgesApi(getToken: () => Promise<string | null>) {
  const tok = () => getToken();
  return {
    catalog: async () => request<CatalogBadge[]>('/badges', undefined, await tok()),
    forUser: async (username: string) => request<BadgeShelfData>(`/users/${encodeURIComponent(username)}/badges`, undefined, await tok()),
  };
}

export function useBadgesApi() {
  const { getToken } = useAuth();
  return useMemo(() => createBadgesApi(getToken), [getToken]);
}

export const BADGES_KEY = ['badges'] as const;
export const userBadgesKey = (username: string) => ['user-badges', username] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
};

/**
 * When it can be earned, for the catalog: "Earn it on Dec 25, 2026" for a one-day rule, a range for
 * a longer one, else the availability window ("Until Jan 5, 2027"). Null when always open.
 */
export function availabilityText(b: Pick<Badge, 'localDate' | 'availableFrom' | 'availableTo'>, now = new Date()): string | null {
  if (b.localDate) {
    return b.localDate.from === b.localDate.to ? `Earn it on ${ymd(b.localDate.from)}` : `Earn it ${ymd(b.localDate.from)} – ${ymd(b.localDate.to)}`;
  }
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (b.availableTo && +new Date(b.availableTo) < +now) return `Ended ${fmt(b.availableTo)}`;
  if (b.availableFrom && +new Date(b.availableFrom) > +now) return `From ${fmt(b.availableFrom)}${b.availableTo ? ` to ${fmt(b.availableTo)}` : ''}`;
  if (b.availableTo) return `Until ${fmt(b.availableTo)}`;
  return null;
}
