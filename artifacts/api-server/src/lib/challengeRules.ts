// Challenges — the rules as pure functions (feature/challenges, phase 2). No database here:
// lib/challenges.ts loads a challenge, its participants and their candidate scores, asks these what
// counts / who's winning / how it ends, and writes the answer. Kept pure so every rule is
// unit-tested (challengeRules.test.ts).
//
// The rules (Will, 2026-09-25/26):
//  - Friends only, checked at creation. 1v1 today, but participants are rows and everything here
//    ranks N of them, so groups are a UI change later, not a rules change.
//  - Types:
//      high_score     best counting score wins, at the deadline.
//      race           "Beat my score / First to X". Target = the number the creator picked, or the
//                     creator's best on the matching machine at creation. The first participant with a
//                     counting score >= target wins on the spot. Nobody by the deadline → no winner:
//                     everyone who played gets `tie`, everyone who didn't gets `no_show`.
//      most_improved  (best counting score − baseline) / baseline, as a percent; highest wins at the
//                     deadline. Baseline = best score on the matching machine played before the window,
//                     frozen at acceptance. No baseline → can't take part (creation / acceptance refused).
//      average        mean of ALL counting scores; needs >= min_plays of them to qualify. Highest
//                     qualified average wins. Played but short of N → `loss` when someone qualified;
//                     nobody qualified → treated like a race nobody finished (played `tie`).
//  - What counts: machine matches (OPDB group for 'game' mode, exact id otherwise), venue matches if
//    the challenge is venue-locked, the score has a photo, BOTH played_at and created_at are inside
//    [starts_at, ends_at] (blocks backdated uploads), and every other participant may see the score
//    (a score at a home venue whose owner hid its activity doesn't count — see venueActivity.ts).
//  - Outcomes: win / loss / tie / forfeit (withdrew after accepting; when only one participant is
//    left they win on the spot) / no_show (no counting score). Nobody played → the challenge is void
//    and everyone is `no_show`.

export const CHALLENGE_TYPES = ['high_score', 'race', 'most_improved', 'average'] as const;
export type ChallengeType = (typeof CHALLENGE_TYPES)[number];
export type MatchMode = 'game' | 'exact';
export type ChallengeStatus = 'pending' | 'active' | 'resolved' | 'declined' | 'cancelled' | 'expired';
export type ParticipantResponse = 'pending' | 'accepted' | 'declined';
export type Outcome = 'win' | 'loss' | 'tie' | 'forfeit' | 'no_show';

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
  | 'machine' | 'venue' | 'no_photo' | 'played_outside_window' | 'uploaded_outside_window' | 'hidden';

const inWindow = (t: Date, rule: CountRule) => +t >= +rule.startsAt && +t <= +rule.endsAt;

/** Why a score doesn't count (the first failing rule), or null when it does. */
export function exclusionReason(rule: CountRule, s: CandidateScore): ExclusionReason | null {
  if (!machineMatches(rule, s)) return 'machine';
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
  /** race only: when the first counting score >= target was uploaded. */
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
      const hits = sorted.filter(s => s.score >= target)
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
  void: boolean;
  participants: ResolvedParticipant[];
}

/** The race winner: earliest upload of a counting score >= target (score id breaks a same-instant tie). */
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
 * forfeits. Void = nobody won, lost or tied.
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
    const noWinnerPossible = (type === 'race' || type === 'average') && qualified.length === 0;
    if (noWinnerPossible) {
      // Nobody reached the target / min plays: those who played draw, the rest didn't show.
      for (const s of remaining) {
        decided.set(s.userId, played(s) ? { outcome: 'tie', group: 0, value: 0 } : { outcome: 'no_show', group: 3, value: 0 });
      }
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
  const isVoid = !participants.some(p => p.outcome === 'win' || p.outcome === 'loss' || p.outcome === 'tie');
  return { reason, void: isVoid, participants };
}

/** Live ranks if the challenge ended now (for standings); forfeits last. */
export function projectedRanks(type: ChallengeType, states: ParticipantState[]): Map<number, number> {
  const winner = type === 'race' ? raceWinner(states) : null;
  const r = resolveChallenge(type, states, winner ? 'race_target' : 'deadline');
  return new Map(r.participants.map(p => [p.userId, p.rank]));
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

/** A pending challenge nobody answered in time: its chosen start, or its end, has passed. */
export function pendingExpired(c: LifecycleChallenge, now: Date): boolean {
  if (c.status !== 'pending') return false;
  if (c.startsAt && +now >= +c.startsAt) return true;
  return +now >= +c.endsAt;
}

export function canAccept(c: LifecycleChallenge, p: LifecycleParticipant | undefined): boolean {
  return !!p && c.status === 'pending' && p.response === 'pending' && p.userId !== c.creatorId;
}
export const canDecline = canAccept;
export function canCancel(c: LifecycleChallenge, actorId: number): boolean {
  return c.status === 'pending' && c.creatorId === actorId;
}
export function canForfeit(c: LifecycleChallenge, p: LifecycleParticipant | undefined): boolean {
  return !!p && c.status === 'active' && p.response === 'accepted' && p.outcome === null;
}

/**
 * What the UI shows: pending, scheduled (accepted, start date ahead), live, resolved, declined,
 * cancelled, expired. ('ended' only for the instant between the deadline and a lazy resolve.)
 */
export type ChallengePhase = 'pending' | 'scheduled' | 'live' | 'ended' | 'resolved' | 'declined' | 'cancelled' | 'expired';
export function phaseOf(c: LifecycleChallenge, now: Date): ChallengePhase {
  if (c.status !== 'active') return c.status;
  if (c.startsAt && +now < +c.startsAt) return 'scheduled';
  if (+now > +c.endsAt) return 'ended';
  return 'live';
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

// ── records ──────────────────────────────────────────────────────────────────

export interface RecordEntry {
  challengeId: number;
  resolvedAt: Date;
  void: boolean;
  outcome: Outcome;
  opponentIds: number[];
}

export interface HeadToHead {
  opponentId: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  forfeits: number;
  noShows: number;
}

export interface ChallengeRecord {
  played: number;
  wins: number;
  losses: number;
  ties: number;
  forfeits: number;
  noShows: number;
  voids: number;
  currentStreak: number;
  bestStreak: number;
  headToHead: HeadToHead[];
}

/**
 * W/L/T/forfeit/no-show totals and win streaks from resolved challenges. A void challenge counts as
 * a no-show (that's each participant's outcome) and in `voids`, and neither extends nor breaks a
 * streak. Streaks are consecutive wins in resolved order; any other non-void outcome ends one.
 */
export function computeRecord(entries: RecordEntry[]): ChallengeRecord {
  const rec: ChallengeRecord = {
    played: 0, wins: 0, losses: 0, ties: 0, forfeits: 0, noShows: 0, voids: 0,
    currentStreak: 0, bestStreak: 0, headToHead: [],
  };
  const h2h = new Map<number, HeadToHead>();
  const bump = (r: { wins: number; losses: number; ties: number; forfeits: number; noShows: number }, o: Outcome) => {
    if (o === 'win') r.wins++;
    else if (o === 'loss') r.losses++;
    else if (o === 'tie') r.ties++;
    else if (o === 'forfeit') r.forfeits++;
    else r.noShows++;
  };
  const ordered = [...entries].sort((a, b) => +a.resolvedAt - +b.resolvedAt || a.challengeId - b.challengeId);
  let run = 0;
  for (const e of ordered) {
    rec.played++;
    bump(rec, e.outcome);
    if (e.void) rec.voids++;
    for (const id of e.opponentIds) {
      const row = h2h.get(id) ?? { opponentId: id, played: 0, wins: 0, losses: 0, ties: 0, forfeits: 0, noShows: 0 };
      row.played++;
      bump(row, e.outcome);
      h2h.set(id, row);
    }
    if (e.void) continue;
    run = e.outcome === 'win' ? run + 1 : 0;
    rec.bestStreak = Math.max(rec.bestStreak, run);
  }
  rec.currentStreak = run;
  rec.headToHead = [...h2h.values()].sort((a, b) => b.played - a.played || a.opponentId - b.opponentId);
  return rec;
}
