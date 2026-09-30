// Challenges — the rules as pure functions (feature/challenges, phase 2). No database here:
// lib/challenges.ts loads a challenge, its participants and their candidate scores, asks these what
// counts / who's winning / how it ends, and writes the answer. Kept pure so every rule is
// unit-tested (challengeRules.test.ts).
//
// The rules (Will, 2026-09-25/26):
//  - Friends only, checked at creation: every invitee must be the challenger's friend (they needn't be
//    friends with each other). Up to MAX_PLAYERS (8) players, the challenger included. Participants
//    are rows and everything here ranks N of them.
//  - GROUPS (feature/group-challenges, Will 2026-09-29): a group proceeds once at least one invitee
//    accepts. A decline drops that player; the challenge ends `declined` only when no invitee is
//    pending or accepted. "Starts when accepted" = once everyone has answered, or when the challenger
//    taps "Start with who's in"; with a fixed start it starts with whoever accepted and the rest are
//    `missed`. See afterAnswer() / pendingDue() below.
//  - COUNTER-OFFERS ARE PROPOSALS (1:1 and groups alike): a proposal row sent to the challenger —
//    creator_id = the challenger, proposed_by_id = the counterer, countered_from_id = the original,
//    status 'proposed'. Taking it ends the original `countered` and turns the proposal into an
//    ordinary pending challenge everyone is re-invited to; rejecting it drops the counterer.
//  - Types:
//      high_score     best counting score wins, at the deadline.
//      race           "Beat my score / First to X". Target = the number the creator picked, or the
//                     creator's best on the matching machine at creation. The target must be BEATEN:
//                     the first participant with a counting score > target (strictly — equalling it is
//                     not a finish) wins on the spot. Nobody by the deadline → the race is ABANDONED:
//                     every participant (played or not) gets `abandoned` — no win, loss, tie or no-show.
//      most_improved  (best counting score − baseline) / baseline, as a percent; highest wins at the
//                     deadline. Baseline = best score on the matching machine played before the window,
//                     frozen at acceptance. No baseline → can't take part (creation / acceptance refused).
//      average        mean of ALL counting scores; needs >= min_plays of them to qualify. Highest
//                     qualified average wins. Played but short of N → `loss` when someone qualified;
//                     nobody qualified → abandoned, like a race nobody finished.
//  - What counts: machine matches (OPDB group for 'game' mode, exact id otherwise), venue matches if
//    the challenge is venue-locked, the score has a photo, BOTH played_at and created_at are inside
//    [starts_at, ends_at] (blocks backdated uploads), played_at is no more than FUTURE_SKEW_MS after
//    created_at (a time in the future — playedAtClock.ts; the score routes refuse new ones, this
//    stops legacy rows counting), and every other participant may see the score
//    (a score at a home venue whose owner hid its activity doesn't count — see venueActivity.ts).
//  - Outcomes: win / loss / tie / forfeit (withdrew after accepting; when only one participant is
//    left they win on the spot) / no_show (no counting score while someone else did play) / abandoned
//    (nobody finished: a race nobody beat, an average nobody qualified for, or — ANY type — nobody
//    posted a counting score at all; Will 2026-09-26: "you signed up and were supposed to play").
//    Forfeits stay `forfeit` throughout.
//  - VOID IS RETIRED (2026-09-26): nobody playing used to make a challenge void (everyone no_show,
//    streaks untouched); it's now abandoned. The `void` column / field / record `voids` count stay so
//    the schema and API don't change, but a new resolution always writes void = false.
//  - Streaks (records): every outcome but a win, abandoned included, breaks one. (A legacy void
//    challenge still neither extends nor breaks one.)

import { playedAfter } from './playedAtClock.js';

export const CHALLENGE_TYPES = ['high_score', 'race', 'most_improved', 'average'] as const;
export type ChallengeType = (typeof CHALLENGE_TYPES)[number];
export type MatchMode = 'game' | 'exact';
export type ChallengeStatus = 'pending' | 'active' | 'resolved' | 'declined' | 'cancelled' | 'expired' | 'countered'
  | 'proposed' | 'rejected' | 'lapsed';
/** 'missed' = never answered: the challenge started (or expired) without them. */
export type ParticipantResponse = 'pending' | 'accepted' | 'declined' | 'countered' | 'missed';
export type Outcome = 'win' | 'loss' | 'tie' | 'forfeit' | 'no_show' | 'abandoned';

export const MIN_PLAYS = { min: 3, max: 10 } as const;
/** Longest window, start to end. */
export const MAX_WINDOW_DAYS = 90;
/** Shortest window, start to end. */
export const MIN_WINDOW_MS = 60 * 60 * 1000;
/** How far ahead a chosen start date may be. A pending challenge expires when its start passes. */
export const MAX_START_AHEAD_DAYS = 30;
/** A chosen start this far in the past still counts as "now" (clock skew, a slow form). */
export const START_GRACE_MS = 5 * 60 * 1000;
/** The daily sweep's "ending soon" notice goes out once this close to the deadline. */
export const ENDING_SOON_MS = 24 * 60 * 60 * 1000;
/** Players in one challenge, the challenger included (Will, 2026-09-29). */
export const MAX_PLAYERS = 8;
export const MAX_INVITEES = MAX_PLAYERS - 1;
/** The daily sweep reminds the challenger once about a suggestion unanswered this long. No timer beyond that. */
export const PROPOSAL_REMINDER_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── machine matching ─────────────────────────────────────────────────────────

/**
 * The OPDB group id of a machine: the part of `opdb_id` before the first '-'. OPDB ids look like
 * `GbPde-M5Rkv` (group-machine) or `G43W4-MXrPx-AO6D9` (group-machine-alias); every model of one
 * game (Pro / Premium / LE, remakes' aliases) shares the group. null when there's no usable id.
 */
export function opdbGroup(opdbId: string | null | undefined): string | null {
  if (!opdbId) return null;
  const group = opdbId.split('-')[0].trim();
  return /^G[A-Za-z0-9]{2,}$/.test(group) ? group : null;
}

/** The group to match on for a new challenge: 'game' mode with a usable OPDB id, else null (exact). */
export function matchGroupFor(matchMode: MatchMode, opdbId: string | null | undefined): string | null {
  return matchMode === 'game' ? opdbGroup(opdbId) : null;
}

export interface MatchRule {
  machineId: number;
  /** OPDB group captured at creation; null = this machine id only. */
  matchGroup: string | null;
}

export function machineMatches(rule: MatchRule, score: { machineId: number; opdbId: string | null }): boolean {
  if (rule.matchGroup) return score.machineId === rule.machineId || opdbGroup(score.opdbId) === rule.matchGroup;
  return score.machineId === rule.machineId;
}

/**
 * Does a Pinball Map roster carry a challenge's machine? (The venue-lock check.) Roster entries are
 * Pinball Map machines, which reach TiltTrack's machines table by name (syncVenueMachineHistory →
 * upsertMachineByName), so the match is by name against `targetNames` — every TiltTrack machine the
 * rule accepts (the challenge's machine in exact mode; every model in its OPDB group in game mode),
 * case-insensitive. In game mode a roster model TiltTrack has never seen can still match through
 * Pinball Map's own catalog (`catalogOpdbByPmId`: PM machine id → opdb_id), when that's available.
 */
export function rosterHasMachine(
  roster: Array<{ machine: { id: number; name: string } }>,
  targetNames: string[],
  matchGroup: string | null,
  catalogOpdbByPmId?: Map<number, string | null>,
): boolean {
  const names = new Set(targetNames.map(n => n.trim().toLowerCase()));
  return roster.some(x => {
    if (names.has(String(x.machine?.name ?? '').trim().toLowerCase())) return true;
    if (!matchGroup || !catalogOpdbByPmId) return false;
    return opdbGroup(catalogOpdbByPmId.get(x.machine?.id) ?? null) === matchGroup;
  });
}

// ── what counts ──────────────────────────────────────────────────────────────

export interface CandidateScore {
  id: number;
  userId: number;
  machineId: number;
  opdbId: string | null;
  venueId: number | null;
  score: number;
  playedAt: Date;
  createdAt: Date;
  /** photo_url or photo_thumbnail is set. */
  hasPhoto: boolean;
  /** Every other participant may see this score (canSeeScore). */
  visibleToOthers: boolean;
}

export interface CountRule extends MatchRule {
  venueId: number | null;
  startsAt: Date;
  endsAt: Date;
}

export type ExclusionReason =
  | 'machine' | 'played_in_future' | 'venue' | 'no_photo' | 'played_outside_window' | 'uploaded_outside_window' | 'hidden';

const inWindow = (t: Date, rule: CountRule) => +t >= +rule.startsAt && +t <= +rule.endsAt;

/** Why a score doesn't count (the first failing rule), or null when it does. */
export function exclusionReason(rule: CountRule, s: CandidateScore): ExclusionReason | null {
  if (!machineMatches(rule, s)) return 'machine';
  // Played after it was logged (beyond clock skew): impossible, so never counts — checked before the
  // other rules because it's the one the player should hear about.
  if (playedAfter(s.playedAt, s.createdAt)) return 'played_in_future';
  if (rule.venueId != null && s.venueId !== rule.venueId) return 'venue';
  if (!s.hasPhoto) return 'no_photo';
  if (!inWindow(s.playedAt, rule)) return 'played_outside_window';
  if (!inWindow(s.createdAt, rule)) return 'uploaded_outside_window';
  if (!s.visibleToOthers) return 'hidden';
  return null;
}

export function scoreCounts(rule: CountRule, s: CandidateScore): boolean {
  return exclusionReason(rule, s) === null;
}

/**
 * Whether a challenge's window is open for counting: active (or resolved), with a start that has
 * passed. Before that nothing counts — evaluate() in challenges.ts and scoreChallengeFits() share it.
 */
export function challengeStarted(c: { status: ChallengeStatus; startsAt: Date | null }, now: Date): boolean {
  return (c.status === 'active' || c.status === 'resolved') && !!c.startsAt && +now >= +c.startsAt;
}

// ── "how did this score fare?" (the Add Score / edit-score summary) ─────────

/**
 * Why a score doesn't count in one challenge, as the Add Score summary words it. Derived from
 * exclusionReason() — the same rules, in the same order, so the summary can never disagree with the
 * standings — with the window reasons split by which side of it the time fell:
 *   played_before_start / played_after_end   (played_at outside [starts_at, ends_at])
 *   posted_before_start / posted_after_end   (created_at outside it — a backdated upload)
 *   wrong_venue (venue lock), no_photo, not_visible (another participant can't see it — canSeeScore),
 *   played_in_future (played_at more than FUTURE_SKEW_MS after created_at).
 * 'machine' never appears: a score on another machine isn't reported at all.
 */
export type ChallengeFitReason =
  | 'counted' | 'not_started'
  | 'wrong_venue' | 'no_photo' | 'played_before_start' | 'played_after_end'
  | 'posted_before_start' | 'posted_after_end' | 'not_visible' | 'played_in_future';
export type ChallengeFitStatus = 'counted' | 'not_counted' | 'not_started';

/** One of the scorer's challenges, as scoreChallengeFits() needs it. */
export interface FitChallenge extends MatchRule {
  challengeId: number;
  machineName: string;
  type: ChallengeType;
  status: ChallengeStatus;
  venueId: number | null;
  venueName: string | null;
  startsAt: Date | null;
  endsAt: Date;
  /** The other accepted players' display names (for the summary's links). */
  opponents: string[];
  /** A challenge_scores row exists for this score — it counted (the lock never lies). */
  locked: boolean;
  /** The score as this challenge's audience sees it (visibleToOthers depends on who's in it). */
  score: CandidateScore;
}

export interface ChallengeFit {
  challengeId: number;
  machineName: string;
  type: ChallengeType;
  status: ChallengeFitStatus;
  reason: ChallengeFitReason;
  startsAt: Date | null;
  endsAt: Date;
  venueName: string | null;
  opponents: string[];
}

function fitReason(rule: CountRule, s: CandidateScore): ChallengeFitReason | 'machine' {
  switch (exclusionReason(rule, s)) {
    case null: return 'counted';
    case 'machine': return 'machine';
    case 'played_in_future': return 'played_in_future';
    case 'venue': return 'wrong_venue';
    case 'no_photo': return 'no_photo';
    case 'played_outside_window': return +s.playedAt < +rule.startsAt ? 'played_before_start' : 'played_after_end';
    case 'uploaded_outside_window': return +s.createdAt < +rule.startsAt ? 'posted_before_start' : 'posted_after_end';
    case 'hidden': return 'not_visible';
  }
}

/**
 * How one score fares in each of its author's challenges on the same machine: counted, not counted
 * (with the first failing rule), or not started yet (pending, or active with a start still ahead — it
 * will count if it's played after the start). Challenges on another machine are left out, so a score
 * on an unrelated game lists nothing. `locked` wins: a score recorded in challenge_scores counted —
 * except a played time in the future, which the standings stopped counting (exclusionReason) even
 * though its append-only lock row stays (a legacy row locked before the rule existed).
 */
export function scoreChallengeFits(challenges: FitChallenge[], now: Date): ChallengeFit[] {
  const out: ChallengeFit[] = [];
  for (const c of challenges) {
    if (!machineMatches(c, c.score)) continue;
    const base = {
      challengeId: c.challengeId, machineName: c.machineName, type: c.type,
      startsAt: c.startsAt, endsAt: c.endsAt, venueName: c.venueName, opponents: c.opponents,
    };
    if (playedAfter(c.score.playedAt, c.score.createdAt)) {
      out.push({ ...base, status: 'not_counted', reason: 'played_in_future' });
      continue;
    }
    if (c.locked) { out.push({ ...base, status: 'counted', reason: 'counted' }); continue; }
    if (!challengeStarted(c, now)) {
      if (c.status === 'pending' || c.status === 'active') out.push({ ...base, status: 'not_started', reason: 'not_started' });
      continue;
    }
    const reason = fitReason({ machineId: c.machineId, matchGroup: c.matchGroup, venueId: c.venueId, startsAt: c.startsAt!, endsAt: c.endsAt }, c.score);
    if (reason === 'machine') continue;
    out.push({ ...base, status: reason === 'counted' ? 'counted' : 'not_counted', reason });
  }
  return out;
}

/**
 * most_improved baseline: the best score on the matching machine PLAYED before the window starts.
 * Venue lock and the photo rule don't apply (it's your history, not a challenge entry), but the
 * visibility rule does, so a hidden home-venue score can't set a baseline the opponent can't see.
 */
export function baselineFrom(rule: MatchRule, startsAt: Date, scores: CandidateScore[]): number | null {
  let best: number | null = null;
  for (const s of scores) {
    if (!machineMatches(rule, s) || !s.visibleToOthers || +s.playedAt >= +startsAt) continue;
    if (best === null || s.score > best) best = s.score;
  }
  return best;
}

/** Best score on the matching machine, any time — the race type's default target ("beat my score"). */
export function bestOnMachine(rule: MatchRule, scores: CandidateScore[]): number | null {
  let best: number | null = null;
  for (const s of scores) if (machineMatches(rule, s) && (best === null || s.score > best)) best = s.score;
  return best;
}

/** Race target: the explicit number, else the creator's best; null = nothing to race to. */
export function raceTarget(explicit: number | null | undefined, creatorBest: number | null): number | null {
  if (explicit != null) return explicit;
  return creatorBest;
}

// ── standings ────────────────────────────────────────────────────────────────

export interface StandingOptions {
  targetScore?: number | null;
  minPlays?: number | null;
  baseline?: number | null;
}

export interface Standing {
  userId: number;
  countingCount: number;
  bestScore: number | null;
  /** high_score / race: best score. most_improved: % over baseline. average: mean. null = none. */
  resultValue: number | null;
  /** Has done enough to be ranked for the win (see each type). */
  qualified: boolean;
  /** race only: when the first counting score > target (strictly) was uploaded. */
  reachedTargetAt: Date | null;
  reachedTargetScoreId: number | null;
  /** The counting scores, best first. */
  scoreIds: number[];
}

/** One participant's standing from their COUNTING scores (already filtered by scoreCounts). */
export function computeStanding(type: ChallengeType, userId: number, counting: CandidateScore[], opts: StandingOptions = {}): Standing {
  const sorted = [...counting].sort((a, b) => b.score - a.score || a.id - b.id);
  const best = sorted.length ? sorted[0].score : null;
  const base: Standing = {
    userId, countingCount: sorted.length, bestScore: best, resultValue: null, qualified: false,
    reachedTargetAt: null, reachedTargetScoreId: null, scoreIds: sorted.map(s => s.id),
  };
  if (!sorted.length) return base;
  switch (type) {
    case 'high_score':
      return { ...base, resultValue: best, qualified: true };
    case 'race': {
      const target = opts.targetScore ?? Infinity;
      // Strictly beaten: equalling the target is not a finish.
      const hits = sorted.filter(s => s.score > target)
        .sort((a, b) => +a.createdAt - +b.createdAt || a.id - b.id);
      return {
        ...base, resultValue: best, qualified: hits.length > 0,
        reachedTargetAt: hits[0]?.createdAt ?? null, reachedTargetScoreId: hits[0]?.id ?? null,
      };
    }
    case 'most_improved': {
      const baseline = opts.baseline;
      if (baseline == null || baseline <= 0) return base;
      return { ...base, resultValue: ((best! - baseline) / baseline) * 100, qualified: true };
    }
    case 'average': {
      const mean = sorted.reduce((sum, s) => sum + s.score, 0) / sorted.length;
      return { ...base, resultValue: mean, qualified: sorted.length >= (opts.minPlays ?? Infinity) };
    }
  }
}

// ── resolution ───────────────────────────────────────────────────────────────

export interface ParticipantState {
  userId: number;
  forfeited: boolean;
  standing: Standing;
}

export interface ResolvedParticipant {
  userId: number;
  outcome: Outcome;
  rank: number;
  resultValue: number | null;
}

export type ResolutionReason = 'deadline' | 'race_target' | 'forfeit';

export interface Resolution {
  reason: ResolutionReason;
  /** Retired (2026-09-26): always false. Kept so the column and API field don't change. */
  void: boolean;
  /** Nobody finished (race / average), or nobody played (any type): every non-forfeited participant is `abandoned`. */
  abandoned: boolean;
  participants: ResolvedParticipant[];
}

/** The race winner: earliest upload of a counting score > target (score id breaks a same-instant tie). */
export function raceWinner(states: ParticipantState[]): ParticipantState | null {
  const hits = states.filter(s => !s.forfeited && s.standing.reachedTargetAt);
  hits.sort((a, b) => +a.standing.reachedTargetAt! - +b.standing.reachedTargetAt!
    || a.standing.reachedTargetScoreId! - b.standing.reachedTargetScoreId!);
  return hits[0] ?? null;
}

/** Whether (and why) an active challenge should resolve now. null = keep going. */
export function resolutionTrigger(
  type: ChallengeType, endsAt: Date, now: Date, states: ParticipantState[],
): ResolutionReason | null {
  const remaining = states.filter(s => !s.forfeited);
  if (states.some(s => s.forfeited) && remaining.length <= 1) return 'forfeit';
  if (type === 'race' && raceWinner(states)) return 'race_target';
  if (+now > +endsAt) return 'deadline';
  return null;
}

/**
 * Outcomes and ranks. `reason` picks the rulebook: 'forfeit' (one participant left: they win),
 * 'race_target' (first to the target wins; others loss if they played, else no_show), 'deadline'
 * (per type — see the header). Ranks are competition ranks (1, 1, 3): winners first, then other
 * ranked participants by result, then those who played without qualifying, then no-shows, then
 * forfeits. Abandoned = nobody finished — a race nobody beat or an average nobody qualified for, or
 * a challenge of any type nobody played: every non-forfeited participant is `abandoned` (ranked:
 * played ahead of didn't). Never void (retired).
 */
export function resolveChallenge(type: ChallengeType, states: ParticipantState[], reason: ResolutionReason): Resolution {
  const remaining = states.filter(s => !s.forfeited);
  const played = (s: ParticipantState) => s.standing.countingCount > 0;
  // outcome + sort group per participant; value orders within a group (higher first).
  const decided = new Map<number, { outcome: Outcome; group: number; value: number }>();
  const val = (s: ParticipantState) => s.standing.resultValue ?? -Infinity;
  for (const s of states) if (s.forfeited) decided.set(s.userId, { outcome: 'forfeit', group: 4, value: 0 });

  if (reason === 'forfeit' && remaining.length <= 1) {
    for (const s of remaining) decided.set(s.userId, { outcome: 'win', group: 0, value: 0 });
  } else if (reason === 'race_target') {
    const winner = raceWinner(states);
    for (const s of remaining) {
      if (s === winner) decided.set(s.userId, { outcome: 'win', group: 0, value: 0 });
      else if (played(s)) decided.set(s.userId, { outcome: 'loss', group: 2, value: val(s) });
      else decided.set(s.userId, { outcome: 'no_show', group: 3, value: 0 });
    }
  } else {
    const qualified = remaining.filter(s => s.standing.qualified);
    const nobodyFinished = (type === 'race' || type === 'average') && qualified.length === 0;
    const nobodyPlayed = !remaining.some(played);
    if (remaining.length && (nobodyFinished || nobodyPlayed)) {
      // Nobody beat the target / reached min plays, or nobody played at all (any type): abandoned for
      // everyone, played or not. Those who played rank level ahead of those who didn't (live standings
      // use this).
      for (const s of remaining) decided.set(s.userId, { outcome: 'abandoned', group: played(s) ? 0 : 3, value: 0 });
    } else {
      const top = Math.max(...qualified.map(val), -Infinity);
      const leaders = qualified.filter(s => val(s) === top);
      for (const s of remaining) {
        if (leaders.includes(s)) decided.set(s.userId, { outcome: leaders.length > 1 ? 'tie' : 'win', group: 0, value: 0 });
        else if (s.standing.qualified) decided.set(s.userId, { outcome: 'loss', group: 1, value: val(s) });
        else if (played(s)) decided.set(s.userId, { outcome: 'loss', group: 2, value: val(s) });
        else decided.set(s.userId, { outcome: 'no_show', group: 3, value: 0 });
      }
    }
  }

  const ahead = (a: { group: number; value: number }, b: { group: number; value: number }) =>
    a.group < b.group || (a.group === b.group && a.value > b.value);
  const participants: ResolvedParticipant[] = states.map(s => {
    const me = decided.get(s.userId)!;
    const rank = 1 + [...decided.values()].filter(o => ahead(o, me)).length;
    return { userId: s.userId, outcome: me.outcome, rank, resultValue: s.standing.resultValue };
  });
  participants.sort((a, b) => a.rank - b.rank || a.userId - b.userId);
  const abandoned = participants.some(p => p.outcome === 'abandoned');
  return { reason, void: false, abandoned, participants };
}

/** Live ranks if the challenge ended now (for standings); forfeits last. */
export function projectedRanks(type: ChallengeType, states: ParticipantState[]): Map<number, number> {
  const winner = type === 'race' ? raceWinner(states) : null;
  const r = resolveChallenge(type, states, winner ? 'race_target' : 'deadline');
  // Only players with a counting score are ranked live: someone who hasn't posted isn't "2nd of 2",
  // they just haven't played yet (Will, 2026-09-30). No-shows sort after everyone who played, so
  // leaving them out doesn't move anyone else's rank.
  const posted = new Set(states.filter(s => s.standing.countingCount > 0).map(s => s.userId));
  return new Map(r.participants.filter(p => posted.has(p.userId)).map(p => [p.userId, p.rank]));
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export interface LifecycleChallenge {
  creatorId: number;
  status: ChallengeStatus;
  startsAt: Date | null;
  endsAt: Date;
}

export interface LifecycleParticipant {
  userId: number;
  response: ParticipantResponse;
  outcome: Outcome | null;
}

/** The statuses a proposal row can be in before it's taken (a taken one is an ordinary challenge). */
export const PROPOSAL_STATUSES = ['proposed', 'rejected', 'lapsed'] as const;
export function isProposalStatus(status: ChallengeStatus): boolean {
  return (PROPOSAL_STATUSES as readonly string[]).includes(status);
}

/** The challenger's invitees: every participant but the creator. */
function inviteesOf<P extends LifecycleParticipant>(c: LifecycleChallenge, ps: P[]): P[] {
  return ps.filter(p => p.userId !== c.creatorId);
}

/**
 * A pending challenge whose chosen start, or end, has passed. (The yes/no view of pendingDue — with a
 * fixed start it may now START rather than expire; see pendingDue.)
 */
export function pendingExpired(c: LifecycleChallenge, now: Date): boolean {
  if (c.status !== 'pending') return false;
  if (c.startsAt && +now >= +c.startsAt) return true;
  return +now >= +c.endsAt;
}

export type PendingDue = 'start' | 'expire' | 'lapse';

/**
 * What a pending challenge (or an open proposal) must do now on its own, if anything:
 *  - pending, its end passed → 'expire' (it can't run any more);
 *  - pending, its fixed start passed → 'start' when at least one invitee accepted (the rest become
 *    `missed`), else 'expire';
 *  - an open proposal ('proposed') whose own start or end passed → 'lapse'.
 * "Starts when accepted" challenges never start here — only an answer (afterAnswer) or the
 * challenger's Start does that.
 */
export function pendingDue(c: LifecycleChallenge, participants: LifecycleParticipant[], now: Date): PendingDue | null {
  if (c.status === 'proposed') {
    return (c.startsAt && +now >= +c.startsAt) || +now >= +c.endsAt ? 'lapse' : null;
  }
  if (c.status !== 'pending') return null;
  if (+now >= +c.endsAt) return 'expire';
  if (c.startsAt && +now >= +c.startsAt) {
    return inviteesOf(c, participants).some(p => p.response === 'accepted') ? 'start' : 'expire';
  }
  return null;
}

/**
 * Checked after every answer (accept, decline, back out, a proposal rejected or lapsed):
 *  - L 'active': pending, no invitee pending, no proposal open, at least one invitee accepted;
 *  - D 'declined': pending, no invitee pending or accepted, no proposal open;
 *  - otherwise null (keep waiting).
 * An open proposal blocks both, so a counter can't be superseded the instant it's made.
 */
export function afterAnswer(c: LifecycleChallenge, participants: LifecycleParticipant[], openProposals: number): 'active' | 'declined' | null {
  if (c.status !== 'pending' || openProposals > 0) return null;
  const invitees = inviteesOf(c, participants);
  if (invitees.some(p => p.response === 'pending')) return null;
  return invitees.some(p => p.response === 'accepted') ? 'active' : 'declined';
}

/** The challenger answering an open proposal: take it ("for everyone") or keep hers. */
export function canDecideProposal(c: LifecycleChallenge, p: LifecycleParticipant | undefined): boolean {
  return !!p && c.status === 'proposed' && p.userId === c.creatorId && p.response === 'pending';
}
/** An invitee answering a pending challenge — or the challenger taking a proposal (the same button). */
export function canAccept(c: LifecycleChallenge, p: LifecycleParticipant | undefined): boolean {
  if (canDecideProposal(c, p)) return true;
  return !!p && c.status === 'pending' && p.response === 'pending' && p.userId !== c.creatorId;
}
/**
 * An invitee saying no — also an accepted invitee backing out while it's still pending (recorded
 * 'declined'; Will 2026-09-29) — or the challenger keeping hers over a proposal.
 */
export function canDecline(c: LifecycleChallenge, p: LifecycleParticipant | undefined): boolean {
  if (canDecideProposal(c, p)) return true;
  return !!p && c.status === 'pending' && p.userId !== c.creatorId && (p.response === 'pending' || p.response === 'accepted');
}
/** Answering "can't get to this one" with a counter-offer: an invitee who hasn't answered yet. */
export function canCounter(c: LifecycleChallenge, p: LifecycleParticipant | undefined): boolean {
  return !!p && c.status === 'pending' && p.response === 'pending' && p.userId !== c.creatorId;
}
export function canCancel(c: LifecycleChallenge, actorId: number): boolean {
  return c.status === 'pending' && c.creatorId === actorId;
}
/** "Start with who's in": the challenger, while pending, once at least one invitee accepted. */
export function canStart(c: LifecycleChallenge, participants: LifecycleParticipant[], actorId: number): boolean {
  return c.status === 'pending' && c.creatorId === actorId && inviteesOf(c, participants).some(p => p.response === 'accepted');
}
export function canForfeit(c: LifecycleChallenge, p: LifecycleParticipant | undefined): boolean {
  return !!p && c.status === 'active' && p.response === 'accepted' && p.outcome === null;
}

/**
 * Who a taken proposal re-invites (Will, 2026-09-29): everyone on the original except the challenger
 * and the proposer (already in), `no_thanks` decliners, and anyone no longer the challenger's friend.
 * Everyone re-accepts, including players who had accepted the original.
 */
export function reinvitees(
  original: LifecycleChallenge, participants: Array<LifecycleParticipant & { declineReason?: DeclineReason | null }>,
  proposerId: number, challengerFriendIds: Set<number>,
): number[] {
  return participants
    .filter(p => p.userId !== original.creatorId && p.userId !== proposerId)
    .filter(p => !(p.response === 'declined' && p.declineReason === 'no_thanks'))
    .filter(p => challengerFriendIds.has(p.userId))
    .map(p => p.userId);
}

/**
 * Why an open proposal closed, and the status it closes with: the challenger kept hers ('rejected'),
 * another suggestion was taken ('superseded'), the challenger started the original ('started'), or it
 * lapsed — the original hit its fixed start ('fixed_start', notified as 'started'), was cancelled, or
 * expired (the original, or the proposal's own window).
 */
export type ProposalCloseReason = 'rejected' | 'superseded' | 'started' | 'fixed_start' | 'cancelled' | 'expired';
export type ProposalNotifyReason = 'rejected' | 'superseded' | 'started' | 'cancelled' | 'expired';
//
// The challenger's own participant row on the proposal (response 'pending' while it's open) is closed
// with it, by status, so no closed proposal is ever left "waiting" on her: 'rejected' -> 'declined'
// (responded_at stamped, decline_reason null: she decided - kept hers, took another, or started the
// original) and 'lapsed' -> 'missed' (no responded_at: it closed without her answer, the same meaning
// as a pending player of an expired challenge). The proposer's row stays 'accepted'.
export function proposalClosure(reason: ProposalCloseReason): {
  status: 'rejected' | 'lapsed'; notifyReason: ProposalNotifyReason; challengerResponse: 'declined' | 'missed';
} {
  switch (reason) {
    case 'rejected': case 'superseded': case 'started': return { status: 'rejected', notifyReason: reason, challengerResponse: 'declined' };
    case 'fixed_start': return { status: 'lapsed', notifyReason: 'started', challengerResponse: 'missed' };
    case 'cancelled': case 'expired': return { status: 'lapsed', notifyReason: reason, challengerResponse: 'missed' };
  }
}

/**
 * What the UI shows: pending, scheduled (accepted, start date ahead), live, resolved, declined,
 * cancelled, expired, countered. ('ended' only for the instant between the deadline and a lazy resolve.)
 * The proposal statuses map onto the old phases (proposed → pending, rejected → declined, lapsed →
 * expired) so an old cached client — whose status line has no default branch — never sees a phase it
 * doesn't know. New clients read `status` for the difference.
 */
export type ChallengePhase = 'pending' | 'scheduled' | 'live' | 'ended' | 'resolved' | 'declined' | 'cancelled' | 'expired' | 'countered';
export function phaseOf(c: LifecycleChallenge, now: Date): ChallengePhase {
  switch (c.status) {
    case 'proposed': return 'pending';
    case 'rejected': return 'declined';
    case 'lapsed': return 'expired';
    case 'active': break;
    default: return c.status;
  }
  if (c.startsAt && +now < +c.startsAt) return 'scheduled';
  if (+now > +c.endsAt) return 'ended';
  return 'live';
}

// ── declining ────────────────────────────────────────────────────────────────

/**
 * Why an invitee said no. Every kind of answer is stored (challenge_participants.decline_reason) so
 * badges can tell "can't get there" from "not interested": 'cant_reach' (a plain decline after
 * "Can't get to this one", and every counter-offer) and 'no_thanks'. A decline sent without a reason
 * (an older client) stays null.
 *
 * 'backed_out' is the third stored value: an ACCEPTED invitee who leaves a group before it starts
 * (response 'declined'). The server sets it on the back-out path only — it is not one of the
 * DECLINE_REASONS a client may send, so a decline body naming it is a 400.
 */
export const DECLINE_REASONS = ['cant_reach', 'no_thanks'] as const;
/** A reason a client may give in a decline body. */
export type ChosenDeclineReason = (typeof DECLINE_REASONS)[number];
/** Every stored value of challenge_participants.decline_reason. */
export type DeclineReason = ChosenDeclineReason | 'backed_out';

/** The optional `reason` of a decline body: a chosen reason, null when absent, or 'invalid' (incl. 'backed_out'). */
export function parseDeclineReason(body: unknown): ChosenDeclineReason | null | 'invalid' {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).reason : undefined;
  if (raw === undefined || raw === null || raw === '') return null;
  return (DECLINE_REASONS as readonly unknown[]).includes(raw) ? raw as ChosenDeclineReason : 'invalid';
}

/**
 * The decline_reason a decline stores: 'backed_out' when the decliner had already accepted (backing
 * out of a pending group — whatever reason the body gave), otherwise the reason they chose (or null).
 */
export function storedDeclineReason(priorResponse: ParticipantResponse, chosen: ChosenDeclineReason | null): DeclineReason | null {
  return priorResponse === 'accepted' ? 'backed_out' : chosen;
}

/**
 * A participant who is out of this challenge: said no (plain decline or counter-offer), or missed it
 * (never answered before it started / expired).
 */
export function saidNo(response: ParticipantResponse): boolean {
  return response === 'declined' || response === 'countered' || response === 'missed';
}

// ── creation input ───────────────────────────────────────────────────────────

export interface CreateInput {
  type: ChallengeType;
  matchMode: MatchMode;
  targetScore: number | null;
  minPlays: number | null;
  /** null = starts when accepted. */
  startsAt: Date | null;
  endsAt: Date;
}

export type Invalid = { ok: false; code: string; error: string };
export type Valid<T> = { ok: true; value: T };

function parseDate(raw: unknown): Date | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return 'invalid';
  const d = new Date(raw);
  return Number.isNaN(+d) ? 'invalid' : d;
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

const bad = (code: string, error: string): Invalid => ({ ok: false, code, error });

/** Validates the type / target / min plays / window part of a create request. */
export function validateCreate(body: Record<string, unknown>, now: Date): Valid<CreateInput> | Invalid {
  const type = body.type;
  if (typeof type !== 'string' || !(CHALLENGE_TYPES as readonly string[]).includes(type)) {
    return bad('invalid_type', `type must be one of ${CHALLENGE_TYPES.join(', ')}`);
  }
  const t = type as ChallengeType;
  const matchMode = body.matchMode ?? 'game';
  if (matchMode !== 'game' && matchMode !== 'exact') return bad('invalid_match_mode', "matchMode must be 'game' or 'exact'");

  let targetScore: number | null = null;
  if (t === 'race' && body.targetScore !== undefined && body.targetScore !== null && body.targetScore !== '') {
    targetScore = parsePositiveInt(body.targetScore);
    if (targetScore == null) return bad('invalid_target', 'targetScore must be a positive whole number');
  }

  let minPlays: number | null = null;
  if (t === 'average') {
    const n = typeof body.minPlays === 'string' ? Number(body.minPlays) : body.minPlays;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_PLAYS.min || n > MIN_PLAYS.max) {
      return bad('invalid_min_plays', `minPlays must be a whole number from ${MIN_PLAYS.min} to ${MIN_PLAYS.max}`);
    }
    minPlays = n;
  }

  const startsAt = parseDate(body.startsAt);
  const endsAt = parseDate(body.endsAt);
  if (startsAt === 'invalid') return bad('invalid_window', 'startsAt is not a valid date');
  if (endsAt === 'invalid' || endsAt === null) return bad('invalid_window', 'endsAt is required');
  if (startsAt && +startsAt < +now - START_GRACE_MS) return bad('invalid_window', 'startsAt can’t be in the past');
  if (startsAt && +startsAt > +now + MAX_START_AHEAD_DAYS * DAY_MS) {
    return bad('invalid_window', `startsAt can be at most ${MAX_START_AHEAD_DAYS} days ahead`);
  }
  const start = startsAt && +startsAt > +now ? startsAt : now;
  if (+endsAt - +start < MIN_WINDOW_MS) return bad('invalid_window', 'The challenge must run for at least an hour');
  if (+endsAt - +start > MAX_WINDOW_DAYS * DAY_MS) return bad('invalid_window', `The challenge can run for at most ${MAX_WINDOW_DAYS} days`);

  // A start within the grace period is just "now": store null so it starts at acceptance.
  return {
    ok: true,
    value: { type: t, matchMode, targetScore, minPlays, startsAt: startsAt && +startsAt > +now ? startsAt : null, endsAt },
  };
}

/** One invitee as the create body names them. */
export type InviteeRef = { id: number } | { username: string };

/**
 * The invitees of a create body: `friendIds` (array of user ids) and/or `friendUsernames`, or the 1:1
 * fields `friendId` / `friendUsername` older clients send. At least one, at most MAX_INVITEES, no
 * repeats (by id, and by username — the DB layer re-checks once usernames resolve to ids).
 */
export function parseInvitees(body: Record<string, unknown>): Valid<InviteeRef[]> | Invalid {
  const refs: InviteeRef[] = [];
  const addId = (raw: unknown): boolean => {
    const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return false;
    refs.push({ id: n });
    return true;
  };
  const addName = (raw: unknown): boolean => {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    refs.push({ username: raw.trim() });
    return true;
  };
  const listError = bad('invalid_user', 'friendIds must be an array of user ids, friendUsernames an array of usernames');
  if (body.friendIds !== undefined && body.friendIds !== null) {
    if (!Array.isArray(body.friendIds) || !body.friendIds.every(addId)) return listError;
  }
  if (body.friendUsernames !== undefined && body.friendUsernames !== null) {
    if (!Array.isArray(body.friendUsernames) || !body.friendUsernames.every(addName)) return listError;
  }
  if (body.friendId !== undefined && body.friendId !== null && body.friendId !== '') {
    if (!addId(body.friendId)) return bad('invalid_user', 'friendId must be a user id');
  } else if (body.friendUsername !== undefined && body.friendUsername !== null && body.friendUsername !== '') {
    if (!addName(body.friendUsername)) return bad('invalid_user', 'friendUsername must be a username');
  }
  if (!refs.length) return bad('invalid_user', 'friendIds (or friendId / friendUsername) is required');
  if (refs.length > MAX_INVITEES) {
    return bad('too_many_players', `A challenge can have at most ${MAX_PLAYERS} players — you and ${MAX_INVITEES} friends`);
  }
  const keys = refs.map(r => ('id' in r ? `id:${r.id}` : `u:${r.username.toLowerCase()}`));
  if (new Set(keys).size !== keys.length) return bad('duplicate_invitee', 'Each friend can only be invited once');
  return { ok: true, value: refs };
}

// ── records ──────────────────────────────────────────────────────────────────

/** One participant's final place in a resolved challenge. */
export interface Placing {
  outcome: Outcome;
  rank: number | null;
}

export interface RecordEntry {
  challengeId: number;
  resolvedAt: Date;
  void: boolean;
  outcome: Outcome;
  /** The subject's rank (head-to-head is pairwise by rank). */
  rank?: number | null;
  /** The other accepted players and their placings. Preferred over `opponentIds`. */
  opponents?: Array<Placing & { userId: number }>;
  /** Older shape: head-to-head then just repeats the headline outcome (right for 1:1 only). */
  opponentIds?: number[];
}

/**
 * My result against one other player of the same resolved challenge (head-to-head is pairwise by
 * rank, Will 2026-09-29). My own forfeit / no-show / abandoned stays in its bucket; if THEY forfeited
 * or didn't show, I win; otherwise the better rank wins and an equal rank ties. For two players this
 * is exactly the headline outcome.
 */
export function pairOutcome(me: Placing, them: Placing): Outcome {
  if (me.outcome === 'forfeit' || me.outcome === 'no_show' || me.outcome === 'abandoned') return me.outcome;
  if (them.outcome === 'forfeit' || them.outcome === 'no_show') return 'win';
  if (me.rank == null || them.rank == null) return me.outcome;
  if (me.rank < them.rank) return 'win';
  if (me.rank > them.rank) return 'loss';
  return 'tie';
}

export interface HeadToHead {
  opponentId: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  forfeits: number;
  noShows: number;
  abandoned: number;
}

export interface ChallengeRecord {
  played: number;
  wins: number;
  losses: number;
  ties: number;
  forfeits: number;
  noShows: number;
  /** Challenges nobody finished or nobody played. Not a win, loss, tie or no-show. */
  abandoned: number;
  /** Legacy void challenges only — void is retired, so this stays 0 from now on. */
  voids: number;
  currentStreak: number;
  bestStreak: number;
  /** Longest run of consecutive losses (badges phase 3). Any other outcome ends one. */
  bestLossStreak: number;
  headToHead: HeadToHead[];
}

/**
 * W/L/T/forfeit/no-show/abandoned totals and streaks from resolved challenges. The headline totals
 * and the streaks use the subject's own `outcome` — in a group, placing below 1st is a loss. An
 * abandoned one counts only in `abandoned` and DOES break a streak. Win streaks are consecutive wins
 * in resolved order, loss streaks consecutive losses; any other outcome ends one. (A legacy void
 * challenge — void is retired — counts as a no-show and in `voids`, and neither extends nor breaks a
 * streak.) Head-to-head is pairwise by rank (pairOutcome).
 */
export function computeRecord(entries: RecordEntry[]): ChallengeRecord {
  const rec: ChallengeRecord = {
    played: 0, wins: 0, losses: 0, ties: 0, forfeits: 0, noShows: 0, abandoned: 0, voids: 0,
    currentStreak: 0, bestStreak: 0, bestLossStreak: 0, headToHead: [],
  };
  const h2h = new Map<number, HeadToHead>();
  const bump = (r: { wins: number; losses: number; ties: number; forfeits: number; noShows: number; abandoned: number }, o: Outcome) => {
    if (o === 'win') r.wins++;
    else if (o === 'loss') r.losses++;
    else if (o === 'tie') r.ties++;
    else if (o === 'forfeit') r.forfeits++;
    else if (o === 'abandoned') r.abandoned++;
    else r.noShows++;
  };
  const ordered = [...entries].sort((a, b) => +a.resolvedAt - +b.resolvedAt || a.challengeId - b.challengeId);
  let run = 0, lossRun = 0;
  for (const e of ordered) {
    rec.played++;
    bump(rec, e.outcome);
    if (e.void) rec.voids++;
    const pairs: Array<[number, Outcome]> = e.opponents
      ? e.opponents.map(o => [o.userId, pairOutcome({ outcome: e.outcome, rank: e.rank ?? null }, o)])
      : (e.opponentIds ?? []).map(id => [id, e.outcome]);
    for (const [id, o] of pairs) {
      const row = h2h.get(id) ?? { opponentId: id, played: 0, wins: 0, losses: 0, ties: 0, forfeits: 0, noShows: 0, abandoned: 0 };
      row.played++;
      bump(row, o);
      h2h.set(id, row);
    }
    if (e.void) continue;
    run = e.outcome === 'win' ? run + 1 : 0;
    lossRun = e.outcome === 'loss' ? lossRun + 1 : 0;
    rec.bestStreak = Math.max(rec.bestStreak, run);
    rec.bestLossStreak = Math.max(rec.bestLossStreak, lossRun);
  }
  rec.currentStreak = run;
  rec.headToHead = [...h2h.values()].sort((a, b) => b.played - a.played || a.opponentId - b.opponentId);
  return rec;
}
