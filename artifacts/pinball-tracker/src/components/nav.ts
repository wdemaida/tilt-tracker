import { Trophy, BarChart2, Building2, Users } from 'lucide-react';
import { PinballIcon } from './PinballIcon';
import { useMyFriends } from '../lib/myFriends';
import { useIncomingChallengeCount } from '../lib/challenges';

// Shared by the desktop header, the avatar menu and the mobile tab bar, so the three can't drift.

export type NavIcon = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

export interface NavItem {
  href: string;
  label: string;
  Icon: NavIcon;
}

export const SCORES: NavItem = { href: '/', label: 'Scores', Icon: Trophy };
export const MACHINES: NavItem = { href: '/machines', label: 'Machines', Icon: PinballIcon };
export const VENUES: NavItem = { href: '/venues', label: 'Venues', Icon: Building2 };
export const STATS: NavItem = { href: '/stats', label: 'Stats', Icon: BarChart2 };
/** Friends + Pods + Challenges. Signed-in only — every tab is the viewer's private data. */
export const CREW: NavItem = { href: '/crew', label: 'Crew', Icon: Users };

/**
 * Whether `href` is the current section: exact for Scores ("/"), otherwise the path or anything
 * under it — so /venues/12 lights Venues. /friends and /pods redirect into /crew, so they match too.
 */
export function isActivePath(location: string, href: string) {
  if (href === '/') return location === '/';
  // A challenge page belongs to Crew (it's reached from the Challenges tab).
  if (href === CREW.href && (location === '/challenges' || location.startsWith('/challenges/'))) return true;
  return location === href || location.startsWith(`${href}/`);
}

/**
 * Pending incoming friend requests plus challenges waiting on your answer — the badge on the Crew
 * nav entries. Reuses the friends list and pending-challenges queries, which the Crew page renders
 * anyway; zero and never fetched when signed out.
 */
export function useCrewBadgeCount() {
  const friends = useMyFriends().incoming.length;
  const challenges = useIncomingChallengeCount();
  return friends + challenges;
}

export function badgeText(n: number) {
  return n > 9 ? '9+' : String(n);
}
