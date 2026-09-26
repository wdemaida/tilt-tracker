import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'wouter';
import { formatDistanceToNow } from 'date-fns';
import { Bell, Loader2, UserCheck, UserPlus } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { NOTIFICATIONS_KEY, UNREAD_COUNT_KEY } from '../lib/myFriends';
import type { AppNotification } from '../lib/api';

// The inbox (feature/friends, phase 1). A page rather than a header dropdown: on a phone a
// dropdown is a cramped overlay, and this list will grow challenge notifications later.
//
// Opening the page marks everything read — once, after the first page has loaded, so the items
// that were new still render highlighted for this visit (the list isn't refetched; only the bell's
// count is).

/** What one notification says and where it goes. Unknown kinds (from a newer server) still render. */
function describe(n: AppNotification): { text: React.ReactNode; href: string | null; Icon: typeof Bell } {
  const who = n.payload.displayName ?? n.payload.username ?? 'Someone';
  const name = <span className="font-semibold text-white">{who}</span>;
  switch (n.kind) {
    case 'friend_request':
      return { text: <>{name} sent you a friend request</>, href: '/friends', Icon: UserPlus };
    case 'friend_accepted':
      return {
        text: <>{name} accepted your friend request</>,
        href: n.payload.username ? `/users/${n.payload.username}` : '/friends',
        Icon: UserCheck,
      };
    default:
      return { text: 'You have a new notification', href: null, Icon: Bell };
  }
}

function Row({ n }: { n: AppNotification }) {
  const { text, href, Icon } = describe(n);
  const unread = !n.readAt;
  const inner = (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
      unread ? 'border-friend/40 bg-friend/5' : 'border-white/10 bg-card'
    } ${href ? 'hover:border-white/25' : ''}`}>
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${unread ? 'text-friend' : 'text-muted-foreground'}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white/80">{text}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}</p>
      </div>
      {unread && <span className="w-2 h-2 rounded-full bg-friend mt-1.5 flex-shrink-0" aria-label="New" />}
    </div>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}

export default function NotificationsPage() {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: ({ pageParam }) => api.notifications.list(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: last => last.nextBefore ?? undefined,
    // Always fresh on open — this page is where new ones are seen.
    refetchOnMount: 'always',
  });

  const markAll = useMutation({
    mutationFn: api.notifications.markAllRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }),
  });

  // Mark read on open, once per visit, after the list has arrived.
  const marked = useRef(false);
  const items = query.data?.pages.flatMap(p => p.items) ?? [];
  const hasUnread = items.some(n => !n.readAt);
  useEffect(() => {
    if (marked.current || !query.isSuccess) return;
    marked.current = true;
    if (hasUnread) markAll.mutate();
  }, [query.isSuccess, hasUnread, markAll]);

  return (
    <div className="max-w-2xl">
      <h1 className="text-4xl font-black uppercase tracking-widest text-white mb-6">Notifications</h1>

      {query.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-400">Couldn’t load your notifications.</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-8 text-center">
          <Bell className="w-8 h-8 text-muted-foreground mx-auto mb-3" aria-hidden />
          <p className="text-sm text-white font-bold mb-1">Nothing yet</p>
          <p className="text-sm text-muted-foreground">Friend requests and replies will show up here.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map(n => <Row key={n.id} n={n} />)}
          {query.hasNextPage && (
            <button
              type="button"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="mt-2 self-center px-4 py-2 rounded-lg border border-white/15 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white hover:border-white/30 disabled:opacity-50 transition-colors"
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Show older'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
