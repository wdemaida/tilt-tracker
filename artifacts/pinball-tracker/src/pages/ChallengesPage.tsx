import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'wouter';
import { formatDistanceToNow } from 'date-fns';
import { Check, CornerDownRight, Loader2, Lock, MapPinOff, Swords, Timer, X } from 'lucide-react';
import UsernameLink from '../components/UsernameLink';
import { ChallengeMeEditor } from '../components/ChallengeMeCard';
import { OutcomeChip, MachineThumb } from '../components/ChallengeParts';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import {
  useChallengeList, invalidateChallengeQueries, challengeErrorText, typeLabel, meAndThem, formatResult,
  timingText, useNow, historyOutcome, isGroupChallenge, othersOf, ordinal,
} from '../lib/challenges';
import type { Challenge, ChallengeDeclineReason } from '../lib/api';

// Crew → Challenges. Four sections from three list queries (pending is split by who has to act):
// Waiting on you · Live · Sent · History. Every row links to /challenges/:id; the inline buttons are
// only the actions a row can take without opening it (accept / can't get to this one / no thanks,
// cancel). "Can't get to this one" offers a counter-offer (/challenges/new?counterOf=) or a decline.
// A counter-offer is a suggestion to the challenger: it sits under "Waiting on you" for her (Take it
// for everyone / Keep mine) and under "Sent" for whoever suggested it. Groups read "vs @bob +2" and
// the live line is your place ("2nd of 4").

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
        {title}{count !== undefined && <span className="ml-1.5 text-white/60">{count}</span>}
      </h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

const btn = 'relative z-10 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50';

function ChallengeRow({ c, myId, now }: { c: Challenge; myId: number | null; now: number }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const [cantReach, setCantReach] = useState(false);
  const act = useMutation({
    mutationFn: ({ action, reason }: { action: 'accept' | 'decline' | 'cancel' | 'start'; reason?: ChallengeDeclineReason }) =>
      api.challenges.act(c.id, action, reason ? { reason } : undefined),
    onSuccess: () => { setError(null); setCantReach(false); invalidateChallengeQueries(); },
    onError: e => { setError(challengeErrorText(e)); invalidateChallengeQueries(); },
  });
  const doing = (action: string, reason?: string) => act.isPending && act.variables?.action === action && act.variables?.reason === reason;
  const { me, them } = meAndThem(c, myId);
  const opponent = them?.user ?? c.opponent;
  const group = isGroupChallenge(c);
  const others = othersOf(c, myId);
  const timing = timingText(c, now);
  const outcome = historyOutcome(c);
  const live = !group && c.status === 'active' && me?.standing && them?.standing;
  const groupLive = group && c.status === 'active' && me?.standing ? me.standing : null;
  const inCount = c.participants.filter(p => p.response === 'accepted').length;
  const deciding = !!c.me.canDecideProposal;
  const busy = act.isPending;
  const spin = <Loader2 className="w-3 h-3 animate-spin" aria-hidden />;

  let historyNote: string | null = null;
  if (c.status === 'declined') {
    const reason = c.participants.find(p => p.response === 'declined')?.declineReason;
    historyNote = reason === 'cant_reach' ? 'Can’t get to it' : reason === 'no_thanks' ? 'Passed' : 'Declined';
  }
  else if (c.status === 'countered') historyNote = c.counteredToId ? 'Moved' : 'Countered';
  else if (c.status === 'cancelled') historyNote = 'Cancelled';
  else if (c.status === 'expired') historyNote = 'Expired — never answered';
  else if (c.status === 'rejected') historyNote = 'Suggestion not taken';
  else if (c.status === 'lapsed') historyNote = 'Suggestion lapsed';
  else if (c.status === 'proposed') historyNote = 'Suggestion';

  return (
    <div className="relative rounded-xl border border-white/10 bg-card px-3 py-3 sm:px-4 hover:border-white/20 transition-colors">
      <div className="flex items-start gap-3">
        <MachineThumb name={c.machine.name} imageUrl={c.machine.imageUrl} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            {/* Stretched link: the whole card opens the challenge; the handle and buttons sit above it. */}
            <Link href={`/challenges/${c.id}`} className="min-w-0 after:absolute after:inset-0 after:rounded-xl">
              <span className="block text-sm font-bold uppercase tracking-wider text-machine line-clamp-2 break-words">{c.machine.name}</span>
            </Link>
            {outcome ? <OutcomeChip outcome={outcome} /> : historyNote && (
              <span className="flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{historyNote}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5">
            <span className="text-white/80">{typeLabel(c)}</span>
            <span>· vs</span>
            {group ? (
              others.length
                ? <span className="relative z-10"><UsernameLink username={others[0].user.username} className="text-friend hover:text-friend/80" />{others.length > 1 && <span className="text-muted-foreground"> +{others.length - 1}</span>}</span>
                : <span>—</span>
            ) : opponent ? <span className="relative z-10"><UsernameLink username={opponent.username} className="text-friend hover:text-friend/80" /></span> : <span>—</span>}
            {c.venue && <span className="inline-flex items-center gap-0.5"><Lock className="w-3 h-3" aria-hidden /> <span className="text-venue truncate max-w-[10rem]">{c.venue.name}</span></span>}
          </p>
          {live && (
            <p className="text-xs mt-1 flex flex-wrap items-center gap-x-2">
              <span>
                <span className="text-username font-semibold">You</span>{' '}
                <span className={`font-black ${me!.standing!.liveRank === 1 ? 'text-primary' : 'text-white/80'}`}>{formatResult(c.type, me!.standing!.resultValue)}</span>
              </span>
              <span className="text-muted-foreground">vs</span>
              <span>
                <span className="text-friend font-semibold">Them</span>{' '}
                <span className={`font-black ${them!.standing!.liveRank === 1 ? 'text-primary' : 'text-white/80'}`}>{formatResult(c.type, them!.standing!.resultValue)}</span>
              </span>
            </p>
          )}
          {groupLive && (
            <p className="text-xs mt-1 flex flex-wrap items-center gap-x-2">
              <span>
                <span className="text-username font-semibold">You</span>{' '}
                <span className={`font-black ${groupLive.liveRank === 1 ? 'text-primary' : 'text-white/80'}`}>
                  {groupLive.liveRank != null ? `${ordinal(groupLive.liveRank)} of ${inCount}` : `— of ${inCount}`}
                </span>
              </span>
              {groupLive.resultValue != null && <span className="text-muted-foreground">· {formatResult(c.type, groupLive.resultValue)}</span>}
            </p>
          )}
          {timing && (
            <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
              <Timer className="w-3 h-3" aria-hidden /> {timing}
            </p>
          )}
          {c.status === 'pending' && (
            <p className="text-[11px] text-muted-foreground mt-1">
              {c.me.canAccept ? 'Sent' : c.me.canCancel ? 'You sent it' : 'You’re in'} {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
              {group && ` · ${inCount} of ${c.participants.length} in`}
            </p>
          )}
          {c.status === 'proposed' && (
            <p className="text-[11px] text-amber-200 mt-1">
              {deciding
                ? <>{c.proposedBy ? `@${c.proposedBy.username}` : 'A friend'} suggested this instead of your challenge</>
                : <>Your suggestion — waiting for them to take it or keep theirs</>}
            </p>
          )}
          {c.status === 'resolved' && c.resolvedAt && (
            <p className="text-[11px] text-muted-foreground mt-1">Ended {formatDistanceToNow(new Date(c.resolvedAt), { addSuffix: true })}</p>
          )}
          {(c.counteredFromId || c.counteredToId) && (
            <p className="relative z-10 text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
              <CornerDownRight className="w-3 h-3" aria-hidden />
              {c.counteredToId
                ? <Link href={`/challenges/${c.counteredToId}`} className="text-friend hover:underline">See the counter-offer</Link>
                : <>Counter-offer to <Link href={`/challenges/${c.counteredFromId}`} className="text-friend hover:underline">an earlier challenge</Link></>}
            </p>
          )}

          {deciding && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'accept' })} className={`${btn} bg-friend text-zinc-950 hover:opacity-90`}>
                {doing('accept') ? spin : <Check className="w-3 h-3" aria-hidden />} Take it for everyone
              </button>
              <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'decline' })} className={`${btn} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`}>
                {doing('decline') ? spin : <X className="w-3 h-3" aria-hidden />} Keep mine
              </button>
            </div>
          )}
          {(c.me.canAccept || c.me.canCancel) && c.status === 'pending' && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {c.me.canAccept && !cantReach && (
                <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'accept' })} className={`${btn} bg-friend text-zinc-950 hover:opacity-90`}>
                  {doing('accept') ? spin : <Check className="w-3 h-3" aria-hidden />} Accept
                </button>
              )}
              {c.me.canDecline && !cantReach && (
                <>
                  <button type="button" disabled={busy} onClick={() => setCantReach(true)} className={`${btn} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`}>
                    <MapPinOff className="w-3 h-3" aria-hidden /> Can’t get to this one
                  </button>
                  <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'decline', reason: 'no_thanks' })} className={`${btn} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`}>
                    {doing('decline', 'no_thanks') ? spin : <X className="w-3 h-3" aria-hidden />} No thanks
                  </button>
                </>
              )}
              {c.me.canDecline && cantReach && (
                <>
                  {(c.me.canCounter ?? true) && (
                    <Link href={`/challenges/new?counterOf=${c.id}`} className={`${btn} bg-friend text-zinc-950 hover:opacity-90`}>
                      <Swords className="w-3 h-3" aria-hidden /> Suggest another machine
                    </Link>
                  )}
                  <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'decline', reason: 'cant_reach' })} className={`${btn} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`}>
                    {doing('decline', 'cant_reach') ? spin : <X className="w-3 h-3" aria-hidden />} Just decline
                  </button>
                  <button type="button" onClick={() => setCantReach(false)} className={`${btn} text-muted-foreground hover:text-white`}>
                    Back
                  </button>
                </>
              )}
              {c.me.canCancel && (
                <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'cancel' })} className={`${btn} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`}>
                  {doing('cancel') ? spin : <X className="w-3 h-3" aria-hidden />} Cancel
                </button>
              )}
            </div>
          )}
          {error && <p className="relative z-10 text-[11px] text-red-400 mt-1">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export default function ChallengesPage() {
  const me = useAppUser();
  const myId = (me as any)?.id ?? null;
  const now = useNow(1000);
  const pending = useChallengeList('pending');
  const active = useChallengeList('active');
  const history = useChallengeList('history');

  const incoming = (pending.data ?? []).filter(c => c.me.canAccept || c.me.response === 'pending');
  const sent = (pending.data ?? []).filter(c => !incoming.includes(c));
  const loading = pending.isLoading || active.isLoading || history.isLoading;
  const error = pending.error || active.error || history.error;
  const empty = !loading && !incoming.length && !sent.length && !(active.data ?? []).length && !(history.data ?? []).length;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <p className="text-sm text-muted-foreground min-w-0 flex-1">
          One machine, you against up to 7 <span className="text-friend font-semibold">Friends</span>. Only the players can see it.
        </p>
        <Link
          href="/challenges/new"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-friend text-zinc-950 text-sm font-black uppercase tracking-wider hover:opacity-90 transition-opacity"
        >
          <Swords className="w-4 h-4" aria-hidden /> Challenge a friend
        </Link>
      </div>

      {/* Your "Challenge me" settings — the same card as on your profile, collapsed once set up. */}
      {myId != null && <ChallengeMeEditor where="challenges" />}

      {error && <p className="text-sm text-red-400 mb-4">{challengeErrorText(error, 'Could not load challenges')}</p>}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
      ) : empty ? (
        <div className="rounded-xl border border-dashed border-white/15 p-8 text-center">
          <Swords className="w-8 h-8 text-muted-foreground mx-auto mb-3" aria-hidden />
          <p className="text-sm text-white font-bold mb-1">No challenges yet</p>
          <p className="text-sm text-muted-foreground">Pick a friend and a machine — highest score, first to beat a number, most improved or best average.</p>
        </div>
      ) : (
        <>
          {incoming.length > 0 && (
            <Section title="Waiting on you" count={incoming.length}>
              {incoming.map(c => <ChallengeRow key={c.id} c={c} myId={myId} now={now} />)}
            </Section>
          )}
          {(active.data ?? []).length > 0 && (
            <Section title="Live" count={active.data!.length}>
              {active.data!.map(c => <ChallengeRow key={c.id} c={c} myId={myId} now={now} />)}
            </Section>
          )}
          {sent.length > 0 && (
            <Section title="Sent" count={sent.length}>
              {sent.map(c => <ChallengeRow key={c.id} c={c} myId={myId} now={now} />)}
            </Section>
          )}
          {(history.data ?? []).length > 0 && (
            <Section title="History">
              {history.data!.map(c => <ChallengeRow key={c.id} c={c} myId={myId} now={now} />)}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
