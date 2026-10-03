import { db, notifications, activityEvents } from '@workspace/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { buildActivityRow, isActivityRecorded, logActivity } from './activity.js';

// The notifications inbox — writing side (feature/friends, phase 1). Reading is routes/notifications.ts.
//
// Kinds: 'friend_request' (to the addressee, on send and on every re-send) and 'friend_accepted'
// (to the requester), plus the challenge kinds (feature/challenges, phase 2 — raised from
// lib/challenges.ts and routes/challenges.ts; every payload carries `challengeId`, `challengeType`,
// `machineName` and the other person's userId/username/displayName):
//   challenge_received          → each invitee, on create (`players`: how many, the challenger included)
//   challenge_accepted/declined → the creator (declined carries `reason`: 'cant_reach' / 'no_thanks' /
//                                 'backed_out' (an accepted player pulled out before the start; `backedOut`
//                                 is true too) / null, and `remaining` — invitees still pending or accepted)
//   challenge_countered         → the challenger, when an invitee suggests another machine: a PROPOSAL
//                                 (feature/group-challenges; `proposal: true`). challengeId = the
//                                 proposal, counteredFromId = the original, machineName = the suggested
//                                 machine, originalMachineName. The daily sweep re-raises it once
//                                 (`reminder: true`) after 24 h unanswered. For a LEGACY counter row
//                                 (no `proposal`) it was that challenge's invitation.
//   challenge_counter_accepted  → the proposer, when the challenger takes the suggestion (challengeId
//                                 = the proposal, now the challenge; `reinvited` count)
//   challenge_counter_rejected  → the proposer, when it closes untaken: `reason` 'rejected' (she kept
//                                 hers), 'superseded' (another was taken), 'started', 'cancelled', 'expired'
//   challenge_moved             → each re-invited player of the original, when a suggestion is taken:
//                                 challengeId = the new challenge, fromChallengeId, originalMachineName,
//                                 `proposedBy` — an invitation (settled on answer, like challenge_received)
//   challenge_started           → groups only: accepted players other than the actor, when it starts
//                                 (`players`, `startsAt`, `byChallenger` for "Start with who's in")
//   challenge_missed            → an invitee who never answered, when it started without them
//   challenge_cancelled         → the invitees (the creator withdrew before the start)
//   challenge_opponent_scored   → the other participant(s), when a counting score is posted: ONE per
//                                 (recipient, score) however many of their challenges it counts in
//                                 (`challengeIds`, `challengeCount`, `challenges` [{challengeId,
//                                 challengeType, machineName, players}], `score`, `scoreId`,
//                                 `scoreMachineName`; top-level challengeId etc. = the first one, for
//                                 older clients). Still one unread per challenge: a newer score trims
//                                 its challenges out of older unread notices (raiseOpponentScored in
//                                 lib/challenges.ts)
//   challenge_ending_soon       → each participant once, ~24h before the end (daily sweep)
//   challenge_result            → every participant on resolution (`outcome`, `rank`, `playerCount`,
//                                 `winners` [{userId, username, displayName}], `postedCount` (players with a
//                                 counting score), `posted` (the recipient has one), `void` — retired, always
//                                 false —, `abandoned`, `reason`)
//   challenge_voided            → every participant, when an admin voids the challenge (`byAdmin: true`, no user ref)
//   badge_earned                → the earner (lib/badges.ts): `badgeId`, `badgeName`, `icon`, `color`,
//                                 `imageVersion` (null = no image), `granted: true` for a manual grant
//   announcement                → each recipient of an admin announcement (lib/announcements.ts):
//                                 `announcementId` (uuid), `title`, `body` (plain text), `link` (a
//                                 validated in-app path, `{username}` already substituted, or null),
//                                 `from: 'TiltTrack'` — no sender identity
// Every raised notification is also written to the admin activity log as `notification.sent` — the
// durable record, since the challenge sweep deletes read notifications after 30 days.
// `payload` is kind-specific jsonb, and `dedupe` lets a kind say "there should only ever be one
// unread one of me about X" — a re-sent friend request replaces the existing unread notification,
// back at the top, instead of stacking a second one.

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NotificationKind =
  | 'friend_request' | 'friend_accepted'
  | 'challenge_received' | 'challenge_accepted' | 'challenge_declined' | 'challenge_cancelled'
  | 'challenge_opponent_scored' | 'challenge_ending_soon' | 'challenge_result' | 'challenge_voided'
  | 'challenge_countered' | 'challenge_counter_accepted' | 'challenge_counter_rejected' | 'challenge_moved'
  | 'challenge_started' | 'challenge_missed'
  | 'badge_earned'
  | 'announcement';

/** Who a friend notification is about, as it was at the time — enough to render and link it. */
export interface UserRefPayload { userId: number; username: string; displayName: string }

/**
 * Raise a notification for `userId`. With `dedupe`, an existing UNREAD notification of the same kind
 * whose payload has the same value at `dedupe.key` is replaced (deleted, then the new one inserted)
 * rather than stacked. Replacing rather than updating in place gives the refreshed one a new id, so
 * id order stays creation order and the inbox can page on id. A read one is left alone and a fresh
 * one is raised, so re-sending after the addressee has seen the first request still puts it back in
 * front of them.
 */
export async function raiseNotification(
  ex: Executor,
  userId: number,
  kind: NotificationKind,
  payload: Record<string, unknown>,
  dedupe?: { key: string; value: string | number },
): Promise<void> {
  if (dedupe) {
    await ex.delete(notifications).where(and(
      eq(notifications.userId, userId),
      eq(notifications.kind, kind),
      isNull(notifications.readAt),
      sql`${notifications.payload} ->> ${dedupe.key} = ${String(dedupe.value)}`,
    ));
  }
  const [row] = await ex.insert(notifications).values({ userId, kind, payload }).returning({ id: notifications.id });
  // Inside the caller's transaction (a savepoint), so a rolled-back action takes its event with it.
  await logActivity({
    type: 'notification.sent', subjectUserId: userId, targetType: 'notification', targetId: row?.id ?? null,
    payload: { kind, ...payload },
  }, { tx: ex });
}

/**
 * Raise one notification of `kind` for each item, in bulk — the badge backfill path, where a
 * go-live can award hundreds of players at once and one raiseNotification() per player (a delete,
 * an insert and an event, each a round trip) made the admin's request take minutes. Same dedupe
 * semantics as raiseNotification, keyed on `dedupeKey` in each item's payload: an existing UNREAD
 * one with the same value is replaced, so each user ends up with exactly one unread per value.
 * Items are chunked (500 per statement); `notification.sent` events are written in bulk too, subject
 * to the same retention gate as logActivity (checked once). Throws on DB errors — the caller decides.
 * Returns the number of notifications inserted.
 */
export async function raiseNotificationsBulk(
  ex: Executor,
  kind: NotificationKind,
  items: Array<{ userId: number; payload: Record<string, unknown> }>,
  dedupeKey: string,
): Promise<number> {
  if (!items.length) return 0;
  // Last write wins within the batch too: one per (user, dedupe value).
  const unique = new Map<string, { userId: number; payload: Record<string, unknown> }>();
  for (const it of items) unique.set(`${it.userId}:${String(it.payload[dedupeKey])}`, it);
  const list = [...unique.values()];
  const recordEvents = await isActivityRecorded('notification.sent');
  let inserted = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    // Group the chunk's deletes by dedupe value (a backfill is one value for everyone).
    const byValue = new Map<string, number[]>();
    for (const it of chunk) {
      const v = String(it.payload[dedupeKey]);
      byValue.set(v, [...(byValue.get(v) ?? []), it.userId]);
    }
    for (const [value, userIds] of byValue) {
      await ex.delete(notifications).where(and(
        inArray(notifications.userId, userIds),
        eq(notifications.kind, kind),
        isNull(notifications.readAt),
        sql`${notifications.payload} ->> ${dedupeKey} = ${value}`,
      ));
    }
    const rows = await ex.insert(notifications)
      .values(chunk.map(it => ({ userId: it.userId, kind, payload: it.payload })))
      .returning({ id: notifications.id, userId: notifications.userId });
    inserted += rows.length;
    if (recordEvents && rows.length) {
      const payloadByUser = new Map(chunk.map(it => [it.userId, it.payload]));
      try {
        await ex.insert(activityEvents).values(rows.map(r => buildActivityRow({
          type: 'notification.sent', subjectUserId: r.userId, targetType: 'notification', targetId: r.id,
          payload: { kind, ...(payloadByUser.get(r.userId) ?? {}) },
        })));
      } catch (err: any) {
        // Same contract as logActivity: a failed log never fails the action.
        console.error('[activity] failed to log notification.sent (bulk):', err?.message ?? err);
      }
    }
  }
  return inserted;
}

/**
 * Settle `userId`'s unread notifications of `kind` about `aboutUserId` (payload.userId — or, with
 * key 'challengeId', about that challenge: `aboutUserId` is then the challenge id).
 * 'read' when they've acted on it (accepted/declined — it's handled, not wrong), 'delete' when it
 * no longer happened (the requester cancelled — the bell shouldn't point at a request that's gone).
 */
export async function settleNotifications(
  ex: Executor,
  userId: number,
  kind: NotificationKind,
  aboutUserId: number,
  mode: 'read' | 'delete',
  key: 'userId' | 'challengeId' = 'userId',
): Promise<void> {
  const where = and(
    eq(notifications.userId, userId),
    eq(notifications.kind, kind),
    isNull(notifications.readAt),
    sql`${notifications.payload} ->> ${key} = ${String(aboutUserId)}`,
  );
  if (mode === 'delete') await ex.delete(notifications).where(where);
  else await ex.update(notifications).set({ readAt: new Date() }).where(where);
}
