import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Plus, X, Loader2 } from 'lucide-react';
import { PinballIcon } from './PinballIcon';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import type { VenueInventory } from '../lib/api';

interface Props {
  venueId: number;
  inventory: VenueInventory | null;
  canManage: boolean;
}

// A home venue's machines, kept by hand — private venues can't use a Pinball Map roster. Everyone who
// may see the venue's machines sees the list; its owner and admins can add and remove. Adding picks
// from the same Pinball Map machine catalog the score wizard searches; the server refuses anything
// that isn't in it.
export default function VenueInventoryPanel({ venueId, inventory, canManage }: Props) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = query.trim();

  const { data: suggestions = [], isFetching } = useQuery({
    queryKey: ['machine-search', q],
    queryFn: () => api.machines.search(q),
    enabled: canManage && q.length > 1,
    staleTime: 60_000,
  });

  const refresh = (next: VenueInventory) => {
    queryClient.setQueryData(['venue-machines', venueId], (old: any) => (old ? { ...old, inventory: next } : old));
    queryClient.invalidateQueries({ queryKey: ['venue-machines', venueId] });
    queryClient.invalidateQueries({ queryKey: ['venue-scores', String(venueId)] });
    queryClient.invalidateQueries({ queryKey: ['venues'] });
  };

  const add = useMutation({
    mutationFn: (name: string) => api.venues.inventory.add(venueId, { name }),
    onSuccess: r => { setQuery(''); setError(null); refresh(r.inventory); },
    onError: (e: any) => setError(e?.message ?? 'Could not add that machine'),
  });
  const remove = useMutation({
    mutationFn: (machineId: number) => api.venues.inventory.remove(venueId, machineId),
    onSuccess: r => { setError(null); refresh(r.inventory); },
    onError: (e: any) => setError(e?.message ?? 'Could not remove that machine'),
  });

  const machines = inventory?.machines ?? [];
  if (!canManage && machines.length === 0) return null;
  const listed = new Set(machines.map(m => m.name.toLowerCase()));

  return (
    <section className="rounded-xl border border-white/10 bg-card p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <PinballIcon className="w-4 h-4" />
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Machines here</h2>
        <span className="text-xs px-1.5 py-0.5 rounded bg-machine/15 text-machine font-bold">{machines.length}</span>
      </div>

      {machines.length === 0 ? (
        <p className="text-sm text-muted-foreground mb-3">
          No machines listed yet. Add the ones you have so they show up here and on the Venues page.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 mb-3">
          {machines.map(m => (
            <li key={m.id} className="flex items-center justify-between gap-3 rounded-lg border border-machine/20 bg-machine/5 px-3 py-2">
              <div className="min-w-0">
                <Link href={`/machines/${encodeURIComponent(m.name)}`} className="text-sm font-bold text-machine hover:text-machine/80 transition-colors">
                  {m.name}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {[m.manufacturer, m.year].filter(Boolean).join(' · ') || ' '}
                </span>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => remove.mutate(m.id)}
                  disabled={remove.isPending}
                  aria-label={`Remove ${m.name}`}
                  title="It left — remove it"
                  className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50 flex-shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setError(null); }}
            placeholder="Add a machine — search by name…"
            aria-label="Add a machine"
            className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
          />
          {q.length > 1 && (
            <div className="mt-1 rounded-lg border border-white/10 bg-background max-h-60 overflow-y-auto">
              {isFetching && suggestions.length === 0 ? (
                <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> Searching…
                </p>
              ) : suggestions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">No machines match “{q}”.</p>
              ) : (
                (suggestions as Array<{ id: number; name: string; manufacturer?: string | null; year?: number | null }>).map(s => {
                  const already = listed.has(s.name.toLowerCase());
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={already || add.isPending}
                      onClick={() => add.mutate(s.name)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-white/5 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
                    >
                      <span className="min-w-0">
                        <span className="text-white/90 font-medium">{s.name}</span>
                        <span className="block text-xs text-muted-foreground">{[s.manufacturer, s.year].filter(Boolean).join(' · ')}</span>
                      </span>
                      {already
                        ? <span className="text-xs text-muted-foreground flex-shrink-0">Listed</span>
                        : <Plus className="w-4 h-4 text-machine flex-shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </section>
  );
}
