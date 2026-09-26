import { db, notifications } from '@workspace/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

// The notifications inbox — writing side (feature/friends, phase 1). Reading is routes/notifications.ts.
//
// Kinds: 'friend_request' (to the addressee, on send and on every re-send) and 'friend_accepted'
// (to the requester), plus the challenge kinds (feature/challenges, phase 2 — raised from
// lib/challenges.ts and routes/challenges.ts; every payload carries `challengeId`, `challengeType`,
// `machineName` and the other person's userId/username/displayName):
//   challenge_received          → the invitee, on create
//   challenge_accepted/declined → the creator
//   challenge_cancelled         → the invitee (the creator withdrew before acceptance)
//   challenge_opponent_scored   → the other participant(s), when a counting score is posted
//                                 (deduped per challenge: one unread at a time, carrying `score`)
//   challenge_ending_soon       → each participant once, ~24h before the end (daily sweep)
//   challenge_result            → every participant on resolution (`outcome`, `void` — retired, always false —, `abandoned`, `reason`)
// `payload` is kind-specific jsonb, and `dedupe` lets a kind say "there should only ever be one
// unread one of me about X" — a re-sent friend request replaces the existing unread notification,
// back at the top, instead of stacking a second one.

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NotificationKind =
  | 'friend_request' | 'friend_accepted'
  | 'challenge_received' | 'challenge_accepted' | 'challenge_declined' | 'challenge_cancelled'
  | 'challenge_opponent_scored' | 'challenge_ending_soon' | 'challenge_result';

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
  await ex.insert(notifications).values({ userId, kind, payload });
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
