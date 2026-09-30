import { useEffect, useRef } from 'react';
import { useApi } from './useApi';
import { queryClient } from './queryClient';
import { toast } from './toast';
import { BADGES_KEY } from './badges';
import BadgeImage from '../components/BadgeImage';
import type { AppNotification } from './api';

// "You earned a badge" toasts while the app is open. Driven by the bell's unread-count poll
// (Header.tsx): when the count goes up — or on the first count of a session — it reads the newest
// page of the inbox and toasts every unread `badge_earned` newer than the last one it toasted.
//
// - The high-water mark (the newest notification id already considered) is per user, in
//   localStorage, so a reload doesn't re-toast. With no mark yet (first visit on this browser) it
//   only records one — no toast storm for an old inbox.
// - Badges already shown on the Add Score "Score saved" step (POST /api/scores `newBadges`) are
//   registered with markBadgesShown() and skipped, so they don't toast a second time.
// - Only badge_earned for now. The same loop would carry other kinds (friend_request,
//   challenge_received, challenge_result) by widening TOAST_KINDS and giving each a line of copy.

const shownBadgeIds = new Set<number>();
/** The caller already celebrated these badges on screen; don't toast them. */
export function markBadgesShown(ids: number[]) {
  for (const id of ids) shownBadgeIds.add(id);
}

const markKey = (userId: number) => `tt.notifToastMark.${userId}`;
function readMark(userId: number): number | null {
  try {
    const v = Number(localStorage.getItem(markKey(userId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}
function writeMark(userId: number, id: number) {
  try { localStorage.setItem(markKey(userId), String(id)); } catch { /* private mode: in-memory only */ }
}

const memoryMark = new Map<number, number>();
const TOAST_KINDS = new Set(['badge_earned']);
const MAX_SEPARATE = 3;

function badgeOf(n: AppNotification) {
  const p = n.payload as Record<string, unknown>;
  return {
    id: typeof p.badgeId === 'number' ? p.badgeId : Number(p.badgeId) || 0,
    name: typeof p.badgeName === 'string' ? p.badgeName : 'a new',
    icon: typeof p.icon === 'string' ? p.icon : 'award',
    color: typeof p.color === 'string' ? p.color : '#f59e0b',
    imageVersion: typeof p.imageVersion === 'number' ? p.imageVersion : null,
    granted: !!p.granted,
  };
}

export function useBadgeToasts(userId: number | undefined, unreadCount: number | undefined) {
  const api = useApi();
  const prev = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    if (userId == null || unreadCount == null) return;
    const before = prev.current;
    prev.current = unreadCount;
    const stored = memoryMark.get(userId) ?? readMark(userId);
    // Nothing new can be waiting unless the count rose (or this is the first count we've seen).
    if (before !== undefined && unreadCount <= before) return;
    if (unreadCount === 0 && stored != null) return;
    if (busy.current) { again.current = true; return; }

    const run = async () => {
      busy.current = true;
      try {
        const mark = memoryMark.get(userId) ?? readMark(userId);
        const { items } = await api.notifications.list(undefined, 20);
        const newest = items.reduce((m, n) => Math.max(m, n.id), mark ?? 0);
        memoryMark.set(userId, newest);
        writeMark(userId, newest);
        if (mark == null) return; // first look on this browser: baseline only
        const fresh = items
          .filter(n => n.id > mark && !n.readAt && TOAST_KINDS.has(n.kind))
          .map(badgeOf)
          .filter(b => !shownBadgeIds.has(b.id))
          .reverse(); // oldest first, so the newest ends on top
        if (!fresh.length) return;
        for (const b of fresh) shownBadgeIds.add(b.id);
        queryClient.invalidateQueries({ queryKey: BADGES_KEY });
        queryClient.invalidateQueries({ queryKey: ['user-badges'] });
        if (fresh.length > MAX_SEPARATE) {
          toast({
            id: 'badges-earned', tone: 'info', href: '/notifications', duration: 8000,
            icon: <BadgeImage badge={fresh[fresh.length - 1]} size={36} />,
            title: `You earned ${fresh.length} badges`,
            body: fresh.map(b => b.name).join(', '),
          });
          return;
        }
        for (const b of fresh) {
          toast({
            id: `badge-${b.id}`, tone: 'info', href: '/badges', duration: 8000,
            icon: <BadgeImage badge={b} size={36} />,
            title: b.granted ? 'You were awarded a badge' : 'Badge earned!',
            body: b.name,
          });
        }
      } catch {
        // A failed peek just means no toast; the bell still shows the count.
      } finally {
        busy.current = false;
        if (again.current) { again.current = false; void run(); }
      }
    };
    void run();
  }, [userId, unreadCount, api]);
}
