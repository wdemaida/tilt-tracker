import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'wouter';
import { formatDistanceToNow } from 'date-fns';
import { Ban, Bell, Flag, Loader2, Swords, Timer, Trophy, TrendingUp, UserCheck, UserPlus } from 'lucide-react';
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

const CHALLENGE_TYPE_LABEL: Record<string, string> = {
  high_score: 'High score',
  race: 'Beat my score',
  most_improved: 'Most improved',
  average: 'Best average',
};

const RESULT_TEXT: Record<string, string> = {
  win: 'You won',
  loss: 'You lost',
  tie: 'It’s a tie',
  forfeit: 'You forfeited',
  no_show: 'No score from you',
  abandoned: 'Abandoned',
};

/** What one notification says and where it goes. Unknown kinds (from a newer server) still render. */
function describe(n: AppNotification): { text: React.ReactNode; href: string | null; Icon: typeof Bell } {
  // Their name plus @handle, like the Friends cards. (A plain @handle, not a UsernameLink: the whole
  // row is already a link.)
  const { displayName, username } = n.payload;
  const name = displayName || username ? (
    <>
      {displayName && <span className="font-semibold text-white">{displayName}</span>}
      {displayName && username && ' '}
      {username && <span className="text-username">@{username}</span>}
    </>
  ) : <span className="font-semibold text-white">Someone</span>;
  switch (n.kind) {
    case 'friend_request':
      return { text: <>{name} sent you a friend request</>, href: '/friends', Icon: UserPlus };
    case 'friend_accepted':
      return {
        text: <>{name} accepted your friend request</>,
        href: n.payload.username ? `/users/${n.payload.username}` : '/friends',
        Icon: UserCheck,
      };
  }

  // Challenge kinds — each links to the challenge page (/challenges/:id).
  if (n.kind.startsWith('challenge_')) {
    const { challengeId, challengeType, machineName } = n.payload;
    const href = typeof challengeId === 'number' ? `/challenges/${challengeId}` : null;
    const what = (
      <>
        {challengeType ? <>{CHALLENGE_TYPE_LABEL[challengeType] ?? 'A'} challenge</> : 'A challenge'}
        {machineName && <> on <span className="text-machine font-semibold">{machineName}</span></>}
      </>
    );
    switch (n.kind) {
      case 'challenge_received':
        return { text: <>{name} challenged you: {what}</>, href, Icon: Swords };
      case 'challenge_accepted':
        return { text: <>{name} accepted your challenge: {what}</>, href, Icon: Swords };
      case 'challenge_declined':
        return { text: <>{name} declined your challenge: {what}</>, href, Icon: Ban };
      case 'challenge_cancelled':
        return { text: <>{name} withdrew their challenge: {what}</>, href, Icon: Ban };
      case 'challenge_opponent_scored': {
        const score = n.payload.score;
        return {
          text: <>{name} posted {typeof score === 'number' ? <span className="text-primary font-semibold">{score.toLocaleString()}</span> : 'a score'} in your challenge: {what}</>,
          href, Icon: TrendingUp,
        };
      }
      case 'challenge_ending_soon':
        return { text: <>Less than a day left: {what}</>, href, Icon: Timer };
      case 'challenge_result': {
        const outcome = n.payload.void ? 'Nobody played, so no result' : RESULT_TEXT[String(n.payload.outcome)] ?? 'Challenge over';
        return { text: <>{outcome}: {what}</>, href, Icon: n.payload.outcome === 'win' ? Trophy : Flag };
      }
      default:
        return { text: <>{what} was updated</>, href, Icon: Swords };
    }
  }
  return { text: 'You have a new notification', href: null, Icon: Bell };
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
          <p className="text-sm text-muted-foreground">Friend requests, challenges and results will show up here.</p>
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
