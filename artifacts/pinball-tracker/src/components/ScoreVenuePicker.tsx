import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Plus, AlertTriangle } from 'lucide-react';
import { useApi } from '../lib/useApi';

interface Props {
  scoreId: number;
  /** The name the score was logged under, if any — worth showing as a hint for what to search. */
  venueNameSnapshot: string | null;
  /** Fired once the score has a venue, so the caller can swap in the linkage/repair UI. */
  onAttached: (venue: { id: number; name: string }) => void;
}

// Attaches a venue to a score that never got one — either because the upload flow's "Skip — no
// venue" was taken, or because the photo carried no GPS and nothing was offered to skip past.
//
// Until this existed such a score was a dead end: the edit modal showed the missing venue as inert
// text, and with no venue there is no Pinball Map location, so its machine could never be verified
// either. Picking a venue here is what unlocks ScoreRepairSection.
//
// Like the rest of the repair UI, attaching applies immediately rather than waiting for the modal's
// Save — the steps that follow it all read the venue from the server.
export default function ScoreVenuePicker({ scoreId, venueNameSnapshot, onAttached }: Props) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState(venueNameSnapshot ?? '');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false);
  const [isResidence, setIsResidence] = useState(false);
  const [privacyTier, setPrivacyTier] = useState<'full' | 'city_state' | 'hidden'>('full');

  const { data: venues = [], isLoading } = useQuery<any[]>({
    queryKey: ['venues'],
    queryFn: () => api.venues.list(),
  });

  const { data: addressSuggestions = [] } = useQuery<any[]>({
    queryKey: ['address-autocomplete', newAddress],
    queryFn: () => api.venues.addressAutocomplete(newAddress),
    enabled: adding && newAddress.trim().length > 2,
  });

  const attach = useMutation({
    mutationFn: (venue: { id: number; name: string }) =>
      api.scores.patch(scoreId, { venueId: venue.id }).then(() => venue),
    onSuccess: venue => {
      queryClient.invalidateQueries({ queryKey: ['scores'] });
      queryClient.invalidateQueries({ queryKey: ['venues'] });
      queryClient.invalidateQueries({ queryKey: ['score-repair', scoreId] });
      onAttached(venue);
    },
    onError: (e: any) => setError(e.message ?? 'Could not attach that venue'),
  });

  const createVenue = useMutation({
    mutationFn: () =>
      api.venues.create({
        name: newName.trim(),
        address: newAddress.trim(),
        isResidence,
        privacyTier,
      }),
    // Creating and attaching are two requests; only the second one decides whether the score is
    // fixed, so chain rather than reporting success off the create.
    onSuccess: (venue: any) => attach.mutate({ id: venue.id, name: venue.name }),
    onError: (e: any) => setError(e.message ?? 'Could not create that venue'),
  });

  const q = search.trim().toLowerCase();
  const matches = q
    ? venues.filter(v => v.name.toLowerCase().includes(q) || (v.address ?? '').toLowerCase().includes(q))
    : venues;
  const busy = attach.isPending || createVenue.isPending;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex flex-col gap-3">
      <p className="flex items-start gap-2 text-xs text-amber-400">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>
          No venue on this score
          {venueNameSnapshot ? ` (it was logged as “${venueNameSnapshot}”)` : ''}. Pick one to unlock
          Pinball Map and machine checking — this applies straight away.
        </span>
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {!adding ? (
        <>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search venues..."
            className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
          />

          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading venues...</p>
          ) : matches.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No venue matches “{search}”. Add it below.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
              {matches.slice(0, 30).map(v => (
                <li key={v.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setError(null); attach.mutate({ id: v.id, name: v.name }); }}
                    className="w-full flex items-center gap-2 text-left rounded border border-white/10 bg-card px-2.5 py-1.5 hover:bg-white/10 disabled:opacity-40 transition-colors"
                  >
                    <MapPin className="w-3.5 h-3.5 text-venue flex-shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-venue truncate">{v.name}</span>
                      {v.address && (
                        <span className="block text-[0.65rem] text-muted-foreground truncate">{v.address}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={() => { setError(null); setNewName(search); setAdding(true); }}
            className="flex items-center gap-1 self-start text-xs text-venue hover:text-venue/80 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add a new venue
          </button>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</span>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Headquarters"
              className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>

          <div className="relative flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Address</span>
            <input
              value={newAddress}
              onChange={e => { setNewAddress(e.target.value); setShowAddressSuggestions(true); }}
              onFocus={() => setShowAddressSuggestions(true)}
              onBlur={() => setTimeout(() => setShowAddressSuggestions(false), 150)}
              placeholder="Street, City, State"
              autoComplete="off"
              className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
            {showAddressSuggestions && addressSuggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-10 mt-1 rounded-lg border border-white/10 bg-background overflow-hidden shadow-xl">
                {addressSuggestions.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { setNewAddress(s.label); setShowAddressSuggestions(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[0.65rem] text-muted-foreground">
              The address is what HERE and Pinball Map are matched against in the next steps.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-white/80">
            <input
              type="checkbox"
              checked={isResidence}
              onChange={e => { setIsResidence(e.target.checked); setPrivacyTier(e.target.checked ? 'hidden' : 'full'); }}
            />
            This is my residence
          </label>
          {isResidence && (
            <div className="flex flex-col gap-1.5 pl-1">
              <p className="text-xs text-muted-foreground">Show my address as:</p>
              {([
                { value: 'full', label: 'Full address' },
                { value: 'city_state', label: 'City & state only' },
                { value: 'hidden', label: 'Fully hidden' },
              ] as const).map(opt => (
                <label key={opt.value} className="flex items-center gap-2 text-sm text-white/80">
                  <input
                    type="radio"
                    name="score-venue-privacy"
                    checked={privacyTier === opt.value}
                    onChange={() => setPrivacyTier(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); setError(null); }}
              className="flex-1 py-2 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!newName.trim() || !newAddress.trim() || busy}
              onClick={() => { setError(null); createVenue.mutate(); }}
              className="flex-1 py-2 rounded-lg bg-venue text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {busy ? 'Saving...' : 'Add & attach'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
