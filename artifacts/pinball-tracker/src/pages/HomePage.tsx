import { useState, useEffect, useMemo, useDeferredValue } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { PlusCircle } from 'lucide-react';
import { Link } from 'wouter';
import { SignedIn } from '@clerk/clerk-react';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';
import { queryClient } from '../lib/queryClient';
import ScoreCard from '../components/ScoreCard';
import { usePodMembership } from '../lib/myPods';
import EditScoreDialog, { type EditScoreTarget } from '../components/EditScoreDialog';
import ChallengeSetupNudge from '../components/ChallengeSetupNudge';
import { scoreMatchesSearch } from '../lib/scoreSearch';

type Filter = 'all' | 'casual' | 'tournament';

export default function HomePage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(10);
  const [editScore, setEditScore] = useState<EditScoreTarget | null>(null);
  const [deleteScoreId, setDeleteScoreId] = useState<number | null>(null);

  const authApi = useApi();
  const appUser = useAppUser();
  const isAdmin = appUser?.role === 'admin';
  const { mine } = useScopeContext();
  const podMembership = usePodMembership();

  const { data: scores = [], isLoading } = useQuery({
    queryKey: ['scores', mine],
    queryFn: () => authApi.scores.list(mine),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => authApi.scores.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scores'] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      queryClient.invalidateQueries({ queryKey: ['venues'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      setDeleteScoreId(null);
    },
  });

  // Filtering runs over every score the server sent (GET /api/scores is unpaginated; "Show more" only
  // reveals more of the filtered list), so a deferred query keeps typing responsive without a timer.
  const query = useDeferredValue(search);

  // Reset pagination when search or filter changes
  useEffect(() => { setVisibleCount(10); }, [filter, query]);

  // Per-machine best score for trophy icon
  const bestScores = useMemo(() => {
    const map = new Map<number, number>();
    (scores as any[]).forEach((s: any) => {
      if (s.score > (map.get(s.machineId) ?? 0)) map.set(s.machineId, s.score);
    });
    return map;
  }, [scores]);

  const filtered = (scores as any[]).filter((s: any) => {
    if (filter !== 'all' && s.type !== filter) return false;
    // Machine, venue (as labelled on the card), @username, display name — lib/scoreSearch.ts.
    if (!scoreMatchesSearch(s, query, appUser?.username)) return false;
    return true;
  });
  const visible = filtered.slice(0, visibleCount);

  function openEdit(s: any) {
    setEditScore({
      id: s.id, machineId: s.machineId, machineName: s.machineName, score: s.score,
      type: s.type, playedAt: s.playedAt, venueId: s.venueId ?? null, venueName: s.venueName ?? null,
      venueTimezone: s.venueTimezone ?? null,
      hasFullPhoto: !!s.hasFullPhoto, isOwn: !!appUser && s.username === appUser.username,
      playedAtSource: s.playedAtSource ?? null,
    });
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">Recent Scores</h1>
        <ScopeToggle />
      </div>
      <p className="text-sm text-muted-foreground mb-4">{mine ? 'Your plays only.' : 'All plays across the site.'}</p>
      <ChallengeSetupNudge />

      <SignedIn>
        <Link
          href="/add"
          className="md:hidden flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl bg-primary text-white font-black uppercase tracking-widest text-sm hover:opacity-90 transition-opacity mb-6"
        >
          <PlusCircle className="w-5 h-5" />
          Add Score
        </Link>
      </SignedIn>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="text"
          placeholder="Search machines, venues, players..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 rounded-lg border border-white/10 bg-card px-4 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
        />
        <div className="flex gap-2">
          {(['all', 'casual', 'tournament'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors ${
                filter === f ? 'bg-primary text-white' : 'border border-white/10 text-muted-foreground hover:text-white'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground">{search.trim() || filter !== 'all' ? 'No matching scores.' : 'No scores yet.'}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((s: any) => (
              <ScoreCard
                key={s.id}
                {...s}
                isHighScore={bestScores.get(s.machineId) === s.score}
                isCurrentUser={!mine && !!appUser && s.username === appUser.username}
                pods={podMembership.get(s.username)}
                onEdit={isAdmin || s.username === appUser?.username ? () => openEdit(s) : undefined}
                onDelete={isAdmin || s.username === appUser?.username ? () => setDeleteScoreId(s.id) : undefined}
              />
            ))}
          </div>
          {filtered.length > visibleCount && (
            <div className="mt-6 flex justify-center">
              <button
                onClick={() => setVisibleCount(c => c + 10)}
                className="px-6 py-2.5 rounded-lg border border-white/10 text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white hover:border-white/30 transition-colors"
              >
                Load more ({filtered.length - visibleCount} remaining)
              </button>
            </div>
          )}
        </>
      )}

      {/* Edit dialog — shared with Add Score's "Edit played time" (components/EditScoreDialog.tsx). */}
      <EditScoreDialog score={editScore} onClose={() => setEditScore(null)} />

      {/* Delete confirm dialog */}
      <Dialog.Root open={deleteScoreId !== null} onOpenChange={open => { if (!open) setDeleteScoreId(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
            <Dialog.Title className="text-lg font-black uppercase tracking-wider text-white mb-2">Delete Score?</Dialog.Title>
            <p className="text-sm text-muted-foreground mb-5">This cannot be undone.</p>
            {deleteMutation.isError && (
              <p className="text-xs text-red-400 mb-3">{(deleteMutation.error as any)?.message}</p>
            )}
            <div className="flex gap-3">
              <Dialog.Close className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
                Cancel
              </Dialog.Close>
              <button
                onClick={() => deleteScoreId !== null && deleteMutation.mutate(deleteScoreId)}
                disabled={deleteMutation.isPending}
                className="flex-1 py-2.5 rounded-lg bg-red-600 text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
