import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from './useApi';
import { queryClient } from './queryClient';
import { formatScoreTime } from './scoreTime';
import type { Challenge, ChallengeOutcome, ChallengeParticipant, ChallengeType } from './api';

// Challenges UI helpers (feature/challenges, phase 3): copy, formatting, query keys and the shared
// queries. The rules themselves live on the api-server (challengeRules.ts) — nothing here decides
// who wins; it only says it.

export const CHALLENGES_KEY = ['challenges'];
export const challengeKey = (id: number) => ['challenges', 'detail', id];
export const challengeListKey = (status: 'pending' | 'active' | 'history') => ['challenges', 'list', status];
export const CHALLENGE_RECORD_KEY = ['challenges', 'record'];

/** After any challenge action: every list, the detail, records, the Crew badge and the bell may have changed. */
export function invalidateChallengeQueries() {
  queryClient.invalidateQueries({ queryKey: CHALLENGES_KEY });
  queryClient.invalidateQueries({ queryKey: ['notifications'] });
}

export const TYPE_META: Record<ChallengeType, { label: string; blurb: string }> = {
  high_score: { label: 'High score', blurb: 'Best score in the window wins.' },
  race: { label: 'Hit the target', blurb: 'First to beat the target wins on the spot. Nobody does → abandoned.' },
  most_improved: { label: 'Most improved', blurb: 'Biggest % gain over your own best from before the challenge.' },
  average: { label: 'Best average', blurb: 'Highest average of all your scores in the window, with enough plays.' },
};

export const TYPE_ORDER: ChallengeType[] = ['high_score', 'race', 'most_improved', 'average'];

/** The type's display label (TYPE_META), or "Challenge" for a type this client doesn't know. */
export function typeLabel(c: Pick<Challenge, 'type'>) {
  return TYPE_META[c.type]?.label ?? 'Challenge';
}

export const OUTCOME_META: Record<string, { label: string; chip: string; banner: string; tone: string }> = {
  win: { label: 'Win', chip: 'W', banner: 'You won', tone: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' },
  loss: { label: 'Loss', chip: 'L', banner: 'You lost', tone: 'border-red-400/40 bg-red-400/10 text-red-300' },
  tie: { label: 'Tie', chip: 'T', banner: 'It’s a tie', tone: 'border-amber-300/40 bg-amber-300/10 text-amber-200' },
  abandoned: { label: 'Abandoned', chip: 'Abandoned', banner: 'Abandoned', tone: 'border-white/20 bg-white/5 text-muted-foreground' },
  no_show: { label: 'No-show', chip: 'No-show', banner: 'No-show', tone: 'border-white/20 bg-white/5 text-muted-foreground' },
  forfeit: { label: 'Forfeit', chip: 'Forfeit', banner: 'Forfeit', tone: 'border-white/20 bg-white/5 text-muted-foreground' },
  void: { label: 'Void', chip: 'Void', banner: 'Void', tone: 'border-white/20 bg-white/5 text-muted-foreground' },
};

export function outcomeMeta(o: ChallengeOutcome | 'void' | null | undefined) {
  return (o && OUTCOME_META[o]) || { label: String(o ?? ''), chip: String(o ?? '?'), banner: String(o ?? ''), tone: 'border-white/20 bg-white/5 text-muted-foreground' };
}

/** Nobody finished a race / qualified for an average. Newer servers say so; older ones only in outcomes. */
export function isAbandoned(c: Challenge) {
  return c.abandoned ?? c.participants.some(p => p.outcome === 'abandoned');
}

/**
 * What to show as the viewer's final result on a history row: void and abandoned are about the whole
 * challenge, so they win over the personal outcome (which on those is no_show / abandoned anyway).
 * (void is retired server-side — nobody playing is abandoned now — so only legacy rows show it.)
 */
export function historyOutcome(c: Challenge): ChallengeOutcome | 'void' | null {
  if (c.status !== 'resolved') return null;
  if (c.void) return 'void';
  if (isAbandoned(c) && c.me.outcome !== 'forfeit') return 'abandoned';
  return c.me.outcome;
}

/** Up to 8 players, you included (the server's MAX_PLAYERS). */
export const MAX_PLAYERS = 8;
export const MAX_INVITEES = MAX_PLAYERS - 1;

/** Out of it: declined, suggested another machine, or never answered before it started. */
export function isOut(p: ChallengeParticipant) {
  return p.response === 'declined' || p.response === 'countered' || p.response === 'missed';
}

/** More than two players (a proposal row is always two: the proposer and the challenger). */
export function isGroupChallenge(c: Challenge) {
  return !c.isProposal && c.participants.length > 2;
}

/** Everyone but you who's still in it — the "vs" list. */
export function othersOf(c: Challenge, myId: number | null | undefined): ChallengeParticipant[] {
  return c.participants.filter(p => p.user.id !== myId && !isOut(p));
}

/** 1st, 2nd, 3rd, 4th … */
export function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

export function meAndThem(c: Challenge, myId: number | null | undefined): { me: ChallengeParticipant | undefined; them: ChallengeParticipant | undefined } {
  const them = c.participants.find(p => (c.opponent ? p.user.id === c.opponent.id : p.user.id !== myId));
  const me = c.participants.find(p => p !== them && (myId == null || p.user.id === myId)) ?? c.participants.find(p => p !== them);
  return { me, them };
}

/** Whole numbers everywhere (see the score formatting rule). */
export function formatScore(n: number | null | undefined) {
  return n == null ? '—' : Math.round(n).toLocaleString();
}

export function formatPercent(n: number | null | undefined) {
  if (n == null) return '—';
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? '+' : ''}${r.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** A participant's result value in the type's own unit. */
export function formatResult(type: ChallengeType, value: number | null | undefined) {
  return type === 'most_improved' ? formatPercent(value) : formatScore(value);
}

export function formatDuration(ms: number) {
  if (ms <= 0) return '0m';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s % 60}s`;
}

/** Re-renders every `everyMs` so countdowns tick. */
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** "3d 4h left" / "Starts in 2h 5m" / "Ended" / null — from the absolute window, ticking. */
export function timingText(c: Challenge, now: number): string | null {
  if (c.status !== 'active') return null;
  if (c.startsAt && +new Date(c.startsAt) > now) return `Starts in ${formatDuration(+new Date(c.startsAt) - now)}`;
  const left = +new Date(c.endsAt) - now;
  return left > 0 ? `${formatDuration(left)} left` : 'Ended — settling';
}

/**
 * When it (will) start — the agreed start, so two challenges on the same machine can be told apart:
 * "Started Sep 29, 8:41 PM" / "Starts Oct 2, 7:00 PM" / "Starts when everyone answers". A start is an
 * instant, not a venue wall clock, so it's rendered in the viewer's zone (formatScoreTime with no
 * venue zone). Null where it never ran or it's history (the row says how it ended instead).
 */
export function startText(c: Challenge, now: number): string | null {
  const when = (iso: string) => formatScoreTime(iso, null, new Date(iso).getFullYear() === new Date(now).getFullYear() ? 'MMM d, h:mm a' : 'MMM d, yyyy, h:mm a');
  if (c.status === 'active') {
    if (!c.startsAt) return null;
    return +new Date(c.startsAt) > now ? `Starts ${when(c.startsAt)}` : `Started ${when(c.startsAt)}`;
  }
  if (c.status === 'pending' || c.status === 'proposed') {
    if (c.startsAt) return `Starts ${when(c.startsAt)}`;
    return isGroupChallenge(c) ? 'Starts when everyone answers' : 'Starts when they accept';
  }
  return null;
}

/** A player has a counting score in a live challenge — the only players who get a live rank. */
export function hasPostedLive(p: ChallengeParticipant | undefined) {
  return (p?.standing?.countingCount ?? 0) > 0;
}

const ERROR_COPY: Record<string, string> = {
  not_friends: 'You can only challenge your friends.',
  cannot_challenge_self: 'You can’t challenge yourself.',
  user_not_found: 'We couldn’t find that player.',
  invalid_user: 'Pick a friend to challenge.',
  invalid_type: 'Pick a challenge type.',
  invalid_match_mode: 'Pick “Any model” or “Exact model”.',
  invalid_target: 'The target must be a whole number above zero.',
  invalid_min_plays: 'Minimum plays must be between 3 and 10.',
  invalid_window: 'Check the dates: it must start no earlier than now (at most 30 days out) and run between 1 hour and 90 days.',
  invalid_machine: 'Pick a machine.',
  machine_not_found: 'That machine isn’t on TiltTrack any more.',
  venue_not_found: 'That venue isn’t on TiltTrack any more.',
  venue_private: 'A challenge can only be locked to a public venue.',
  machine_not_at_venue: 'That venue doesn’t have this machine right now.',
  race_target_required: 'You have no score on this machine to beat yet — pick a number instead.',
  no_baseline: 'Most improved needs a score of yours on this machine from before the challenge — log one first.',
  creator_no_baseline: 'The challenger no longer has an earlier score on this machine, so improvement can’t be measured.',
  cannot_accept: 'This challenge can’t be accepted any more — it may have been cancelled or expired.',
  cannot_decline: 'This challenge can’t be declined any more.',
  cannot_cancel: 'This challenge can’t be cancelled any more — they may already have answered.',
  cannot_forfeit: 'This challenge can’t be forfeited now.',
  cannot_counter: 'You can’t suggest another machine for this one any more — it may have been cancelled, expired or already answered.',
  invalid_reason: 'Something went wrong sending your answer — try again.',
  challenge_not_found: 'This challenge doesn’t exist, or isn’t one of yours.',
  too_many_machines: 'Pick at most 3 machines to be challenged on.',
  too_many_venues: 'That’s a lot of challenge locations — remove a few first.',
  invalid_prefs: 'Those challenge settings didn’t look right — try again.',
  too_many_players: 'A challenge can have at most 8 players — you and 7 friends.',
  duplicate_invitee: 'Each friend can only be invited once.',
  cannot_start: 'It can’t be started now — someone has to accept first, and it has to still be waiting.',
};

/** Recommendation groups on the create form, most reliable first. */
export const REC_LEVEL_LABEL: Record<1 | 2 | 3, string> = {
  1: 'Wants to be challenged on',
  2: 'Can reach',
  3: 'Played lately',
};

/** The query key for someone's recommendations, and your own challenge preferences. */
export const recommendationsKey = (username: string) => ['challenges', 'recommendations', username.toLowerCase()];
export const groupRecommendationsKey = (usernames: string[]) => ['challenges', 'recommendations', 'group', ...usernames.map(u => u.toLowerCase()).sort()];
export const CHALLENGE_PREFS_KEY = ['challenges', 'prefs'];

export function challengeErrorText(e: unknown, fallback = 'Something went wrong'): string {
  const code = (e as any)?.code as string | undefined;
  if (code && ERROR_COPY[code]) return ERROR_COPY[code];
  return (e as any)?.message ?? fallback;
}

/** One of the three list queries (Crew → Challenges, and the badge for 'pending'). Signed-in only. */
export function useChallengeList(status: 'pending' | 'active' | 'history') {
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
  return useQuery({
    queryKey: challengeListKey(status),
    queryFn: () => api.challenges.list(status),
    enabled: isLoaded && !!isSignedIn,
    staleTime: 30_000,
  });
}

/** Pending challenges (and suggestions to decide) waiting on the viewer — part of the Crew badge. */
export function useIncomingChallengeCount() {
  const { data } = useChallengeList('pending');
  return (data ?? []).filter(c => c.me.canAccept).length;
}

/** The score rules, in the order a player needs them. Shown on the create flow and the detail page. */
export const SCORE_RULES = [
  'Scores need a photo.',
  'Played and uploaded during the window — no backdated uploads.',
  'Once a score counts it’s locked: it can’t be edited or deleted.',
];
