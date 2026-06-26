import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { X, PlusCircle } from 'lucide-react';
import { Link } from 'wouter';
import { SignedIn } from '@clerk/clerk-react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { queryClient } from '../lib/queryClient';
import ScoreCard from '../components/ScoreCard';

type Filter = 'all' | 'casual' | 'tournament';

interface EditScore {
  id: number;
  machineId: number;
  machineName: string;
  score: number;
  type: 'casual' | 'tournament';
  playedAt: string;
}

export default function HomePage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(10);
  const [editScore, setEditScore] = useState<EditScore | null>(null);
  const [deleteScoreId, setDeleteScoreId] = useState<number | null>(null);

  // Edit form state
  const [editScoreVal, setEditScoreVal] = useState('');
  const [editType, setEditType] = useState<'casual' | 'tournament'>('casual');
  const [editPlayedAt, setEditPlayedAt] = useState('');
  const [editMachineSearch, setEditMachineSearch] = useState('');

  const authApi = useApi();
  const appUser = useAppUser();
  const isAdmin = appUser?.role === 'admin';

  const { data: scores = [], isLoading } = useQuery({ queryKey: ['scores'], queryFn: api.scores.list });

  const { data: machineSuggestions = [] } = useQuery({
    queryKey: ['machine-search-edit', editMachineSearch],
    queryFn: () => api.machines.search(editMachineSearch),
    enabled: !!editScore && editMachineSearch.length > 1 && editMachineSearch !== editScore?.machineName,
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) => authApi.scores.patch(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scores'] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      setEditScore(null);
    },
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

  // Reset pagination when search or filter changes
  useEffect(() => { setVisibleCount(10); }, [filter, search]);

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
    if (search && !s.machineName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const visible = filtered.slice(0, visibleCount);

  function openEdit(s: any) {
    setEditScore({ id: s.id, machineId: s.machineId, machineName: s.machineName, score: s.score, type: s.type, playedAt: s.playedAt });
    setEditScoreVal(Number(s.score).toLocaleString());
    setEditType(s.type);
    setEditPlayedAt(new Date(s.playedAt).toISOString().slice(0, 16));
    setEditMachineSearch(s.machineName);
  }

  async function handleSave() {
    if (!editScore) return;
    let resolvedMachineId = editScore.machineId;
    if (editMachineSearch !== editScore.machineName) {
      const machine = await authApi.machines.upsert({ name: editMachineSearch });
      resolvedMachineId = machine.id;
    }
    patchMutation.mutate({
      id: editScore.id,
      body: {
        score: Number(editScoreVal.replace(/,/g, '')),
        type: editType,
        playedAt: editPlayedAt,
        ...(resolvedMachineId !== editScore.machineId && { machineId: resolvedMachineId }),
      },
    });
  }

  return (
    <div>
      <h1 className="text-4xl font-black uppercase tracking-widest text-white mb-1">Recent Scores</h1>
      <p className="text-sm text-muted-foreground mb-4">Your latest plays across the grid.</p>

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
          placeholder="Search machines..."
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
        <p className="text-muted-foreground">No scores yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((s: any) => (
              <ScoreCard
                key={s.id}
                {...s}
                isHighScore={bestScores.get(s.machineId) === s.score}
                onEdit={isAdmin ? () => openEdit(s) : undefined}
                onDelete={isAdmin ? () => setDeleteScoreId(s.id) : undefined}
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

      {/* Edit dialog */}
      <Dialog.Root open={!!editScore} onOpenChange={open => { if (!open) setEditScore(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <Dialog.Title className="text-lg font-black uppercase tracking-wider text-white">Edit Score</Dialog.Title>
              <Dialog.Close className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors">
                <X className="w-4 h-4" />
              </Dialog.Close>
            </div>
            <div className="flex flex-col gap-4">
              {/* Machine */}
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Machine</span>
                <div className="relative">
                  <input
                    value={editMachineSearch}
                    onChange={e => setEditMachineSearch(e.target.value)}
                    placeholder="Search machines..."
                    className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                  />
                  {(machineSuggestions as any[]).length > 0 && editMachineSearch !== editScore?.machineName && (
                    <div className="absolute top-full left-0 right-0 mt-1 z-10 rounded-lg border border-white/10 bg-card overflow-hidden shadow-xl">
                      {(machineSuggestions as any[]).slice(0, 6).map((m: any) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setEditMachineSearch(m.name)}
                          className="w-full text-left px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </label>

              {/* Score */}
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Score</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={editScoreVal}
                  onChange={e => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    setEditScoreVal(raw ? Number(raw).toLocaleString() : '');
                  }}
                  className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                />
              </label>

              {/* Type */}
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Type</span>
                <select
                  value={editType}
                  onChange={e => setEditType(e.target.value as 'casual' | 'tournament')}
                  className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                >
                  <option value="casual">Casual</option>
                  <option value="tournament">Tournament</option>
                </select>
              </label>

              {/* Date & Time */}
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Date & Time</span>
                <input
                  type="datetime-local"
                  value={editPlayedAt}
                  onChange={e => setEditPlayedAt(e.target.value)}
                  className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                />
              </label>

              {patchMutation.isError && (
                <p className="text-xs text-red-400">{(patchMutation.error as any)?.message}</p>
              )}
              <div className="flex gap-3 pt-1">
                <Dialog.Close className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
                  Cancel
                </Dialog.Close>
                <button
                  onClick={handleSave}
                  disabled={patchMutation.isPending}
                  className="flex-1 py-2.5 rounded-lg bg-primary text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {patchMutation.isPending ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

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
