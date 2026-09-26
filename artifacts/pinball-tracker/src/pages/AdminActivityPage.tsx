import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearch, useLocation } from 'wouter';
import { X } from 'lucide-react';
import { useAdminApi } from '../lib/adminApi';
import { AdminShell, ActivityList, LoadMore, ErrorNote } from '../components/admin/AdminParts';

// /admin/activity — the event log, newest first. Filters: category, exact type, one user (actor or
// subject — ?userId= in the URL, so the user page can link here), and a date range. Keyset-paged.

const select = 'border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-primary';

/** A yyyy-mm-dd from a date input, as the start (or end) of that day in the viewer's zone. */
function dayBound(v: string, end: boolean): string | undefined {
  if (!v) return undefined;
  const [y, m, d] = v.split('-').map(Number);
  const local = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
  return local.toISOString();
}

export default function AdminActivityPage() {
  const admin = useAdminApi();
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const userId = Number(params.get('userId')) || null;
  const [category, setCategory] = useState(params.get('category') ?? '');
  const [type, setType] = useState(params.get('type') ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const types = useQuery({ queryKey: ['admin', 'activity-types'], queryFn: admin.activityTypes, staleTime: Infinity });
  const typeOptions = useMemo(() => {
    const all = types.data ?? {};
    return category ? (all[category] ?? []) : Object.values(all).flat();
  }, [types.data, category]);

  const filters = { category: category || undefined, type: type || undefined, userId, from: dayBound(from, false), to: dayBound(to, true) };
  const q = useInfiniteQuery({
    queryKey: ['admin', 'activity', filters],
    queryFn: ({ pageParam }) => admin.activity({ ...filters, before: pageParam, limit: 50 }),
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextBefore,
  });
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  const who = items.find(e => e.actor?.id === userId)?.actor ?? items.find(e => e.subject?.id === userId)?.subject;

  return (
    <AdminShell>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <select aria-label="Category" value={category} onChange={e => { setCategory(e.target.value); setType(''); }} className={select}>
          <option value="">All categories</option>
          {Object.keys(types.data ?? {}).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select aria-label="Event type" value={type} onChange={e => setType(e.target.value)} className={select}>
          <option value="">All types</option>
          {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="date" aria-label="From" value={from} onChange={e => setFrom(e.target.value)} className={select} />
        <input type="date" aria-label="To" value={to} onChange={e => setTo(e.target.value)} className={select} />
      </div>
      {userId && (
        <p className="mb-3">
          <button type="button" onClick={() => navigate('/admin/activity')}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/20 text-primary text-xs font-bold">
            {who ? `@${who.username}` : `user #${userId}`} <X className="w-3 h-3" aria-label="Clear user filter" />
          </button>
        </p>
      )}
      <ErrorNote error={q.error} />
      {q.isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> : <ActivityList items={items} empty="No events match." />}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
    </AdminShell>
  );
}
