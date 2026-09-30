import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ChevronDown, Home, Loader2, MapPin, Plus, Search, Swords, X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { CHALLENGE_PREFS_KEY, challengeErrorText } from '../lib/challenges';
import MachinePicker, { type MachineOption } from './MachinePicker';
import { MachineThumb } from './ChallengeParts';
import type { ChallengeMeMachine, ChallengePrefs, ChallengePrefVenue } from '../lib/api';

// "Challenge me" (feature/challenge-recs).
//  - Yours (on your profile and the Challenges page, collapsible): the machines you want to be
//    challenged on (max 3) and your challenge locations — venues you can get to, pre-filled once
//    from where you've played, with suggestions to add and a search over TiltTrack's own venues
//    (never Pinball Map / HERE). Friends' create forms recommend from these. Saved on every change.
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

/** Type-ahead over TiltTrack's own venues (public, yours, or ones you've scored at) to add any location. */
function VenueSearch({ onPick, busy }: { onPick: (id: number) => void; busy: boolean }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const active = searchable(dq);
  const hits = useQuery({
    queryKey: ['challenge-venue-search', dq],
    queryFn: () => api.challenges.searchVenues(dq),
    enabled: active,
    staleTime: 30_000,
  });
  const results = hits.data ?? [];
  return (
    <div className="mt-2">
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search TiltTrack venues to add…"
          aria-label="Search venues to add as a challenge location"
          className="w-full rounded-lg border border-white/10 bg-card pl-8 pr-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-venue/50"
        />
      </div>
      {active && (
        <div className="mt-1.5 rounded-lg border border-white/10 bg-card divide-y divide-white/5">
          {hits.isLoading && <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Searching…</p>}
          {hits.isError && <p className="px-3 py-2 text-xs text-red-400">{challengeErrorText(hits.error, 'Search failed')}</p>}
          {!hits.isLoading && !hits.isError && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No TiltTrack venue matches. A venue shows up here once someone has logged a score there.</p>
          )}
          {results.map(v => (
            <button key={v.id} type="button" disabled={busy}
              onClick={() => { onPick(v.id); setQ(''); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 disabled:opacity-50">
              {v.isHome ? <Home className="w-3.5 h-3.5 text-venue flex-shrink-0" aria-hidden /> : <MapPin className="w-3.5 h-3.5 text-venue flex-shrink-0" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-venue truncate">{v.name}</span>
                {(v.city || v.state) && <span className="block text-[11px] text-muted-foreground truncate">{[v.city, v.state].filter(Boolean).join(', ')}</span>}
              </span>
              <Plus className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden />
            </button>
          ))}
        </div>
      )}
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
  const addVenue = (id: number) => { if (!venueIds.includes(id) && !venuesFull) save.mutate({ venueIds: [...venueIds, id] }); };

  return (
    <section className="rounded-xl border border-friend/25 bg-friend/5 mb-6">
      <button type="button" onClick={toggle} aria-expanded={open} className="group w-full flex items-center gap-3 p-4 text-left">
        <Swords className="w-4 h-4 text-friend flex-shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-friend">
            Machines you can get to
            {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5">Help friends challenge you on machines you can actually play</span>
          <span className={`sm:hidden block text-xs mt-1 ${setUp ? 'text-white/80' : 'text-muted-foreground italic'}`}>{summary}</span>
        </span>
        <span className={`hidden sm:block text-xs flex-shrink-0 ${setUp ? 'text-white/80' : 'text-muted-foreground italic'}`}>{summary}</span>
        <ChevronDown className={`w-4 h-4 text-muted-foreground group-hover:text-white transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && (
        <div className="px-4 pb-4 -mt-1">
          <p className="text-xs text-muted-foreground mb-3">Friends see these as recommendations when they challenge you.</p>

          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Challenge me on <span className="text-white/60">{machines.length}/{limits.machines}</span></p>
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

          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-4 mb-1.5">Challenge locations <span className="text-white/60">{venues.length}/{limits.venues}</span></p>
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
            : <VenueSearch onPick={addVenue} busy={busy} />}
          <p className="text-[11px] text-muted-foreground mt-3">Friends never see a home venue’s name — its machines just show as “at home”.</p>
          {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}
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
        <Swords className="w-3.5 h-3.5" aria-hidden /> Challenge me on
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
