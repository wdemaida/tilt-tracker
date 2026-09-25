import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Plus, AlertTriangle } from 'lucide-react';
import { useApi } from '../lib/useApi';

interface DuplicateCandidate {
  id: number;
  name: string;
  address: string | null;
  /** Null when the new venue couldn't be geocoded — matched on name alone. */
  distance: number | null;
}

interface Props {
  scoreId: number;
  /** The name the score was logged under, if any — worth showing as a hint for what to search. */
  venueNameSnapshot: string | null;
  /** Fired once the score has a venue, so the caller can swap in the linkage/repair UI. */
  onAttached: (venue: { id: number; name: string; timezone?: string | null }) => void;
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
  // Set when the server rejects the create as a likely duplicate. Holds the existing venues it
  // matched, so the user can attach one instead of making a second copy.
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [privateNearby, setPrivateNearby] = useState(false);

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
    mutationFn: (venue: { id: number; name: string; timezone?: string | null }) =>
      api.scores.patch(scoreId, { venueId: venue.id }).then(() => venue),
    onSuccess: venue => {
      queryClient.invalidateQueries({ queryKey: ['scores'] });
      queryClient.invalidateQueries({ queryKey: ['venues'] });
      queryClient.invalidateQueries({ queryKey: ['score-repair', scoreId] });
      onAttached(venue);
    },
    onError: (e: any) => setError(e.message ?? 'Could not attach that venue'),
  });

  const createVenue = useMutation<any, any, boolean>({
    mutationFn: (allowDuplicate: boolean) =>
      api.venues.create({
        name: newName.trim(),
        address: newAddress.trim(),
        isResidence,
        privacyTier,
        allowDuplicate,
      }),
    // Creating and attaching are two requests; only the second one decides whether the score is
    // fixed, so chain rather than reporting success off the create.
    onSuccess: (venue: any) => { setDuplicates(null); attach.mutate({ id: venue.id, name: venue.name, timezone: venue.timezone }); },
    onError: (e: any) => {
      if (e.code === 'duplicate_venue' && (e.body?.candidates?.length || e.body?.privateNearby)) {
        // Not an error the user should have to re-read as prose — show the matches and let them pick.
        // A private match (someone's residence) arrives only as `privateNearby`, with no details and
        // nothing to attach to; the user can still create their own venue.
        setDuplicates(e.body.candidates ?? []);
        setPrivateNearby(!!e.body.privateNearby);
        setError(null);
      } else {
        setError(e.message ?? 'Could not create that venue');
      }
    },
  });

  // `/api/venues` comes back ordered by play count, which is the Venues page's question ("where do I
  // play most?"). Attaching a venue to a score asks a different one — "where was I?" — and the answer
  // is almost always somewhere recent. Sorting here rather than changing the endpoint keeps the
  // Venues page's ordering intact. Venues with no scores yet sort last, alphabetically.
  // Someone else's residence can't hold your score (the server refuses it), so it isn't offered.
  const byRecency = useMemo(() => venues.filter(v => v.canAttachScore !== false).sort((a, b) => {
    const at = a.lastPlayedAt ? new Date(a.lastPlayedAt).getTime() : null;
    const bt = b.lastPlayedAt ? new Date(b.lastPlayedAt).getTime() : null;
    if (at === null && bt === null) return a.name.localeCompare(b.name);
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at;
  }), [venues]);

  const q = search.trim().toLowerCase();
  const matches = q
    ? byRecency.filter(v => v.name.toLowerCase().includes(q) || (v.address ?? '').toLowerCase().includes(q))
    : byRecency;
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
                    onClick={() => { setError(null); attach.mutate({ id: v.id, name: v.name, timezone: v.timezone }); }}
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

          {duplicates && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 flex flex-col gap-2">
              <p className="flex items-start gap-2 text-xs text-amber-400">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                {duplicates.length > 0 ? (
                  <span>
                    {duplicates.length === 1 ? 'This venue looks like one you already have' : 'These venues look like the one you’re adding'}.
                    Use the existing one, unless this really is a different place.
                    {privateNearby && ' A private venue with this name is also nearby.'}
                  </span>
                ) : (
                  <span>A private venue with this name already exists nearby. You can still add yours.</span>
                )}
              </p>
              <ul className="flex flex-col gap-1.5">
                {duplicates.map(d => (
                  <li key={d.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setError(null); attach.mutate({ id: d.id, name: d.name }); }}
                      className="w-full flex items-center gap-2 text-left rounded border border-white/10 bg-card px-2.5 py-1.5 hover:bg-white/10 disabled:opacity-40 transition-colors"
                    >
                      <MapPin className="w-3.5 h-3.5 text-venue flex-shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-venue truncate">{d.name}</span>
                        <span className="block text-[0.65rem] text-muted-foreground truncate">
                          {d.distance != null ? `${d.distance}m away` : 'same name'}
                          {d.address ? ` · ${d.address}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setError(null); createVenue.mutate(true); }}
                className="self-start text-xs text-muted-foreground hover:text-white underline disabled:opacity-40 transition-colors"
              >
                {duplicates.length > 0 ? 'No, this is a different venue — create it anyway' : 'Create my venue'}
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); setError(null); setDuplicates(null); setPrivateNearby(false); }}
              className="flex-1 py-2 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!newName.trim() || !newAddress.trim() || busy}
              onClick={() => { setError(null); setDuplicates(null); setPrivateNearby(false); createVenue.mutate(false); }}
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
