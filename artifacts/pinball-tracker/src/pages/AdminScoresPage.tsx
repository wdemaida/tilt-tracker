import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearch, useLocation } from 'wouter';
import { X } from 'lucide-react';
import { useAdminApi } from '../lib/adminApi';
import { AdminShell, Card, Segmented, LoadMore, ErrorNote } from '../components/admin/AdminParts';
import { AdminScoreRow } from '../components/admin/AdminRows';

// /admin/scores — recent uploads with thumbnails and full-photo status, and the delete actions
// (score, full-size photo, thumbnail). ?userId= narrows to one person (the user page links here).

type PhotoFilter = 'all' | 'full' | 'thumb' | 'none';

export default function AdminScoresPage() {
  const admin = useAdminApi();
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const userId = Number(params.get('userId')) || null;
  const [photo, setPhoto] = useState<PhotoFilter>('all');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'scores', userId, photo],
    queryFn: ({ pageParam }) => admin.scores({ userId, photo: photo === 'all' ? null : photo, before: pageParam }),
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextBefore,
  });
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  const who = userId ? items[0]?.user : null;

  return (
    <AdminShell>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Segmented<PhotoFilter> value={photo} onChange={setPhoto} options={[
          { value: 'all', label: 'All' }, { value: 'full', label: 'Full photo' }, { value: 'thumb', label: 'Thumbnail' }, { value: 'none', label: 'No photo' },
        ]} />
        {userId && (
          <button type="button" onClick={() => navigate('/admin/scores')}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/20 text-primary text-xs font-bold">
            {who ? `@${who.username}` : `user #${userId}`} <X className="w-3 h-3" aria-label="Clear user filter" />
          </button>
        )}
      </div>
      <ErrorNote error={q.error} />
      {q.isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">No scores match.</p> : (
        <Card className="overflow-hidden"><ul className="divide-y divide-white/5">{items.map(s => <AdminScoreRow key={s.id} s={s} showUser={!userId} />)}</ul></Card>
      )}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
    </AdminShell>
  );
}
