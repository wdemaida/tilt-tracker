import { useAuth } from '@clerk/clerk-react';
import { useMemo } from 'react';
import { request } from './api';

// Badges — the public side (catalog, profile shelf, images). Badges are public on every profile:
// these calls work signed out, and send the token when there is one only so the catalog can mark
// your own earned badges. Admin calls are in adminApi.ts.

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

/** A badge as the server's publicBadge() shapes it. `imageVersion` null = no image → lucide icon. */
export interface Badge {
  id: number;
  key: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  imageVersion: number | null;
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

export interface BadgeShelfData {
  user: { id: number; username: string; displayName: string };
  isSelf: boolean;
  badges: ShelfBadge[];
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
