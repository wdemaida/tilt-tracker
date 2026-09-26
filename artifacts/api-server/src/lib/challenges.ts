import {
  db, challenges, challengeParticipants, challengeScores, scores, machines, venues, users, friendships, notifications,
  type Challenge,
} from '@workspace/db';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, gt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  computeStanding, resolveChallenge, resolutionTrigger, projectedRanks, scoreCounts, baselineFrom, bestOnMachine,
  raceTarget, matchGroupFor, pendingExpired, canAccept, canDecline, canCancel, canForfeit, phaseOf, validateCreate,
  computeRecord, ENDING_SOON_MS,
  type CandidateScore, type CountRule, type MatchRule, type ParticipantState, type ResolutionReason, type Outcome,
  type ChallengeRecord,
} from './challengeRules.js';
import { canSeeScore, type ActivityVenue } from './venueActivity.js';
import { isPrivateVenue } from './venueAddress.js';
import { acceptedPairSql } from './friendships.js';
import { raiseNotification, settleNotifications, type Executor } from './notify.js';

// Challenges — database orchestration (feature/challenges, phase 2). The rules are pure, in
// challengeRules.ts; this file loads rows, asks the rules, and writes the answers. Routes are
// routes/challenges.ts (thin: HTTP in, one of these functions, HTTP out).
//
// RESOLUTION has three triggers, all funnelled through syncChallenge(), which locks the challenge
// row (FOR UPDATE) so two triggers can't resolve it twice:
//   (a) lazily on read — list / detail / record call it before answering;
//   (b) onScoreCreated() — POST /api/scores calls it for the uploader's active challenges: a race
//       resolves on the spot, and the other participant(s) get challenge_opponent_scored;
//   (c) runChallengeSweep() — the daily secret-guarded cron route: resolves past-deadline
//       challenges, expires stale pending ones, sends "ending soon", and prunes read notifications.
//
// THE SCORE LOCK: every time syncChallenge() evaluates an active challenge (every trigger above,
// the create hook included, so in practice the moment a counting score is uploaded) it records the
// scores that currently count in challenge_scores. PATCH/DELETE /api/scores/:id refuse a score with
// a row there (409 score_locked_by_challenge). Rows are only ever added: a locked score can't be
// edited, so it can't stop counting.
//
// PRIVACY: a challenge, its participants and its standings are only ever returned to its
// participants; anyone else gets 404 challenge_not_found (the pods pattern). A score only counts
// when every other participant may see it (canSeeScore), so standings never surface a score from a
// home venue whose owner hid its activity.
//
// TIMESTAMPS: starts_at / ends_at are naive `timestamp` columns holding UTC, the same convention as
// scores.played_at / created_at under Drizzle (it writes toISOString() and reads values back as
// UTC). All comparisons happen in JS on Dates read through Drizzle, or against Dates it serialises.

type AppUser = { id: number; username: string; displayName: string; role: string };
export type UserRef = { id: number; username: string; displayName: string };

export type ParticipantRow = {
  userId: number;
  response: 'pending' | 'accepted' | 'declined';
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

type ScoredCandidate = CandidateScore & { venueName: string | null };

export class ChallengeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const notFound = () => new ChallengeError(404, 'challenge_not_found', 'Challenge not found');

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

async function loadParticipants(ex: Executor, challengeId: number): Promise<ParticipantRow[]> {
  return ex
    .select({
      userId: challengeParticipants.userId, response: challengeParticipants.response,
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
      vOwnerId: venues.ownerId, vIsResidence: venues.isResidence, vTier: venues.privacyTier,
      vShow: venues.showMachinesAndScores,
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
      id: r.id, userId: r.userId, machineId: r.machineId, opdbId: r.opdbId, venueId: r.venueId, venueName: r.venueName,
      score: r.score, playedAt: r.playedAt, createdAt: r.createdAt, hasPhoto: !!r.hasPhoto, visibleToOthers,
    };
  });
}

const matchRuleOf = (c: Pick<Challenge, 'machineId' | 'matchGroup'>): MatchRule => ({ machineId: c.machineId, matchGroup: c.matchGroup });
const audienceOf = (ps: ParticipantRow[]) => ps.filter(p => p.response !== 'declined').map(p => ({ id: p.user.id, role: p.user.role }));

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

// ── sync (the one place a challenge changes state on its own) ────────────────

export interface SyncResult {
  status: Challenge['status'];
  /** Set when this call resolved it. */
  resolvedNow: ResolutionReason | null;
  countingScoreIds: Set<number>;
}

function userPayload(c: ChallengeRow, other: UserRef | undefined): Record<string, unknown> {
  return {
    challengeId: c.id, challengeType: c.type, machineName: c.machine.name,
    ...(other ? { userId: other.id, username: other.username, displayName: other.displayName } : {}),
  };
}

/** The first other accepted participant (the opponent, in 1v1) — who a notification is "about". */
function otherOf(participants: ParticipantRow[], userId: number): UserRef | undefined {
  const o = participants.find(p => p.userId !== userId && p.response !== 'declined');
  return o ? { id: o.user.id, username: o.user.username, displayName: o.user.displayName } : undefined;
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
  await tx.update(challenges).set({ status: 'resolved', void: r.void, resolvedAt: now }).where(eq(challenges.id, c.id));
  for (const p of r.participants) {
    await raiseNotification(tx, p.userId, 'challenge_result', {
      ...userPayload(c, otherOf(participants, p.userId)), outcome: p.outcome, rank: p.rank, void: r.void, reason,
    });
  }
}

/**
 * Bring one challenge up to date: expire it if it went unanswered, record its counting scores
 * (the lock), and resolve it if a race was won, someone forfeited, or its deadline passed.
 * Idempotent; safe to call from any trigger at any time.
 */
export async function syncChallenge(id: number, now = new Date()): Promise<SyncResult | null> {
  return db.transaction(async tx => {
    const c = await loadChallenge(tx, id, true);
    if (!c) return null;
    const out: SyncResult = { status: c.status, resolvedNow: null, countingScoreIds: new Set() };

    if (pendingExpired(c, now)) {
      await tx.update(challenges).set({ status: 'expired' }).where(eq(challenges.id, c.id));
      const ps = await loadParticipants(tx, c.id);
      for (const p of ps) if (p.response === 'pending') await settleNotifications(tx, p.userId, 'challenge_received', c.id, 'read', 'challengeId');
      out.status = 'expired';
      return out;
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

/** Sync every challenge of `userId` that has something due (expiry or deadline). For lazy reads. */
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
    and(eq(challenges.status, 'pending'), or(lte(challenges.startsAt, now), lte(challenges.endsAt, now))),
    and(eq(challenges.status, 'active'), lt(challenges.endsAt, now)),
  )!;
}

// ── trigger (b): the score-create hook ───────────────────────────────────────

/**
 * Called by POST /api/scores after inserting a score. For each of the uploader's active challenges:
 * sync it (records the lock, resolves a won race); if the new score counts and the challenge is
 * still going, tell the other participant(s). Never throws — a challenge problem must not fail a
 * score upload.
 */
export async function onScoreCreated(score: { id: number; userId: number }, now = new Date()): Promise<void> {
  try {
    const mine = await db
      .select({ id: challenges.id })
      .from(challenges)
      .innerJoin(challengeParticipants, eq(challengeParticipants.challengeId, challenges.id))
      .where(and(
        eq(challenges.status, 'active'),
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
        await raiseNotification(db, p.userId, 'challenge_opponent_scored',
          { ...userPayload(c!, uploader.user), score: value },
          { key: 'challengeId', value: id });
      }
    }
  } catch (err) {
    console.error('Challenge score hook failed:', err);
  }
}

// ── trigger (c): the daily sweep ─────────────────────────────────────────────

export const NOTIFICATION_RETENTION_DAYS = 30;

export interface SweepResult { expired: number; resolved: number; endingSoon: number; notificationsDeleted: number; errors: number }

export async function runChallengeSweep(now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { expired: 0, resolved: 0, endingSoon: 0, notificationsDeleted: 0, errors: 0 };

  const due = await db.select({ id: challenges.id }).from(challenges).where(dueSql(now));
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
  scores?: Array<{ id: number; score: number; playedAt: Date; createdAt: Date; venueId: number | null; venueName: string | null }>;
}

export interface ChallengeView {
  id: number;
  type: Challenge['type'];
  status: Challenge['status'];
  phase: ReturnType<typeof phaseOf>;
  void: boolean;
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
  /** ms until ends_at while active; null otherwise. */
  timeLeftMs: number | null;
  /** ms until starts_at while scheduled; null otherwise. */
  startsInMs: number | null;
  me: { response: ParticipantRow['response']; outcome: Outcome | null; canAccept: boolean; canDecline: boolean; canCancel: boolean; canForfeit: boolean };
  /** 1v1 convenience: the other participant. */
  opponent: UserRef | null;
  participants: ParticipantView[];
}

function buildView(c: ChallengeRow, participants: ParticipantRow[], candidates: ScoredCandidate[], viewerId: number, now: Date, includeScores: boolean): ChallengeView {
  const ev = evaluate(c, participants, candidates, now);
  const live = ev.started ? projectedRanks(c.type, ev.states) : new Map<number, number>();
  const me = participants.find(p => p.userId === viewerId)!;
  const phase = phaseOf(c, now);
  return {
    id: c.id, type: c.type, status: c.status, phase, void: c.void, matchMode: c.matchMode, matchGroup: c.matchGroup,
    machine: { id: c.machine.id, name: c.machine.name, imageUrl: c.machine.imageUrl },
    venue: c.venue, targetScore: c.targetScore, minPlays: c.minPlays,
    startsAt: c.startsAt, endsAt: c.endsAt, createdAt: c.createdAt, resolvedAt: c.resolvedAt, creatorId: c.creatorId,
    timeLeftMs: c.status === 'active' ? Math.max(0, +c.endsAt - +now) : null,
    startsInMs: phase === 'scheduled' ? +c.startsAt! - +now : null,
    me: {
      response: me.response, outcome: me.outcome,
      canAccept: canAccept(c, me), canDecline: canDecline(c, me), canCancel: canCancel(c, viewerId), canForfeit: canForfeit(c, me),
    },
    opponent: otherOf(participants, viewerId) ?? null,
    participants: participants.map(p => {
      const st = ev.states.find(s => s.userId === p.userId)?.standing;
      const view: ParticipantView = {
        user: { id: p.user.id, username: p.user.username, displayName: p.user.displayName },
        isCreator: p.userId === c.creatorId,
        response: p.response, respondedAt: p.respondedAt, outcome: p.outcome, rank: p.rank,
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
          .map(s => ({ id: s.id, score: s.score, playedAt: s.playedAt, createdAt: s.createdAt, venueId: s.venueId, venueName: s.venueName }));
      }
      return view;
    }),
  };
}

async function viewOf(id: number, viewerId: number, now: Date, includeScores: boolean): Promise<ChallengeView | null> {
  const c = await loadChallenge(db, id);
  if (!c) return null;
  const participants = await loadParticipants(db, id);
  if (!participants.some(p => p.userId === viewerId)) return null;
  const accepted = participants.filter(p => p.response === 'accepted').map(p => p.userId);
  const candidates = c.startsAt ? await loadCandidates(db, matchRuleOf(c), accepted, audienceOf(participants)) : [];
  return buildView(c, participants, candidates, viewerId, now, includeScores);
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
const HISTORY: Challenge['status'][] = ['resolved', 'declined', 'cancelled', 'expired'];

/** GET /api/challenges?status= — the caller's challenges, newest first, with live standings. */
export async function listChallenges(viewer: AppUser, filter: ListFilter, now = new Date()): Promise<ChallengeView[]> {
  await syncDueFor(viewer.id, now);
  const statusSql = filter === 'pending' ? eq(challenges.status, 'pending')
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
 * W/L/T/forfeit/no-show totals, streaks and head-to-head from resolved challenges. For your own
 * record head-to-head lists every opponent; for someone else's it only lists their record against
 * you (who else they challenge is between them and those people).
 */
export async function getRecord(username: string | null, viewer: AppUser, now = new Date()): Promise<RecordView> {
  const [subject] = username
    ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(eq(users.username, username)).limit(1)
    : [{ id: viewer.id, username: viewer.username, displayName: viewer.displayName }];
  if (!subject) throw new ChallengeError(404, 'user_not_found', 'User not found');
  await syncDueFor(subject.id, now);

  const mine = await db
    .select({ challengeId: challenges.id, resolvedAt: challenges.resolvedAt, void: challenges.void, outcome: challengeParticipants.outcome })
    .from(challenges)
    .innerJoin(challengeParticipants, eq(challengeParticipants.challengeId, challenges.id))
    .where(and(
      eq(challenges.status, 'resolved'), eq(challengeParticipants.userId, subject.id),
      eq(challengeParticipants.response, 'accepted'), isNotNull(challengeParticipants.outcome),
    ));
  const ids = mine.map(m => m.challengeId);
  const others = ids.length ? await db
    .select({ challengeId: challengeParticipants.challengeId, user: { id: users.id, username: users.username, displayName: users.displayName } })
    .from(challengeParticipants)
    .innerJoin(users, eq(users.id, challengeParticipants.userId))
    .where(and(inArray(challengeParticipants.challengeId, ids), ne(challengeParticipants.userId, subject.id), eq(challengeParticipants.response, 'accepted')))
    : [];
  const refs = new Map(others.map(o => [o.user.id, o.user]));
  const rec = computeRecord(mine.map(m => ({
    challengeId: m.challengeId, resolvedAt: m.resolvedAt ?? new Date(0), void: m.void, outcome: m.outcome!,
    opponentIds: others.filter(o => o.challengeId === m.challengeId).map(o => o.user.id),
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

async function resolveInvitee(body: Record<string, unknown>): Promise<UserRef & { role: string }> {
  const cols = { id: users.id, username: users.username, displayName: users.displayName, role: users.role };
  let row: (UserRef & { role: string }) | undefined;
  if (body.friendId !== undefined && body.friendId !== null && body.friendId !== '') {
    const id = Number(body.friendId);
    if (!Number.isInteger(id) || id <= 0) throw new ChallengeError(400, 'invalid_user', 'friendId must be a user id');
    [row] = await db.select(cols).from(users).where(eq(users.id, id)).limit(1);
  } else if (typeof body.friendUsername === 'string' && body.friendUsername.trim()) {
    [row] = await db.select(cols).from(users).where(eq(users.username, body.friendUsername.trim())).limit(1);
  } else {
    throw new ChallengeError(400, 'invalid_user', 'friendId or friendUsername is required');
  }
  if (!row) throw new ChallengeError(404, 'user_not_found', 'User not found');
  return row;
}

/** POST /api/challenges */
export async function createChallenge(me: AppUser, body: Record<string, unknown>, now = new Date()): Promise<ChallengeView> {
  const input = validateCreate(body, now);
  if (!input.ok) throw new ChallengeError(400, input.code, input.error);
  const v = input.value;

  const friend = await resolveInvitee(body);
  if (friend.id === me.id) throw new ChallengeError(400, 'cannot_challenge_self', 'You can’t challenge yourself');
  const [pair] = await db.select({ id: friendships.id }).from(friendships).where(acceptedPairSql(me.id, friend.id)).limit(1);
  if (!pair) throw new ChallengeError(403, 'not_friends', 'You can only challenge your friends');

  const machineId = Number(body.machineId);
  if (!Number.isInteger(machineId) || machineId <= 0) throw new ChallengeError(400, 'invalid_machine', 'machineId is required');
  const [machine] = await db.select({ id: machines.id, name: machines.name, opdbId: machines.opdbId }).from(machines).where(eq(machines.id, machineId)).limit(1);
  if (!machine) throw new ChallengeError(404, 'machine_not_found', 'Machine not found');

  let venueId: number | null = null;
  if (body.venueId !== undefined && body.venueId !== null && body.venueId !== '') {
    venueId = Number(body.venueId);
    const [venue] = Number.isInteger(venueId) && venueId > 0
      ? await db.select({ id: venues.id, isResidence: venues.isResidence, privacyTier: venues.privacyTier }).from(venues).where(eq(venues.id, venueId)).limit(1)
      : [];
    if (!venue) throw new ChallengeError(404, 'venue_not_found', 'Venue not found');
    // A venue lock names the venue to the other participant, so it must be a public one.
    if (isPrivateVenue(venue)) throw new ChallengeError(400, 'venue_private', 'A challenge can only be locked to a public venue');
  }

  const rule: MatchRule = { machineId: machine.id, matchGroup: matchGroupFor(v.matchMode, machine.opdbId) };
  const audience = [{ id: me.id, role: me.role }, { id: friend.id, role: friend.role }];
  const creatorScores = await loadCandidates(db, rule, [me.id], audience);

  let targetScore = v.targetScore;
  if (v.type === 'race') {
    targetScore = raceTarget(v.targetScore, bestOnMachine(rule, creatorScores.filter(s => s.visibleToOthers)));
    if (targetScore == null) {
      throw new ChallengeError(400, 'race_target_required', 'You have no score on this machine to beat — pick a target score');
    }
  }
  if (v.type === 'most_improved' && baselineFrom(rule, v.startsAt ?? now, creatorScores) == null) {
    throw new ChallengeError(409, 'no_baseline', 'Most improved needs a score of yours on this machine from before the challenge');
  }

  const id = await db.transaction(async tx => {
    const [row] = await tx.insert(challenges).values({
      creatorId: me.id, type: v.type, machineId: machine.id, matchMode: v.matchMode, matchGroup: rule.matchGroup,
      venueId, targetScore, minPlays: v.minPlays, startsAt: v.startsAt, endsAt: v.endsAt, status: 'pending',
    }).returning({ id: challenges.id });
    await tx.insert(challengeParticipants).values([
      { challengeId: row.id, userId: me.id, response: 'accepted', respondedAt: now },
      { challengeId: row.id, userId: friend.id, response: 'pending' },
    ]);
    await raiseNotification(tx, friend.id, 'challenge_received', {
      challengeId: row.id, challengeType: v.type, machineName: machine.name,
      userId: me.id, username: me.username, displayName: me.displayName,
    }, { key: 'challengeId', value: row.id });
    return row.id;
  });
  return (await viewOf(id, me.id, now, true))!;
}

type Action = 'accept' | 'decline' | 'cancel' | 'forfeit';

/** POST /api/challenges/:id/(accept|decline|cancel|forfeit) */
export async function actOnChallenge(id: number, me: AppUser, action: Action, now = new Date()): Promise<ChallengeView> {
  // Bring it up to date first (a past-deadline challenge resolves; an unanswered one expires).
  const synced = await syncChallenge(id, now);
  if (!synced) throw notFound();

  const followUp = await db.transaction(async tx => {
    const c = await loadChallenge(tx, id, true);
    if (!c) throw notFound();
    const participants = await loadParticipants(tx, id);
    const mine = participants.find(p => p.userId === me.id);
    if (!mine) throw notFound();
    const asRef = { id: me.id, username: me.username, displayName: me.displayName };

    switch (action) {
      case 'accept': {
        if (!canAccept(c, mine)) throw stateError(c, 'accept');
        // "Starts when accepted" is stamped with the DATABASE clock, the same clock that stamps
        // scores.created_at — so an upload a moment after accepting can't fall before the start
        // because the app server's clock runs a little ahead of Neon's.
        const [{ dbNowMs }] = await tx.select({ dbNowMs: sql<number>`(extract(epoch from now()) * 1000)::float8` }).from(sql`(select 1) as one`);
        const startsAt = c.startsAt ?? new Date(Number(dbNowMs));
        const accepted = participants.map(p => (p.userId === me.id ? { ...p, response: 'accepted' as const } : p));
        const everyoneIn = accepted.every(p => p.response === 'accepted');
        // most_improved: freeze each participant's baseline now. No prior score → can't take part.
        const baselines = new Map<number, number | null>();
        if (c.type === 'most_improved') {
          const cands = await loadCandidates(tx, matchRuleOf(c), accepted.map(p => p.userId), audienceOf(accepted));
          for (const p of accepted) baselines.set(p.userId, baselineFrom(matchRuleOf(c), startsAt, cands.filter(s => s.userId === p.userId)));
          if (baselines.get(me.id) == null) {
            throw new ChallengeError(409, 'no_baseline', 'Most improved needs a score of yours on this machine from before the challenge');
          }
          if (everyoneIn && [...baselines.values()].some(b => b == null)) {
            throw new ChallengeError(409, 'creator_no_baseline', 'The challenger no longer has a score on this machine to measure improvement from');
          }
        }
        await tx.update(challengeParticipants).set({ response: 'accepted', respondedAt: now })
          .where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, me.id)));
        if (everyoneIn) {
          for (const [userId, baseline] of baselines) {
            await tx.update(challengeParticipants).set({ baselineScore: baseline })
              .where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, userId)));
          }
          await tx.update(challenges).set({ status: 'active', startsAt }).where(eq(challenges.id, id));
        }
        await settleNotifications(tx, me.id, 'challenge_received', id, 'read', 'challengeId');
        await raiseNotification(tx, c.creatorId, 'challenge_accepted', userPayload(c, asRef));
        return false;
      }
      case 'decline': {
        if (!canDecline(c, mine)) throw stateError(c, 'decline');
        await tx.update(challengeParticipants).set({ response: 'declined', respondedAt: now })
          .where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, me.id)));
        await tx.update(challenges).set({ status: 'declined' }).where(eq(challenges.id, id));
        await settleNotifications(tx, me.id, 'challenge_received', id, 'read', 'challengeId');
        await raiseNotification(tx, c.creatorId, 'challenge_declined', userPayload(c, asRef));
        return false;
      }
      case 'cancel': {
        if (!canCancel(c, me.id)) throw stateError(c, 'cancel');
        await tx.update(challenges).set({ status: 'cancelled' }).where(eq(challenges.id, id));
        for (const p of participants) {
          if (p.userId === me.id || p.response === 'declined') continue;
          // The invitation no longer exists: remove it from their unread, and say it was withdrawn.
          await settleNotifications(tx, p.userId, 'challenge_received', id, 'delete', 'challengeId');
          await raiseNotification(tx, p.userId, 'challenge_cancelled', userPayload(c, asRef));
        }
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
  return (await viewOf(id, me.id, now, true))!;
}

function stateError(c: ChallengeRow, action: Action): ChallengeError {
  const why: Record<string, string> = {
    active: 'it’s already under way', resolved: 'it’s over', declined: 'it was declined',
    cancelled: 'it was cancelled', expired: 'it expired',
  };
  const reason = why[c.status];
  return new ChallengeError(409, `cannot_${action}`, `You can’t ${action} this challenge${reason ? ` — ${reason}` : ''}.`);
}
