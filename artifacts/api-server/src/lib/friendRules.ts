// Friends — the request/response rules as pure functions (feature/friends, phase 1). No database
// here: routes/friends.ts loads the pair's one row (there is at most one per unordered pair), asks
// these what to do, and applies it. Kept pure so the rules are unit-tested (friendRules.test.ts).
//
// The rules (Will, 2026-09-25):
//  - Mutual: one person asks, the other accepts or declines.
//  - A pair allows MAX_DECLINES (3) declines in total, counting the first request. Once the row's
//    decline_count reaches it, the person who was declined can never ask that person again. The
//    server refuses; the UI just shows the person as unavailable.
//  - Asking again while a request is still unanswered is unlimited. It refreshes the existing row
//    (created_at) and re-raises the notification — never a second row, never a second unread
//    notification.
//  - Asking again after a decline (under the cap) puts the same row back to pending.
//  - If B asks A while A→B is pending, that is B accepting.
//  - The DECLINER may always ask later (decision 2026-09-25): the row's roles flip — they become
//    the requester — and decline_count keeps its history. The count is the pair's, not a
//    direction's, so after a flip the cap still applies to whoever is declined next.
//  - Declines send no notification. To the person declined, a declined request simply stops being
//    listed as outgoing and "Add friend" comes back (or, at the cap, "unavailable") — nothing ever
//    says "declined".
//  - Unfriending (either side) deletes the row. The decline history goes with it; that's a fresh
//    start both people agreed to by having been friends.

export const MAX_DECLINES = 3;

export type FriendshipStatus = 'pending' | 'accepted' | 'declined';

/** The fields of a `friendships` row these rules need. */
export interface PairRow {
  requesterId: number;
  addresseeId: number;
  status: FriendshipStatus;
  declineCount: number;
}

/**
 * The relationship as `viewerId` sees it — the only form a friendship ever leaves the server in.
 *  - none        no relationship; the viewer may send a request
 *  - outgoing    the viewer asked; unanswered
 *  - incoming    the other person asked the viewer; unanswered
 *  - friends
 *  - unavailable the viewer was declined MAX_DECLINES times and can't ask again
 */
export type Relationship = 'none' | 'outgoing' | 'incoming' | 'friends' | 'unavailable';

export function relationshipFor(row: PairRow | null | undefined, viewerId: number): Relationship {
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  const viewerAsked = row.requesterId === viewerId;
  if (row.status === 'pending') return viewerAsked ? 'outgoing' : 'incoming';
  // declined — the decliner (addressee) may always ask; the declined (requester) only under the cap.
  if (viewerAsked && row.declineCount >= MAX_DECLINES) return 'unavailable';
  return 'none';
}

export type SendDecision =
  /** No row yet: insert a pending one. */
  | { action: 'insert' }
  /** Pending and the sender already asked: bump created_at, re-raise the notification. */
  | { action: 'refresh' }
  /** Pending the other way: the sender is answering yes. */
  | { action: 'accept' }
  /** Declined, and the sender may ask: back to pending. `flip` = the decliner is asking, so roles swap. */
  | { action: 'reopen'; flip: boolean }
  /** Nothing to do. */
  | { action: 'already_friends' }
  /** The sender hit the decline cap with this person. */
  | { action: 'unavailable' };

export function decideSend(row: PairRow | null | undefined, senderId: number): SendDecision {
  if (!row) return { action: 'insert' };
  if (row.status === 'accepted') return { action: 'already_friends' };
  const senderAsked = row.requesterId === senderId;
  if (row.status === 'pending') return senderAsked ? { action: 'refresh' } : { action: 'accept' };
  if (!senderAsked) return { action: 'reopen', flip: true };
  if (row.declineCount >= MAX_DECLINES) return { action: 'unavailable' };
  return { action: 'reopen', flip: false };
}

/** Accept / decline: only the addressee of a pending request. Anything else is "no such request". */
export function canRespond(row: PairRow | null | undefined, actorId: number): boolean {
  return !!row && row.status === 'pending' && row.addresseeId === actorId;
}

/** Cancel: only the requester of a pending request. */
export function canCancel(row: PairRow | null | undefined, actorId: number): boolean {
  return !!row && row.status === 'pending' && row.requesterId === actorId;
}

/** Unfriend: either side of an accepted friendship. */
export function canUnfriend(row: PairRow | null | undefined, actorId: number): boolean {
  return !!row && row.status === 'accepted' && (row.requesterId === actorId || row.addresseeId === actorId);
}

/** The row after the addressee declines: the count is the pair's running total. */
export function afterDecline(row: PairRow): PairRow {
  return { ...row, status: 'declined', declineCount: row.declineCount + 1 };
}

/** The row after a send, for decisions that write one (insert / refresh / accept / reopen). */
export function afterSend(row: PairRow | null | undefined, senderId: number, targetId: number, decision: SendDecision): PairRow | null {
  switch (decision.action) {
    case 'insert':
      return { requesterId: senderId, addresseeId: targetId, status: 'pending', declineCount: 0 };
    case 'refresh':
      return row ? { ...row } : null;
    case 'accept':
      return row ? { ...row, status: 'accepted' } : null;
    case 'reopen':
      return row ? { ...row, status: 'pending', requesterId: senderId, addresseeId: targetId } : null;
    default:
      return row ?? null;
  }
}
