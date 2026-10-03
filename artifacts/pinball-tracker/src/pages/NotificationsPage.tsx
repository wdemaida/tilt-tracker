import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Bell, Loader2 } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { NOTIFICATIONS_KEY, UNREAD_COUNT_KEY } from '../lib/myFriends';
import NotificationRow from '../components/NotificationRow';

// The inbox (feature/friends, phase 1). A page rather than a header dropdown: on a phone a
// dropdown is a cramped overlay, and this list will grow challenge notifications later.
//
// Opening the page marks everything read — once, after the first page has loaded, so the items
// that were new still render highlighted for this visit (the list isn't refetched; only the bell's
// count is).

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

  // "Clear all" deletes the whole inbox, read or not — behind an inline confirm, like removing a friend.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearAll = useMutation({
    mutationFn: api.notifications.clearAll,
    onSuccess: () => {
      setConfirmingClear(false);
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY });
    },
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
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">Notifications</h1>
        {items.length > 0 && (
          confirmingClear ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Delete all notifications?</span>
              <button
                type="button"
                disabled={clearAll.isPending}
                onClick={() => clearAll.mutate()}
                className="px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
              >
                {clearAll.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Clear all'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingClear(false)}
                className="px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors"
              >
                Keep
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              className="px-3 py-1.5 rounded-lg border border-white/15 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-white hover:border-white/30 transition-colors"
            >
              Clear all
            </button>
          )
        )}
      </div>
      {clearAll.isError && <p className="text-xs text-red-400 -mt-4 mb-4">Couldn’t clear your notifications. Try again.</p>}

      {query.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-400">Couldn’t load your notifications.</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-8 text-center">
          <Bell className="w-8 h-8 text-muted-foreground mx-auto mb-3" aria-hidden />
          <p className="text-sm text-white font-bold mb-1">Nothing yet</p>
          <p className="text-sm text-muted-foreground">Friend requests, challenges, results, badges and announcements from TiltTrack will show up here.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map(n => <NotificationRow key={n.id} n={n} />)}
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
