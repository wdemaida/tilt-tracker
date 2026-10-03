import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Lock, Radar } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { CHALLENGE_AREA_KEY, challengeErrorText } from '../lib/challenges';
import type { ChallengeAreaResponse } from '../lib/api';

// "Last Resort" (feature/last-resort) — under Favorite Challenge Locations in the "Machines you can
// get to" card (ChallengeMeCard.tsx). A US ZIP + a radius: anywhere within N miles you'd still drive
// to for a challenge. Matchmaking only looks at it when someone taps Expand search on the create form
// (NewChallengePage's ExpandSearch). The server stores the ZIP and a rounded centroid, never an
// address, and sends back ZIP + town only — no coordinates, not even to you. Friends see a count of
// spots near you plus your town, never the ZIP or the spots.

const FALLBACK_CHOICES = [5, 10, 15, 20, 30, 50];
const DEFAULT_RADIUS = 15;

export default function LastResortArea() {
  const api = useApi();
  const area = useQuery({ queryKey: CHALLENGE_AREA_KEY, queryFn: () => api.challenges.area(), staleTime: 60_000 });
  const [editing, setEditing] = useState(false);
  const [zip, setZip] = useState('');
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [error, setError] = useState<string | null>(null);
  const current = area.data?.area ?? null;
  const choices = area.data?.radiusChoices?.length ? area.data.radiusChoices : FALLBACK_CHOICES;

  // Start the form from what's saved.
  useEffect(() => {
    if (!editing) return;
    setZip(current?.postalCode ?? '');
    setRadius(current?.radiusMiles ?? DEFAULT_RADIUS);
    setError(null);
  }, [editing, current?.postalCode, current?.radiusMiles]);

  const onSaved = (next: ChallengeAreaResponse) => {
    queryClient.setQueryData(CHALLENGE_AREA_KEY, next);
    // Recommendations carry an `expand` hint that depends on whether you have an area.
    queryClient.invalidateQueries({ queryKey: ['challenges', 'recommendations'] });
    setEditing(false);
    setError(null);
  };
  const save = useMutation({
    mutationFn: () => api.challenges.saveArea({ postalCode: zip.trim(), radiusMiles: radius }),
    onSuccess: onSaved,
    onError: e => setError(challengeErrorText(e, 'Could not save')),
  });
  const clear = useMutation({
    mutationFn: () => api.challenges.clearArea(),
    onSuccess: onSaved,
    onError: e => setError(challengeErrorText(e, 'Could not clear')),
  });
  const busy = save.isPending || clear.isPending;
  const zipOk = /^\d{5}$/.test(zip.trim());

  if (area.isLoading || area.isError) return null;

  return (
    <div className="mt-5">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Radar className="w-3 h-3" aria-hidden /> Last Resort
      </p>
      <p className="text-xs text-muted-foreground mb-2">
        How far you’d still drive for a challenge. Only used when a friend’s recommendations come up short and one of you taps <span className="text-white/80">Expand search</span>.
      </p>

      {!editing && (
        current ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-sm text-white/90">
              Within <span className="font-semibold text-venue">{current.radiusMiles} mi</span> of {current.postalCode}
              {current.label && <span className="text-muted-foreground"> ({current.label})</span>}
            </span>
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className="text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white disabled:opacity-50">Change</button>
            <button type="button" disabled={busy} onClick={() => clear.mutate()} className="text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-red-300 disabled:opacity-50">
              {clear.isPending ? 'Clearing…' : 'Clear'}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/80 hover:border-venue/50">
            Set your Last Resort area
          </button>
        )
      )}

      {editing && (
        <form
          className="rounded-lg border border-white/10 bg-card p-3 flex flex-wrap items-end gap-3"
          onSubmit={e => { e.preventDefault(); if (zipOk && !busy) save.mutate(); }}
        >
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            ZIP code
            <input
              value={zip}
              onChange={e => setZip(e.target.value.replace(/[^\d-]/g, '').slice(0, 10))}
              inputMode="numeric"
              autoComplete="postal-code"
              placeholder="02639"
              aria-invalid={zip.trim() !== '' && !zipOk}
              className="w-28 rounded-lg border border-white/10 bg-background px-3 py-2 text-sm normal-case tracking-normal text-white placeholder:text-muted-foreground focus:outline-none focus:border-venue/50"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            Within
            <select
              value={radius}
              onChange={e => setRadius(Number(e.target.value))}
              className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm normal-case tracking-normal text-white focus:outline-none focus:border-venue/50"
            >
              {choices.map(n => <option key={n} value={n}>{n} miles</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={!zipOk || busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50">
              {save.isPending && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />} Save
            </button>
            <button type="button" disabled={busy} onClick={() => { setEditing(false); setError(null); }}
              className="px-2 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white disabled:opacity-50">
              Cancel
            </button>
          </div>
          <p className="basis-full text-[11px] text-muted-foreground">City players usually pick 5–10 miles, rural players 20–50. US ZIP codes only for now.</p>
        </form>
      )}

      {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}
      <p className="text-[11px] text-muted-foreground mt-2 flex items-start gap-1.5">
        <Lock className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden />
        <span>Friends never see your ZIP code or the places near you — only how many spots near you have a machine, and your town.</span>
      </p>
    </div>
  );
}
