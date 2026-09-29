import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Home, Loader2, MapPin, Plus, Swords, X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { CHALLENGE_PREFS_KEY, challengeErrorText } from '../lib/challenges';
import MachinePicker, { type MachineOption } from './MachinePicker';
import { MachineThumb } from './ChallengeParts';
import type { ChallengeMeMachine, ChallengePrefs, ChallengePrefVenue } from '../lib/api';

// "Challenge me" on a profile (feature/challenge-recs).
//  - Your own profile: the machines you want to be challenged on (max 3) and your challenge
//    locations — venues you can get to, pre-filled once from where you've played, with suggestions
//    to add. Friends' create forms recommend from these. Saved on every change.
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

/** Your own "Challenge me" settings. */
export function ChallengeMeEditor() {
  const api = useApi();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    onSuccess: next => { setError(null); queryClient.setQueryData<ChallengePrefs>(CHALLENGE_PREFS_KEY, next); },
    onError: e => setError(challengeErrorText(e, 'Could not save')),
  });

  if (prefs.isLoading) return null;
  if (prefs.isError || !prefs.data) return null;
  const { machines, venues, suggestions, limits } = prefs.data;
  const machineIds = machines.map(m => m.id);
  const venueIds = venues.map(v => v.id);
  const busy = save.isPending;
  const full = machines.length >= limits.machines;

  return (
    <section className="rounded-xl border border-friend/25 bg-friend/5 p-4 mb-6">
      <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-friend mb-1">
        <Swords className="w-3.5 h-3.5" aria-hidden /> Challenge me
        {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
      </h2>
      <p className="text-xs text-muted-foreground mb-3">What your friends see as recommendations when they challenge you.</p>

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

      <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-4 mb-1.5">Challenge locations</p>
      <div className="flex flex-wrap items-center gap-2">
        {venues.map(v => (
          <VenueChip key={v.id} v={v} busy={busy} onRemove={() => save.mutate({ venueIds: venueIds.filter(id => id !== v.id) })} />
        ))}
        {venues.length === 0 && <span className="text-xs text-muted-foreground">Venues you can get to — their machines get recommended.</span>}
      </div>
      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Add:</span>
          {suggestions.map(v => (
            <button key={v.id} type="button" disabled={busy} onClick={() => save.mutate({ venueIds: [...venueIds, v.id] })}
              className={`${chip} border-dashed border-white/20 text-white/75 hover:border-venue/50 disabled:opacity-50`}>
              <Plus className="w-3 h-3" aria-hidden />
              {v.isHome && <Home className="w-3 h-3" aria-hidden />}
              <span className="truncate max-w-[12rem]">{v.name}</span>
            </button>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground mt-3">Friends never see a home venue’s name — its machines just show as “at home”.</p>
      {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}
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
