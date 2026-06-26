import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'wouter';
import { MapPin, Trophy, X, ExternalLink, Pencil, Trash2 } from 'lucide-react';
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
  ownMachines: Array<{ id: number; name: string; bestScore: number; playCount: number }>;
  pmMachines: Array<{ xrefId: number; id: number; name: string; manufacturer?: string; year?: number }>;
}

interface EditVenue { id: number; name: string; address: string; }

export default function VenuesPage() {
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

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">Venues</h1>
        <ScopeToggle />
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {venues.length} {venues.length === 1 ? 'venue' : 'venues'} {mine ? 'you\'ve visited' : 'visited across site'}
      </p>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : venues.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-card p-12 text-center">
          <MapPin className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-white font-bold uppercase tracking-wider">No venues yet</p>
          <p className="text-sm text-muted-foreground mt-1">Add a score with a venue to see it here</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(venues as Venue[]).map(venue => (
            <div
              key={venue.id}
              className="rounded-xl border border-white/10 bg-card p-5 flex flex-col gap-3 hover:border-primary/30 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <MapPin className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <Link href={`/venues/${venue.id}`} className="font-black uppercase tracking-wider text-white text-sm leading-tight hover:text-primary transition-colors">
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
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10">
                  <Trophy className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-medium">
                    {venue.scoreCount} {venue.scoreCount === 1 ? 'score' : 'scores'}
                  </span>
                </div>

                <button
                  onClick={() => setModalVenueId(venue.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/30 hover:bg-primary/20 hover:border-primary/60 transition-colors"
                >
                  <PinballIcon className="w-3 h-3 text-primary" />
                  <span className="text-xs text-primary font-bold">
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
                <h2 className="text-lg font-black uppercase tracking-wider text-white leading-tight">
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
                            className="flex items-center justify-between rounded-lg border border-white/10 bg-background px-4 py-3"
                          >
                            <div className="flex items-center gap-2">
                              <PinballIcon className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                              <span className="text-sm font-bold text-white">{m.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {m.playCount} {m.playCount === 1 ? 'play' : 'plays'}
                              </span>
                            </div>
                            <span className="text-sm font-bold text-primary">{Number(m.bestScore).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Pinball Map machines */}
                  {machinesData && machinesData.pmMachines.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                          Also on Pinball Map
                        </p>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">
                          {machinesData.pmMachines.length} machines
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {machinesData.pmMachines.map(m => (
                          <div
                            key={m.xrefId}
                            className="flex items-center justify-between rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-3"
                          >
                            <div className="flex items-center gap-2">
                              <PinballIcon className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
                              <span className="text-sm font-bold text-white">{m.name}</span>
                            </div>
                            {(m.manufacturer || m.year) && (
                              <span className="text-xs text-muted-foreground">
                                {[m.manufacturer, m.year].filter(Boolean).join(' · ')}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {machinesData && machinesData.ownMachines.length === 0 && machinesData.pmMachines.length === 0 && (
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
