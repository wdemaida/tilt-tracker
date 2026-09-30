import {
  db, challenges, challengeParticipants, challengeScores, scores, machines, venues, users, friendships, notifications,
  venueMachineHistory, pmLocationCache, type Challenge,
} from '@workspace/db';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, gt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  computeStanding, resolveChallenge, resolutionTrigger, projectedRanks, scoreCounts, baselineFrom, bestOnMachine,
  raceTarget, matchGroupFor, pendingDue, afterAnswer, canAccept, canDecline, canCounter, canCancel, canStart, canForfeit,
  canDecideProposal, phaseOf, validateCreate, parseInvitees, computeRecord, rosterHasMachine, saidNo, reinvitees, proposalClosure,
  isProposalStatus, storedDeclineReason, ENDING_SOON_MS, PROPOSAL_REMINDER_MS, MAX_PLAYERS,
  type CandidateScore, type MatchMode, type CountRule, type MatchRule, type ParticipantState, type ResolutionReason, type Outcome,
  type ChallengeRecord, type ChosenDeclineReason, type CreateInput, type DeclineReason, type ParticipantResponse, type ProposalCloseReason,
} from './challengeRules.js';
import { canSeeScore, type ActivityVenue } from './venueActivity.js';
import { isPrivateVenue } from './venueAddress.js';
import { acceptedPairSql } from './friendships.js';
import { raiseNotification, settleNotifications, type Executor } from './notify.js';
import { logActivity } from './activity.js';
import { getVenueRoster } from './pmRosterCache.js';
import { getCatalogOrNull, getStoredCatalog, type PinballMachine } from './pinballMap.js';
import { challengePmLimiter } from './pmGuards.js';
import type { PmLocationMachineXref } from './pinballmapApi.js';

// Challenges — database orchestration (feature/challenges, phase 2; groups + proposals,
// feature/group-challenges). The rules are pure, in challengeRules.ts; this file loads rows, asks the
// rules, and writes the answers. Routes are routes/challenges.ts (thin: HTTP in, one of these
// functions, HTTP out).
//
// STATE CHANGES ON THEIR OWN have three triggers, all funnelled through syncChallenge(), which locks
// the challenge row (FOR UPDATE) so two triggers can't act on it twice:
//   (a) lazily on read — list / detail / record call it before answering;
//   (b) onScoreCreated() — POST /api/scores calls it for the uploader's active challenges (and pending
//       ones whose fixed start has passed — they start first): a race resolves on the spot, and the
//       other participant(s) get challenge_opponent_scored;
//   (c) runChallengeSweep() — the daily secret-guarded cron route: resolves past-deadline challenges,
//       starts / expires pending ones at their fixed start, lapses stale proposals, sends "ending soon"
//       and the one proposal reminder, and prunes read notifications.
//
// GROUPS AND PROPOSALS (Will, 2026-09-29) — see the header of challengeRules.ts. After every answer
// settleAfterAnswer() applies afterAnswer(): L (everyone answered, ≥ 1 accepted, no proposal open) →
// active; D (nobody pending or accepted, no proposal open) → declined. A counter-offer is a PROPOSAL
// row (status 'proposed', creator = the challenger, proposed_by_id = the counterer, countered_from_id
// = the original). /accept and /decline on a proposal are the challenger's "take it for everyone" /
// "keep mine" (takeProposal / closeProposal). LOCK ORDER: always the original first, then its
// proposals (lockForAction / syncChallenge peek at a proposal's original before locking it).
// Legacy counter rows (countered_from_id set, proposed_by_id null — the migrate22 model, created by
// the counterer) are ordinary pending challenges here.
//
// THE SCORE LOCK: every time syncChallenge() evaluates an active challenge (every trigger above,
// the create hook included, so in practice the moment a counting score is uploaded) it records the
// scores that currently count in challenge_scores. PATCH/DELETE /api/scores/:id refuse a score with
// a row there (409 score_locked_by_challenge). Rows are only ever added: a locked score can't be
// edited, so it can't stop counting.
//
// PRIVACY: a challenge, its participants and its standings are only ever returned to its
// participants; anyone else gets 404 challenge_not_found (the pods pattern). A proposal row's
// participants are just the proposer and the challenger, so the other invitees can't open it; the
// original's `proposals` list is shown to the challenger (all) and to each proposer (their own).
// A score only counts when every other participant may see it (canSeeScore), so standings never
// surface a score from a home venue whose owner hid its activity.
//
// TIMESTAMPS: starts_at / ends_at are naive `timestamp` columns holding UTC, the same convention as
// scores.played_at / created_at under Drizzle (it writes toISOString() and reads values back as
// UTC). All comparisons happen in JS on Dates read through Drizzle, or against Dates it serialises.

type AppUser = { id: number; username: string; displayName: string; role: string };
export type UserRef = { id: number; username: string; displayName: string };

export type ParticipantRow = {
  userId: number;
  response: ParticipantResponse;
  declineReason: DeclineReason | null;
  outcome: Outcome | null;
  baselineScore: number | null;
  resultValue: string | null;
  rank: number | null;
  respondedAt: Date | null;
  user: UserRef & { role: string };
};

export type ChallengeRow = Challenge & {
  machine: { id: number; name: string; imageUrl: string | null; opdbId: string | null };
  venue: { id: number; name: string } | null;
};

type ScoredCandidate = CandidateScore & { venueName: string | null; venueTimezone: string | null; hasFullPhoto: boolean; hasThumbnail: boolean };

export class ChallengeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const notFound = () => new ChallengeError(404, 'challenge_not_found', 'Challenge not found');
const noBaseline = () => new ChallengeError(409, 'no_baseline', 'Most improved needs a score of yours on this machine from before the challenge');
const creatorNoBaseline = () => new ChallengeError(409, 'creator_no_baseline', 'The challenger no longer has a score on this machine to measure improvement from');

// ── loading ──────────────────────────────────────────────────────────────────

async function loadChallenge(ex: Executor, id: number, lock = false): Promise<ChallengeRow | undefined> {
  const q = ex
    .select({
      c: challenges,
      machine: { id: machines.id, name: machines.name, imageUrl: machines.imageUrl, opdbId: machines.opdbId },
      venueId: venues.id, venueName: venues.name,
    })
    .from(challenges)
    .innerJoin(machines, eq(machines.id, challenges.machineId))
    .leftJoin(venues, eq(venues.id, challenges.venueId))
    .where(eq(challenges.id, id))
    .limit(1);
  const [row] = lock ? await q.for('update', { of: challenges }) : await q;
  if (!row) return undefined;
  return { ...row.c, machine: row.machine, venue: row.venueId != null ? { id: row.venueId, name: row.venueName! } : null };
}

/** An original's open proposals, oldest first (locked when `lock` — after the original, never before). */
async function openProposals(ex: Executor, originalId: number, lock = false): Promise<ChallengeRow[]> {
  const q = ex.select({ id: challenges.id }).from(challenges)
    .where(and(eq(challenges.counteredFromId, originalId), eq(challenges.status, 'proposed')))
    .orderBy(asc(challenges.id));
  const ids = lock ? await q.for('update') : await q;
  const out: ChallengeRow[] = [];
  for (const { id } of ids) {
    const row = await loadChallenge(ex, id);
    if (row) out.push(row);
  }
  return out;
}

async function loadParticipants(ex: Executor, challengeId: number): Promise<ParticipantRow[]> {
  return ex
    .select({
      userId: challengeParticipants.userId, response: challengeParticipants.response, declineReason: challengeParticipants.declineReason,
      outcome: challengeParticipants.outcome, baselineScore: challengeParticipants.baselineScore,
      resultValue: challengeParticipants.resultValue, rank: challengeParticipants.rank,
      respondedAt: challengeParticipants.respondedAt,
      user: { id: users.id, username: users.username, displayName: users.displayName, role: users.role },
    })
    .from(challengeParticipants)
    .innerJoin(users, eq(users.id, challengeParticipants.userId))
    .where(eq(challengeParticipants.challengeId, challengeId))
    .orderBy(asc(challengeParticipants.respondedAt), asc(challengeParticipants.userId));
}

function matchSql(rule: MatchRule): SQL {
  return rule.matchGroup
    ? sql`(${scores.machineId} = ${rule.machineId} OR split_part(${machines.opdbId}, '-', 1) = ${rule.matchGroup})`
    : sql`${scores.machineId} = ${rule.machineId}`;
}

/**
 * Every score of `userIds` on the matching machine (any time — the rules filter the window, and
 * most_improved needs the history before it). `visibleToOthers` = every one of `audience` other than
 * the score's author may see it.
 */
async function loadCandidates(ex: Executor, rule: MatchRule, userIds: number[], audience: Array<{ id: number; role: string }>): Promise<ScoredCandidate[]> {
  if (!userIds.length) return [];
  const rows = await ex
    .select({
      id: scores.id, userId: scores.userId, machineId: scores.machineId, opdbId: machines.opdbId,
      venueId: scores.venueId, venueName: scores.venueName, score: scores.score,
      playedAt: scores.playedAt, createdAt: scores.createdAt,
      // The app stores the photo as a data-URL thumbnail (photo_thumbnail); photo_url is never
      // written by today's client. Either one is "has a photo".
      hasPhoto: sql<boolean>`(${scores.photoUrl} IS NOT NULL OR ${scores.photoThumbnail} IS NOT NULL)`,
      // Full-size photo on R2 (display only — never part of the "has a photo" rule above).
      hasFullPhoto: sql<boolean>`(${scores.photoKey} IS NOT NULL)`,
      // The data-URL thumbnail alone (not photo_url, which dev seed scripts fill) — lets the list offer
      // the viewer for a thumbnail-only score.
      hasThumbnail: sql<boolean>`(${scores.photoThumbnail} IS NOT NULL)`,
      vOwnerId: venues.ownerId, vIsResidence: venues.isResidence, vTier: venues.privacyTier,
      vShow: venues.showMachinesAndScores,
      // Shown in the venue's zone, like ScoreCard — except a hidden-tier venue's zone, which would
      // narrow down where it is (the same CASE as GET /api/machines/:name).
      venueTimezone: sql<string | null>`CASE WHEN ${venues.privacyTier} = 'hidden' THEN NULL ELSE ${venues.timezone} END`,
    })
    .from(scores)
    .innerJoin(machines, eq(machines.id, scores.machineId))
    .leftJoin(venues, eq(venues.id, scores.venueId))
    .where(and(inArray(scores.userId, userIds), matchSql(rule)));
  return rows.map(r => {
    const venue: ActivityVenue | null = r.venueId != null && r.vTier != null
      ? { ownerId: r.vOwnerId, isResidence: !!r.vIsResidence, privacyTier: r.vTier, showMachinesAndScores: r.vShow ?? true }
      : null;
    const visibleToOthers = audience.filter(a => a.id !== r.userId).every(a => canSeeScore({ userId: r.userId }, venue, a));
    return {
      id: r.id, userId: r.userId, machineId: r.machineId, opdbId: r.opdbId, venueId: r.venueId, venueName: r.venueName, venueTimezone: r.venueTimezone ?? null,
      score: r.score, playedAt: r.playedAt, createdAt: r.createdAt, hasPhoto: !!r.hasPhoto, hasFullPhoto: !!r.hasFullPhoto, hasThumbnail: !!r.hasThumbnail, visibleToOthers,
    };
  });
}

/**
 * Settle the invitation to a challenge in `userId`'s inbox: challenge_received, challenge_moved (a
 * re-invite after a taken counter-offer), or challenge_countered (the challenger's notice of a
 * proposal — or, for a legacy counter row, its invitation).
 */
export async function settleInvitation(ex: Executor, userId: number, challengeId: number, mode: 'read' | 'delete'): Promise<void> {
  await settleNotifications(ex, userId, 'challenge_received', challengeId, mode, 'challengeId');
  await settleNotifications(ex, userId, 'challenge_moved', challengeId, mode, 'challengeId');
  await settleNotifications(ex, userId, 'challenge_countered', challengeId, mode, 'challengeId');
}

const matchRuleOf = (c: Pick<Challenge, 'machineId' | 'matchGroup'>): MatchRule => ({ machineId: c.machineId, matchGroup: c.matchGroup });
const audienceOf = (ps: ParticipantRow[]) => ps.filter(p => !saidNo(p.response)).map(p => ({ id: p.user.id, role: p.user.role }));
const refOf = (p: { user: UserRef }): UserRef => ({ id: p.user.id, username: p.user.username, displayName: p.user.displayName });
const isGroup = (ps: ParticipantRow[]) => ps.length > 2;

/** The database clock — the same clock that stamps scores.created_at. */
async function dbNow(tx: Executor): Promise<Date> {
  const [{ dbNowMs }] = await tx.select({ dbNowMs: sql<number>`(extract(epoch from now()) * 1000)::float8` }).from(sql`(select 1) as one`);
  return new Date(Number(dbNowMs));
}

// ── evaluation ───────────────────────────────────────────────────────────────

interface Evaluation {
  /** Accepted participants only. */
  states: ParticipantState[];
  counting: Map<number, ScoredCandidate[]>;
  started: boolean;
}

function evaluate(c: ChallengeRow, participants: ParticipantRow[], candidates: ScoredCandidate[], now: Date): Evaluation {
  const accepted = participants.filter(p => p.response === 'accepted');
  const started = (c.status === 'active' || c.status === 'resolved') && !!c.startsAt && +now >= +c.startsAt;
  const rule: CountRule | null = started ? { ...matchRuleOf(c), venueId: c.venueId, startsAt: c.startsAt!, endsAt: c.endsAt } : null;
  const counting = new Map<number, ScoredCandidate[]>();
  const states = accepted.map(p => {
    const mine = rule ? candidates.filter(s => s.userId === p.userId && scoreCounts(rule, s)) : [];
    counting.set(p.userId, mine);
    return {
      userId: p.userId,
      forfeited: p.outcome === 'forfeit',
      standing: computeStanding(c.type, p.userId, mine, { targetScore: c.targetScore, minPlays: c.minPlays, baseline: c.type === 'most_improved' ? p.baselineScore : null }),
    };
  });
  return { states, counting, started };
}

// ── notifications: who a notice is "about" ──────────────────────────────────

function userPayload(c: Pick<ChallengeRow, 'id' | 'type' | 'machine'>, other: UserRef | undefined): Record<string, unknown> {
  return {
    challengeId: c.id, challengeType: c.type, machineName: c.machine.name,
    ...(other ? { userId: other.id, username: other.username, displayName: other.displayName } : {}),
  };
}

/** The first other participant still in it (the opponent, in 1v1) — who a notification is "about". */
function otherOf(participants: ParticipantRow[], userId: number): UserRef | undefined {
  const o = participants.find(p => p.userId !== userId && !saidNo(p.response));
  return o ? refOf(o) : undefined;
}

function creatorRefOf(c: Pick<Challenge, 'creatorId'>, participants: ParticipantRow[]): UserRef | undefined {
  const p = participants.find(x => x.userId === c.creatorId);
  return p ? refOf(p) : undefined;
}

// ── state transitions (inside the caller's transaction, rows already locked) ─

/**
 * Close an open proposal: 'rejected' (kept / superseded / the challenger started the original) or
 * 'lapsed' (the original's fixed start, cancel or expiry, or its own window). The challenger's own
 * row on it closes too - 'declined' (rejected) or 'missed' (lapsed), see proposalClosure - so no
 * closed proposal keeps a 'pending' participant. Settles the challenger's notice and tells the
 * proposer (challenge_counter_rejected, with the reason). The one challenge.counter_rejected event is
 * written here (the route doesn't log it again): `actorId` is whoever's action closed it (the
 * challenger's keep / take / Start / cancel), null when it closed on its own (fixed start, expiry).
 */
async function closeProposal(tx: Executor, p: ChallengeRow, reason: ProposalCloseReason, now: Date, actorId: number | null): Promise<void> {
  const { status, notifyReason, challengerResponse } = proposalClosure(reason);
  await tx.update(challenges).set({ status, proposalDecidedAt: now }).where(and(eq(challenges.id, p.id), eq(challenges.status, 'proposed')));
  await tx.update(challengeParticipants)
    .set({ response: challengerResponse, respondedAt: challengerResponse === 'declined' ? now : null })
    .where(and(eq(challengeParticipants.challengeId, p.id), eq(challengeParticipants.userId, p.creatorId), eq(challengeParticipants.response, 'pending')));
  await settleInvitation(tx, p.creatorId, p.id, 'read');
  const ps = await loadParticipants(tx, p.id);
  const challenger = creatorRefOf(p, ps);
  if (p.proposedById) {
    await raiseNotification(tx, p.proposedById, 'challenge_counter_rejected', {
      ...userPayload(p, challenger), counteredFromId: p.counteredFromId, reason: notifyReason,
    });
  }
  await logActivity({
    type: 'challenge.counter_rejected', actorUserId: actorId, subjectUserId: p.proposedById, targetType: 'challenge', targetId: p.id,
    payload: { counteredFromId: p.counteredFromId, reason: notifyReason, status, challengeType: p.type, machineName: p.machine.name },
  }, { tx });
}

interface ActivateOpts {
  /** Who made it start (their answer, or the challenger's Start); null = its fixed start passed. */
  actorId: number | null;
  /**
   * Accept and "Start with who's in" only: a missing most_improved baseline for the actor or the
   * challenger refuses the action (no_baseline / creator_no_baseline). Every other trigger — a
   * decline, a rejected or lapsed proposal, a fixed start — must never fail, so a missing baseline
   * is stored as null (that player can't qualify).
   */
  strict: boolean;
  /** How any still-open proposals close ('started' / 'fixed_start'); null = there are none (L). */
  closeReason: 'started' | 'fixed_start' | null;
}

/**
 * Pending → active with whoever accepted: the start is stamped (DB clock) for "starts when accepted",
 * most_improved baselines are frozen, anyone still pending becomes `missed` (challenge_missed), open
 * proposals close, and in a group the accepted players other than the actor get challenge_started.
 */
async function activate(tx: Executor, c: ChallengeRow, participants: ParticipantRow[], now: Date, o: ActivateOpts): Promise<void> {
  const startsAt = c.startsAt ?? await dbNow(tx);
  const accepted = participants.filter(p => p.response === 'accepted');
  if (c.type === 'most_improved') {
    const rule = matchRuleOf(c);
    const cands = await loadCandidates(tx, rule, accepted.map(p => p.userId), audienceOf(accepted));
    for (const p of accepted) {
      const baseline = baselineFrom(rule, startsAt, cands.filter(s => s.userId === p.userId));
      if (baseline == null && o.strict) {
        if (p.userId === o.actorId) throw noBaseline();
        if (p.userId === c.creatorId) throw creatorNoBaseline();
      }
      await tx.update(challengeParticipants).set({ baselineScore: baseline })
        .where(and(eq(challengeParticipants.challengeId, c.id), eq(challengeParticipants.userId, p.userId)));
    }
  }
  const creator = creatorRefOf(c, participants);
  const missed = participants.filter(p => p.response === 'pending');
  if (missed.length) {
    await tx.update(challengeParticipants).set({ response: 'missed' })
      .where(and(eq(challengeParticipants.challengeId, c.id), inArray(challengeParticipants.userId, missed.map(p => p.userId))));
    for (const p of missed) {
      await settleInvitation(tx, p.userId, c.id, 'read');
      await raiseNotification(tx, p.userId, 'challenge_missed', { ...userPayload(c, creator), players: accepted.length });
    }
  }
  if (o.closeReason) for (const p of await openProposals(tx, c.id, true)) await closeProposal(tx, p, o.closeReason, now, o.actorId);
  await tx.update(challenges).set({ status: 'active', startsAt }).where(eq(challenges.id, c.id));
  if (isGroup(participants)) {
    const actor = participants.find(p => p.userId === o.actorId);
    for (const p of accepted) {
      if (p.userId === o.actorId) continue;
      await raiseNotification(tx, p.userId, 'challenge_started', {
        ...userPayload(c, actor ? refOf(actor) : creator), players: accepted.length, startsAt, byChallenger: o.actorId === c.creatorId,
      });
    }
  }
  await logActivity({
    type: 'challenge.started', actorUserId: o.actorId, targetType: 'challenge', targetId: c.id,
    payload: {
      trigger: o.actorId == null ? 'fixed_start' : o.closeReason === 'started' ? 'start_with_whos_in' : 'answered',
      players: accepted.length, missed: missed.length, challengeType: c.type, machineName: c.machine.name,
    },
  }, { tx });
}

/** Pending → expired: nobody is left to play it (or its window ran out). Pending players are `missed`. */
async function expireChallenge(tx: Executor, c: ChallengeRow, participants: ParticipantRow[], now: Date): Promise<void> {
  await tx.update(challenges).set({ status: 'expired' }).where(eq(challenges.id, c.id));
  const pending = participants.filter(p => p.response === 'pending');
  if (pending.length) {
    await tx.update(challengeParticipants).set({ response: 'missed' })
      .where(and(eq(challengeParticipants.challengeId, c.id), inArray(challengeParticipants.userId, pending.map(p => p.userId))));
  }
  for (const p of pending) await settleInvitation(tx, p.userId, c.id, 'read');
  for (const p of await openProposals(tx, c.id, true)) await closeProposal(tx, p, 'expired', now, null);
  await logActivity({ type: 'challenge.expired', targetType: 'challenge', targetId: c.id, payload: { challengeType: c.type, machineName: c.machine.name } }, { tx });
}

/**
 * After an answer on a pending challenge: L → active, D → declined (afterAnswer). Returns the status.
 * `c` must be locked; its open proposals are counted (they block both).
 */
async function settleAfterAnswer(tx: Executor, c: ChallengeRow, now: Date, o: { actorId: number | null; strict: boolean }): Promise<Challenge['status']> {
  const participants = await loadParticipants(tx, c.id);
  const open = (await openProposals(tx, c.id)).length;
  const next = afterAnswer({ ...c, status: 'pending' }, participants, open);
  if (next === 'active') {
    await activate(tx, c, participants, now, { ...o, closeReason: null });
    return 'active';
  }
  if (next === 'declined') {
    await tx.update(challenges).set({ status: 'declined' }).where(eq(challenges.id, c.id));
    return 'declined';
  }
  return 'pending';
}

/**
 * A pending (locked) challenge's own due work: expire, start at its fixed start, or lapse proposals
 * whose own window passed (then re-check L/D). Returns the status it's left in.
 */
async function syncPending(tx: Executor, c: ChallengeRow, now: Date): Promise<Challenge['status']> {
  const participants = await loadParticipants(tx, c.id);
  const due = pendingDue(c, participants, now);
  if (due === 'expire') {
    await expireChallenge(tx, c, participants, now);
    return 'expired';
  }
  if (due === 'start') {
    await activate(tx, c, participants, now, { actorId: null, strict: false, closeReason: 'fixed_start' });
    return 'active';
  }
  let lapsed = 0;
  for (const p of await openProposals(tx, c.id, true)) {
    if (pendingDue(p, [], now) === 'lapse') {
      await closeProposal(tx, p, 'expired', now, null);
      lapsed++;
    }
  }
  return lapsed ? settleAfterAnswer(tx, c, now, { actorId: null, strict: false }) : 'pending';
}

// ── sync (the one place a challenge changes state on its own) ────────────────

export interface SyncResult {
  status: Challenge['status'];
  /** Set when this call resolved it. */
  resolvedNow: ResolutionReason | null;
  countingScoreIds: Set<number>;
}

async function applyResolution(
  tx: Executor, c: ChallengeRow, participants: ParticipantRow[], states: ParticipantState[], reason: ResolutionReason, now: Date,
): Promise<void> {
  const r = resolveChallenge(c.type, states, reason);
  for (const p of r.participants) {
    await tx.update(challengeParticipants)
      .set({ outcome: p.outcome, rank: p.rank, resultValue: p.resultValue == null ? null : String(p.resultValue) })
      .where(and(eq(challengeParticipants.challengeId, c.id), eq(challengeParticipants.userId, p.userId)));
  }
  // r.void is always false now (void is retired — nobody playing is abandoned); the column stays.
  await tx.update(challenges).set({ status: 'resolved', void: r.void, resolvedAt: now }).where(eq(challenges.id, c.id));
  const byId = new Map(participants.map(p => [p.userId, p]));
  const winners = r.participants.filter(p => p.rank === 1 && (p.outcome === 'win' || p.outcome === 'tie'))
    .map(p => byId.get(p.userId)).filter((p): p is ParticipantRow => !!p).map(refOf)
    .map(u => ({ userId: u.id, username: u.username, displayName: u.displayName }));
  for (const p of r.participants) {
    await raiseNotification(tx, p.userId, 'challenge_result', {
      ...userPayload(c, otherOf(participants, p.userId)), outcome: p.outcome, rank: p.rank, void: r.void, abandoned: r.abandoned, reason,
      playerCount: r.participants.length, winners,
    });
  }
  await logActivity({
    type: 'challenge.resolved', targetType: 'challenge', targetId: c.id,
    payload: {
      reason, abandoned: r.abandoned, challengeType: c.type, machineName: c.machine.name,
      outcomes: r.participants.map(p => ({
        userId: p.userId, username: byId.get(p.userId)?.user.username ?? null,
        outcome: p.outcome, rank: p.rank, resultValue: p.resultValue,
      })),
    },
  }, { tx });
}

/**
 * Bring one challenge up to date: expire / start / lapse it if it's pending (or a proposal), record
 * its counting scores (the lock), and resolve it if a race was won, someone forfeited, or its
 * deadline passed. Idempotent; safe to call from any trigger at any time.
 */
export async function syncChallenge(id: number, now = new Date()): Promise<SyncResult | null> {
  return db.transaction(async tx => {
    const peek = await loadChallenge(tx, id);
    if (!peek) return null;
    // A proposal: lock its original first (lock order), and let the original's pending sync lapse it.
    const original = peek.status === 'proposed' && peek.counteredFromId ? await loadChallenge(tx, peek.counteredFromId, true) : undefined;
    let c = (await loadChallenge(tx, id, true))!;
    if (!c) return null;
    const out: SyncResult = { status: c.status, resolvedNow: null, countingScoreIds: new Set() };

    if (c.status === 'proposed') {
      if (!original || original.status !== 'pending') {
        // Its original is gone or closed (normally closed with it — this is the safety net).
        await closeProposal(tx, c, original?.status === 'cancelled' ? 'cancelled' : 'expired', now, null);
      } else {
        await syncPending(tx, original, now);
      }
      out.status = (await loadChallenge(tx, id))!.status;
      return out;
    }
    if (c.status === 'pending') {
      out.status = await syncPending(tx, c, now);
      if (out.status !== 'active') return out;
      c = (await loadChallenge(tx, id))!;
    }
    if (c.status !== 'active') return out;

    const participants = await loadParticipants(tx, c.id);
    const accepted = participants.filter(p => p.response === 'accepted');
    const candidates = await loadCandidates(tx, matchRuleOf(c), accepted.map(p => p.userId), audienceOf(participants));
    const ev = evaluate(c, participants, candidates, now);
    const ids = [...ev.counting.values()].flat().map(s => s.id);
    ids.forEach(i => out.countingScoreIds.add(i));
    if (ids.length) {
      await tx.insert(challengeScores).values(ids.map(scoreId => ({ challengeId: c.id, scoreId }))).onConflictDoNothing();
    }
    const trigger = resolutionTrigger(c.type, c.endsAt, now, ev.states);
    if (trigger) {
      await applyResolution(tx, c, participants, ev.states, trigger, now);
      out.status = 'resolved';
      out.resolvedNow = trigger;
    }
    return out;
  });
}

/** Sync every challenge of `userId` that has something due (expiry, start, lapse or deadline). For lazy reads. */
async function syncDueFor(userId: number, now: Date): Promise<void> {
  const due = await db
    .select({ id: challenges.id })
    .from(challenges)
    .innerJoin(challengeParticipants, eq(challengeParticipants.challengeId, challenges.id))
    .where(and(eq(challengeParticipants.userId, userId), dueSql(now)));
  for (const { id } of due) await syncChallenge(id, now);
}

function dueSql(now: Date): SQL {
  return or(
    and(inArray(challenges.status, ['pending', 'proposed']), or(lte(challenges.startsAt, now), lte(challenges.endsAt, now))),
    and(eq(challenges.status, 'active'), lt(challenges.endsAt, now)),
  )!;
}

// ── trigger (b): the score-create hook ───────────────────────────────────────

/**
 * Called by POST /api/scores after inserting a score. For each of the uploader's active challenges
 * — and pending ones whose fixed start has passed, which start first (a group can sit pending past
 * its start until someone syncs it) — sync it (records the lock, resolves a won race); if the new
 * score counts and the challenge is still going, tell the other participant(s). Never throws — a
 * challenge problem must not fail a score upload.
 */
export async function onScoreCreated(score: { id: number; userId: number }, now = new Date()): Promise<void> {
  try {
    const mine = await db
      .select({ id: challenges.id })
      .from(challenges)
      .innerJoin(challengeParticipants, eq(challengeParticipants.challengeId, challenges.id))
      .where(and(
        or(eq(challenges.status, 'active'), and(eq(challenges.status, 'pending'), lte(challenges.startsAt, now))),
        eq(challengeParticipants.userId, score.userId),
        eq(challengeParticipants.response, 'accepted'),
        isNull(challengeParticipants.outcome),
      ));
    for (const { id } of mine) {
      const r = await syncChallenge(id, now);
      if (!r || !r.countingScoreIds.has(score.id) || r.status !== 'active') continue;
      const c = await loadChallenge(db, id);
      const participants = await loadParticipants(db, id);
      const uploader = participants.find(p => p.userId === score.userId)!;
      const [{ value }] = await db.select({ value: scores.score }).from(scores).where(eq(scores.id, score.id));
      for (const p of participants) {
        if (p.userId === score.userId || p.response !== 'accepted' || p.outcome) continue;
        // One unread "X posted" per challenge per player: the newest replaces the last.
        await raiseNotification(db, p.userId, 'challenge_opponent_scored',
          { ...userPayload(c!, uploader.user), score: value, players: participants.filter(x => x.response === 'accepted').length },
          { key: 'challengeId', value: id });
      }
    }
  } catch (err) {
    console.error('Challenge score hook failed:', err);
  }
}

// ── trigger (c): the daily sweep ─────────────────────────────────────────────

export const NOTIFICATION_RETENTION_DAYS = 30;

export interface SweepResult {
  expired: number; resolved: number; endingSoon: number; proposalReminders: number; notificationsDeleted: number; errors: number;
}

export async function runChallengeSweep(now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { expired: 0, resolved: 0, endingSoon: 0, proposalReminders: 0, notificationsDeleted: 0, errors: 0 };

  const due = await db.select({ id: challenges.id }).from(challenges).where(dueSql(now)).orderBy(asc(challenges.id));
  for (const { id } of due) {
    try {
      const r = await syncChallenge(id, now);
      if (r?.status === 'expired') out.expired++;
      if (r?.resolvedNow) out.resolved++;
    } catch (err) {
      out.errors++;
      console.error(`Challenge sweep: sync ${id} failed:`, err);
    }
  }

  // "Ending soon": live challenges within ENDING_SOON_MS of the end, once per participant.
  const soon = await db
    .select({ challengeId: challengeParticipants.challengeId, userId: challengeParticipants.userId })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(and(
      eq(challenges.status, 'active'),
      gt(challenges.endsAt, now),
      lte(challenges.endsAt, new Date(+now + ENDING_SOON_MS)),
      lte(challenges.startsAt, now),
      eq(challengeParticipants.response, 'accepted'),
      isNull(challengeParticipants.outcome),
      isNull(challengeParticipants.endingSoonNotifiedAt),
    ));
  for (const { challengeId, userId } of soon) {
    try {
      await db.transaction(async tx => {
        const claimed = await tx.update(challengeParticipants)
          .set({ endingSoonNotifiedAt: now })
          .where(and(
            eq(challengeParticipants.challengeId, challengeId), eq(challengeParticipants.userId, userId),
            isNull(challengeParticipants.endingSoonNotifiedAt),
          ))
          .returning({ userId: challengeParticipants.userId });
        if (!claimed.length) return;
        const c = (await loadChallenge(tx, challengeId))!;
        const participants = await loadParticipants(tx, challengeId);
        await raiseNotification(tx, userId, 'challenge_ending_soon', { ...userPayload(c, otherOf(participants, userId)), endsAt: c.endsAt });
        out.endingSoon++;
      });
    } catch (err) {
      out.errors++;
      console.error(`Challenge sweep: ending-soon ${challengeId}/${userId} failed:`, err);
    }
  }

  // One reminder to the challenger about a suggestion she hasn't answered in 24 h. No timer beyond
  // that (Will, 2026-09-29); proposal_reminded_at makes it once only.
  const stale = await db.select({ id: challenges.id }).from(challenges).where(and(
    eq(challenges.status, 'proposed'), isNull(challenges.proposalRemindedAt), lte(challenges.createdAt, new Date(+now - PROPOSAL_REMINDER_MS)),
  ));
  for (const { id } of stale) {
    try {
      await db.transaction(async tx => {
        const claimed = await tx.update(challenges).set({ proposalRemindedAt: now })
          .where(and(eq(challenges.id, id), eq(challenges.status, 'proposed'), isNull(challenges.proposalRemindedAt)))
          .returning({ id: challenges.id });
        if (!claimed.length) return;
        const p = (await loadChallenge(tx, id))!;
        const ps = await loadParticipants(tx, id);
        const proposer = ps.find(x => x.userId === p.proposedById);
        const [orig] = p.counteredFromId ? await tx.select({ machineId: challenges.machineId, name: machines.name }).from(challenges)
          .innerJoin(machines, eq(machines.id, challenges.machineId)).where(eq(challenges.id, p.counteredFromId)) : [];
        await raiseNotification(tx, p.creatorId, 'challenge_countered', {
          ...userPayload(p, proposer ? refOf(proposer) : undefined), newChallengeId: p.id, counteredFromId: p.counteredFromId,
          originalMachineName: orig?.name ?? null, proposal: true, reminder: true,
        }, { key: 'challengeId', value: p.id });
        out.proposalReminders++;
      });
    } catch (err) {
      out.errors++;
      console.error(`Challenge sweep: proposal reminder ${id} failed:`, err);
    }
  }

  // Retention: READ notifications older than 30 days go; unread ones stay however old.
  const deleted = await db.delete(notifications)
    .where(and(isNotNull(notifications.readAt), lt(notifications.createdAt, new Date(+now - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000))))
    .returning({ id: notifications.id });
  out.notificationsDeleted = deleted.length;
  return out;
}

// ── the score lock ───────────────────────────────────────────────────────────

/** Whether a score counted toward a challenge (and so can't be edited or deleted). */
export async function scoreLockedByChallenge(scoreId: number): Promise<boolean> {
  const [row] = await db.select({ id: challengeScores.challengeId }).from(challengeScores).where(eq(challengeScores.scoreId, scoreId)).limit(1);
  return !!row;
}

export const SCORE_LOCKED = {
  error: 'This score counts toward a challenge, so it can’t be changed or deleted.',
  code: 'score_locked_by_challenge',
} as const;

// ── views ────────────────────────────────────────────────────────────────────

export interface ParticipantView {
  user: UserRef;
  isCreator: boolean;
  response: ParticipantRow['response'];
  /** Why they said no: 'cant_reach' / 'no_thanks' / 'backed_out' (declined), always 'cant_reach' when countered. */
  declineReason: DeclineReason | null;
  respondedAt: Date | null;
  /** Final, once resolved (or 'forfeit' as soon as they withdraw). */
  outcome: Outcome | null;
  rank: number | null;
  resultValue: number | null;
  baselineScore: number | null;
  standing: {
    resultValue: number | null;
    countingCount: number;
    bestScore: number | null;
    qualified: boolean;
    liveRank: number | null;
    reachedTargetAt: Date | null;
  } | null;
  scores?: Array<{ id: number; score: number; playedAt: Date; createdAt: Date; venueId: number | null; venueName: string | null; venueTimezone: string | null; hasFullPhoto: boolean; hasThumbnail: boolean }>;
}

/** A counter-offer on this challenge, as the challenger (all) or its proposer (their own) sees it. */
export interface ProposalView {
  id: number;
  status: Challenge['status'];
  proposedBy: UserRef | null;
  type: Challenge['type'];
  matchMode: Challenge['matchMode'];
  machine: { id: number; name: string; imageUrl: string | null };
  venue: { id: number; name: string } | null;
  targetScore: number | null;
  minPlays: number | null;
  startsAt: Date | null;
  endsAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface ChallengeView {
  id: number;
  type: Challenge['type'];
  status: Challenge['status'];
  /** Old phases only: proposed → pending, rejected → declined, lapsed → expired (see phaseOf). */
  phase: ReturnType<typeof phaseOf>;
  /**
   * RETIRED (2026-09-26): nobody playing is now abandoned, so new challenges always resolve with
   * void = false. Only a legacy row can be true. Kept so the API shape doesn't change.
   */
  void: boolean;
  /**
   * Resolved with nobody finishing — a race nobody beat, an average nobody qualified for, or any type
   * nobody played: every non-forfeited participant's outcome is 'abandoned'. Derived from the
   * participant rows (no column); never true together with `void`.
   */
  abandoned: boolean;
  matchMode: Challenge['matchMode'];
  matchGroup: string | null;
  machine: { id: number; name: string; imageUrl: string | null };
  venue: { id: number; name: string } | null;
  targetScore: number | null;
  minPlays: number | null;
  startsAt: Date | null;
  endsAt: Date;
  createdAt: Date;
  resolvedAt: Date | null;
  creatorId: number;
  /** This challenge is a counter-offer to that one: a proposal, a taken proposal, or a legacy counter. */
  counteredFromId: number | null;
  /** This challenge was countered: the taken counter-offer's id (status 'countered' only). */
  counteredToId: number | null;
  /** A proposal row (status proposed / rejected / lapsed) — the challenger decides it. */
  isProposal: boolean;
  /** Who suggested this one (proposals and taken proposals); null otherwise. */
  proposedBy: UserRef | null;
  /** Counter-offers on this challenge the viewer may see: all for the challenger, their own for a proposer. */
  proposals: ProposalView[];
  /** ms until ends_at while active; null otherwise. */
  timeLeftMs: number | null;
  /** ms until starts_at while scheduled; null otherwise. */
  startsInMs: number | null;
  me: {
    response: ParticipantRow['response']; outcome: Outcome | null;
    canAccept: boolean; canDecline: boolean; canCounter: boolean; canCancel: boolean; canForfeit: boolean;
    /** "Start with who's in" (challenger, pending, ≥ 1 accepted). */
    canStart: boolean;
    /** This is a proposal waiting on the viewer (the challenger): accept = take it, decline = keep mine. */
    canDecideProposal: boolean;
  };
  /** 1v1 convenience: the other participant (in a group, the first other one still in it). */
  opponent: UserRef | null;
  /** Players still in it (accepted + pending) — or, once started, those who accepted. */
  playerCount: number;
  maxPlayers: number;
  participants: ParticipantView[];
}

interface ViewExtras { counteredToId: number | null; proposals: ProposalView[] }

function buildView(c: ChallengeRow, participants: ParticipantRow[], candidates: ScoredCandidate[], viewerId: number, now: Date, includeScores: boolean, extras: ViewExtras): ChallengeView {
  const ev = evaluate(c, participants, candidates, now);
  const live = ev.started ? projectedRanks(c.type, ev.states) : new Map<number, number>();
  const me = participants.find(p => p.userId === viewerId)!;
  const phase = phaseOf(c, now);
  const proposer = c.proposedById ? participants.find(p => p.userId === c.proposedById) : undefined;
  return {
    id: c.id, type: c.type, status: c.status, phase, void: c.void,
    abandoned: c.status === 'resolved' && participants.some(p => p.outcome === 'abandoned'),
    matchMode: c.matchMode, matchGroup: c.matchGroup,
    machine: { id: c.machine.id, name: c.machine.name, imageUrl: c.machine.imageUrl },
    venue: c.venue, targetScore: c.targetScore, minPlays: c.minPlays,
    startsAt: c.startsAt, endsAt: c.endsAt, createdAt: c.createdAt, resolvedAt: c.resolvedAt, creatorId: c.creatorId,
    counteredFromId: c.counteredFromId ?? null, counteredToId: extras.counteredToId,
    isProposal: isProposalStatus(c.status),
    proposedBy: proposer ? refOf(proposer) : null,
    proposals: extras.proposals,
    timeLeftMs: c.status === 'active' ? Math.max(0, +c.endsAt - +now) : null,
    startsInMs: phase === 'scheduled' ? +c.startsAt! - +now : null,
    me: {
      response: me.response, outcome: me.outcome,
      canAccept: canAccept(c, me), canDecline: canDecline(c, me), canCounter: canCounter(c, me), canCancel: canCancel(c, viewerId),
      canForfeit: canForfeit(c, me), canStart: canStart(c, participants, viewerId), canDecideProposal: canDecideProposal(c, me),
    },
    opponent: otherOf(participants, viewerId) ?? null,
    playerCount: participants.filter(p => !saidNo(p.response)).length,
    maxPlayers: MAX_PLAYERS,
    participants: participants.map(p => {
      const st = ev.states.find(s => s.userId === p.userId)?.standing;
      const view: ParticipantView = {
        user: refOf(p),
        isCreator: p.userId === c.creatorId,
        response: p.response, declineReason: p.declineReason ?? null, respondedAt: p.respondedAt, outcome: p.outcome, rank: p.rank,
        resultValue: p.resultValue == null ? null : Number(p.resultValue),
        baselineScore: p.baselineScore,
        standing: st && ev.started ? {
          resultValue: st.resultValue, countingCount: st.countingCount, bestScore: st.bestScore, qualified: st.qualified,
          liveRank: live.get(p.userId) ?? null, reachedTargetAt: st.reachedTargetAt,
        } : null,
      };
      if (includeScores) {
        view.scores = (ev.counting.get(p.userId) ?? [])
          .sort((a, b) => +b.createdAt - +a.createdAt)
          .map(s => ({ id: s.id, score: s.score, playedAt: s.playedAt, createdAt: s.createdAt, venueId: s.venueId, venueName: s.venueName, venueTimezone: s.venueTimezone, hasFullPhoto: s.hasFullPhoto, hasThumbnail: s.hasThumbnail }));
      }
      return view;
    }),
  };
}

/** The counter-offers on `c` that `viewerId` may see: every one for the challenger, their own for a proposer. */
async function proposalsFor(c: ChallengeRow, viewerId: number): Promise<ProposalView[]> {
  const rows = await db
    .select({
      id: challenges.id, status: challenges.status, proposedById: challenges.proposedById, type: challenges.type, matchMode: challenges.matchMode,
      machine: { id: machines.id, name: machines.name, imageUrl: machines.imageUrl },
      venueId: venues.id, venueName: venues.name,
      targetScore: challenges.targetScore, minPlays: challenges.minPlays, startsAt: challenges.startsAt, endsAt: challenges.endsAt,
      createdAt: challenges.createdAt, decidedAt: challenges.proposalDecidedAt,
      proposer: { id: users.id, username: users.username, displayName: users.displayName },
    })
    .from(challenges)
    .innerJoin(machines, eq(machines.id, challenges.machineId))
    .leftJoin(venues, eq(venues.id, challenges.venueId))
    .leftJoin(users, eq(users.id, challenges.proposedById))
    .where(and(
      eq(challenges.counteredFromId, c.id), isNotNull(challenges.proposedById),
      c.creatorId === viewerId ? undefined : eq(challenges.proposedById, viewerId),
    ))
    .orderBy(asc(challenges.id));
  return rows.map(r => ({
    id: r.id, status: r.status, proposedBy: r.proposer?.id != null ? r.proposer as UserRef : null, type: r.type, matchMode: r.matchMode,
    machine: r.machine, venue: r.venueId != null ? { id: r.venueId, name: r.venueName! } : null,
    targetScore: r.targetScore, minPlays: r.minPlays, startsAt: r.startsAt, endsAt: r.endsAt, createdAt: r.createdAt, decidedAt: r.decidedAt,
  }));
}

async function viewOf(id: number, viewerId: number, now: Date, includeScores: boolean): Promise<ChallengeView | null> {
  const c = await loadChallenge(db, id);
  if (!c) return null;
  const participants = await loadParticipants(db, id);
  if (!participants.some(p => p.userId === viewerId)) return null;
  const accepted = participants.filter(p => p.response === 'accepted').map(p => p.userId);
  const candidates = c.startsAt ? await loadCandidates(db, matchRuleOf(c), accepted, audienceOf(participants)) : [];
  // The counter-offer that replaced this one: a taken proposal, or (legacy) the counter row.
  const [counter] = c.status === 'countered'
    ? await db.select({ id: challenges.id }).from(challenges)
      .where(and(eq(challenges.counteredFromId, c.id), sql`${challenges.status} NOT IN ('proposed', 'rejected', 'lapsed')`))
      .orderBy(asc(challenges.id)).limit(1)
    : [];
  const proposals = isProposalStatus(c.status) ? [] : await proposalsFor(c, viewerId);
  return buildView(c, participants, candidates, viewerId, now, includeScores, { counteredToId: counter?.id ?? null, proposals });
}

/** GET /api/challenges/:id — participants only (404 otherwise). Resolves it first if due. */
export async function getChallenge(id: number, viewer: AppUser, now = new Date()): Promise<ChallengeView> {
  const [member] = await db.select({ u: challengeParticipants.userId }).from(challengeParticipants)
    .where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, viewer.id))).limit(1);
  if (!member) throw notFound();
  await syncChallenge(id, now);
  const v = await viewOf(id, viewer.id, now, true);
  if (!v) throw notFound();
  return v;
}

export type ListFilter = 'pending' | 'active' | 'history' | 'all';
const PENDING: Challenge['status'][] = ['pending', 'proposed'];
const HISTORY: Challenge['status'][] = ['resolved', 'declined', 'countered', 'cancelled', 'expired', 'rejected', 'lapsed'];

/** GET /api/challenges?status= — the caller's challenges, newest first, with live standings. */
export async function listChallenges(viewer: AppUser, filter: ListFilter, now = new Date()): Promise<ChallengeView[]> {
  await syncDueFor(viewer.id, now);
  const statusSql = filter === 'pending' ? inArray(challenges.status, PENDING)
    : filter === 'active' ? eq(challenges.status, 'active')
    : filter === 'history' ? inArray(challenges.status, HISTORY)
    : undefined;
  const rows = await db
    .select({ id: challenges.id })
    .from(challenges)
    .innerJoin(challengeParticipants, eq(challengeParticipants.challengeId, challenges.id))
    .where(and(eq(challengeParticipants.userId, viewer.id), statusSql))
    .orderBy(desc(sql`coalesce(${challenges.resolvedAt}, ${challenges.createdAt})`), desc(challenges.id))
    .limit(filter === 'history' || filter === 'all' ? 50 : 100);
  const out: ChallengeView[] = [];
  for (const { id } of rows) {
    const v = await viewOf(id, viewer.id, now, false);
    if (v) out.push(v);
  }
  return out;
}

// ── records ──────────────────────────────────────────────────────────────────

export interface RecordView extends Omit<ChallengeRecord, 'headToHead'> {
  user: UserRef;
  headToHead: Array<Omit<ChallengeRecord['headToHead'][number], 'opponentId'> & { opponent: UserRef }>;
}

/**
 * W/L/T/forfeit/no-show totals, streaks and head-to-head from resolved challenges. Headline and
 * streaks use the subject's own outcome (in a group, below 1st is a loss); head-to-head is pairwise
 * by rank (pairOutcome). For your own record head-to-head lists every opponent; for someone else's it
 * only lists their record against you (who else they challenge is between them and those people).
 */
export async function getRecord(username: string | null, viewer: AppUser, now = new Date()): Promise<RecordView> {
  const [subject] = username
    ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(eq(users.username, username)).limit(1)
    : [{ id: viewer.id, username: viewer.username, displayName: viewer.displayName }];
  if (!subject) throw new ChallengeError(404, 'user_not_found', 'User not found');
  await syncDueFor(subject.id, now);

  const mine = await db
    .select({ challengeId: challenges.id, resolvedAt: challenges.resolvedAt, void: challenges.void, outcome: challengeParticipants.outcome, rank: challengeParticipants.rank })
    .from(challenges)
    .innerJoin(challengeParticipants, eq(challengeParticipants.challengeId, challenges.id))
    .where(and(
      eq(challenges.status, 'resolved'), eq(challengeParticipants.userId, subject.id),
      eq(challengeParticipants.response, 'accepted'), isNotNull(challengeParticipants.outcome),
    ));
  const ids = mine.map(m => m.challengeId);
  const others = ids.length ? await db
    .select({
      challengeId: challengeParticipants.challengeId, outcome: challengeParticipants.outcome, rank: challengeParticipants.rank,
      user: { id: users.id, username: users.username, displayName: users.displayName },
    })
    .from(challengeParticipants)
    .innerJoin(users, eq(users.id, challengeParticipants.userId))
    .where(and(inArray(challengeParticipants.challengeId, ids), ne(challengeParticipants.userId, subject.id), eq(challengeParticipants.response, 'accepted')))
    : [];
  const refs = new Map(others.map(o => [o.user.id, o.user]));
  const rec = computeRecord(mine.map(m => ({
    challengeId: m.challengeId, resolvedAt: m.resolvedAt ?? new Date(0), void: m.void, outcome: m.outcome!, rank: m.rank,
    opponents: others.filter(o => o.challengeId === m.challengeId && o.outcome)
      .map(o => ({ userId: o.user.id, outcome: o.outcome!, rank: o.rank })),
  })));
  const self = subject.id === viewer.id;
  return {
    ...rec,
    user: subject,
    headToHead: rec.headToHead
      .filter(h => self || h.opponentId === viewer.id)
      .map(({ opponentId, ...rest }) => ({ ...rest, opponent: refs.get(opponentId)! })),
  };
}

// ── mutations ────────────────────────────────────────────────────────────────

type InviteeRow = UserRef & { role: string };

/** The create body's invitees, resolved: each a real user, not you, not repeated, and your friend. */
async function resolveInvitees(me: AppUser, body: Record<string, unknown>): Promise<InviteeRow[]> {
  const parsed = parseInvitees(body);
  if (!parsed.ok) throw new ChallengeError(400, parsed.code, parsed.error);
  const cols = { id: users.id, username: users.username, displayName: users.displayName, role: users.role };
  const out: InviteeRow[] = [];
  for (const ref of parsed.value) {
    const [row] = await db.select(cols).from(users).where('id' in ref ? eq(users.id, ref.id) : eq(users.username, ref.username)).limit(1);
    if (!row) throw new ChallengeError(404, 'user_not_found', 'User not found');
    out.push(row);
  }
  if (out.some(u => u.id === me.id)) throw new ChallengeError(400, 'cannot_challenge_self', 'You can’t challenge yourself');
  if (new Set(out.map(u => u.id)).size !== out.length) throw new ChallengeError(400, 'duplicate_invitee', 'Each friend can only be invited once');
  for (const u of out) {
    const [pair] = await db.select({ id: friendships.id }).from(friendships).where(acceptedPairSql(me.id, u.id)).limit(1);
    if (!pair) throw new ChallengeError(403, 'not_friends', 'You can only challenge your friends');
  }
  return out;
}

// ── venue lock: the venue must have the machine ─────────────────────────────
//
// A challenge locked to a venue that doesn't have its machine can't be played. Sources, in order
// (any one of them is enough):
//   1. the venue's current Pinball Map roster, when it's PM-linked — through pmRosterCache, the only
//      sanctioned way to read one (6h cache; a stale copy during a PM outage). If Pinball Map can't
//      be reached at all we fall through to our own data rather than block the challenge;
//   2. venue_machine_history — a machine seen there and not since marked removed;
//   3. a score recorded on the machine at the venue.
// "The machine" follows the match mode: exact = that machine; game = any model in its OPDB group.
// Pinball Map roster entries map to TiltTrack machines by name (see rosterHasMachine).

/** Every TiltTrack machine the rule accepts: the machine itself, plus (game mode) its group's models. */
async function targetMachines(rule: MatchRule): Promise<Array<{ id: number; name: string }>> {
  return db.select({ id: machines.id, name: machines.name }).from(machines).where(rule.matchGroup
    ? or(eq(machines.id, rule.machineId), sql`split_part(${machines.opdbId}, '-', 1) = ${rule.matchGroup}`)
    : eq(machines.id, rule.machineId));
}

/**
 * Pinball Map's catalog (PM machine id → opdb_id), for game-mode matches TiltTrack has no row for.
 * `stored`: only the copy already in pm_catalog_cache, at any age — never a Pinball Map call (the
 * venue-options read path). Otherwise the normal 24h DB-backed accessor, which refreshes at most
 * once a day. Either way a missing catalog means undefined, and matching falls back to exact names.
 */
async function pmCatalogOpdb(rule: MatchRule, { stored = false }: { stored?: boolean } = {}): Promise<Map<number, string | null> | undefined> {
  if (!rule.matchGroup) return undefined;
  const all: PinballMachine[] | null = stored ? await getStoredCatalog() : await getCatalogOrNull();
  return all ? new Map(all.map(m => [m.id, m.opdb_id])) : undefined;
}

export type VenueMachineSource = 'pinball_map' | 'history' | 'scores';

/** Which source (if any) shows the venue has the rule's machine. See the block comment above. */
export async function venueMachineSource(
  venue: { id: number; pinballMapId: number | null }, rule: MatchRule,
  { allowLive }: { allowLive?: () => boolean } = {},
): Promise<VenueMachineSource | null> {
  const targets = await targetMachines(rule);
  const targetIds = targets.map(t => t.id);

  if (venue.pinballMapId) {
    try {
      const { xrefs } = await getVenueRoster(venue.pinballMapId, { allowLive });
      if (rosterHasMachine(xrefs, targets.map(t => t.name), rule.matchGroup, await pmCatalogOpdb(rule))) return 'pinball_map';
    } catch (err) {
      console.error('Challenge venue check: Pinball Map roster unavailable, using TiltTrack data:', err);
    }
  }

  const [seen] = await db.select({ id: venueMachineHistory.id }).from(venueMachineHistory).where(and(
    eq(venueMachineHistory.venueId, venue.id), isNull(venueMachineHistory.removedAt), inArray(venueMachineHistory.machineId, targetIds),
  )).limit(1);
  if (seen) return 'history';

  const [played] = await db.select({ id: scores.id }).from(scores)
    .where(and(eq(scores.venueId, venue.id), inArray(scores.machineId, targetIds))).limit(1);
  if (played) return 'scores';
  return null;
}

export interface VenueOption { id: number; name: string; city: string | null; state: string | null }

/**
 * GET /api/challenges/venue-options?machineId=&matchMode= — the public venues a challenge on this
 * machine can be locked to. Same sources as venueMachineSource, but it makes ZERO Pinball Map calls:
 * it reads the cached rosters as they are (any age) and the stored catalog (any age; without one,
 * exact-name matching only) instead of fetching. POST /api/challenges re-checks the chosen venue
 * against a fresh-enough roster.
 */
export async function venueOptions(query: Record<string, unknown>): Promise<VenueOption[]> {
  const machineId = Number(query.machineId);
  if (!Number.isInteger(machineId) || machineId <= 0) throw new ChallengeError(400, 'invalid_machine', 'machineId is required');
  const matchMode = (query.matchMode ?? 'game') as MatchMode;
  if (matchMode !== 'game' && matchMode !== 'exact') throw new ChallengeError(400, 'invalid_match_mode', 'matchMode must be game or exact');
  const [machine] = await db.select({ id: machines.id, opdbId: machines.opdbId }).from(machines).where(eq(machines.id, machineId)).limit(1);
  if (!machine) throw new ChallengeError(404, 'machine_not_found', 'Machine not found');

  const rule: MatchRule = { machineId, matchGroup: matchGroupFor(matchMode, machine.opdbId) };
  const targets = await targetMachines(rule);
  const targetIds = targets.map(t => t.id);
  const isPublic = and(eq(venues.isResidence, false), eq(venues.privacyTier, 'full'));

  const ids = new Set<number>();
  const cached = await db.select({ id: venues.id, roster: pmLocationCache.machines }).from(venues)
    .innerJoin(pmLocationCache, eq(pmLocationCache.pmLocationId, venues.pinballMapId))
    .where(isPublic);
  if (cached.length) {
    const catalog = await pmCatalogOpdb(rule, { stored: true });
    const names = targets.map(t => t.name);
    for (const c of cached) if (rosterHasMachine(c.roster as PmLocationMachineXref[], names, rule.matchGroup, catalog)) ids.add(c.id);
  }
  const seen = await db.selectDistinct({ id: venueMachineHistory.venueId }).from(venueMachineHistory)
    .where(and(isNull(venueMachineHistory.removedAt), inArray(venueMachineHistory.machineId, targetIds)));
  seen.forEach(r => ids.add(r.id));
  const played = await db.selectDistinct({ id: scores.venueId }).from(scores)
    .where(and(isNotNull(scores.venueId), inArray(scores.machineId, targetIds)));
  played.forEach(r => r.id != null && ids.add(r.id));

  if (!ids.size) return [];
  return db.select({ id: venues.id, name: venues.name, city: venues.city, state: venues.state }).from(venues)
    .where(and(isPublic, inArray(venues.id, [...ids])))
    .orderBy(asc(venues.name));
}

/** A create body that passed every check — what insertChallenge() / insertProposal() write. */
interface PreparedChallenge {
  v: CreateInput;
  invitees: InviteeRow[];
  machine: { id: number; name: string; opdbId: string | null };
  rule: MatchRule;
  venueId: number | null;
  targetScore: number | null;
}

/**
 * Validate a create body (type / window / invitees / machine / venue lock / race target / baseline)
 * for `me` — the challenger, or the proposer of a counter-offer (whose best is the race's "beat my
 * score" and whose baseline is checked). Reads only — nothing is written until insert.
 */
async function prepareChallenge(me: AppUser, body: Record<string, unknown>, now: Date): Promise<PreparedChallenge> {
  const input = validateCreate(body, now);
  if (!input.ok) throw new ChallengeError(400, input.code, input.error);
  const v = input.value;

  const invitees = await resolveInvitees(me, body);

  const machineId = Number(body.machineId);
  if (!Number.isInteger(machineId) || machineId <= 0) throw new ChallengeError(400, 'invalid_machine', 'machineId is required');
  const [machine] = await db.select({ id: machines.id, name: machines.name, opdbId: machines.opdbId }).from(machines).where(eq(machines.id, machineId)).limit(1);
  if (!machine) throw new ChallengeError(404, 'machine_not_found', 'Machine not found');

  const rule: MatchRule = { machineId: machine.id, matchGroup: matchGroupFor(v.matchMode, machine.opdbId) };

  let venueId: number | null = null;
  if (body.venueId !== undefined && body.venueId !== null && body.venueId !== '') {
    venueId = Number(body.venueId);
    const [venue] = Number.isInteger(venueId) && venueId > 0
      ? await db.select({ id: venues.id, isResidence: venues.isResidence, privacyTier: venues.privacyTier, pinballMapId: venues.pinballMapId }).from(venues).where(eq(venues.id, venueId)).limit(1)
      : [];
    if (!venue) throw new ChallengeError(404, 'venue_not_found', 'Venue not found');
    // A venue lock names the venue to the other participants, so it must be a public one.
    if (isPrivateVenue(venue)) throw new ChallengeError(400, 'venue_private', 'A challenge can only be locked to a public venue');
    // A cache miss here is one roster fetch per venue per 6h (de-duplicated in flight), charged to a
    // per-user limit; past it the check uses TiltTrack's own data instead of calling Pinball Map.
    if (!(await venueMachineSource(venue, rule, { allowLive: () => challengePmLimiter.take(String(me.id)).ok }))) {
      throw new ChallengeError(400, 'machine_not_at_venue', 'That venue doesn’t have this machine right now');
    }
  }
  const audience = [{ id: me.id, role: me.role }, ...invitees.map(u => ({ id: u.id, role: u.role }))];
  const myScores = await loadCandidates(db, rule, [me.id], audience);

  let targetScore = v.targetScore;
  if (v.type === 'race') {
    targetScore = raceTarget(v.targetScore, bestOnMachine(rule, myScores.filter(s => s.visibleToOthers)));
    if (targetScore == null) {
      throw new ChallengeError(400, 'race_target_required', 'You have no score on this machine to beat — pick a target score');
    }
  }
  if (v.type === 'most_improved' && baselineFrom(rule, v.startsAt ?? now, myScores) == null) throw noBaseline();
  return { v, invitees, machine, rule, venueId, targetScore };
}

/** Write a prepared challenge inside the caller's transaction: the row, every participant, the invitations. */
async function insertChallenge(tx: Executor, me: AppUser, p: PreparedChallenge, now: Date): Promise<number> {
  const { v, invitees, machine, rule } = p;
  const [row] = await tx.insert(challenges).values({
    creatorId: me.id, type: v.type, machineId: machine.id, matchMode: v.matchMode, matchGroup: rule.matchGroup,
    venueId: p.venueId, targetScore: p.targetScore, minPlays: v.minPlays, startsAt: v.startsAt, endsAt: v.endsAt, status: 'pending',
  }).returning({ id: challenges.id });
  await tx.insert(challengeParticipants).values([
    { challengeId: row.id, userId: me.id, response: 'accepted', respondedAt: now },
    ...invitees.map(u => ({ challengeId: row.id, userId: u.id, response: 'pending' as const })),
  ]);
  const about = { challengeId: row.id, challengeType: v.type, machineName: machine.name, userId: me.id, username: me.username, displayName: me.displayName, players: invitees.length + 1 };
  for (const u of invitees) await raiseNotification(tx, u.id, 'challenge_received', about, { key: 'challengeId', value: row.id });
  return row.id;
}

/**
 * Write a counter-offer as a PROPOSAL row: creator = the challenger, proposed_by_id = me, status
 * 'proposed', countered_from_id = the original. Participants: me (accepted) and the challenger
 * (pending). The challenger's notice is challenge_countered, keyed on the proposal's id.
 */
async function insertProposal(tx: Executor, me: AppUser, original: ChallengeRow, p: PreparedChallenge, now: Date): Promise<number> {
  const { v, machine, rule } = p;
  const [row] = await tx.insert(challenges).values({
    creatorId: original.creatorId, proposedById: me.id, counteredFromId: original.id,
    type: v.type, machineId: machine.id, matchMode: v.matchMode, matchGroup: rule.matchGroup,
    venueId: p.venueId, targetScore: p.targetScore, minPlays: v.minPlays, startsAt: v.startsAt, endsAt: v.endsAt, status: 'proposed',
  }).returning({ id: challenges.id });
  await tx.insert(challengeParticipants).values([
    { challengeId: row.id, userId: me.id, response: 'accepted', respondedAt: now },
    { challengeId: row.id, userId: original.creatorId, response: 'pending' },
  ]);
  await raiseNotification(tx, original.creatorId, 'challenge_countered', {
    challengeId: row.id, challengeType: v.type, machineName: machine.name, userId: me.id, username: me.username, displayName: me.displayName,
    newChallengeId: row.id, counteredFromId: original.id, originalMachineName: original.machine.name, proposal: true,
  }, { key: 'challengeId', value: row.id });
  return row.id;
}

/** POST /api/challenges — body { friendIds | friendId | friendUsername…, type, machineId, … }. */
export async function createChallenge(me: AppUser, body: Record<string, unknown>, now = new Date()): Promise<ChallengeView> {
  const prepared = await prepareChallenge(me, body, now);
  const id = await db.transaction(tx => insertChallenge(tx, me, prepared, now));
  return (await viewOf(id, me.id, now, true))!;
}

/**
 * POST /api/challenges/:id/counter — "can't get to this one, how about this instead". Body: a create
 * body (machineId, type, matchMode, window, targetScore / minPlays, venueId); invitees in the body
 * are ignored. One transaction: the counterer's participant row on the original becomes response
 * 'countered' / decline_reason 'cant_reach' (their invitation is settled), and a PROPOSAL row is
 * written for the challenger to take or reject. The original stays pending — and an open proposal
 * blocks it from starting or ending on its own. 409 cannot_counter unless it's pending and waiting on you.
 */
export async function counterChallenge(id: number, me: AppUser, body: Record<string, unknown>, now = new Date()): Promise<{ original: ChallengeView; counter: ChallengeView }> {
  const synced = await syncChallenge(id, now);
  if (!synced) throw notFound();
  const c0 = await loadChallenge(db, id);
  const mine0 = c0 && (await loadParticipants(db, id)).find(p => p.userId === me.id);
  if (!c0 || !mine0) throw notFound();
  if (!canCounter(c0, mine0)) throw stateError(c0, 'counter');

  const { friendId: _f, friendUsername: _u, friendIds: _fs, friendUsernames: _us, ...rest } = body;
  const prepared = await prepareChallenge(me, { ...rest, friendIds: [c0.creatorId] }, now);

  const newId = await db.transaction(async tx => {
    const c = await loadChallenge(tx, id, true);
    if (!c) throw notFound();
    const mine = (await loadParticipants(tx, id)).find(p => p.userId === me.id);
    if (!mine) throw notFound();
    // Re-checked under the row lock: it may have been cancelled or answered since the check above.
    if (!canCounter(c, mine)) throw stateError(c, 'counter');
    await tx.update(challengeParticipants).set({ response: 'countered', declineReason: 'cant_reach', respondedAt: now })
      .where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, me.id)));
    await settleInvitation(tx, me.id, id, 'read');
    return insertProposal(tx, me, c, prepared, now);
  });
  const [original, counter] = await Promise.all([viewOf(id, me.id, now, true), viewOf(newId, me.id, now, true)]);
  return { original: original!, counter: counter! };
}

/**
 * The challenger takes a proposal "for everyone" (inside the action's transaction; original and
 * proposal locked, in that order). The original ends 'countered'; the proposal becomes an ordinary
 * pending challenge with the challenger accepted; everyone else on the original is re-invited
 * (reinvitees: not `no_thanks` decliners, not ex-friends; everyone re-accepts) with challenge_moved;
 * other open proposals are rejected as superseded; the proposer gets challenge_counter_accepted.
 * Then L is evaluated — a 1:1 counter goes straight to active.
 */
async function takeProposal(tx: Executor, original: ChallengeRow, proposal: ChallengeRow, me: AppUser, now: Date): Promise<void> {
  if (original.status !== 'pending') throw stateError(proposal, 'accept');
  if (proposal.type === 'most_improved') {
    const rule = matchRuleOf(proposal);
    const mineScores = await loadCandidates(tx, rule, [me.id], []);
    if (baselineFrom(rule, proposal.startsAt ?? await dbNow(tx), mineScores) == null) throw noBaseline();
  }
  const origParticipants = await loadParticipants(tx, original.id);
  const proposerId = proposal.proposedById!;
  const candidateIds = origParticipants.map(p => p.userId).filter(u => u !== me.id && u !== proposerId);
  const friendIds = new Set<number>();
  for (const u of candidateIds) {
    const [pair] = await tx.select({ id: friendships.id }).from(friendships).where(acceptedPairSql(me.id, u)).limit(1);
    if (pair) friendIds.add(u);
  }
  const again = reinvitees(original, origParticipants, proposerId, friendIds);

  await tx.update(challenges).set({ status: 'countered' }).where(eq(challenges.id, original.id));
  for (const p of origParticipants) if (p.userId !== me.id) await settleInvitation(tx, p.userId, original.id, 'read');
  await tx.update(challenges).set({ status: 'pending', proposalDecidedAt: now }).where(eq(challenges.id, proposal.id));
  await tx.update(challengeParticipants).set({ response: 'accepted', respondedAt: now })
    .where(and(eq(challengeParticipants.challengeId, proposal.id), eq(challengeParticipants.userId, me.id)));
  await settleInvitation(tx, me.id, proposal.id, 'read');

  const proposalParticipants = await loadParticipants(tx, proposal.id);
  const proposer = proposalParticipants.find(p => p.userId === proposerId);
  const asRef = { id: me.id, username: me.username, displayName: me.displayName };
  if (again.length) {
    await tx.insert(challengeParticipants).values(again.map(userId => ({ challengeId: proposal.id, userId, response: 'pending' as const })))
      .onConflictDoNothing();
    for (const userId of again) {
      await raiseNotification(tx, userId, 'challenge_moved', {
        ...userPayload(proposal, asRef), fromChallengeId: original.id, originalMachineName: original.machine.name,
        proposedBy: proposer ? { userId: proposer.user.id, username: proposer.user.username, displayName: proposer.user.displayName } : null,
        players: again.length + 2,
      }, { key: 'challengeId', value: proposal.id });
    }
  }
  for (const other of await openProposals(tx, original.id, true)) await closeProposal(tx, other, 'superseded', now, me.id);
  await raiseNotification(tx, proposerId, 'challenge_counter_accepted', {
    ...userPayload(proposal, asRef), counteredFromId: original.id, originalMachineName: original.machine.name, reinvited: again.length,
  });
  const nowPending = { ...proposal, status: 'pending' as const };
  await settleAfterAnswer(tx, nowPending, now, { actorId: me.id, strict: true });
}

/**
 * Lock a challenge for an action — and, for an open proposal, its original first (lock order). The
 * returned `c` is the locked target; `original` is set only for a proposal.
 */
async function lockForAction(tx: Executor, id: number): Promise<{ c: ChallengeRow; original?: ChallengeRow }> {
  const peek = await loadChallenge(tx, id);
  if (!peek) throw notFound();
  const original = peek.status === 'proposed' && peek.counteredFromId ? await loadChallenge(tx, peek.counteredFromId, true) : undefined;
  const c = await loadChallenge(tx, id, true);
  if (!c) throw notFound();
  return { c, original };
}

export type Action = 'accept' | 'decline' | 'cancel' | 'forfeit' | 'start';
/** What an action turned out to be: a plain answer, or the challenger deciding a proposal. */
export type ActionKind = 'answer' | 'take' | 'reject';

/**
 * POST /api/challenges/:id/(accept|decline|cancel|forfeit|start). A decline may carry `reason`
 * ('cant_reach' | 'no_thanks'), stored on the participant row and passed on in challenge_declined.
 * An accepted invitee's decline is a back-out: stored (and notified) as reason 'backed_out'.
 * On a proposal, accept = take it and decline = keep mine (the challenger only).
 */
export async function actOnChallengeDetailed(
  id: number, me: AppUser, action: Action, now = new Date(), opts: { reason?: ChosenDeclineReason | null } = {},
): Promise<{ view: ChallengeView; kind: ActionKind }> {
  // Bring it up to date first (a past-deadline challenge resolves; an unanswered one expires or starts).
  const synced = await syncChallenge(id, now);
  if (!synced) throw notFound();

  let kind: ActionKind = 'answer';
  const followUp = await db.transaction(async tx => {
    const { c, original } = await lockForAction(tx, id);
    const participants = await loadParticipants(tx, id);
    const mine = participants.find(p => p.userId === me.id);
    if (!mine) throw notFound();
    const asRef = { id: me.id, username: me.username, displayName: me.displayName };

    switch (action) {
      case 'accept': {
        if (!canAccept(c, mine)) throw stateError(c, 'accept');
        if (c.status === 'proposed') {
          if (!original) throw stateError(c, 'accept');
          kind = 'take';
          await takeProposal(tx, original, c, me, now);
          return false;
        }
        // most_improved: you need a baseline of your own to take part at all.
        if (c.type === 'most_improved') {
          const rule = matchRuleOf(c);
          const cands = await loadCandidates(tx, rule, participants.filter(p => !saidNo(p.response)).map(p => p.userId), audienceOf(participants));
          const startsAt = c.startsAt ?? await dbNow(tx);
          if (baselineFrom(rule, startsAt, cands.filter(s => s.userId === me.id)) == null) throw noBaseline();
        }
        await tx.update(challengeParticipants).set({ response: 'accepted', respondedAt: now })
          .where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, me.id)));
        await settleInvitation(tx, me.id, id, 'read');
        await raiseNotification(tx, c.creatorId, 'challenge_accepted', { ...userPayload(c, asRef), players: participants.length });
        await settleAfterAnswer(tx, c, now, { actorId: me.id, strict: true });
        return false;
      }
      case 'decline': {
        if (!canDecline(c, mine)) throw stateError(c, 'decline');
        if (c.status === 'proposed') {
          kind = 'reject';
          await closeProposal(tx, c, 'rejected', now, me.id);
          // The proposer stays out; the original carries on (it may now start, or end declined).
          if (original?.status === 'pending') await settleAfterAnswer(tx, original, now, { actorId: me.id, strict: false });
          return false;
        }
        // Backing out (an accepted invitee leaving a pending group) is stored as 'backed_out',
        // whatever the body said; a normal decline stores the reason chosen (or null).
        const backedOut = mine.response === 'accepted';
        const reason = storedDeclineReason(mine.response, opts.reason ?? null);
        await tx.update(challengeParticipants).set({ response: 'declined', declineReason: reason, respondedAt: now })
          .where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, me.id)));
        await settleInvitation(tx, me.id, id, 'read');
        const remaining = participants.filter(p => p.userId !== c.creatorId && p.userId !== me.id && (p.response === 'pending' || p.response === 'accepted')).length;
        await raiseNotification(tx, c.creatorId, 'challenge_declined', { ...userPayload(c, asRef), reason, remaining, backedOut });
        // A decline never fails: a missing baseline elsewhere doesn't block the start it may cause.
        await settleAfterAnswer(tx, c, now, { actorId: me.id, strict: false });
        return false;
      }
      case 'cancel': {
        if (!canCancel(c, me.id)) throw stateError(c, 'cancel');
        await tx.update(challenges).set({ status: 'cancelled' }).where(eq(challenges.id, id));
        for (const p of participants) {
          if (p.userId === me.id || saidNo(p.response)) continue;
          // The invitation no longer exists: remove it from their unread, and say it was withdrawn.
          await settleInvitation(tx, p.userId, id, 'delete');
          await raiseNotification(tx, p.userId, 'challenge_cancelled', userPayload(c, asRef));
        }
        for (const p of await openProposals(tx, id, true)) await closeProposal(tx, p, 'cancelled', now, me.id);
        return false;
      }
      case 'start': {
        if (!canStart(c, participants, me.id)) throw stateError(c, 'start');
        await activate(tx, c, participants, now, { actorId: me.id, strict: true, closeReason: 'started' });
        return false;
      }
      case 'forfeit': {
        if (!canForfeit(c, mine)) throw stateError(c, 'forfeit');
        await tx.update(challengeParticipants).set({ outcome: 'forfeit' })
          .where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, me.id)));
        return true; // resolves (1v1) in the sync below
      }
    }
  });
  if (followUp) await syncChallenge(id, now);
  return { view: (await viewOf(id, me.id, now, true))!, kind };
}

export async function actOnChallenge(
  id: number, me: AppUser, action: Action, now = new Date(), opts: { reason?: ChosenDeclineReason | null } = {},
): Promise<ChallengeView> {
  return (await actOnChallengeDetailed(id, me, action, now, opts)).view;
}

function stateError(c: ChallengeRow, action: Action | 'counter'): ChallengeError {
  const why: Record<string, string> = {
    active: 'it’s already under way', resolved: 'it’s over', declined: 'it was declined',
    cancelled: 'it was cancelled', expired: 'it expired', countered: 'it moved to another machine',
    rejected: 'that suggestion was turned down', lapsed: 'that suggestion lapsed',
  };
  const reason = why[c.status];
  return new ChallengeError(409, `cannot_${action}`, `You can’t ${action} this challenge${reason ? ` — ${reason}` : ''}.`);
}
