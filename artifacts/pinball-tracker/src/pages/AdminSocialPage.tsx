import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearch, useLocation } from 'wouter';
import { useAdminApi } from '../lib/adminApi';
import { AdminShell, Card, Segmented, LoadMore, ErrorNote } from '../components/admin/AdminParts';
import { AdminChallengeRow, AdminFriendshipRow, AdminNotificationRow } from '../components/admin/AdminRows';

// /admin/crew — friendships & requests (with decline counts), challenges in every state, and the
// notifications inbox across all users. ?tab= picks the section so the overview tiles can deep-link.

type Tab = 'friendships' | 'challenges' | 'notifications';

function Friendships() {
  const admin = useAdminApi();
  const [status, setStatus] = useState<'all' | 'pending' | 'accepted' | 'declined'>('pending');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'friendships', status],
    queryFn: ({ pageParam }) => admin.friendships(status === 'all' ? null : status, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextBefore,
  });
  const summary = q.data?.pages[0]?.summary ?? [];
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  const count = (s: string) => summary.find(x => x.status === s)?.n ?? 0;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Segmented value={status} onChange={setStatus} options={[
          { value: 'pending', label: `Pending ${count('pending')}` },
          { value: 'accepted', label: `Friends ${count('accepted')}` },
          { value: 'declined', label: `Declined ${count('declined')}` },
          { value: 'all', label: 'All' },
        ]} />
        <span className="text-xs text-muted-foreground">{summary.reduce((a, s) => a + s.declines, 0)} declines recorded in total</span>
      </div>
      <ErrorNote error={q.error} />
      {q.isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
        <Card className="overflow-hidden"><ul className="divide-y divide-white/5">{items.map(f => <AdminFriendshipRow key={f.id} f={f} />)}</ul></Card>
      )}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
    </>
  );
}

function Challenges() {
  const admin = useAdminApi();
  const [status, setStatus] = useState<string>('active');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'challenges', status],
    queryFn: ({ pageParam }) => admin.challenges(status === 'all' ? null : status, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextBefore,
  });
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  return (
    <>
      <div className="mb-3">
        <Segmented value={status} onChange={setStatus} options={['active', 'pending', 'resolved', 'cancelled', 'declined', 'expired', 'all'].map(s => ({ value: s, label: s }))} />
      </div>
      <ErrorNote error={q.error} />
      {q.isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
        <Card className="overflow-hidden"><ul className="divide-y divide-white/5">{items.map(c => <AdminChallengeRow key={c.id} c={c} />)}</ul></Card>
      )}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
      <p className="text-xs text-muted-foreground mt-3">
        Voiding sets a challenge to cancelled, clears every result (so it leaves W/L/T and streaks) and releases its score locks.
      </p>
    </>
  );
}

function Notifications() {
  const admin = useAdminApi();
  const [unread, setUnread] = useState<'all' | 'unread'>('all');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'notifications', unread],
    queryFn: ({ pageParam }) => admin.notifications({ unread: unread === 'unread', before: pageParam }),
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextBefore,
  });
  const s = q.data?.pages[0]?.summary;
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Segmented value={unread} onChange={setUnread} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
        {s && <span className="text-xs text-muted-foreground">{s.total} in inboxes · {s.unread} unread · {s.today} sent today</span>}
      </div>
      <ErrorNote error={q.error} />
      {q.isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
        <Card className="overflow-hidden"><ul className="divide-y divide-white/5">{items.map(n => <AdminNotificationRow key={n.id} n={n} />)}</ul></Card>
      )}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
      <p className="text-xs text-muted-foreground mt-3">
        Read notifications are deleted after 30 days by the daily sweep; the Activity log (notification.sent) is the permanent record.
      </p>
    </>
  );
}

export default function AdminSocialPage() {
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const raw = params.get('tab');
  const tab: Tab = raw === 'challenges' || raw === 'notifications' ? raw : 'friendships';
  return (
    <AdminShell>
      <div className="mb-5">
        <Segmented<Tab> value={tab} onChange={t => navigate(`/admin/crew?tab=${t}`, { replace: true })}
          options={[{ value: 'friendships', label: 'Friendships' }, { value: 'challenges', label: 'Challenges' }, { value: 'notifications', label: 'Notifications' }]} />
      </div>
      {tab === 'friendships' && <Friendships />}
      {tab === 'challenges' && <Challenges />}
      {tab === 'notifications' && <Notifications />}
    </AdminShell>
  );
}
