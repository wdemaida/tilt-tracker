import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { Star, Pencil, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';
import { queryClient } from '../lib/queryClient';
import { format } from 'date-fns';

interface Machine {
  id: number;
  name: string;
  manufacturer?: string | null;
  year?: number | null;
  imageUrl?: string | null;
  bestScore: number;
  playCount: number;
  lastPlayed: string;
}

interface EditMachine {
  id: number;
  name: string;
  manufacturer: string;
  year: string;
}

type SortKey = 'name' | 'playCount' | 'lastPlayed' | 'bestScore';
type SortDir = 'asc' | 'desc';

export default function MachinesPage() {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('bestScore');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [editMachine, setEditMachine] = useState<EditMachine | null>(null);
  const [deleteMachineId, setDeleteMachineId] = useState<number | null>(null);
  const [, navigate] = useLocation();

  const authApi = useApi();
  const appUser = useAppUser();
  const isAdmin = appUser?.role === 'admin';
  const { mine } = useScopeContext();

  const { data: machines = [], isLoading } = useQuery({
    queryKey: ['machines', mine],
    queryFn: () => authApi.machines.list(mine),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) => authApi.machines.patch(id, body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['machines'] }); setEditMachine(null); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => authApi.machines.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['machines'] }); setDeleteMachineId(null); },
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  const filtered = (machines as Machine[])
    .filter(m => m.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'playCount') cmp = a.playCount - b.playCount;
      else if (sortKey === 'lastPlayed') cmp = new Date(a.lastPlayed).getTime() - new Date(b.lastPlayed).getTime();
      else if (sortKey === 'bestScore') cmp = a.bestScore - b.bestScore;
      return sortDir === 'asc' ? cmp : -cmp;
    });

  function openEdit(m: Machine, e: React.MouseEvent) {
    e.stopPropagation();
    setEditMachine({ id: m.id, name: m.name, manufacturer: m.manufacturer ?? '', year: m.year != null ? String(m.year) : '' });
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronUp className="w-3 h-3 opacity-20" />;
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 text-primary" />
      : <ChevronDown className="w-3 h-3 text-primary" />;
  }

  function SortableHeader({ col, label, align = 'left' }: { col: SortKey; label: string; align?: 'left' | 'right' }) {
    return (
      <th className={`py-3 px-4 ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <button
          onClick={() => toggleSort(col)}
          className={`flex items-center gap-1 text-xs font-bold uppercase tracking-wider transition-colors ${sortKey === col ? 'text-primary' : 'text-muted-foreground hover:text-white'} ${align === 'right' ? 'ml-auto' : ''}`}
        >
          {label}
          <SortIcon col={col} />
        </button>
      </th>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">Machines</h1>
        <ScopeToggle />
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {machines.length} {(machines as Machine[]).length === 1 ? 'machine' : 'machines'} {mine ? 'you\'ve played' : 'played across site'} · click a row to see full history
      </p>

      <div className="rounded-xl border border-white/10 bg-card p-3 mb-4">
        <input
          type="text"
          placeholder="Search machines..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-transparent text-sm text-white placeholder:text-muted-foreground focus:outline-none px-2 py-1"
        />
      </div>

      {isLoading ? <p className="text-muted-foreground">Loading...</p> : filtered.length === 0 ? (
        <p className="text-muted-foreground">No machines found.</p>
      ) : (
        <div className="rounded-xl border border-white/10 bg-card overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="border-b border-white/10">
                <SortableHeader col="name" label="Machine" />
                <SortableHeader col="playCount" label="Plays" />
                <SortableHeader col="lastPlayed" label="Last Played" />
                <SortableHeader col="bestScore" label="Best Score" align="right" />
                {isAdmin && <th className="w-16" />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((m, i) => (
                <tr
                  key={m.id}
                  onClick={() => navigate(`/machines/${encodeURIComponent(m.name)}`)}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer"
                >
                  {/* Machine name + image + mfr/year */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {m.imageUrl ? (
                        <img src={m.imageUrl} alt={m.name} className="w-9 h-9 rounded-lg object-cover flex-shrink-0 border border-white/10" />
                      ) : (
                        <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                          {i === 0 && sortKey === 'bestScore' && sortDir === 'desc'
                            ? <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                            : <span className="text-xs font-bold text-muted-foreground">#{i + 1}</span>
                          }
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-black uppercase tracking-wider text-white truncate">{m.name}</p>
                        {(m.manufacturer || m.year) && (
                          <p className="text-xs text-muted-foreground">{[m.manufacturer, m.year].filter(Boolean).join(' · ')}</p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Plays */}
                  <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                    {m.playCount}
                  </td>

                  {/* Last Played */}
                  <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                    {format(new Date(m.lastPlayed), 'M/d/yyyy')}
                  </td>

                  {/* Best Score */}
                  <td className="px-4 py-3 text-right font-bold text-lg text-primary whitespace-nowrap">
                    {Number(m.bestScore).toLocaleString()}
                  </td>

                  {/* Admin buttons */}
                  {isAdmin && (
                    <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={e => openEdit(m, e)}
                          className="p-1 rounded text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
                          aria-label="Edit machine"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setDeleteMachineId(m.id); }}
                          className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors"
                          aria-label="Delete machine"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit dialog */}
      <Dialog.Root open={!!editMachine} onOpenChange={open => { if (!open) setEditMachine(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <Dialog.Title className="text-lg font-black uppercase tracking-wider text-white">Edit Machine</Dialog.Title>
              <Dialog.Close className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors">
                <X className="w-4 h-4" />
              </Dialog.Close>
            </div>
            {editMachine && (
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</span>
                  <input
                    value={editMachine.name}
                    onChange={e => setEditMachine({ ...editMachine, name: e.target.value })}
                    className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Manufacturer</span>
                  <input
                    value={editMachine.manufacturer}
                    onChange={e => setEditMachine({ ...editMachine, manufacturer: e.target.value })}
                    className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Year</span>
                  <input
                    type="number"
                    value={editMachine.year}
                    onChange={e => setEditMachine({ ...editMachine, year: e.target.value })}
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
                    onClick={() => patchMutation.mutate({ id: editMachine.id, body: { name: editMachine.name, manufacturer: editMachine.manufacturer, year: editMachine.year } })}
                    disabled={patchMutation.isPending}
                    className="flex-1 py-2.5 rounded-lg bg-primary text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {patchMutation.isPending ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Delete confirm dialog */}
      <Dialog.Root open={deleteMachineId !== null} onOpenChange={open => { if (!open) setDeleteMachineId(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
            <Dialog.Title className="text-lg font-black uppercase tracking-wider text-white mb-2">Delete Machine?</Dialog.Title>
            <p className="text-sm text-muted-foreground mb-5">This cannot be undone. Blocked if any scores exist for this machine.</p>
            {deleteMutation.isError && (
              <p className="text-xs text-red-400 mb-3">{(deleteMutation.error as any)?.message}</p>
            )}
            <div className="flex gap-3">
              <Dialog.Close className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
                Cancel
              </Dialog.Close>
              <button
                onClick={() => deleteMachineId !== null && deleteMutation.mutate(deleteMachineId)}
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
