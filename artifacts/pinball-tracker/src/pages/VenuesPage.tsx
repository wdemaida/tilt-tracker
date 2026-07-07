import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'wouter';
import { MapPin, Trophy, X, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { PinballIcon } from '../components/PinballIcon';
import * as Dialog from '@radix-ui/react-dialog';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';
import { queryClient } from '../lib/queryClient';

interface Venue {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  pinballMapId: number | null;
  pmMachineCount: number | null;
  scoreCount: number;
  machineCount: number;
}

interface VenueMachinesData {
  venue: Venue;
  ownMachines: Array<{ id: number; name: string; manufacturer?: string; year?: number; bestScore: number; playCount: number }>;
  pmMachines: Array<{ xrefId: number; id: number; name: string; manufacturer?: string; year?: number }>;
  formerMachines: Array<{ id: number; name: string; manufacturer?: string; year?: number; firstSeenAt: string; removedAt: string }>;
  ttMachineNames: string[];
}

interface EditVenue { id: number; name: string; address: string; }

// Addresses look like "..., City, ST" or "..., City, ST ZIP, United States" — the state
// abbreviation is whichever comma-separated segment starts with two uppercase letters.
function parseState(address: string | null): string | null {
  if (!address) return null;
  const segments = address.split(',').map(s => s.trim());
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = segments[i].match(/^([A-Z]{2})\b/);
    if (m) return m[1];
  }
  return null;
}

export default function VenuesPage() {
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [modalVenueId, setModalVenueId] = useState<number | null>(null);
  const [editVenue, setEditVenue] = useState<EditVenue | null>(null);
  const [deleteVenueId, setDeleteVenueId] = useState<number | null>(null);

  const authApi = useApi();
  const appUser = useAppUser();
  const isAdmin = appUser?.role === 'admin';
  const { mine } = useScopeContext();

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) => authApi.venues.patch(id, body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['venues'] }); setEditVenue(null); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => authApi.venues.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['venues'] }); setDeleteVenueId(null); },
  });

  const { data: venues = [], isLoading } = useQuery({
    queryKey: ['venues', mine],
    queryFn: () => authApi.venues.list(mine),
  });

  const { data: machinesData, isLoading: machinesLoading } = useQuery<VenueMachinesData>({
    queryKey: ['venue-machines', modalVenueId],
    queryFn: () => authApi.venues.machines(modalVenueId!),
    enabled: modalVenueId != null,
  });

  const ownNames = new Set((machinesData?.ownMachines ?? []).map(m => m.name.toLowerCase()));
  const pmMachinesExcludingOwn = (machinesData?.pmMachines ?? []).filter(m => !ownNames.has(m.name.toLowerCase()));
  const ttNamesLower = new Set((machinesData?.ttMachineNames ?? []).map(n => n.toLowerCase()));

  const states = useMemo(
    () => Array.from(new Set((venues as Venue[]).map(v => parseState(v.address)).filter((v): v is string => !!v))).sort(),
    [venues]
  );

  const filteredVenues = (venues as Venue[])
    .filter(v => {
      const q = search.toLowerCase();
      return v.name.toLowerCase().includes(q) || (v.address ?? '').toLowerCase().includes(q);
    })
    .filter(v => !stateFilter || parseState(v.address) === stateFilter)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">Venues</h1>
        <ScopeToggle />
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {filteredVenues.length} {filteredVenues.length === 1 ? 'venue' : 'venues'} {mine ? 'you\'ve visited' : 'visited across site'}
      </p>

      <div className="rounded-xl border border-white/10 bg-card p-3 mb-4 flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          placeholder="Search venues..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder:text-muted-foreground focus:outline-none px-2 py-1"
        />
        <select
          value={stateFilter}
          onChange={e => setStateFilter(e.target.value)}
          className="bg-transparent text-sm text-white focus:outline-none px-2 py-1 border-t sm:border-t-0 sm:border-l border-white/10 sm:pl-3"
        >
          <option value="" className="bg-card">All States</option>
          {states.map(s => <option key={s} value={s} className="bg-card">{s}</option>)}
        </select>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : venues.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-card p-12 text-center">
          <MapPin className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-white font-bold uppercase tracking-wider">No venues yet</p>
          <p className="text-sm text-muted-foreground mt-1">Add a score with a venue to see it here</p>
        </div>
      ) : filteredVenues.length === 0 ? (
        <p className="text-muted-foreground">No venues found.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredVenues.map(venue => (
            <div
              key={venue.id}
              className="rounded-xl border border-white/10 bg-card p-5 flex flex-col gap-3 hover:border-venue/30 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <Link href={`/map?venueId=${venue.id}`} className="font-black uppercase tracking-wider text-venue text-sm leading-tight hover:text-venue/80 transition-colors">
                    {venue.name}
                  </Link>
                  {venue.address && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{venue.address}</p>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => setEditVenue({ id: venue.id, name: venue.name, address: venue.address ?? '' })}
                      className="p-1 rounded text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
                      aria-label="Edit venue"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteVenueId(venue.id)}
                      className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors"
                      aria-label="Delete venue"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Link
                  href={`/venues/${venue.id}`}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/30 hover:bg-primary/20 hover:border-primary/60 transition-colors"
                >
                  <Trophy className="w-3 h-3 text-primary" />
                  <span className="text-xs text-primary font-bold">
                    {venue.scoreCount} {venue.scoreCount === 1 ? 'score' : 'scores'}
                  </span>
                </Link>

                <button
                  onClick={() => setModalVenueId(venue.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-machine/10 border border-machine/30 hover:bg-machine/20 hover:border-machine/60 transition-colors"
                >
                  <PinballIcon className="w-3 h-3 text-machine" />
                  <span className="text-xs text-machine font-bold">
                    {venue.pmMachineCount != null
                      ? `${venue.machineCount}/${venue.pmMachineCount} machines`
                      : `${venue.machineCount} ${venue.machineCount === 1 ? 'machine' : 'machines'}`}
                  </span>
                </button>

                {venue.pinballMapId && (
                  <a
                    href={`https://pinballmap.com/map?by_location_id=${venue.pinballMapId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-violet-500/10 border border-violet-500/30 hover:bg-violet-500/20 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3 text-violet-400" />
                    <span className="text-xs text-violet-400 font-medium">Pinball Map</span>
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit venue dialog */}
      <Dialog.Root open={!!editVenue} onOpenChange={open => { if (!open) setEditVenue(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <Dialog.Title className="text-lg font-black uppercase tracking-wider text-white">Edit Venue</Dialog.Title>
              <Dialog.Close className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors">
                <X className="w-4 h-4" />
              </Dialog.Close>
            </div>
            {editVenue && (
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</span>
                  <input
                    value={editVenue.name}
                    onChange={e => setEditVenue({ ...editVenue, name: e.target.value })}
                    className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Address</span>
                  <input
                    value={editVenue.address}
                    onChange={e => setEditVenue({ ...editVenue, address: e.target.value })}
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
                    onClick={() => patchMutation.mutate({ id: editVenue.id, body: { name: editVenue.name, address: editVenue.address } })}
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

      {/* Delete venue confirm dialog */}
      <Dialog.Root open={deleteVenueId !== null} onOpenChange={open => { if (!open) setDeleteVenueId(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
            <Dialog.Title className="text-lg font-black uppercase tracking-wider text-white mb-2">Delete Venue?</Dialog.Title>
            <p className="text-sm text-muted-foreground mb-5">This cannot be undone. Blocked if any scores are logged at this venue.</p>
            {deleteMutation.isError && (
              <p className="text-xs text-red-400 mb-3">{(deleteMutation.error as any)?.message}</p>
            )}
            <div className="flex gap-3">
              <Dialog.Close className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
                Cancel
              </Dialog.Close>
              <button
                onClick={() => deleteVenueId !== null && deleteMutation.mutate(deleteVenueId)}
                disabled={deleteMutation.isPending}
                className="flex-1 py-2.5 rounded-lg bg-red-600 text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Machines Modal */}
      {modalVenueId != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setModalVenueId(null); }}
        >
          <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-card shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-bold">Machines at</p>
                <h2 className="text-lg font-black uppercase tracking-wider text-venue leading-tight">
                  {machinesData?.venue.name ?? '...'}
                </h2>
              </div>
              <button
                onClick={() => setModalVenueId(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto max-h-[60vh] p-6 flex flex-col gap-6">
              {machinesLoading ? (
                <p className="text-muted-foreground text-sm">Loading...</p>
              ) : (
                <>
                  {/* Your scores */}
                  {machinesData && machinesData.ownMachines.length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                        Your scores here
                      </p>
                      <div className="flex flex-col gap-2">
                        {machinesData.ownMachines.map(m => (
                          <div
                            key={m.id}
                            className="flex flex-col gap-2 rounded-lg border border-white/10 bg-background px-4 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-sm font-bold text-machine leading-snug min-w-0">{m.name}</span>
                              <span className="text-sm font-bold text-primary whitespace-nowrap flex-shrink-0">
                                {Number(m.bestScore).toLocaleString()}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-xs text-muted-foreground">
                                {[m.manufacturer, m.year].filter(Boolean).join(' · ') || ' '}
                              </span>
                              <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
                                {m.playCount} {m.playCount === 1 ? 'play' : 'plays'}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Pinball Map machines */}
                  {pmMachinesExcludingOwn.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                          Also on Pinball Map
                        </p>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">
                          {pmMachinesExcludingOwn.length} machines
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {pmMachinesExcludingOwn.map(m => (
                          <div
                            key={m.xrefId}
                            className="flex flex-col gap-2 rounded-lg border border-machine/20 bg-machine/5 px-4 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-sm font-bold text-machine leading-snug min-w-0">{m.name}</span>
                              {ttNamesLower.has(m.name.toLowerCase()) && (
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <span title="In TiltTrack" className="text-xs px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">TT</span>
                                </div>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {[m.manufacturer, m.year].filter(Boolean).join(' · ') || ' '}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Formerly here — inferred from Pinball Map's removal history */}
                  {machinesData && machinesData.formerMachines.length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                        Formerly here
                      </p>
                      <div className="flex flex-col gap-2">
                        {machinesData.formerMachines.map(m => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between rounded-lg border border-white/10 bg-background/50 px-4 py-3 opacity-70"
                          >
                            <span className="text-sm font-bold text-muted-foreground">{m.name}</span>
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              left {format(new Date(m.removedAt), 'MMM yyyy')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {machinesData && machinesData.ownMachines.length === 0 && pmMachinesExcludingOwn.length === 0 && machinesData.formerMachines.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No machine data available</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
