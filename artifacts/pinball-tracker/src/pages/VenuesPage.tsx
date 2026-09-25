import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'wouter';
import { MapPin, Trophy, ExternalLink, Pencil, Trash2, Home, AlertTriangle } from 'lucide-react';
import { PinballIcon } from '../components/PinballIcon';
import VenueMachinesModal from '../components/VenueMachinesModal';
import EditVenueDialog, { editTargetFromVenue, type EditVenueTarget } from '../components/EditVenueDialog';
import * as Dialog from '@radix-ui/react-dialog';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';
import { queryClient } from '../lib/queryClient';

// Someone else's home venue arrives trimmed to what its card needs (name, the address its privacy
// tier allows, counts) — no ownerId, tier, coordinates or timezone. Hence the optional fields.
interface Venue {
  id: number;
  name: string;
  address: string | null;
  pinballMapId: number | null;
  pmMachineCount: number | null;
  isResidence: boolean;
  /** Only on rows this viewer can edit (seeds the Edit Venue dialog). */
  privacyTier?: 'full' | 'city_state' | 'hidden';
  showMachinesAndScores?: boolean;
  /** Scores this viewer can see here. */
  scoreCount: number;
  /** Null when the owner keeps this venue's machines private from this viewer. */
  machineCount: number | null;
  /** Residence or restricted tier. */
  isPrivate: boolean;
  /** Owner or admin — decided server-side; shows the edit pencil. */
  canEdit: boolean;
  /** The owner turned "Show my machines/scores publicly" off, and this viewer isn't exempt. */
  activityHidden: boolean;
  /** No address and not a residence — fixable from the venue page's repair panel. */
  needsAddress?: boolean;
  /** Whether *this* viewer may repair the venue (admin / owner / creator) — decided server-side. */
  canRepair?: boolean;
}

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
  const [editVenue, setEditVenue] = useState<EditVenueTarget | null>(null);
  const [deleteVenueId, setDeleteVenueId] = useState<number | null>(null);
  const [onlyNeedsAddress, setOnlyNeedsAddress] = useState(false);

  const authApi = useApi();
  const appUser = useAppUser();
  const isAdmin = appUser?.role === 'admin';
  const { mine } = useScopeContext();

  const deleteMutation = useMutation({
    mutationFn: (id: number) => authApi.venues.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['venues'] }); setDeleteVenueId(null); },
  });

  const { data: venues = [], isLoading } = useQuery({
    queryKey: ['venues', mine],
    queryFn: () => authApi.venues.list(mine),
  });

  const states = useMemo(
    () => Array.from(new Set((venues as Venue[]).map(v => parseState(v.address)).filter((v): v is string => !!v))).sort(),
    [venues]
  );

  // "Needs address" is only shown to someone who can act on it — the server's `canRepair`, the same
  // rule as the repair routes. Everyone else sees the card exactly as before.
  const showNeedsAddress = (v: Venue) => !!v.needsAddress && !!v.canRepair;
  const needsAddressCount = (venues as Venue[]).filter(showNeedsAddress).length;

  const filteredVenues = (venues as Venue[])
    .filter(v => !onlyNeedsAddress || showNeedsAddress(v))
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
        {(needsAddressCount > 0 || onlyNeedsAddress) && (
          <button
            onClick={() => setOnlyNeedsAddress(o => !o)}
            aria-pressed={onlyNeedsAddress}
            className={`flex items-center gap-1 text-xs font-bold uppercase tracking-wider rounded-full border px-2.5 py-1 transition-colors self-start sm:self-center ${
              onlyNeedsAddress ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10'
            }`}
          >
            <AlertTriangle className="w-3 h-3" />
            {needsAddressCount} need{needsAddressCount === 1 ? 's' : ''} an address
          </button>
        )}
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
                  <div className="flex items-center gap-1.5">
                    <Link href={`/venues/${venue.id}`} className="font-black uppercase tracking-wider text-venue text-sm leading-tight hover:text-venue/80 transition-colors">
                      {venue.name}
                    </Link>
                    {venue.isResidence && (
                      <span title="Residence">
                        <Home className="w-3 h-3 text-venue/70 flex-shrink-0" />
                      </span>
                    )}
                  </div>
                  {venue.address ? (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{venue.address}</p>
                  ) : venue.isResidence || venue.isPrivate ? (
                    <p className="text-xs text-muted-foreground/60 italic mt-0.5">Address hidden</p>
                  ) : showNeedsAddress(venue) ? (
                    <Link
                      href={`/venues/${venue.id}`}
                      title="Open the venue page to find its address"
                      className="inline-flex items-center gap-1 mt-1 text-[0.65rem] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors"
                    >
                      <AlertTriangle className="w-3 h-3" />
                      Needs address
                    </Link>
                  ) : null}
                </div>
                {venue.canEdit && (
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => setEditVenue(editTargetFromVenue(venue))}
                      className="p-1 rounded text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
                      aria-label="Edit venue"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => setDeleteVenueId(venue.id)}
                        className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors"
                        aria-label="Delete venue"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {/* A home venue whose owner keeps its machines and scores private shows only its
                    name — plus your own scores there, if you have any. */}
                {(!venue.activityHidden || venue.scoreCount > 0) && (
                  <Link
                    href={`/venues/${venue.id}`}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/30 hover:bg-primary/20 hover:border-primary/60 transition-colors"
                  >
                    <Trophy className="w-3 h-3 text-primary" />
                    <span className="text-xs text-primary font-bold">
                      {venue.scoreCount} {venue.scoreCount === 1 ? 'score' : 'scores'}
                    </span>
                  </Link>
                )}

                {venue.machineCount != null && (
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
                )}

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

      <EditVenueDialog venue={editVenue} onClose={() => setEditVenue(null)} />

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

      <VenueMachinesModal venueId={modalVenueId} onClose={() => setModalVenueId(null)} />
    </div>
  );
}
