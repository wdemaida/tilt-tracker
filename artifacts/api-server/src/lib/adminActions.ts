import {
  db, users, scores, machines, challenges, challengeParticipants, challengeScores, friendships, notifications,
} from '@workspace/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { logActivity, type ActivityInput } from './activity.js';
import { setClerkBan } from './clerkAdmin.js';
import { deletePhotoBestEffort, getPhotoStore, type PhotoStore } from './photoStore.js';
import { raiseNotification, settleNotifications } from './notify.js';

// Admin actions (routes/adminArea.ts is the HTTP side). Every action:
//   - is only reachable behind requireAppUser + requireAdmin (the admin router's guard);
//   - writes an `admin.*` activity event with the admin as actor;
//   - returns { status, body } rather than throwing for expected refusals.
//
// SEMANTICS worth knowing (also in artifacts/api-server/CLAUDE.md, "Admin area"):
//   - Disable: users.disabled_at set first (app-level lockout is immediate: requireAppUser → 403
//     account_disabled), then the Clerk user is banned (revokes sessions, blocks sign-in). A Clerk
//     failure is reported (clerkBanned: false) but the app-level disable stands; re-running retries.
//     Admins can't disable themselves or another admin.
//   - Delete score: REFUSED (409 score_locked_by_challenge, with the challenge ids) while any
//     challenge has it locked. Void those challenges first — that releases the lock — then delete.
//     Deleting a counted score out from under a live or resolved challenge would silently change a
//     result and the records built on it, so the refusal is the safe default.
//   - Delete full-size photo: allowed even on a locked score (it's display-only, never part of the
//     challenge "has a photo" rule). Clears photo_key/bytes/width/height, then deletes the R2 object.
//   - Delete thumbnail: clears photo_thumbnail (+ photo_url). Refused on a locked score, because the
//     thumbnail IS what made it count toward the challenge.
//   - Void challenge: any non-closed challenge (pending, active or resolved) → status 'cancelled',
//     admin_cancelled_* stamped, every participant's outcome/rank/result cleared, its score locks
//     released. Records only count 'resolved', so a voided challenge simply drops out of W/L/T and
//     streaks — nothing is miscounted. Participants get a `challenge_voided` notification. The prior
//     status and outcomes are kept in the event payload.

type Admin = { id: number; role: string };
export type ActionResult = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown> = { ok: true }): ActionResult => ({ status: 200, body });
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): ActionResult =>
  ({ status, body: { error, code, ...extra } });

function adminEvent(admin: Admin, meta: Pick<ActivityInput, 'ip' | 'userAgent'>, ev: Omit<ActivityInput, 'actorUserId'>): ActivityInput {
  return { ...ev, actorUserId: admin.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null };
}

type Meta = Pick<ActivityInput, 'ip' | 'userAgent'>;
const cleanReason = (r: unknown) => (typeof r === 'string' ? r.trim().slice(0, 500) : '') || null;

// ── users ────────────────────────────────────────────────────────────────────

export async function disableUser(admin: Admin, userId: number, reasonRaw: unknown, meta: Meta = {}): Promise<ActionResult> {
  if (userId === admin.id) return fail(400, 'cannot_disable_self', 'You can’t disable your own account');
  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return fail(404, 'user_not_found', 'User not found');
  if (target.role === 'admin') return fail(403, 'cannot_disable_admin', 'Admins can’t be disabled — remove the admin role first');
  const reason = cleanReason(reasonRaw);

  const wasDisabled = !!target.disabledAt;
  if (!wasDisabled) {
    await db.update(users).set({ disabledAt: new Date(), disabledReason: reason, disabledById: admin.id }).where(eq(users.id, userId));
  } else if (reason && reason !== target.disabledReason) {
    await db.update(users).set({ disabledReason: reason }).where(eq(users.id, userId));
  }
  const clerk = await setClerkBan(target.clerkId, true);
  await logActivity(adminEvent(admin, meta, {
    type: 'admin.user_disabled', subjectUserId: userId, targetType: 'user', targetId: userId,
    payload: { reason, username: target.username, alreadyDisabled: wasDisabled, clerkBanned: clerk.ok, ...(clerk.ok ? {} : { clerkError: clerk.error }) },
  }));
  return ok({ ok: true, disabled: true, clerkBanned: clerk.ok, ...(clerk.ok ? {} : { clerkError: clerk.error }) });
}

export async function enableUser(admin: Admin, userId: number, meta: Meta = {}): Promise<ActionResult> {
  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return fail(404, 'user_not_found', 'User not found');
  await db.update(users).set({ disabledAt: null, disabledReason: null, disabledById: null }).where(eq(users.id, userId));
  const clerk = await setClerkBan(target.clerkId, false);
  await logActivity(adminEvent(admin, meta, {
    type: 'admin.user_enabled', subjectUserId: userId, targetType: 'user', targetId: userId,
    payload: { username: target.username, wasDisabled: !!target.disabledAt, clerkUnbanned: clerk.ok, ...(clerk.ok ? {} : { clerkError: clerk.error }) },
  }));
  return ok({ ok: true, disabled: false, clerkUnbanned: clerk.ok, ...(clerk.ok ? {} : { clerkError: clerk.error }) });
}

// ── scores & photos ──────────────────────────────────────────────────────────

async function lockingChallenges(scoreId: number): Promise<number[]> {
  const rows = await db.select({ id: challengeScores.challengeId }).from(challengeScores).where(eq(challengeScores.scoreId, scoreId));
  return rows.map(r => r.id);
}

function lockedResult(challengeIds: number[]): ActionResult {
  return fail(409, 'score_locked_by_challenge',
    `This score counts toward challenge${challengeIds.length === 1 ? '' : 's'} ${challengeIds.map(i => `#${i}`).join(', ')}. Void ${challengeIds.length === 1 ? 'it' : 'them'} first, then delete the score.`,
    { challengeIds });
}

async function scoreFacts(scoreId: number) {
  const [row] = await db
    .select({
      id: scores.id, userId: scores.userId, score: scores.score, machineName: machines.name, venueId: scores.venueId,
      playedAt: scores.playedAt, photoKey: scores.photoKey, hasThumb: sql<boolean>`(${scores.photoThumbnail} IS NOT NULL OR ${scores.photoUrl} IS NOT NULL)`,
    })
    .from(scores).innerJoin(machines, eq(machines.id, scores.machineId))
    .where(eq(scores.id, scoreId)).limit(1);
  return row;
}

export async function deleteScoreAsAdmin(admin: Admin, scoreId: number, meta: Meta = {}, store: PhotoStore | null = getPhotoStore()): Promise<ActionResult> {
  const facts = await scoreFacts(scoreId);
  if (!facts) return fail(404, 'score_not_found', 'Score not found');
  const locks = await lockingChallenges(scoreId);
  if (locks.length) return lockedResult(locks);

  let gone: { photoKey: string | null } | undefined;
  try {
    [gone] = await db.delete(scores).where(eq(scores.id, scoreId)).returning({ photoKey: scores.photoKey });
  } catch (err: any) {
    // A challenge locked it between the check and the delete — the FK refuses.
    if (err?.code === '23503') return lockedResult(await lockingChallenges(scoreId));
    throw err;
  }
  if (!gone) return fail(404, 'score_not_found', 'Score not found');
  // Row first, object after — same rule as DELETE /api/scores/:id (an orphan, never a dangling row).
  await deletePhotoBestEffort(gone.photoKey, `admin delete score ${scoreId}`, store);
  await logActivity(adminEvent(admin, meta, {
    type: 'admin.score_deleted', subjectUserId: facts.userId, targetType: 'score', targetId: scoreId,
    payload: { score: facts.score, machineName: facts.machineName, venueId: facts.venueId, playedAt: facts.playedAt, hadFullPhoto: !!gone.photoKey },
  }));
  return ok({ ok: true, deleted: true });
}

export async function deleteFullPhotoAsAdmin(admin: Admin, scoreId: number, meta: Meta = {}, store: PhotoStore | null = getPhotoStore()): Promise<ActionResult> {
  const outcome = await db.transaction(async tx => {
    const [row] = await tx.select({ userId: scores.userId, photoKey: scores.photoKey }).from(scores).where(eq(scores.id, scoreId)).for('update');
    if (!row) return null;
    if (!row.photoKey) return { ...row, cleared: false };
    await tx.update(scores).set({ photoKey: null, photoBytes: null, photoWidth: null, photoHeight: null }).where(eq(scores.id, scoreId));
    return { ...row, cleared: true };
  });
  if (!outcome) return fail(404, 'score_not_found', 'Score not found');
  if (!outcome.cleared) return fail(404, 'no_full_photo', 'This score has no full-size photo');
  await deletePhotoBestEffort(outcome.photoKey, `admin delete photo of score ${scoreId}`, store);
  await logActivity(adminEvent(admin, meta, {
    type: 'admin.photo_deleted', subjectUserId: outcome.userId, targetType: 'score', targetId: scoreId, payload: {},
  }));
  return ok({ ok: true, hasFullPhoto: false });
}

export async function deleteThumbnailAsAdmin(admin: Admin, scoreId: number, meta: Meta = {}): Promise<ActionResult> {
  const facts = await scoreFacts(scoreId);
  if (!facts) return fail(404, 'score_not_found', 'Score not found');
  if (!facts.hasThumb) return fail(404, 'no_thumbnail', 'This score has no thumbnail');
  const locks = await lockingChallenges(scoreId);
  if (locks.length) {
    return fail(409, 'score_locked_by_challenge',
      `The thumbnail is what makes this score count toward challenge${locks.length === 1 ? '' : 's'} ${locks.map(i => `#${i}`).join(', ')}. Void ${locks.length === 1 ? 'it' : 'them'} first.`,
      { challengeIds: locks });
  }
  await db.update(scores).set({ photoThumbnail: null, photoUrl: null }).where(eq(scores.id, scoreId));
  await logActivity(adminEvent(admin, meta, {
    type: 'admin.thumbnail_deleted', subjectUserId: facts.userId, targetType: 'score', targetId: scoreId,
    payload: { machineName: facts.machineName },
  }));
  return ok({ ok: true });
}

// ── challenges ───────────────────────────────────────────────────────────────

const CLOSED: string[] = ['declined', 'cancelled', 'expired'];

export async function voidChallenge(admin: Admin, challengeId: number, reasonRaw: unknown, meta: Meta = {}): Promise<ActionResult> {
  const reason = cleanReason(reasonRaw);
  return db.transaction(async tx => {
    const [c] = await tx.select().from(challenges).where(eq(challenges.id, challengeId)).for('update');
    if (!c) return fail(404, 'challenge_not_found', 'Challenge not found');
    if (CLOSED.includes(c.status)) return fail(409, 'challenge_closed', `This challenge is already ${c.status}`);
    const [machine] = await tx.select({ name: machines.name }).from(machines).where(eq(machines.id, c.machineId));
    const parts = await tx
      .select({ userId: challengeParticipants.userId, response: challengeParticipants.response, outcome: challengeParticipants.outcome, rank: challengeParticipants.rank, resultValue: challengeParticipants.resultValue, username: users.username })
      .from(challengeParticipants).innerJoin(users, eq(users.id, challengeParticipants.userId))
      .where(eq(challengeParticipants.challengeId, challengeId));

    const released = await tx.delete(challengeScores).where(eq(challengeScores.challengeId, challengeId)).returning({ scoreId: challengeScores.scoreId });
    await tx.update(challengeParticipants).set({ outcome: null, rank: null, resultValue: null }).where(eq(challengeParticipants.challengeId, challengeId));
    await tx.update(challenges).set({
      status: 'cancelled', adminCancelledAt: new Date(), adminCancelledById: admin.id, adminCancelReason: reason,
    }).where(eq(challenges.id, challengeId));

    for (const p of parts) {
      if (p.response === 'declined') continue;
      await settleNotifications(tx, p.userId, 'challenge_received', challengeId, 'delete', 'challengeId');
      await raiseNotification(tx, p.userId, 'challenge_voided', {
        challengeId, challengeType: c.type, machineName: machine?.name ?? null, byAdmin: true,
      });
    }
    await logActivity(adminEvent(admin, meta, {
      type: 'admin.challenge_voided', targetType: 'challenge', targetId: challengeId,
      payload: {
        reason, previousStatus: c.status, machineName: machine?.name ?? null, challengeType: c.type,
        participants: parts.map(p => ({ userId: p.userId, username: p.username, response: p.response, outcome: p.outcome, rank: p.rank, resultValue: p.resultValue })),
        releasedScoreIds: released.map(r => r.scoreId),
      },
    }), { tx });
    return ok({ ok: true, status: 'cancelled', releasedScoreIds: released.map(r => r.scoreId) });
  });
}

// ── social ───────────────────────────────────────────────────────────────────

export async function removeFriendship(admin: Admin, friendshipId: number, meta: Meta = {}): Promise<ActionResult> {
  const [row] = await db.delete(friendships).where(eq(friendships.id, friendshipId)).returning();
  if (!row) return fail(404, 'friendship_not_found', 'Friendship not found');
  // A pending request's unread notification points at a request that's gone now.
  if (row.status === 'pending') await settleNotifications(db, row.addresseeId, 'friend_request', row.requesterId, 'delete');
  await logActivity(adminEvent(admin, meta, {
    type: 'admin.friendship_removed', subjectUserId: row.requesterId, targetType: 'friendship', targetId: friendshipId,
    payload: { requesterId: row.requesterId, addresseeId: row.addresseeId, status: row.status, declineCount: row.declineCount },
  }));
  return ok({ ok: true });
}

export async function deleteNotification(admin: Admin, notificationId: number, meta: Meta = {}): Promise<ActionResult> {
  const [row] = await db.delete(notifications).where(eq(notifications.id, notificationId)).returning({ userId: notifications.userId, kind: notifications.kind });
  if (!row) return fail(404, 'notification_not_found', 'Notification not found');
  await logActivity(adminEvent(admin, meta, {
    type: 'admin.notification_deleted', subjectUserId: row.userId, targetType: 'notification', targetId: notificationId, payload: { kind: row.kind },
  }));
  return ok({ ok: true });
}

export async function clearUserNotifications(admin: Admin, userId: number, meta: Meta = {}): Promise<ActionResult> {
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return fail(404, 'user_not_found', 'User not found');
  const deleted = await db.delete(notifications).where(eq(notifications.userId, userId)).returning({ id: notifications.id });
  await logActivity(adminEvent(admin, meta, {
    type: 'admin.notifications_cleared', subjectUserId: userId, targetType: 'user', targetId: userId, payload: { deleted: deleted.length },
  }));
  return ok({ ok: true, deleted: deleted.length });
}

/** For the user detail page: the challenges a score set is locked by (id → challenge ids). */
export async function locksFor(scoreIds: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!scoreIds.length) return out;
  const rows = await db.select({ scoreId: challengeScores.scoreId, challengeId: challengeScores.challengeId })
    .from(challengeScores).where(inArray(challengeScores.scoreId, scoreIds));
  for (const r of rows) out.set(r.scoreId, [...(out.get(r.scoreId) ?? []), r.challengeId]);
  return out;
}

