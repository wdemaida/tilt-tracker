import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { X, Home, Lock, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { useApi } from '../lib/useApi';
import type { MachineVenues } from '../lib/api';
import { parseState } from '../lib/venueState';

interface MachineVenuesModalProps {
  machine: { id: number; name: string } | null;
  onClose: () => void;
}

// The Machines page's "X Venues" pill opens this: where a machine is on the floor right now, and
// public venues it has left. The server decides what may be shown (machineVenues.ts) — someone
// else's home collection is never named, only counted in "+N private collections". Venue rosters
// come from Pinball Map's cached listings (zero Pinball Map calls behind this) and home inventories.
export default function MachineVenuesModal({ machine, onClose }: MachineVenuesModalProps) {
  const authApi = useApi();
  const [stateFilter, setStateFilter] = useState('');

  const { data, isLoading, isError } = useQuery<MachineVenues>({
    queryKey: ['machine-venues', machine?.id],
    queryFn: () => authApi.machines.venues(machine!.id),
    enabled: machine != null,
  });

  // State filter over the addresses the server sent — already redacted, so it can't place anything
  // the server withheld.
  const states = useMemo(() => {
    const all = [...(data?.onFloor ?? []), ...(data?.formerly ?? [])].map(v => parseState(v.address));
    return Array.from(new Set(all.filter((s): s is string => !!s))).sort();
  }, [data]);
  const inState = (address: string | null) => !stateFilter || parseState(address) === stateFilter;
  const onFloor = (data?.onFloor ?? []).filter(v => inState(v.address));
  const formerly = (data?.formerly ?? []).filter(v => inState(v.address));
  // Private collections carry no location, so they can't be placed in a state — shown unfiltered only.
  const privateCount = stateFilter ? 0 : (data?.privateCount ?? 0);
  const titleId = useId();

  // Escape closes, as in BadgeDetail. Only listens while open.
  const open = machine != null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (machine == null) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-card shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-white/10">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-bold">Where to play</p>
            <h2 id={titleId} className="text-lg font-black uppercase tracking-wider text-machine leading-tight truncate">
              {machine.name}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto max-h-[60vh] p-6 flex flex-col gap-6">
          {isLoading ? (
            <p className="text-muted-foreground text-sm">Loading...</p>
          ) : isError || !data ? (
            <p className="text-sm text-red-400">Couldn’t load this machine’s venues.</p>
          ) : (
            <>
              {states.length > 1 && (
                <select
                  value={stateFilter}
                  onChange={e => setStateFilter(e.target.value)}
                  aria-label="Filter by state"
                  className="self-start shrink-0 rounded-lg border border-white/10 bg-background text-sm text-white focus:outline-none px-3 py-1.5"
                >
                  <option value="" className="bg-card">All states</option>
                  {states.map(s => <option key={s} value={s} className="bg-card">{s}</option>)}
                </select>
              )}

              {(onFloor.length > 0 || privateCount > 0) && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                    On the floor
                  </p>
                  <div className="flex flex-col gap-2">
                    {onFloor.map(v => (
                      <Link
                        key={v.id}
                        href={`/venues/${v.id}`}
                        onClick={onClose}
                        className="flex items-start justify-between gap-3 rounded-lg border border-venue/20 bg-venue/5 px-4 py-3 hover:border-venue/40 transition-colors"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-venue leading-snug">{v.name}</span>
                          {v.address && <span className="block text-xs text-muted-foreground truncate">{v.address}</span>}
                        </span>
                        {v.home && (
                          <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-white/10 text-white font-medium flex-shrink-0">
                            <Home className="w-3 h-3" /> Home
                          </span>
                        )}
                      </Link>
                    ))}
                    {privateCount > 0 && (
                      <p className="flex items-center gap-2 rounded-lg border border-white/10 bg-background/50 px-4 py-3 text-sm text-muted-foreground">
                        <Lock className="w-3.5 h-3.5 flex-shrink-0" />
                        +{privateCount} private {privateCount === 1 ? 'collection' : 'collections'}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {formerly.length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                    Formerly here
                  </p>
                  <div className="flex flex-col gap-2">
                    {formerly.map(v => (
                      <Link
                        key={v.id}
                        href={`/venues/${v.id}`}
                        onClick={onClose}
                        className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-background/50 px-4 py-3 opacity-70 hover:opacity-100 transition-opacity"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-muted-foreground leading-snug">{v.name}</span>
                          {v.address && <span className="block text-xs text-muted-foreground truncate">{v.address}</span>}
                        </span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
                          left {format(new Date(v.removedAt), 'MMM yyyy')}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {onFloor.length === 0 && privateCount === 0 && formerly.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {stateFilter ? `No venues in ${stateFilter}.` : 'No venue on TiltTrack lists this machine yet.'}
                </p>
              )}

              {/* Pinball Map's data is CC BY-SA. Each venue's own page links its specific listing. */}
              <a
                href="https://pinballmap.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-venue transition-colors"
              >
                Public venue machine lists from Pinball Map
                <ExternalLink className="w-3 h-3" />
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
