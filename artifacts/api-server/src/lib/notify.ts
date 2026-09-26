import { db, notifications } from '@workspace/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

// The notifications inbox — writing side (feature/friends, phase 1). Reading is routes/notifications.ts.
//
// Kinds today: 'friend_request' (to the addressee, on send and on every re-send) and
// 'friend_accepted' (to the requester). Challenge kinds come later and reuse raiseNotification():
// `payload` is kind-specific jsonb, and `dedupe` lets a kind say "there should only ever be one
// unread one of me about X" — a re-sent friend request replaces the existing unread notification,
// back at the top, instead of stacking a second one.

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NotificationKind = 'friend_request' | 'friend_accepted';

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
 * Settle `userId`'s unread notifications of `kind` about `aboutUserId` (payload.userId).
 * 'read' when they've acted on it (accepted/declined — it's handled, not wrong), 'delete' when it
 * no longer happened (the requester cancelled — the bell shouldn't point at a request that's gone).
 */
export async function settleNotifications(
  ex: Executor,
  userId: number,
  kind: NotificationKind,
  aboutUserId: number,
  mode: 'read' | 'delete',
): Promise<void> {
  const where = and(
    eq(notifications.userId, userId),
    eq(notifications.kind, kind),
    isNull(notifications.readAt),
    sql`${notifications.payload} ->> 'userId' = ${String(aboutUserId)}`,
  );
  if (mode === 'delete') await ex.delete(notifications).where(where);
  else await ex.update(notifications).set({ readAt: new Date() }).where(where);
}
