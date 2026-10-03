import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Building2, ChevronDown, Home, Loader2, LocateFixed, Lock, MapPin, Plus, Search, Swords, X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { CHALLENGE_PREFS_KEY, challengeErrorText } from '../lib/challenges';
import { useVenueSearch, MIN_PLACE_SEARCH_CHARS } from '../lib/venueSearch';
import { getCurrentPosition, geoFailureMessage, CurrentPositionError } from '../lib/photoLocation';
import MachinePicker, { type MachineOption } from './MachinePicker';
import { MachineThumb } from './ChallengeParts';
import { PinballIcon } from './PinballIcon';
import DuplicateVenuePrompt, { duplicateCandidates, type DuplicateCandidate } from './DuplicateVenuePrompt';
import LastResortArea from './LastResortArea';
import type { ChallengeMeMachine, ChallengePrefs, ChallengePrefVenue, ChallengeVenueHit } from '../lib/api';

// "Challenge me" (feature/challenge-recs).
//  - Yours (on your profile and the Challenges page, collapsible): the machines you want to be
//    challenged on (max 3) and your challenge locations — venues you can get to, pre-filled once
//    from where you've played, with suggestions to add and a search over TiltTrack's own venues.
//    A place that isn't on TiltTrack yet (a friend's regular bar nobody has logged at) can be added
//    too, from "Near me" or the search's Places fallback — the Add Score venue step's own endpoints
//    (feature/pm-challenge-locations, see AddLocation). Friends' create forms recommend from these.
//    Saved on every change. Under the locations, the "My Last Resort" area (LastResortArea.tsx,
//    feature/last-resort): a ZIP + radius used only when someone taps Expand search.
//  - A friend's profile: their "Challenge me on" machines as chips that open the create form on
//    that exact model. (Challenge locations never show on a profile — only in the create flow.)

const chip = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors';

function VenueChip({ v, onRemove, busy }: { v: ChallengePrefVenue; onRemove: () => void; busy: boolean }) {
  return (
    <span className={`${chip} border-venue/40 text-venue`}>
      {v.isHome ? <Home className="w-3 h-3" aria-hidden /> : <MapPin className="w-3 h-3" aria-hidden />}
      <span className="truncate max-w-[12rem]">{v.name}</span>
      <button type="button" disabled={busy} onClick={onRemove} aria-label={`Remove ${v.name}`} className="text-muted-foreground hover:text-white disabled:opacity-50">
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Collapsed/expanded, remembered per place it's shown. Storage can be missing or throw — then it's just the default. */
const OPEN_KEY = (where: string) => `tilttrack.challengeMe.open.${where}`;
function readOpen(where: string): boolean | null {
  try {
    const v = localStorage.getItem(OPEN_KEY(where));
    return v === '1' ? true : v === '0' ? false : null;
  } catch { return null; }
}
function writeOpen(where: string, open: boolean) {
  try { localStorage.setItem(OPEN_KEY(where), open ? '1' : '0'); } catch { /* not remembered */ }
}

function plural(n: number, one: string) { return `${n} ${one}${n === 1 ? '' : 's'}`; }
/** Letters/digits only — the server searches from 2 of them (MIN_QUERY_CHARS). */
const searchable = (q: string) => q.replace(/[^\p{L}\p{N}]/gu, '').length >= 2;

/**
 * A place that isn't a TiltTrack venue yet — a HERE result from "Near me" or the search's Places
 * fallback. Adding one creates the venue (POST /api/venues), links its Pinball Map listing, then adds it.
 */
interface PlacePick {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  /**
   * Set when Near me already matched it to Pinball Map (an id the server allowlisted for this user):
   * pm-link takes it directly, no pm-match. Null — a search place, or a Near-me place with no id —
   * gets one pm-match at the place's own coordinates. A Near-me place without an id is NOT "checked":
   * nearby-venues asks Pinball Map for 1 mile around *you*, while HERE's places reach further
   * (Land Ho, 4.7 mi out, came back with no id although it's PM #5388).
   */
  pinballMapId: number | null;
}

/** One row of POST /api/upload/nearby-venues (hereApi.ts `Venue`): a TiltTrack venue (`venueId`) or a HERE place. */
interface NearbyVenue {
  venueId?: number; name: string; address: string; distance: number; hereId: string | null;
  venueLat?: number; venueLng?: number; pinballMapId?: number;
}

type Point = { lat: number; lng: number };

function PlaceRow({ name, detail, busy, onPick }: { name: string; detail: string; busy: boolean; onPick: () => void }) {
  return (
    <button type="button" disabled={busy} onClick={onPick}
      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 disabled:opacity-50">
      <MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-white/90 truncate">{name}</span>
        {detail && <span className="block text-[11px] text-muted-foreground truncate">{detail}</span>}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">New</span>
      <Plus className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden />
    </button>
  );
}

/**
 * Type-ahead over TiltTrack's own venues (public, yours, or ones you've scored at) to add any location.
 * Focused with nothing typed, it offers the venues you've most recently played at ("Recently played",
 * the same endpoint with an empty q); typing switches to search results. When no TiltTrack venue
 * matches, it falls back to the Add Score search's HERE "Places" (GET /api/venues/search) — a place
 * picked there becomes a new venue (`onPickPlace`).
 */
function VenueSearch({ onPick, onPickPlace, at, busy }: {
  onPick: (id: number) => void; onPickPlace: (p: PlacePick) => void; at: Point | null; busy: boolean;
}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q.trim(), 250);
  const recentMode = q.trim() === '';
  const active = !recentMode && searchable(dq);
  const hits = useQuery({
    queryKey: ['challenge-venue-search', dq],
    queryFn: () => api.challenges.searchVenues(dq),
    enabled: open && active,
    staleTime: 30_000,
  });
  const recent = useQuery({
    queryKey: ['challenge-venue-search', ''],
    queryFn: () => api.challenges.searchVenues(''),
    enabled: open && recentMode,
    staleTime: 30_000,
  });
  const results = (recentMode ? recent.data : hits.data) ?? [];
  // Places only once TiltTrack has nothing for this text (the HERE half costs a request), from 3
  // letters like the Add Score box. Same hook, endpoint, cache and rate limit as that box.
  const wantPlaces = open && active && hits.isSuccess && results.length === 0 && dq.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_PLACE_SEARCH_CHARS;
  const placeSearch = useVenueSearch(wantPlaces ? dq : '', at);
  const places = wantPlaces ? (placeSearch.result?.places ?? []) : [];
  const pick = (id: number) => { onPick(id); setQ(''); setOpen(false); };
  const pickPlace = (p: PlacePick) => { onPickPlace(p); setQ(''); setOpen(false); };
  // Recently played: nothing until it has loaded (no spinner flash), a quiet line if there are none.
  const showRecent = open && recentMode && recent.isSuccess;
  const showSearch = open && active;
  const venueRow = (v: ChallengeVenueHit) => (
    <button key={v.id} type="button" disabled={busy} onClick={() => pick(v.id)}
      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 disabled:opacity-50">
      {v.isHome ? <Home className="w-3.5 h-3.5 text-venue flex-shrink-0" aria-hidden /> : <MapPin className="w-3.5 h-3.5 text-venue flex-shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-venue truncate">{v.name}</span>
        {(v.city || v.state) && <span className="block text-[11px] text-muted-foreground truncate">{[v.city, v.state].filter(Boolean).join(', ')}</span>}
      </span>
      <Plus className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden />
    </button>
  );
  return (
    <div>
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={e => { if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); } }}
          placeholder="Search venues or places to add…"
          aria-label="Search venues to add as a challenge location"
          aria-expanded={showRecent || showSearch}
          className="w-full rounded-lg border border-white/10 bg-card pl-8 pr-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-venue/50"
        />
      </div>
      {(showRecent || showSearch) && (
        // mousedown would blur the input (closing the list) before the click lands on a row.
        <div onMouseDown={e => e.preventDefault()} className="mt-1.5 rounded-lg border border-white/10 bg-card divide-y divide-white/5">
          {showRecent && (results.length === 0
            ? <p className="px-3 py-2 text-xs text-muted-foreground">No recent venues</p>
            : <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Recently played</p>)}
          {showSearch && hits.isLoading && <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Searching…</p>}
          {showSearch && hits.isError && <p className="px-3 py-2 text-xs text-red-400">{challengeErrorText(hits.error, 'Search failed')}</p>}
          {showSearch && !hits.isLoading && !hits.isError && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No TiltTrack venue matches.{wantPlaces ? '' : ' Type a few more letters to search places too.'}
            </p>
          )}
          {results.map(venueRow)}
          {wantPlaces && placeSearch.pending && <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Searching places…</p>}
          {wantPlaces && placeSearch.failed && <p className="px-3 py-2 text-xs text-red-400">Place search failed</p>}
          {wantPlaces && placeSearch.result && places.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No places match either.</p>}
          {places.length > 0 && <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Places — not on <span className="normal-case">TiltTrack</span> yet; adding one creates it</p>}
          {places.map(p => (
            <PlaceRow key={p.hereId} name={p.name} busy={busy}
              detail={[p.address, p.distance != null ? `${(p.distance / 1609.34).toFixed(1)} mi` : ''].filter(Boolean).join(' · ')}
              onPick={() => pickPlace({ name: p.name, address: p.address, lat: p.venueLat, lng: p.venueLng, pinballMapId: null })} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Everything under the chips that adds a location: "Near me" (the Add Score "Use my current location"
 * lookup, only ever on a tap), the search, and turning a picked place into a venue. A place is created
 * through the same POST /api/venues as every other "add a venue" form (its 409 duplicate prompt
 * included), then matched to Pinball Map once (skipped when Near me already carries its id) and linked
 * through the venue repair pm-link — which reads the roster once into pm_location_cache, where
 * recommendations find it without ever calling Pinball Map. Then it's added like any other venue.
 */
function AddLocation({ listedIds, onAddId, busy }: { listedIds: number[]; onAddId: (id: number) => void; busy: boolean }) {
  const api = useApi();
  const [at, setAt] = useState<Point | null>(null);
  const [near, setNear] = useState<{ status: 'idle' | 'locating' | 'done' | 'error'; venues: NearbyVenue[]; message?: string }>({ status: 'idle', venues: [] });
  const [working, setWorking] = useState<string | null>(null);
  const [dup, setDup] = useState<{ place: PlacePick; candidates: DuplicateCandidate[] } | null>(null);
  const [notice, setNotice] = useState<{ text: string; venueId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || working != null;

  async function nearMe() {
    setNear({ status: 'locating', venues: [] });
    try {
      const pos = await getCurrentPosition();
      setAt({ lat: pos.latitude, lng: pos.longitude });
      const { venues } = await api.venues.nearby(pos.latitude, pos.longitude);
      setNear({ status: 'done', venues: (venues ?? []) as NearbyVenue[] });
    } catch (err: any) {
      setNear({
        status: 'error', venues: [],
        message: err instanceof CurrentPositionError ? geoFailureMessage(err.reason) : challengeErrorText(err, "Couldn't look up venues near you"),
      });
    }
  }

  /**
   * Pinball Map for a just-created venue: with a Near-me id, straight to pm-link (its roster read
   * verifies the id) — 1 request; otherwise one pm-match at the place, then pm-link — ≤ 2.
   */
  async function linkPinballMap(venueId: number, place: PlacePick): Promise<{ machines: number } | 'none' | 'failed'> {
    try {
      let pmId = place.pinballMapId;
      if (pmId == null) {
        setWorking(`Checking Pinball Map for “${place.name}”…`);
        const m = await api.venues.pmMatch(place.lat != null && place.lng != null
          ? { lat: place.lat, lng: place.lng, name: place.name }
          : { venueId });
        pmId = m.pinballMapId;
      }
      if (pmId == null) return 'none';
      setWorking(`Linking “${place.name}” to Pinball Map…`);
      const linked = await api.venues.repair.pmLink(venueId, pmId);
      return { machines: Number(linked?.machineCount ?? 0) };
    } catch {
      return 'failed';
    }
  }

  async function addPlace(place: PlacePick, allowDuplicate = false) {
    setDup(null); setNotice(null); setError(null);
    if (!place.address.trim()) {
      setError(`There's no address for “${place.name}” — add it from Add Score instead.`);
      return;
    }
    setWorking(`Adding “${place.name}” to TiltTrack…`);
    let venue: { id: number; name: string };
    try {
      venue = await api.venues.create({ name: place.name, address: place.address, allowDuplicate });
    } catch (e) {
      setWorking(null);
      const candidates = duplicateCandidates(e);
      if (candidates) setDup({ place, candidates });
      else setError(challengeErrorText(e, 'Could not add that venue'));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['venues'] });
    const pm = await linkPinballMap(venue.id, place);
    setWorking(null);
    onAddId(venue.id);
    setNear(n => ({ ...n, venues: n.venues.filter(v => !(v.venueId == null && v.name === place.name)) }));
    setNotice({
      venueId: venue.id,
      text: pm === 'none'
        ? `Added “${venue.name}”. It isn’t on Pinball Map, so its machines will come from scores logged there.`
        : pm === 'failed'
          ? `Added “${venue.name}”, but Pinball Map couldn’t be checked just now — you can link it from the venue page.`
          : `Added “${venue.name}” — linked to Pinball Map (${plural(pm.machines, 'machine')}).`,
    });
  }

  const nearbyRows = near.venues.slice(0, 10);
  return (
    <div className="mt-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <VenueSearch onPick={id => { setNotice(null); onAddId(id); }} onPickPlace={p => addPlace(p)} at={at} busy={disabled} />
        </div>
        <button type="button" onClick={nearMe} disabled={disabled || near.status === 'locating'}
          className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-card px-3 py-2 text-xs text-white/80 hover:border-venue/50 disabled:opacity-50">
          {near.status === 'locating' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <LocateFixed className="w-3.5 h-3.5" aria-hidden />}
          Near me
        </button>
      </div>
      {near.status === 'error' && <p className="text-xs text-red-400 mt-1.5">{near.message}</p>}
      {near.status === 'done' && (
        <div className="mt-1.5 rounded-lg border border-white/10 bg-card divide-y divide-white/5">
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Near you</p>
            <button type="button" onClick={() => setNear({ status: 'idle', venues: [] })} aria-label="Close nearby venues" className="text-muted-foreground hover:text-white">
              <X className="w-3 h-3" />
            </button>
          </div>
          {nearbyRows.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">Nothing found near you — try the search.</p>}
          {nearbyRows.map(v => {
            const detail = [v.address, v.distance != null ? `${v.distance}m` : ''].filter(Boolean).join(' · ');
            if (v.venueId == null) {
              return (
                <PlaceRow key={`here-${v.hereId ?? v.name}`} name={v.name} detail={detail} busy={disabled}
                  onPick={() => addPlace({ name: v.name, address: v.address, lat: v.venueLat ?? null, lng: v.venueLng ?? null, pinballMapId: v.pinballMapId ?? null })} />
              );
            }
            const listed = listedIds.includes(v.venueId);
            return (
              <button key={`tt-${v.venueId}`} type="button" disabled={disabled || listed} onClick={() => { setNotice(null); onAddId(v.venueId!); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 disabled:opacity-50">
                <MapPin className="w-3.5 h-3.5 text-venue flex-shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-venue truncate">{v.name}</span>
                  {detail && <span className="block text-[11px] text-muted-foreground truncate">{detail}</span>}
                </span>
                {listed ? <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Added</span> : <Plus className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
      {working && <p className="flex items-center gap-2 text-xs text-muted-foreground mt-2" role="status"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> {working}</p>}
      {dup && (
        <div className="mt-2">
          <DuplicateVenuePrompt
            candidates={dup.candidates}
            busy={disabled}
            // Someone's private venue (name-only candidate) can't be a challenge location — the PUT refuses it.
            usable={c => !c.isPrivate}
            onUse={c => { setDup(null); onAddId(c.id); }}
            onCreateAnyway={() => addPlace(dup.place, true)}
          />
        </div>
      )}
      {notice && (
        <p className="text-xs text-white/80 mt-2" role="status">
          {notice.text} <Link href={`/venues/${notice.venueId}`} className="text-venue hover:underline">View venue</Link>
        </p>
      )}
      {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}
    </div>
  );
}

/**
 * Your own "Challenge me" settings, as a collapsible card. Shown on your profile (`where="profile"`)
 * and on the Challenges page (`where="challenges"`); each remembers open/closed on its own. Default:
 * collapsed once anything is set up, open while it's empty.
 */
export function ChallengeMeEditor({ where }: { where: 'profile' | 'challenges' }) {
  const api = useApi();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPref, setOpenPref] = useState<boolean | null>(() => readOpen(where));
  const prefs = useQuery({ queryKey: CHALLENGE_PREFS_KEY, queryFn: () => api.challenges.prefs(), staleTime: 60_000 });
  const { data: allMachines = [], isLoading: machinesLoading } = useQuery({
    queryKey: ['machines', 'all-for-challenge'],
    queryFn: () => api.machines.list(false) as Promise<MachineOption[]>,
    staleTime: 60_000,
    enabled: adding,
  });
  const { data: myMachines = [] } = useQuery({
    queryKey: ['machines', 'mine-for-challenge'],
    queryFn: () => api.machines.list(true) as Promise<MachineOption[]>,
    staleTime: 60_000,
    enabled: adding,
  });
  const save = useMutation({
    mutationFn: (body: { machineIds?: number[]; venueIds?: number[] }) => api.challenges.savePrefs(body),
    onSuccess: next => {
      setError(null);
      queryClient.setQueryData<ChallengePrefs>(CHALLENGE_PREFS_KEY, next);
      queryClient.invalidateQueries({ queryKey: ['challenge-venue-search'] });
    },
    onError: e => setError(challengeErrorText(e, 'Could not save')),
  });

  if (prefs.isLoading) return null;
  if (prefs.isError || !prefs.data) return null;
  const { machines, venues, suggestions, limits } = prefs.data;
  const machineIds = machines.map(m => m.id);
  const venueIds = venues.map(v => v.id);
  const busy = save.isPending;
  const full = machines.length >= limits.machines;
  const venuesFull = venues.length >= limits.venues;
  const setUp = machines.length > 0 || venues.length > 0;
  const open = openPref ?? !setUp;
  const toggle = () => { setOpenPref(!open); writeOpen(where, !open); };
  const summary = setUp ? `${plural(machines.length, 'machine')} · ${plural(venues.length, 'location')}` : 'Not set up yet';
  // Reads the cached prefs, not this render's list: a place add finishes seconds after its tap.
  const addVenue = (id: number) => {
    const current = queryClient.getQueryData<ChallengePrefs>(CHALLENGE_PREFS_KEY)?.venues.map(v => v.id) ?? venueIds;
    if (!current.includes(id) && current.length < limits.venues) save.mutate({ venueIds: [...current, id] });
  };

  return (
    <section className="rounded-xl border border-friend/25 bg-friend/5 mb-6">
      <button type="button" onClick={toggle} aria-expanded={open} className="group w-full flex items-center gap-3 p-4 text-left">
        <Swords className="w-4 h-4 text-friend flex-shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-friend">
            Machines you can get to
            {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5">Help friends challenge you on machines you can actually play — friends will have machines recommended based on the below</span>
          <span className={`sm:hidden block text-xs mt-1 ${setUp ? 'text-white/80' : 'text-muted-foreground italic'}`}>{summary}</span>
        </span>
        <span className={`hidden sm:block text-xs flex-shrink-0 ${setUp ? 'text-white/80' : 'text-muted-foreground italic'}`}>{summary}</span>
        <ChevronDown className={`w-4 h-4 text-muted-foreground group-hover:text-white transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && (
        <div className="px-4 pb-4 -mt-1">
          <p className="text-[11px] uppercase tracking-wider text-friend mb-1.5 flex items-center gap-1.5">
            <PinballIcon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden /> My Preferred Machines <span className="text-white/60">{machines.length}/{limits.machines}</span></p>
          <div className="flex flex-wrap items-center gap-2">
            {machines.map(m => (
              <span key={m.id} className={`${chip} border-machine/40 text-machine`}>
                <span className="truncate max-w-[12rem]">{m.name}</span>
                <button type="button" disabled={busy} onClick={() => save.mutate({ machineIds: machineIds.filter(id => id !== m.id) })}
                  aria-label={`Remove ${m.name}`} className="text-muted-foreground hover:text-white disabled:opacity-50">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            {!full && !adding && (
              <button type="button" onClick={() => setAdding(true)} className={`${chip} border-white/15 text-white/80 hover:border-machine/50`}>
                <Plus className="w-3 h-3" aria-hidden /> Add a machine
              </button>
            )}
            {machines.length === 0 && !adding && <span className="text-xs text-muted-foreground">Up to {limits.machines} exact machines you’d like to be challenged on.</span>}
          </div>
          {adding && !full && (
            <div className="mt-3 rounded-lg border border-white/10 bg-card p-3">
              <MachinePicker
                allMachines={allMachines}
                myMachines={myMachines}
                loading={machinesLoading}
                exclude={machineIds}
                disabled={busy}
                onPick={m => { save.mutate({ machineIds: [...machineIds, m.id] }); if (machines.length + 1 >= limits.machines) setAdding(false); }}
              />
              <button type="button" onClick={() => setAdding(false)} className="mt-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white">Done</button>
            </div>
          )}

          <p className="text-[11px] uppercase tracking-wider text-friend mt-4 mb-0.5 flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5 flex-shrink-0" aria-hidden /> My Preferred Venues <span className="text-white/60">{venues.length}/{limits.venues}</span></p>
          <p className="text-xs text-muted-foreground mb-1.5">Places you like to play — friends’ challenges look here first.</p>
          <div className="flex flex-wrap items-center gap-2">
            {venues.map(v => (
              <VenueChip key={v.id} v={v} busy={busy} onRemove={() => save.mutate({ venueIds: venueIds.filter(id => id !== v.id) })} />
            ))}
            {venues.length === 0 && <span className="text-xs text-muted-foreground">Venues you can get to — their machines get recommended.</span>}
          </div>
          {suggestions.length > 0 && !venuesFull && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Suggested:</span>
              {suggestions.map(v => (
                <button key={v.id} type="button" disabled={busy} onClick={() => addVenue(v.id)}
                  className={`${chip} border-dashed border-white/20 text-white/75 hover:border-venue/50 disabled:opacity-50`}>
                  <Plus className="w-3 h-3" aria-hidden />
                  {v.isHome && <Home className="w-3 h-3" aria-hidden />}
                  <span className="truncate max-w-[12rem]">{v.name}</span>
                </button>
              ))}
            </div>
          )}
          {venuesFull
            ? <p className="text-[11px] text-muted-foreground mt-2">That’s the limit of {limits.venues} — remove one to add another.</p>
            : <AddLocation listedIds={venueIds} onAddId={addVenue} busy={busy} />}
          <p className="text-[11px] text-muted-foreground mt-3 flex items-start gap-1.5">
            <Lock className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden />
            <span>Friends never see a home venue’s name — its machines just show as “at home”.</span>
          </p>
          {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}
          <LastResortArea />
        </div>
      )}
    </section>
  );
}

/** A friend's "Challenge me on" machines — each opens the create form on that exact model. */
export function ChallengeMeChips({ username, machines }: { username: string; machines: ChallengeMeMachine[] }) {
  if (!machines.length) return null;
  return (
    <section className="rounded-xl border border-white/10 bg-card p-4 mb-6">
      <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-friend mb-3">
        <Swords className="w-3.5 h-3.5" aria-hidden /> Preferred Machines
      </h2>
      <div className="flex flex-wrap gap-2">
        {machines.map(m => (
          <Link
            key={m.id}
            href={`/challenges/new?friend=${encodeURIComponent(username)}&machine=${m.id}&mode=exact`}
            className="inline-flex items-center gap-2 rounded-lg border border-friend/40 pl-1 pr-3 py-1 text-sm text-machine hover:bg-friend/10 transition-colors"
          >
            <MachineThumb name={m.name} imageUrl={m.imageUrl} size="sm" />
            <span className="font-semibold truncate max-w-[14rem]">{m.name}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
