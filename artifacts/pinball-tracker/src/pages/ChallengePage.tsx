import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { useAuth } from '@clerk/clerk-react';
import { format } from 'date-fns';
import { ArrowLeft, Check, Clock, CornerDownRight, Crown, Flag, Lightbulb, Loader2, Lock, LogOut, MapPin, MapPinOff, Play, ShieldCheck, Swords, Target, Timer, Users, X } from 'lucide-react';
import UsernameLink from '../components/UsernameLink';
import { MachineThumb, OutcomeChip } from '../components/ChallengeParts';
import { FullPhotoButton } from '../components/PhotoViewer';
import { Pill } from '../components/admin/AdminParts';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { useAdminApi } from '../lib/adminApi';
import { formatScoreTime, zoneAbbreviation } from '../lib/scoreTime';
import {
  TYPE_META, SCORE_RULES, challengeKey, invalidateChallengeQueries, challengeErrorText, meAndThem, formatScore,
  formatResult, formatDuration, useNow, isAbandoned, historyOutcome, outcomeMeta, isGroupChallenge, isOut, othersOf, ordinal, typeLabel,
} from '../lib/challenges';
import type { Challenge, ChallengeDeclineChoice, ChallengeParticipant, ChallengeProposal } from '../lib/api';
import VenueName from '../components/VenueName';

// /challenges/:id — one challenge, for its participants. Machine + rules up top, a live countdown,
// the standings (you in username yellow, them in friend aqua), each side's counting scores, and the
// actions the server says you may take (me.can*). Resolution happens server-side on read, so a
// refetch after the deadline is what flips it to the outcome banner.
//
// Groups (up to 8 players): a ranked StandingsList instead of side-by-side cards, the roster with
// who has answered, "Start with who's in" for the challenger. Counter-offers are PROPOSALS to the
// challenger: the original lists them (ProposalsPanel — "Take it for everyone" / "Keep mine"), and a
// proposal's own page says whose suggestion it is. statusLine has a default branch on purpose: an
// unknown status from a newer server must never crash the page.
//
// Admin view (fix/admin-challenge-view): when /api/challenges/:id is a 404 (not one of yours) and you
// are an admin, the page loads GET /api/admin/challenges/:id instead — the same challenge with
// `adminView: true` and a read-only `me` (every can* false). It shows an "Admin view" note, no "You",
// no actions and no "Add a score"; the action routes refuse a non-participant regardless.

function rulesLine(c: Challenge) {
  switch (c.type) {
    case 'high_score': return 'Best score in the window wins. If nobody plays, it’s abandoned.';
    case 'race': return `First to beat ${formatScore(c.targetScore)} wins on the spot — matching it isn’t enough. If nobody beats it by the end, it’s abandoned.`;
    case 'most_improved': return 'Biggest % gain over your own best from before the challenge wins. If nobody plays, it’s abandoned.';
    case 'average': return `Highest average of all your scores in the window wins. You need at least ${c.minPlays ?? '?'} plays to qualify; if nobody does, it’s abandoned.`;
  }
}

const MUTED = 'text-muted-foreground';

function statusLine(c: Challenge, now: number): { text: string; tone: string } {
  // The proposal statuses first — the server maps them onto old phases for old clients.
  switch (c.status) {
    case 'proposed':
      return c.me.canDecideProposal
        ? { text: 'A suggestion for you — take it for everyone, or keep yours', tone: 'text-amber-200' }
        : { text: 'Suggested — waiting for an answer', tone: 'text-amber-200' };
    case 'rejected': return { text: 'Not taken', tone: MUTED };
    case 'lapsed': return { text: 'Lapsed — the original closed first', tone: MUTED };
  }
  switch (c.phase) {
    case 'pending': {
      const invitees = c.participants.filter(p => !p.isCreator && !isOut(p));
      const waiting = invitees.filter(p => p.response === 'pending').length;
      if (isGroupChallenge(c)) {
        if (waiting === 0 && (c.proposals ?? []).some(p => p.status === 'proposed')) return { text: 'Waiting on a suggestion to be answered', tone: 'text-amber-200' };
        return { text: `Waiting on ${waiting} of ${invitees.length} to answer`, tone: 'text-amber-200' };
      }
      return { text: 'Waiting for an answer', tone: 'text-amber-200' };
    }
    case 'scheduled': return { text: `Starts in ${formatDuration(+new Date(c.startsAt!) - now)}`, tone: 'text-friend' };
    case 'live': {
      const left = +new Date(c.endsAt) - now;
      return left > 0 ? { text: `${formatDuration(left)} left`, tone: 'text-friend' } : { text: 'Time’s up — settling…', tone: 'text-muted-foreground' };
    }
    case 'ended': return { text: 'Time’s up — settling…', tone: 'text-muted-foreground' };
    case 'resolved': return { text: `Finished ${c.resolvedAt ? format(new Date(c.resolvedAt), 'MMM d, h:mm a') : ''}`, tone: 'text-muted-foreground' };
    case 'declined': {
      const reason = c.participants.find(p => p.response === 'declined')?.declineReason;
      return { text: reason === 'cant_reach' ? 'Declined — can’t get to this machine' : reason === 'no_thanks' ? 'Passed on' : reason === 'backed_out' ? 'Declined — players backed out' : 'Declined', tone: 'text-muted-foreground' };
    }
    case 'countered': return { text: c.counteredToId ? 'Moved to a suggested machine' : 'Countered — another machine was suggested', tone: MUTED };
    case 'cancelled': return { text: 'Cancelled', tone: MUTED };
    case 'expired': return { text: 'Expired — never started', tone: MUTED };
    default: return { text: String(c.status), tone: MUTED };
  }
}

/** A player has a counting score: only they're ranked (a no-show is "—", not "4th of 4"). */
function hasPosted(c: Challenge, p: ChallengeParticipant | undefined) {
  if (!p) return false;
  return c.status === 'resolved' ? p.resultValue != null : (p.standing?.countingCount ?? 0) > 0;
}

/** "You placed 2nd of 4." — counting only the players who posted when someone didn't. */
function placedText(c: Challenge, rank: number) {
  const players = c.participants.filter(p => p.response === 'accepted');
  const posted = players.filter(p => hasPosted(c, p)).length;
  return posted < players.length ? `You placed ${ordinal(rank)} of ${posted} who posted.` : `You placed ${ordinal(rank)} of ${players.length}.`;
}

function OutcomeBanner({ c, myRank, meP }: { c: Challenge; myRank: number | null; meP: ChallengeParticipant | undefined }) {
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
    : o === 'win' && !isGroupChallenge(c) && c.opponent && c.participants.find(p => p.user.id === c.opponent!.id)?.outcome === 'forfeit' ? 'They forfeited.'
    : isGroupChallenge(c) && (o === 'loss' || o === 'tie' || o === 'win') && myRank != null && hasPosted(c, meP)
      ? placedText(c, myRank)
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

/** The type-specific line under a player's value: race progress, baseline, plays, counting scores. */
function standingDetail(c: Challenge, p: ChallengeParticipant): React.ReactNode {
  const st = p.standing;
  const resolved = c.status === 'resolved';
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
  return detail;
}

/** Why a player isn't in it (or hasn't said yet) — the roster's and the cards' small print. */
function responseNote(p: ChallengeParticipant): React.ReactNode {
  if (p.response === 'pending') return <span className="text-amber-200">Hasn’t answered</span>;
  if (p.response === 'missed') return 'Missed it — didn’t answer in time';
  if (p.response === 'countered') return 'Suggested another machine';
  if (p.response === 'declined') return p.declineReason === 'cant_reach' ? 'Can’t get to it' : p.declineReason === 'no_thanks' ? 'Passed' : p.declineReason === 'backed_out' ? 'Backed out' : 'Declined';
  return null;
}

function StandingCard({ c, p, isMe, leader }: { c: Challenge; p: ChallengeParticipant; isMe: boolean; leader: boolean }) {
  const value = valueOf(p);
  const resolved = c.status === 'resolved';
  const nameColor = isMe ? 'text-username hover:text-username/80' : 'text-friend hover:text-friend/80';
  const outcome = resolved ? (c.void ? 'void' : p.outcome) : p.outcome === 'forfeit' ? 'forfeit' : null;
  const detail = standingDetail(c, p);
  const note = responseNote(p);

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
      {note && <p className="text-[11px] text-muted-foreground mt-1">{note}</p>}
    </div>
  );
}

/**
 * Groups: one ranked row per player who's in — phone-friendly (a row, not a card per player). The
 * rank is the final one once resolved, the live one while it runs; ties share a rank.
 */
function StandingsList({ c, myId, leaderId }: { c: Challenge; myId: number | null; leaderId: number | null }) {
  const resolved = c.status === 'resolved';
  const players = c.participants.filter(p => p.response === 'accepted');
  // Only players with a counting score get a rank; the rest show "—" (and sort last).
  const rankOf = (p: ChallengeParticipant) => (hasPosted(c, p) ? (resolved ? p.rank : p.standing?.liveRank) ?? null : null);
  const sorted = [...players].sort((a, b) => (rankOf(a) ?? 99) - (rankOf(b) ?? 99) || (valueOf(b) ?? -Infinity) - (valueOf(a) ?? -Infinity));
  return (
    <ol className="flex flex-col gap-1.5">
      {sorted.map(p => {
        const isMe = p.user.id === myId;
        const value = valueOf(p);
        const rank = rankOf(p);
        const outcome = resolved ? (c.void ? 'void' : p.outcome) : p.outcome === 'forfeit' ? 'forfeit' : null;
        const leader = leaderId === p.user.id;
        return (
          <li key={p.user.id} className={`rounded-lg border px-3 py-2 flex items-start gap-3 ${leader ? 'border-primary/50 bg-primary/10' : isMe ? 'border-username/30 bg-card' : 'border-white/10 bg-card'}`}>
            <span className={`w-8 flex-shrink-0 text-sm font-black ${rank === 1 ? 'text-primary' : 'text-white/70'}`}>{rank != null ? ordinal(rank) : '—'}</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">
                {isMe && <span className="text-username">You </span>}
                <UsernameLink username={p.user.username} className={isMe ? 'text-username hover:text-username/80' : 'text-friend hover:text-friend/80'} />
              </p>
              {standingDetail(c, p)}
            </div>
            <div className="flex flex-col items-end gap-1 flex-shrink-0">
              <span className={`text-base sm:text-lg font-black whitespace-nowrap ${value != null ? 'text-primary' : 'text-muted-foreground'}`}>{formatResult(c.type, value)}</span>
              {outcome ? <OutcomeChip outcome={outcome} /> : leader && <Crown className="w-4 h-4 text-primary" aria-label="Leading" />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Who's in a group and who has answered — shown while it's waiting (and whoever didn't join, after). */
function Roster({ c, myId }: { c: Challenge; myId: number | null }) {
  const started = c.status !== 'pending' && c.status !== 'proposed';
  const list = started ? c.participants.filter(p => p.response !== 'accepted') : c.participants;
  if (!list.length) return null;
  return (
    <section className="mb-6">
      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
        <Users className="w-3.5 h-3.5" aria-hidden /> {started ? 'Didn’t join' : `Players · ${c.playerCount ?? list.filter(p => !isOut(p)).length} of ${c.maxPlayers ?? 8} max`}
      </h2>
      <ul className="flex flex-col gap-1">
        {list.map(p => (
          <li key={p.user.id} className="flex flex-wrap items-center gap-x-2 text-sm">
            {p.user.id === myId && <span className="text-username font-semibold">You</span>}
            <UsernameLink username={p.user.username} className={p.user.id === myId ? 'text-username hover:text-username/80' : 'text-friend hover:text-friend/80'} />
            <span className="text-[11px] text-muted-foreground">
              {p.isCreator ? 'challenger' : p.response === 'accepted' ? <span className="text-emerald-300">in</span> : responseNote(p)}
            </span>
          </li>
        ))}
      </ul>
    </section>
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
                    <VenueName
                      name={s.venueName}
                      ownerUsername={s.venueOwnerUsername}
                      href={s.venueId != null ? `/venues/${s.venueId}` : undefined}
                      nameClassName="hover:text-venue/80"
                      className="truncate"
                    />
                  </p>
                )}
              </div>
              <FullPhotoButton
                scoreId={s.id}
                hasFullPhoto={s.hasFullPhoto}
                hasThumbnail={s.hasThumbnail}
                caption={{ machineName: c.machine.name, score: s.score, playedAt: s.playedAt, venueTimezone: s.venueTimezone, username: p.user.username }}
              />
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

/** Each side of a counter-offer links to the other: the suggestion ↔ the challenge it answers. */
function CounterLinks({ c, myId }: { c: Challenge; myId: number | null }) {
  if (!c.counteredFromId && !c.counteredToId) return null;
  const by = c.proposedBy;
  const mine = by?.id === myId;
  const earlier = c.counteredFromId ? <Link href={`/challenges/${c.counteredFromId}`} className="text-friend hover:underline">the original challenge</Link> : 'the original challenge';
  return (
    <div className="mb-6 rounded-lg border border-white/10 bg-card px-4 py-3 text-sm text-white/85 flex flex-col gap-1">
      {c.counteredFromId && (
        <p className="flex items-start gap-1.5"><CornerDownRight className="w-4 h-4 mt-0.5 text-friend flex-shrink-0" aria-hidden />
          <span>
            {c.isProposal && by ? (
              <>{mine ? 'Your suggestion' : <><span className="text-friend">@{by.username}</span>’s suggestion</>} instead of {earlier}.
                {c.status === 'proposed' && (c.me.canDecideProposal
                  ? ' Taking it moves everyone here — they’ll all be asked again.'
                  : ' If it’s taken, everyone moves here.')}</>
            ) : by ? (
              <>Moved here from {earlier} — <span className="text-friend">@{by.username}</span>’s suggestion.</>
            ) : (
              <>A counter-offer to {earlier} that couldn’t be played.</>
            )}
          </span>
        </p>
      )}
      {c.counteredToId && (
        <p className="flex items-center gap-1.5"><CornerDownRight className="w-4 h-4 text-friend flex-shrink-0" aria-hidden />
          <span>Everyone moved to <Link href={`/challenges/${c.counteredToId}`} className="text-friend hover:underline">a suggested machine</Link>.</span>
        </p>
      )}
    </div>
  );
}

const PROPOSAL_STATUS: Record<string, { label: string; tone: string }> = {
  proposed: { label: 'Open', tone: 'text-amber-200' },
  rejected: { label: 'Not taken', tone: 'text-muted-foreground' },
  lapsed: { label: 'Lapsed', tone: 'text-muted-foreground' },
};

/**
 * Suggestions on this challenge — every one for the challenger (with "Take it for everyone" / "Keep
 * mine" on the open ones), just your own for a proposer. Anything else (pending/active/…) means it
 * was taken and became the challenge everyone moved to.
 */
function ProposalsPanel({ c }: { c: Challenge }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'accept' | 'decline' }) => api.challenges.act(id, action),
    onSuccess: () => { setError(null); invalidateChallengeQueries(); },
    onError: e => { setError(challengeErrorText(e)); invalidateChallengeQueries(); },
  });
  const list = c.proposals ?? [];
  if (!list.length) return null;
  // Only the challenger may decide, and only while her original is still waiting (canCancel).
  const spin = <Loader2 className="w-3 h-3 animate-spin" aria-hidden />;
  const btn = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50';
  return (
    <section className="mb-6">
      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
        <Lightbulb className="w-3.5 h-3.5" aria-hidden /> Suggestions
      </h2>
      <ul className="flex flex-col gap-2">
        {list.map((p: ChallengeProposal) => {
          const st = PROPOSAL_STATUS[p.status] ?? { label: 'Taken', tone: 'text-emerald-300' };
          const open = p.status === 'proposed';
          const doing = (action: string) => decide.isPending && decide.variables?.id === p.id && decide.variables?.action === action;
          return (
            <li key={p.id} className="rounded-lg border border-white/10 bg-card px-3 py-2">
              <div className="flex items-start gap-3">
                <MachineThumb name={p.machine.name} imageUrl={p.machine.imageUrl} size="sm" />
                <div className="flex-1 min-w-0">
                  <Link href={`/challenges/${p.id}`} className="block text-sm font-semibold text-machine hover:text-machine/80 break-words">{p.machine.name}</Link>
                  <p className="text-[11px] text-muted-foreground flex flex-wrap gap-x-1.5">
                    <span>{typeLabel(p)}</span>
                    {p.proposedBy && <span>· from <span className="text-friend">@{p.proposedBy.username}</span></span>}
                    {p.venue && <span className="text-venue">· {p.venue.name}</span>}
                  </p>
                </div>
                <span className={`flex-shrink-0 text-[11px] font-bold uppercase tracking-wider ${st.tone}`}>{st.label}</span>
              </div>
              {open && c.me.canCancel && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, action: 'accept' })} className={`${btn} bg-friend text-zinc-950 hover:opacity-90`}>
                    {doing('accept') ? spin : <Check className="w-3 h-3" aria-hidden />} Take it for everyone
                  </button>
                  <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, action: 'decline' })} className={`${btn} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`}>
                    {doing('decline') ? spin : <X className="w-3 h-3" aria-hidden />} Keep mine
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}
    </section>
  );
}

function Actions({ c }: { c: Challenge }) {
  const api = useApi();
  const [confirmForfeit, setConfirmForfeit] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmBackOut, setConfirmBackOut] = useState(false);
  const [cantReach, setCantReach] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ action, reason }: { action: 'accept' | 'decline' | 'cancel' | 'forfeit' | 'start'; reason?: ChallengeDeclineChoice }) =>
      api.challenges.act(c.id, action, reason ? { reason } : undefined),
    onSuccess: () => { setError(null); setConfirmForfeit(false); setConfirmStart(false); setConfirmBackOut(false); setCantReach(false); invalidateChallengeQueries(); },
    onError: e => { setError(challengeErrorText(e)); invalidateChallengeQueries(); },
  });
  const { canAccept, canDecline, canCancel, canForfeit } = c.me;
  const canStart = !!c.me.canStart;
  const deciding = !!c.me.canDecideProposal;
  // An accepted player backing out while it's still waiting (a decline, server-side).
  const backingOut = canDecline && !deciding && c.me.response === 'accepted';
  const canCounter = c.me.canCounter ?? (canDecline && !backingOut);
  const inCount = c.participants.filter(p => p.response === 'accepted').length;
  const waitingCount = c.participants.filter(p => p.response === 'pending').length;
  if (!canAccept && !canDecline && !canCancel && !canForfeit && !canStart) return null;
  const busy = act.isPending;
  const doing = (action: string, reason?: string) => busy && act.variables?.action === action && act.variables?.reason === reason;
  const spin = <Loader2 className="w-4 h-4 animate-spin" aria-hidden />;
  const base = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-colors disabled:opacity-50';
  const ghost = `${base} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`;

  if (deciding) {
    const by = c.proposedBy?.username;
    return (
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'accept' })} className={`${base} bg-friend text-zinc-950 hover:opacity-90`}>
            {doing('accept') ? spin : <Check className="w-4 h-4" aria-hidden />} Take it for everyone
          </button>
          <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'decline' })} className={ghost}>
            {doing('decline') ? spin : <X className="w-4 h-4" aria-hidden />} Keep mine
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Taking it ends your original and asks everyone again on this machine. Keeping yours leaves {by ? `@${by}` : 'them'} out of it.
        </p>
        {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-2">
        {canStart && !confirmStart && (
          <button type="button" disabled={busy} onClick={() => setConfirmStart(true)} className={`${base} bg-friend text-zinc-950 hover:opacity-90`}>
            <Play className="w-4 h-4" aria-hidden /> Start with who’s in
          </button>
        )}
        {backingOut && !confirmBackOut && (
          <button type="button" disabled={busy} onClick={() => setConfirmBackOut(true)} className={ghost}>
            <LogOut className="w-4 h-4" aria-hidden /> Back out
          </button>
        )}
        {canAccept && (
          <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'accept' })} className={`${base} bg-friend text-zinc-950 hover:opacity-90`}>
            {doing('accept') ? spin : <Check className="w-4 h-4" aria-hidden />} Accept
          </button>
        )}
        {canDecline && !backingOut && !cantReach && (
          <button type="button" disabled={busy} onClick={() => setCantReach(true)} className={ghost}>
            <MapPinOff className="w-4 h-4" aria-hidden /> Can’t get to this one
          </button>
        )}
        {canDecline && !backingOut && (
          <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'decline', reason: 'no_thanks' })} className={ghost}>
            {doing('decline', 'no_thanks') ? spin : <X className="w-4 h-4" aria-hidden />} No thanks
          </button>
        )}
        {canCancel && (
          <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'cancel' })} className={ghost}>
            {doing('cancel') ? spin : <X className="w-4 h-4" aria-hidden />} Cancel challenge
          </button>
        )}
        {canForfeit && !confirmForfeit && (
          <button type="button" disabled={busy} onClick={() => setConfirmForfeit(true)} className={ghost}>
            <Flag className="w-4 h-4" aria-hidden /> Forfeit
          </button>
        )}
      </div>
      {confirmStart && (
        <div className="mt-3 rounded-lg border border-friend/30 bg-friend/5 p-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-white/90 flex-1 min-w-[12rem]">
            Start now with {inCount} {inCount === 1 ? 'player' : 'players'}?{waitingCount > 0 && ` ${waitingCount === 1 ? 'The one who hasn’t' : `The ${waitingCount} who haven’t`} answered will miss it.`}
            {(c.proposals ?? []).some(p => p.status === 'proposed') && ' Open suggestions won’t be taken.'}
          </p>
          <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'start' })} className={`${base} bg-friend text-zinc-950 hover:opacity-90`}>
            {doing('start') ? spin : <Play className="w-4 h-4" aria-hidden />} Start
          </button>
          <button type="button" onClick={() => setConfirmStart(false)} className="px-2 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white">
            Not yet
          </button>
        </div>
      )}
      {confirmBackOut && (
        <div className="mt-3 rounded-lg border border-white/15 bg-white/5 p-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-white/90 flex-1 min-w-[12rem]">Back out? You’ll be out of this challenge — it hasn’t started, so it isn’t a forfeit.</p>
          <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'decline' })} className={`${base} border border-white/25 text-white hover:border-white/40`}>
            {doing('decline') ? spin : <LogOut className="w-4 h-4" aria-hidden />} Back out
          </button>
          <button type="button" onClick={() => setConfirmBackOut(false)} className="px-2 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white">
            Stay in
          </button>
        </div>
      )}
      {cantReach && canDecline && !backingOut && (
        <div className="mt-3 rounded-lg border border-friend/30 bg-friend/5 p-3">
          <p className="text-sm text-white/90 mb-2">Can’t get to {c.machine.name}? Suggest a machine instead — it goes to whoever challenged you, and if they take it, everyone moves to it. It’s not a no.</p>
          <div className="flex flex-wrap items-center gap-2">
            {canCounter && (
              <Link href={`/challenges/new?counterOf=${c.id}`} className={`${base} bg-friend text-zinc-950 hover:opacity-90`}>
                <Swords className="w-4 h-4" aria-hidden /> Suggest another machine
              </Link>
            )}
            <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'decline', reason: 'cant_reach' })} className={ghost}>
              {doing('decline', 'cant_reach') ? spin : <X className="w-4 h-4" aria-hidden />} Just decline
            </button>
            <button type="button" onClick={() => setCantReach(false)} className="px-2 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white">
              Back
            </button>
          </div>
        </div>
      )}
      {confirmForfeit && (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 p-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-white/90 flex-1 min-w-[12rem]">Forfeit? It counts as a forfeit on your record{isGroupChallenge(c) ? ' and you drop to last.' : ' and they win.'}</p>
          <button type="button" disabled={busy} onClick={() => act.mutate({ action: 'forfeit' })} className={`${base} bg-red-500/80 text-white hover:bg-red-500`}>
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
  const adminApi = useAdminApi();
  const isAdmin = (appUser as any)?.role === 'admin';
  const mine = useQuery({
    queryKey: challengeKey(cid),
    queryFn: () => api.challenges.get(cid),
    enabled: valid && !!isSignedIn,
    retry: (n, e: any) => e?.status !== 404 && n < 1,
    // Keep live standings fresh while it's running; a finished one never changes.
    refetchInterval: q => (q.state.data?.status === 'active' ? 60_000 : false),
  });
  const notMine = (mine.error as any)?.status === 404;
  // Not one of yours: an admin reads it through the admin area instead (read-only).
  const asAdmin = useQuery({
    queryKey: ['admin', 'challenge', cid],
    queryFn: () => adminApi.challenge(cid),
    enabled: valid && !!isSignedIn && isAdmin && notMine,
    retry: (n, e: any) => e?.status !== 404 && n < 1,
    refetchInterval: q => (q.state.data?.status === 'active' ? 60_000 : false),
  });
  const viaAdmin = notMine && isAdmin;
  const { data: c, error } = viaAdmin ? asAdmin : mine;
  // isPending for the admin read: it's enabled only after the first 404, and isLoading is false for
  // the render before its fetch starts.
  const isLoading = viaAdmin ? asAdmin.isPending : mine.isLoading;

  if (!isSignedIn) return null;
  if (!valid || (error as any)?.status === 404 || (notMine && !isAdmin)) return <NotFound />;
  if (isLoading) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>;
  if (error || !c) return <p className="text-sm text-red-400">{challengeErrorText(error, 'Could not load this challenge')}</p>;

  const adminView = !!c.adminView;
  // An admin viewer isn't a player: nobody is "you".
  const myId: number | null = adminView ? null : (appUser as any)?.id ?? null;
  const { me, them } = adminView ? { me: undefined, them: undefined } : meAndThem(c, myId);
  const group = isGroupChallenge(c);
  const others = othersOf(c, myId);
  const status = statusLine(c, now);
  const started = c.participants.some(p => p.standing);
  // Leader: live rank 1 alone while running; the winner once resolved. No crown on a tie.
  const ranked = c.participants.filter(p => (c.status === 'resolved' ? p.outcome === 'win' : p.standing?.liveRank === 1 && valueOf(p) != null));
  const leaderId = ranked.length === 1 ? ranked[0].user.id : null;
  const showStandings = c.status === 'active' || c.status === 'resolved';
  const order = [...(me ? [me] : []), ...c.participants.filter(p => p !== me)];

  return (
    <div className="max-w-3xl">
      <Link href={adminView ? '/admin/crew?tab=challenges' : '/crew?tab=challenges'} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors mb-4">
        <ArrowLeft className="w-4 h-4" /> {adminView ? 'Admin · Challenges' : 'Challenges'}
      </Link>

      {adminView && (
        <div className="mb-5 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-white/85 flex flex-wrap items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0" aria-hidden />
          <Pill tone="primary">Admin view</Pill>
          <span>You’re not in this challenge — read-only.</span>
        </div>
      )}

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
            {adminView ? (
              // Nobody is "you": a group lists who's still in, a 1:1 both players (a decliner too).
              (group ? others : c.participants).map((p, i, list) => (
                <span key={p.user.id}>
                  <UsernameLink username={p.user.username} className="text-friend hover:text-friend/80" />{i < list.length - 1 ? (group ? ',' : ' vs') : ''}
                </span>
              ))
            ) : <>
            {me && <span className="text-username">You</span>}
            <span>vs</span>
            {group ? (
              others.length ? others.slice(0, 3).map((p, i) => (
                <span key={p.user.id}>
                  <UsernameLink username={p.user.username} className="text-friend hover:text-friend/80" />{i < Math.min(others.length, 3) - 1 ? ',' : ''}
                </span>
              )) : <span>—</span>
            ) : them ? <UsernameLink username={them.user.username} className="text-friend hover:text-friend/80" /> : <span>—</span>}
            {group && others.length > 3 && <span>+{others.length - 3}</span>}
            </>}
          </p>
          <p className={`text-sm font-bold mt-1 flex items-center gap-1.5 ${status.tone}`}>
            <Timer className="w-4 h-4" aria-hidden /> {status.text}
          </p>
        </div>
      </div>

      <OutcomeBanner c={c} myRank={me?.rank ?? null} meP={me} />
      <CounterLinks c={c} myId={myId} />
      {!adminView && <Actions c={c} />}
      <ProposalsPanel c={c} />
      {group && <Roster c={c} myId={myId} />}

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
          ) : group ? (
            <StandingsList c={c} myId={myId} leaderId={leaderId} />
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
          <div className={group ? 'flex flex-col gap-4' : 'flex flex-col sm:flex-row gap-4 sm:gap-6'}>
            {(group ? order.filter(p => p.response === 'accepted') : order).map(p => <ScoreList key={p.user.id} c={c} p={p} isMe={p === me} />)}
          </div>
          {c.status === 'active' && !adminView && (
            <p className="text-[11px] text-muted-foreground mt-3">
              Only scores with a photo, played and uploaded in the window{c.venue ? ` at ${c.venue.name}` : ''}, count.{' '}
              <Link href="/add" className="text-primary hover:underline">Add a score</Link>
            </p>
          )}
        </section>
      )}

      {c.type === 'most_improved' && (c.status === 'pending' || c.status === 'proposed') && !adminView && (
        <p className="text-xs text-muted-foreground">Accepting needs a score of yours on this machine from before the challenge starts.</p>
      )}
    </div>
  );
}
