import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { useAuth } from '@clerk/clerk-react';
import { format } from 'date-fns';
import { ArrowLeft, Check, Clock, Crown, Flag, Loader2, Lock, MapPin, Swords, Target, Timer, X } from 'lucide-react';
import UsernameLink from '../components/UsernameLink';
import { MachineThumb, OutcomeChip } from '../components/ChallengeParts';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { formatScoreTime, zoneAbbreviation } from '../lib/scoreTime';
import {
  TYPE_META, SCORE_RULES, challengeKey, invalidateChallengeQueries, challengeErrorText, meAndThem, formatScore,
  formatResult, formatDuration, useNow, isAbandoned, historyOutcome, outcomeMeta,
} from '../lib/challenges';
import type { Challenge, ChallengeParticipant } from '../lib/api';

// /challenges/:id — one challenge, for its participants. Machine + rules up top, a live countdown,
// the standings (you in username yellow, them in friend aqua), each side's counting scores, and the
// actions the server says you may take (me.can*). Resolution happens server-side on read, so a
// refetch after the deadline is what flips it to the outcome banner.

function rulesLine(c: Challenge) {
  switch (c.type) {
    case 'high_score': return 'Best score in the window wins. If nobody plays, it’s abandoned.';
    case 'race': return `First to beat ${formatScore(c.targetScore)} wins on the spot — matching it isn’t enough. If nobody beats it by the end, it’s abandoned.`;
    case 'most_improved': return 'Biggest % gain over your own best from before the challenge wins. If nobody plays, it’s abandoned.';
    case 'average': return `Highest average of all your scores in the window wins. You need at least ${c.minPlays ?? '?'} plays to qualify; if nobody does, it’s abandoned.`;
  }
}

function statusLine(c: Challenge, now: number): { text: string; tone: string } {
  switch (c.phase) {
    case 'pending': return { text: 'Waiting for an answer', tone: 'text-amber-200' };
    case 'scheduled': return { text: `Starts in ${formatDuration(+new Date(c.startsAt!) - now)}`, tone: 'text-friend' };
    case 'live': {
      const left = +new Date(c.endsAt) - now;
      return left > 0 ? { text: `${formatDuration(left)} left`, tone: 'text-friend' } : { text: 'Time’s up — settling…', tone: 'text-muted-foreground' };
    }
    case 'ended': return { text: 'Time’s up — settling…', tone: 'text-muted-foreground' };
    case 'resolved': return { text: `Finished ${c.resolvedAt ? format(new Date(c.resolvedAt), 'MMM d, h:mm a') : ''}`, tone: 'text-muted-foreground' };
    case 'declined': return { text: 'Declined', tone: 'text-muted-foreground' };
    case 'cancelled': return { text: 'Cancelled', tone: 'text-muted-foreground' };
    case 'expired': return { text: 'Expired — never accepted', tone: 'text-muted-foreground' };
  }
}

function OutcomeBanner({ c }: { c: Challenge }) {
  const o = historyOutcome(c);
  if (!o) return null;
  const m = outcomeMeta(o);
  const sub =
    // void is retired (nobody playing is now abandoned); kept for legacy rows.
    o === 'void' ? 'Nobody posted a counting score.'
    // Abandoned = nobody finished. For race / average that covers nobody playing too; for high score
    // and most improved it can only mean nobody played.
    : o === 'abandoned' ? (
      c.type === 'race' ? 'Nobody beat the target in time — no winner, no loser.'
      : c.type === 'average' ? 'Nobody reached the minimum plays — no winner, no loser.'
      : 'Nobody played in time — no winner, no loser.')
    : o === 'no_show' ? 'You didn’t post a counting score.'
    : o === 'forfeit' ? 'You withdrew from this challenge.'
    : o === 'win' && c.opponent && c.participants.find(p => p.user.id === c.opponent!.id)?.outcome === 'forfeit' ? 'They forfeited.'
    : null;
  return (
    <div className={`rounded-xl border p-4 mb-6 flex items-center gap-3 ${m.tone}`}>
      {o === 'win' ? <Crown className="w-6 h-6 flex-shrink-0" aria-hidden /> : <Flag className="w-6 h-6 flex-shrink-0" aria-hidden />}
      <div>
        <p className="text-xl font-black uppercase tracking-widest">{m.banner}</p>
        {sub && <p className="text-xs opacity-80 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

/** The value a participant is on: live standing while active, the final value once resolved. */
function valueOf(p: ChallengeParticipant) {
  return p.standing?.resultValue ?? p.resultValue;
}

function StandingCard({ c, p, isMe, leader }: { c: Challenge; p: ChallengeParticipant; isMe: boolean; leader: boolean }) {
  const st = p.standing;
  const value = valueOf(p);
  const resolved = c.status === 'resolved';
  const nameColor = isMe ? 'text-username hover:text-username/80' : 'text-friend hover:text-friend/80';
  const outcome = resolved ? (c.void ? 'void' : p.outcome) : p.outcome === 'forfeit' ? 'forfeit' : null;

  let detail: React.ReactNode = null;
  if (c.type === 'race' && c.targetScore) {
    const best = st?.bestScore ?? (resolved ? p.resultValue : null);
    const pct = best != null ? Math.min(100, (best / c.targetScore) * 100) : 0;
    detail = (
      <>
        <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden" aria-hidden>
          <div className={`h-full ${st?.qualified ? 'bg-primary' : 'bg-primary/50'}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          {st?.qualified ? 'Beat the target'
            : best == null ? 'No counting score yet'
            : best === c.targetScore ? 'Matched it — has to beat it'
            : `${formatScore(c.targetScore - best + 1)} more to beat it`}
        </p>
      </>
    );
  } else if (c.type === 'most_improved') {
    detail = (
      <p className="text-[11px] text-muted-foreground mt-1">
        Baseline {formatScore(p.baselineScore)}{st?.bestScore != null && <> → best {formatScore(st.bestScore)}</>}
      </p>
    );
  } else if (c.type === 'average') {
    const n = st?.countingCount ?? p.scores?.length ?? 0;
    detail = (
      <p className={`text-[11px] mt-1 ${st?.qualified ? 'text-emerald-300' : 'text-muted-foreground'}`}>
        {n} of {c.minPlays ?? '?'} plays{st?.qualified ? ' · qualified' : ''}
      </p>
    );
  } else if (st) {
    detail = <p className="text-[11px] text-muted-foreground mt-1">{st.countingCount} counting {st.countingCount === 1 ? 'score' : 'scores'}</p>;
  }

  return (
    <div className={`flex-1 min-w-0 rounded-xl border p-3 sm:p-4 ${leader ? 'border-primary/50 bg-primary/10' : 'border-white/10 bg-card'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold truncate min-w-0">
          {isMe && <span className="text-username">You </span>}
          <UsernameLink username={p.user.username} className={nameColor} />
        </span>
        {leader && !resolved && <Crown className="w-4 h-4 text-primary flex-shrink-0" aria-label="Leading" />}
        {outcome && <OutcomeChip outcome={outcome} />}
      </div>
      <p className={`mt-1 text-xl sm:text-3xl font-black break-all ${value != null ? 'text-primary' : 'text-muted-foreground'}`}>
        {formatResult(c.type, value)}
      </p>
      {c.type === 'average' && value != null && <p className="text-[11px] text-muted-foreground -mt-0.5">average</p>}
      {detail}
      {p.response === 'pending' && <p className="text-[11px] text-amber-200 mt-1">Hasn’t answered</p>}
      {p.response === 'declined' && <p className="text-[11px] text-muted-foreground mt-1">Declined</p>}
    </div>
  );
}

function ScoreList({ c, p, isMe }: { c: Challenge; p: ChallengeParticipant; isMe: boolean }) {
  const list = p.scores ?? [];
  return (
    <div className="flex-1 min-w-0">
      <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
        {isMe ? <span className="text-username">Your</span> : <span className="text-friend">@{p.user.username}’s</span>} counting scores
        <span className="ml-1.5 text-white/60">{list.length}</span>
      </h3>
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">None yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.map(s => {
            // Venue-local time, with the zone only when it differs from the reader's (as ScoreCard).
            const zone = zoneAbbreviation(s.playedAt, s.venueTimezone);
            return (
            <li key={s.id} className="rounded-lg border border-white/10 bg-card px-3 py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Clock className="w-3 h-3 flex-shrink-0" aria-hidden />
                  {formatScoreTime(s.playedAt, s.venueTimezone, 'MMM d · h:mm a')}
                  {zone && <span className="text-muted-foreground/60">{zone}</span>}
                </p>
                {s.venueName && (
                  <p className="text-[11px] text-venue flex items-center gap-1 min-w-0">
                    <MapPin className="w-3 h-3 flex-shrink-0" aria-hidden />
                    {s.venueId != null
                      ? <Link href={`/venues/${s.venueId}`} className="truncate hover:text-venue/80">{s.venueName}</Link>
                      : <span className="truncate">{s.venueName}</span>}
                  </p>
                )}
              </div>
              <Link href={`/machines/${encodeURIComponent(c.machine.name)}`} className="text-base font-black text-primary whitespace-nowrap hover:text-primary/80">
                {formatScore(s.score)}
              </Link>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Actions({ c }: { c: Challenge }) {
  const api = useApi();
  const [confirmForfeit, setConfirmForfeit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (action: 'accept' | 'decline' | 'cancel' | 'forfeit') => api.challenges.act(c.id, action),
    onSuccess: () => { setError(null); setConfirmForfeit(false); invalidateChallengeQueries(); },
    onError: e => { setError(challengeErrorText(e)); invalidateChallengeQueries(); },
  });
  const { canAccept, canDecline, canCancel, canForfeit } = c.me;
  if (!canAccept && !canDecline && !canCancel && !canForfeit) return null;
  const busy = act.isPending;
  const spin = <Loader2 className="w-4 h-4 animate-spin" aria-hidden />;
  const base = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-colors disabled:opacity-50';
  const ghost = `${base} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`;

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-2">
        {canAccept && (
          <button type="button" disabled={busy} onClick={() => act.mutate('accept')} className={`${base} bg-friend text-zinc-950 hover:opacity-90`}>
            {busy && act.variables === 'accept' ? spin : <Check className="w-4 h-4" aria-hidden />} Accept
          </button>
        )}
        {canDecline && (
          <button type="button" disabled={busy} onClick={() => act.mutate('decline')} className={ghost}>
            {busy && act.variables === 'decline' ? spin : <X className="w-4 h-4" aria-hidden />} Decline
          </button>
        )}
        {canCancel && (
          <button type="button" disabled={busy} onClick={() => act.mutate('cancel')} className={ghost}>
            {busy && act.variables === 'cancel' ? spin : <X className="w-4 h-4" aria-hidden />} Cancel challenge
          </button>
        )}
        {canForfeit && !confirmForfeit && (
          <button type="button" disabled={busy} onClick={() => setConfirmForfeit(true)} className={ghost}>
            <Flag className="w-4 h-4" aria-hidden /> Forfeit
          </button>
        )}
      </div>
      {confirmForfeit && (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 p-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-white/90 flex-1 min-w-[12rem]">Forfeit? It counts as a forfeit on your record and they win.</p>
          <button type="button" disabled={busy} onClick={() => act.mutate('forfeit')} className={`${base} bg-red-500/80 text-white hover:bg-red-500`}>
            {busy ? spin : 'Forfeit'}
          </button>
          <button type="button" onClick={() => setConfirmForfeit(false)} className="px-2 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white">
            Keep playing
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
      <Swords className="w-10 h-10 text-muted-foreground" aria-hidden />
      <p className="text-xl font-bold uppercase tracking-widest text-white">Challenge not found</p>
      <p className="text-sm text-muted-foreground max-w-sm">It doesn’t exist, or it isn’t one of yours — challenges are only visible to the players in them.</p>
      <Link href="/crew?tab=challenges" className="text-sm text-friend hover:underline mt-2">← Your challenges</Link>
    </div>
  );
}

export default function ChallengePage() {
  const { id } = useParams<{ id: string }>();
  const cid = Number(id);
  const api = useApi();
  const appUser = useAppUser();
  const now = useNow(1000);
  const valid = Number.isInteger(cid) && cid > 0;
  // AuthGate renders its children for a moment before redirecting a signed-out visitor; don't fire a
  // request that can only 401.
  const { isSignedIn } = useAuth();
  const { data: c, isLoading, error } = useQuery({
    queryKey: challengeKey(cid),
    queryFn: () => api.challenges.get(cid),
    enabled: valid && !!isSignedIn,
    retry: (n, e: any) => e?.status !== 404 && n < 1,
    // Keep live standings fresh while it's running; a finished one never changes.
    refetchInterval: q => (q.state.data?.status === 'active' ? 60_000 : false),
  });

  if (!isSignedIn) return null;
  if (!valid || (error as any)?.status === 404) return <NotFound />;
  if (isLoading) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>;
  if (error || !c) return <p className="text-sm text-red-400">{challengeErrorText(error, 'Could not load this challenge')}</p>;

  const { me, them } = meAndThem(c, (appUser as any)?.id);
  const status = statusLine(c, now);
  const started = c.participants.some(p => p.standing);
  // Leader: live rank 1 alone while running; the winner once resolved. No crown on a tie.
  const ranked = c.participants.filter(p => (c.status === 'resolved' ? p.outcome === 'win' : p.standing?.liveRank === 1 && valueOf(p) != null));
  const leaderId = ranked.length === 1 ? ranked[0].user.id : null;
  const showStandings = c.status === 'active' || c.status === 'resolved';
  const mine = me ? [me] : [];
  const order = [...mine, ...c.participants.filter(p => p !== me)];

  return (
    <div className="max-w-3xl">
      <Link href="/crew?tab=challenges" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors mb-4">
        <ArrowLeft className="w-4 h-4" /> Challenges
      </Link>

      {/* header */}
      <div className="flex items-start gap-4 mb-5">
        <Link href={`/machines/${encodeURIComponent(c.machine.name)}`} className="flex-shrink-0">
          <MachineThumb name={c.machine.name} imageUrl={c.machine.imageUrl} size="lg" />
        </Link>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-widest text-friend flex items-center gap-1.5">
            <Swords className="w-3.5 h-3.5" aria-hidden /> {TYPE_META[c.type]?.label ?? 'Challenge'}
          </p>
          <Link href={`/machines/${encodeURIComponent(c.machine.name)}`} className="block text-2xl sm:text-3xl font-black uppercase tracking-widest text-machine hover:text-machine/80 leading-tight break-words">
            {c.machine.name}
          </Link>
          <p className="text-sm text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5">
            {me && <span className="text-username">You</span>}
            <span>vs</span>
            {them ? <UsernameLink username={them.user.username} className="text-friend hover:text-friend/80" /> : <span>—</span>}
          </p>
          <p className={`text-sm font-bold mt-1 flex items-center gap-1.5 ${status.tone}`}>
            <Timer className="w-4 h-4" aria-hidden /> {status.text}
          </p>
        </div>
      </div>

      <OutcomeBanner c={c} />
      <Actions c={c} />

      {/* terms */}
      <div className="rounded-xl border border-white/10 bg-card p-4 mb-6 text-sm">
        <p className="text-white/90">{rulesLine(c)}</p>
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          {c.type === 'race' && (
            <div className="flex items-center gap-1.5"><Target className="w-3.5 h-3.5 text-primary" aria-hidden /><dt className="text-muted-foreground">Target</dt><dd className="text-primary font-bold">{formatScore(c.targetScore)}</dd></div>
          )}
          {c.type === 'average' && (
            <div className="flex items-center gap-1.5"><Target className="w-3.5 h-3.5 text-muted-foreground" aria-hidden /><dt className="text-muted-foreground">Min plays</dt><dd className="text-white font-bold">{c.minPlays}</dd></div>
          )}
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Models</dt>
            <dd className="text-white/90">{c.matchMode === 'game' ? 'Any model of this game' : 'This exact model only'}</dd>
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            {c.venue ? <Lock className="w-3.5 h-3.5 text-venue flex-shrink-0" aria-hidden /> : <MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden />}
            <dt className="text-muted-foreground">Venue</dt>
            <dd className="min-w-0 truncate">{c.venue ? <Link href={`/venues/${c.venue.id}`} className="text-venue hover:text-venue/80">{c.venue.name}</Link> : <span className="text-white/90">Any</span>}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Window</dt>
            <dd className="text-white/90">
              {c.startsAt ? format(new Date(c.startsAt), 'MMM d, h:mm a') : 'When accepted'} → {format(new Date(c.endsAt), 'MMM d, h:mm a')}
            </dd>
          </div>
        </dl>
        <ul className="mt-3 pt-3 border-t border-white/10 text-xs text-muted-foreground space-y-0.5 list-disc pl-4">
          {SCORE_RULES.map(r => <li key={r}>{r}</li>)}
        </ul>
      </div>

      {/* standings */}
      {showStandings && (
        <section className="mb-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
            {c.status === 'resolved' ? 'Final standings' : 'Standings'}
          </h2>
          {!started && c.status === 'active' ? (
            <p className="text-sm text-muted-foreground">Standings appear once the challenge starts.</p>
          ) : (
            <div className="flex gap-2 sm:gap-3">
              {order.map(p => <StandingCard key={p.user.id} c={c} p={p} isMe={p === me} leader={leaderId === p.user.id} />)}
            </div>
          )}
          {c.type === 'most_improved' && started && (
            <p className="text-[11px] text-muted-foreground mt-2">% = best counting score over your best from before the challenge.</p>
          )}
          {isAbandoned(c) && c.status === 'resolved' && (
            <p className="text-[11px] text-muted-foreground mt-2">Abandoned challenges don’t count as a win, loss or tie — they break a win streak.</p>
          )}
        </section>
      )}

      {/* counting scores */}
      {showStandings && started && (
        <section className="mb-6">
          <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
            {order.map(p => <ScoreList key={p.user.id} c={c} p={p} isMe={p === me} />)}
          </div>
          {c.status === 'active' && (
            <p className="text-[11px] text-muted-foreground mt-3">
              Only scores with a photo, played and uploaded in the window{c.venue ? ` at ${c.venue.name}` : ''}, count.{' '}
              <Link href="/add" className="text-primary hover:underline">Add a score</Link>
            </p>
          )}
        </section>
      )}

      {c.type === 'most_improved' && c.status === 'pending' && (
        <p className="text-xs text-muted-foreground">Accepting needs a score of yours on this machine from before the challenge starts.</p>
      )}
    </div>
  );
}
