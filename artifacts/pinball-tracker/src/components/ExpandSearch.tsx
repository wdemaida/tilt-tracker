import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ExternalLink, Loader2, MapPin, Radar } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { challengeErrorText, formatScore } from '../lib/challenges';
import { MachineThumb } from './ChallengeParts';
import type { ChallengeAreaMatch, ChallengeExpandHint, ChallengeExpandResult } from '../lib/api';
import type { MachineOption } from './MachinePicker';

// Last Resort "Expand search" on the create form (feature/last-resort) — single friend only. It's a
// tap, never automatic: the POST may ask Pinball Map (one request per area, cached 7 days and rate
// limited server-side). Prominent when the recommendations are thin (`hint.suggested` — fewer than 2
// you can reach), a quiet link when an area exists but the list is fine, and a pointer to set your
// own area when you have none. Each match: your nearest spots (yours to see, with Pinball Map links —
// attribution is a licence condition) and only a COUNT of spots near the friend, plus their town.
// Picking one challenges on that exact model, with no venue lock.

const MINE_REACH: Record<1 | 2 | 3, string> = {
  1: 'On your preferred machines list',
  2: 'At one of your preferred venues',
  3: 'You played it lately',
};

function theirsText(m: ChallengeAreaMatch, username: string, place: string | null): string {
  if (m.theirs.kind === 'area') {
    const n = m.theirs.spotCount;
    return `${n} spot${n === 1 ? '' : 's'} near @${username}${place ? `, ${place}` : ''}`;
  }
  return m.theirs.level === 1 ? `@${username} wants to be challenged on it`
    : m.theirs.level === 2 ? `At one of @${username}’s preferred venues`
      : `@${username} played it lately`;
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - +new Date(iso)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function MatchRow({ m, username, place, busy, onPick }: { m: ChallengeAreaMatch; username: string; place: string | null; busy: boolean; onPick: () => void }) {
  const first = m.mine.kind === 'area' ? m.mine.spots[0] : null;
  const more = m.mine.kind === 'area' ? m.mine.spotCount - 1 : 0;
  return (
    <div className="rounded-lg border border-white/10 px-2.5 py-2 hover:border-machine/50 transition-colors">
      <button type="button" disabled={busy} onClick={onPick} className="w-full flex items-center gap-3 text-left disabled:opacity-60">
        <MachineThumb name={m.name} imageUrl={m.imageUrl} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-machine truncate">{m.name}</span>
          <span className="block text-[11px] text-muted-foreground">
            {first
              ? <>Near you: <span className="text-venue">{first.name}</span>{first.city ? ` (${first.city})` : ''} {first.miles} mi{more > 0 ? ` · +${more} more` : ''}</>
              : m.mine.kind === 'reach' ? MINE_REACH[m.mine.level] : null}
          </span>
          <span className="block text-[11px] text-friend/90">{theirsText(m, username, place)}</span>
          {m.viewerBest != null && <span className="block text-[11px] text-muted-foreground">Your best <span className="text-primary font-semibold">{formatScore(m.viewerBest)}</span></span>}
        </span>
      </button>
      {m.mine.kind === 'area' && m.mine.spots.length > 0 && (
        <div className="mt-1 pl-11 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          {m.mine.spots.map(s => (
            <a key={s.pmLocationId} href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-white">
              <MapPin className="w-2.5 h-2.5" aria-hidden />{s.name} on Pinball Map <ExternalLink className="w-2.5 h-2.5" aria-hidden />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExpandSearch({ username, hint, thin, onPick }: {
  username: string;
  hint: ChallengeExpandHint | undefined;
  /** Fewer than 2 recommendations you can reach — only then point at setting an area up. */
  thin: boolean;
  onPick: (machine: MachineOption) => void;
}) {
  const api = useApi();
  const [result, setResult] = useState<ChallengeExpandResult | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const search = useMutation({
    mutationFn: () => api.challenges.expand(username),
    onSuccess: r => { setResult(r); setPickError(null); },
  });
  const pick = useMutation({
    mutationFn: async (m: ChallengeAreaMatch): Promise<MachineOption> => {
      if (m.machineId != null) return { id: m.machineId, name: m.name, imageUrl: m.imageUrl, manufacturer: m.manufacturer, year: m.year };
      const made = await api.challenges.expandMachine(username, m.pmMachineId);
      return { id: made.id, name: made.name, imageUrl: made.imageUrl, manufacturer: made.manufacturer, year: made.year };
    },
    onSuccess: onPick,
    onError: e => setPickError(challengeErrorText(e, 'Could not pick that machine')),
  });

  if (!hint) return null; // an older server
  if (!hint.available) {
    if (!thin) return null;
    return (
      <p className="mb-4 text-[11px] text-muted-foreground flex items-start gap-1.5">
        <Radar className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden />
        <span>
          Not much in common? <Link href="/crew?tab=challenges" className="text-friend hover:underline">Set your Last Resort area</Link> — a ZIP and how far you’d go — to search beyond your preferred venues.
        </span>
      </p>
    );
  }

  const button = !result && (
    hint.suggested ? (
      <button type="button" onClick={() => search.mutate()} disabled={search.isPending}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-friend/50 bg-friend/10 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-friend hover:bg-friend/20 disabled:opacity-60">
        {search.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Radar className="w-3.5 h-3.5" aria-hidden />}
        Expand search — machines near both of you
      </button>
    ) : (
      <button type="button" onClick={() => search.mutate()} disabled={search.isPending}
        className="inline-flex items-center gap-1.5 text-xs text-friend hover:underline disabled:opacity-60">
        {search.isPending ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <Radar className="w-3 h-3" aria-hidden />}
        Expand search with your Last Resort areas
      </button>
    )
  );

  return (
    <div className="mb-4">
      {button}
      {hint.suggested && !result && !search.isPending && (
        <p className="text-[11px] text-muted-foreground mt-1.5">
          {hint.mine && hint.theirs ? 'Looks at the machines within both of your Last Resort areas.'
            : hint.mine ? `Looks at the machines within your Last Resort area that @${username} can reach.`
              : `Looks at the machines within @${username}’s Last Resort area that you can reach.`}
          {!hint.mine && <> <Link href="/crew?tab=challenges" className="text-friend hover:underline">Set yours</Link> to search near you too.</>}
        </p>
      )}
      {search.isError && <p className="text-xs text-red-400 mt-2" role="alert">{challengeErrorText(search.error, 'Search failed')}</p>}
      {result && (
        <div className="rounded-lg border border-friend/25 bg-friend/5 p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-friend">Near both of you</p>
            <button type="button" onClick={() => setResult(null)} className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-white">Hide</button>
          </div>
          {(result.areas.mine === 'unavailable' || result.areas.theirs === 'unavailable') && (
            <p className="text-xs text-amber-300 mb-2">Pinball Map couldn’t be reached for {result.areas.mine === 'unavailable' && result.areas.theirs === 'unavailable' ? 'either area' : result.areas.mine === 'unavailable' ? 'your area' : `@${username}’s area`} — try again later.</p>
          )}
          {result.matches.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {result.areas.mine === 'none' && result.areas.theirs === 'none'
                ? 'Neither of you has a Last Resort area yet.'
                : 'No machine turned up in both places. A bigger Last Resort radius may help.'}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {result.matches.map(m => (
                <MatchRow key={m.pmMachineId} m={m} username={username} place={result.theirPlace} busy={pick.isPending} onPick={() => pick.mutate(m)} />
              ))}
            </div>
          )}
          {pick.isPending && <p className="flex items-center gap-2 text-xs text-muted-foreground mt-2"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Adding the machine…</p>}
          {pickError && <p className="text-xs text-red-400 mt-2" role="alert">{pickError}</p>}
          <p className="text-[10px] text-muted-foreground mt-2">
            Exact model only — picking one challenges on that model, anywhere.
            {result.asOf && <> Machine data from <a href="https://pinballmap.com" target="_blank" rel="noreferrer" className="hover:text-white underline">Pinball Map</a>, {ago(result.asOf)}{result.stale ? ' (couldn’t refresh)' : ''}.</>}
          </p>
        </div>
      )}
    </div>
  );
}
