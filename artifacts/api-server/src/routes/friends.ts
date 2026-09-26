import { Router } from 'express';
import { db, friendships, users } from '@workspace/db';
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  decideSend, relationshipFor, canRespond, canCancel, canUnfriend, afterDecline,
  type PairRow, type Relationship,
} from '../lib/friendRules.js';
import { pairSql } from '../lib/friendships.js';
import { raiseNotification, settleNotifications, type Executor, type UserRefPayload } from '../lib/notify.js';
import { isUniqueViolation } from '../lib/venueAddress.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { logActivity } from '../lib/activity.js';

// Friends (feature/friends, phase 1). The rules live in lib/friendRules.ts; this file loads the
// pair's single row (under a row lock), asks the rules what to do, writes it, and raises the
// notification that goes with it.
//
// PRIVACY: your friend list and your requests are yours. Every route is signed-in only and only ever
// answers about pairs the caller is half of. Nothing here tells anyone who someone else's friends
// are. A decline is never reported to the person declined: their request simply stops being
// outgoing (see relationshipFor).
//
// Mounted behind requireAppUser in index.ts (`app.use('/api/friends', requireAppUser, friendsRouter)`),
// so every handler can rely on req.appUser. Kept out of this file so test-friends.ts can mount the
// same router behind a stub.
const router = Router();

type AppUser = { id: number; username: string; displayName: string };
type UserRef = { id: number; username: string; displayName: string };

const userRefCols = { id: users.id, username: users.username, displayName: users.displayName };

function payloadFor(u: AppUser): UserRefPayload {
  return { userId: u.id, username: u.username, displayName: u.displayName };
}

async function lockPair(ex: Executor, a: number, b: number): Promise<(PairRow & { id: number }) | undefined> {
  const [row] = await ex
    .select({
      id: friendships.id, requesterId: friendships.requesterId, addresseeId: friendships.addresseeId,
      status: friendships.status, declineCount: friendships.declineCount,
    })
    .from(friendships)
    .where(pairSql(a, b))
    .for('update')
    .limit(1);
  return row;
}

// Parses :userId / body.userId. Returns null (after answering 400/404) for a bad id or yourself.
async function loadTarget(req: any, res: any, raw: unknown): Promise<UserRef | null> {
  const me: AppUser = req.appUser;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'userId is required', code: 'invalid_user' });
    return null;
  }
  if (id === me.id) {
    res.status(400).json({ error: 'That’s you', code: 'cannot_friend_self' });
    return null;
  }
  const [target] = await db.select(userRefCols).from(users).where(eq(users.id, id)).limit(1);
  if (!target) {
    res.status(404).json({ error: 'User not found', code: 'user_not_found' });
    return null;
  }
  return target;
}

// ── reads ────────────────────────────────────────────────────────────────────

// GET /api/friends — { friends, incoming, outgoing }, each entry with the other person's public
// basics. Declined rows are in none of the lists (see the privacy note above).
router.get('/', async (req, res) => {
  const me: AppUser = (req as any).appUser;
  try {
    const other = sql<number>`CASE WHEN ${friendships.requesterId} = ${me.id} THEN ${friendships.addresseeId} ELSE ${friendships.requesterId} END`;
    const rows = await db
      .select({
        requesterId: friendships.requesterId, status: friendships.status,
        createdAt: friendships.createdAt, respondedAt: friendships.respondedAt,
        user: userRefCols,
      })
      .from(friendships)
      .innerJoin(users, eq(users.id, other))
      .where(and(
        or(eq(friendships.requesterId, me.id), eq(friendships.addresseeId, me.id)),
        ne(friendships.status, 'declined'),
      ))
      .orderBy(asc(sql`lower(${users.displayName})`), asc(users.id));

    res.json({
      friends: rows.filter(r => r.status === 'accepted')
        .map(r => ({ user: r.user, since: r.respondedAt ?? r.createdAt })),
      // Newest request first — a re-send bumps created_at, so it moves back to the top.
      incoming: rows.filter(r => r.status === 'pending' && r.requesterId !== me.id)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .map(r => ({ user: r.user, requestedAt: r.createdAt })),
      outgoing: rows.filter(r => r.status === 'pending' && r.requesterId === me.id)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .map(r => ({ user: r.user, requestedAt: r.createdAt })),
    });
  } catch (err) {
    console.error('List friends error:', err);
    res.status(500).json({ error: 'Failed to load friends' });
  }
});

// GET /api/friends/search?q= — people to befriend, by username or display name (prefix matches
// first), excluding the caller, at most 10. Each result carries the caller's relationship with them.
// Same rate limit as the pod member search, so it can't page through the user table quickly.
const searchLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

router.get('/search', async (req, res) => {
  const me: AppUser = (req as any).appUser;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 1 || q.length > 50) return res.json([]);

  const { allowed, retryAfterMs } = searchLimiter.hit(me.id);
  if (!allowed) {
    res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many searches — try again in a minute', code: 'rate_limited' });
  }

  const escaped = q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`);
  const prefix = `${escaped}%`;
  const contains = `%${escaped}%`;
  try {
    const people = await db
      .select(userRefCols)
      .from(users)
      .where(and(
        ne(users.id, me.id),
        sql`(lower(${users.username}) LIKE ${contains} OR lower(${users.displayName}) LIKE ${contains})`,
      ))
      .orderBy(
        sql`CASE WHEN lower(${users.username}) LIKE ${prefix} OR lower(${users.displayName}) LIKE ${prefix} THEN 0 ELSE 1 END`,
        asc(sql`lower(${users.displayName})`),
      )
      .limit(10);
    const rels = await relationshipsWith(me.id, people.map(p => p.id));
    res.json(people.map(p => ({ ...p, relationship: rels.get(p.id) ?? 'none' })));
  } catch (err) {
    console.error('Friend search error:', err);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// The caller's relationship with each of `ids` (absent = 'none').
async function relationshipsWith(meId: number, ids: number[]): Promise<Map<number, Relationship>> {
  const out = new Map<number, Relationship>();
  if (!ids.length) return out;
  const rows = await db
    .select({
      requesterId: friendships.requesterId, addresseeId: friendships.addresseeId,
      status: friendships.status, declineCount: friendships.declineCount,
    })
    .from(friendships)
    .where(or(
      and(eq(friendships.requesterId, meId), inArray(friendships.addresseeId, ids)),
      and(eq(friendships.addresseeId, meId), inArray(friendships.requesterId, ids)),
    ));
  for (const r of rows) out.set(r.requesterId === meId ? r.addresseeId : r.requesterId, relationshipFor(r, meId));
  return out;
}

// GET /api/friends/with/:username — the caller's relationship with one person, for the profile
// page's button. 404 for an unknown username; `self` when it's the caller.
router.get('/with/:username', async (req, res) => {
  const me: AppUser = (req as any).appUser;
  try {
    const [user] = await db.select(userRefCols).from(users).where(eq(users.username, req.params.username)).limit(1);
    if (!user) return res.status(404).json({ error: 'User not found', code: 'user_not_found' });
    if (user.id === me.id) return res.json({ user, relationship: 'self' });
    const rels = await relationshipsWith(me.id, [user.id]);
    res.json({ user, relationship: rels.get(user.id) ?? 'none' });
  } catch (err) {
    console.error('Friend status error:', err);
    res.status(500).json({ error: 'Failed to load friend status' });
  }
});

// ── writes ───────────────────────────────────────────────────────────────────

type SendResult = 'sent' | 'resent' | 'accepted' | 'already_friends' | 'unavailable';

async function applySend(me: AppUser, target: UserRef): Promise<SendResult> {
  return db.transaction(async tx => {
    const row = await lockPair(tx, me.id, target.id);
    const decision = decideSend(row, me.id);
    const now = new Date();
    const request = () => raiseNotification(tx, target.id, 'friend_request', { ...payloadFor(me) }, { key: 'userId', value: me.id });

    switch (decision.action) {
      case 'insert':
        await tx.insert(friendships).values({ requesterId: me.id, addresseeId: target.id, status: 'pending' });
        await request();
        return 'sent';
      case 'refresh':
        await tx.update(friendships).set({ createdAt: now }).where(eq(friendships.id, row!.id));
        await request();
        return 'resent';
      case 'reopen':
        await tx.update(friendships)
          .set({ requesterId: me.id, addresseeId: target.id, status: 'pending', createdAt: now, respondedAt: null })
          .where(eq(friendships.id, row!.id));
        await request();
        return 'sent';
      case 'accept':
        // They asked us first — asking back is saying yes.
        await tx.update(friendships).set({ status: 'accepted', respondedAt: now }).where(eq(friendships.id, row!.id));
        await raiseNotification(tx, target.id, 'friend_accepted', { ...payloadFor(me) });
        await settleNotifications(tx, me.id, 'friend_request', target.id, 'read');
        return 'accepted';
      case 'already_friends':
        return 'already_friends';
      case 'unavailable':
        return 'unavailable';
    }
  });
}

// POST /api/friends/requests — body { userId }. Send (or re-send) a friend request.
//   201 { result: 'sent' }            new request, or asking again after a decline
//   200 { result: 'resent' }          still pending — refreshed and re-notified
//   200 { result: 'accepted' }        they had already asked you, so you're now friends
//   200 { result: 'already_friends' }
//   403 request_unavailable           the decline cap; deliberately says no more than that
router.post('/requests', async (req, res) => {
  const me: AppUser = (req as any).appUser;
  const target = await loadTarget(req, res, req.body?.userId);
  if (!target) return;
  try {
    let result: SendResult;
    try {
      result = await applySend(me, target);
    } catch (err) {
      // Two first requests for the same pair at once (either direction): the loser hits the pair's
      // unique index. Its row now exists, so running the rules again gives the right answer.
      if (!isUniqueViolation(err)) throw err;
      result = await applySend(me, target);
    }
    if (result !== 'already_friends' && result !== 'unavailable') {
      await logActivity({
        type: result === 'sent' ? 'friend.request_sent' : result === 'resent' ? 'friend.request_resent' : 'friend.request_accepted',
        actorUserId: me.id, subjectUserId: target.id, targetType: 'user', targetId: target.id,
        payload: { username: target.username, ...(result === 'accepted' ? { viaMutualRequest: true } : {}) },
      });
    }
    if (result === 'unavailable') {
      return res.status(403).json({ error: 'You can’t send this person a friend request.', code: 'request_unavailable' });
    }
    const relationship: Relationship = result === 'accepted' || result === 'already_friends' ? 'friends' : 'outgoing';
    res.status(result === 'sent' ? 201 : 200).json({ result, relationship });
  } catch (err) {
    console.error('Send friend request error:', err);
    res.status(500).json({ error: 'Failed to send friend request' });
  }
});

const noRequest = { error: 'No pending request from that user', code: 'request_not_found' };

// POST /api/friends/requests/:userId/accept — accept :userId's pending request to you.
router.post('/requests/:userId/accept', async (req, res) => {
  const me: AppUser = (req as any).appUser;
  const target = await loadTarget(req, res, req.params.userId);
  if (!target) return;
  try {
    const ok = await db.transaction(async tx => {
      const row = await lockPair(tx, me.id, target.id);
      if (!canRespond(row, me.id)) return false;
      await tx.update(friendships).set({ status: 'accepted', respondedAt: new Date() }).where(eq(friendships.id, row!.id));
      await raiseNotification(tx, target.id, 'friend_accepted', { ...payloadFor(me) });
      await settleNotifications(tx, me.id, 'friend_request', target.id, 'read');
      return true;
    });
    if (!ok) return res.status(404).json(noRequest);
    await logActivity({ type: 'friend.request_accepted', actorUserId: me.id, subjectUserId: target.id, targetType: 'user', targetId: target.id, payload: { username: target.username } });
    res.json({ relationship: 'friends' });
  } catch (err) {
    console.error('Accept friend request error:', err);
    res.status(500).json({ error: 'Failed to accept friend request' });
  }
});

// POST /api/friends/requests/:userId/decline — decline :userId's pending request. Counts toward the
// pair's decline cap. No notification to them.
router.post('/requests/:userId/decline', async (req, res) => {
  const me: AppUser = (req as any).appUser;
  const target = await loadTarget(req, res, req.params.userId);
  if (!target) return;
  try {
    const ok = await db.transaction(async tx => {
      const row = await lockPair(tx, me.id, target.id);
      if (!row || !canRespond(row, me.id)) return false;
      const next = afterDecline(row);
      await tx.update(friendships)
        .set({ status: next.status, declineCount: next.declineCount, respondedAt: new Date() })
        .where(eq(friendships.id, row.id));
      await settleNotifications(tx, me.id, 'friend_request', target.id, 'read');
      return true;
    });
    if (!ok) return res.status(404).json(noRequest);
    await logActivity({ type: 'friend.request_declined', actorUserId: me.id, subjectUserId: target.id, targetType: 'user', targetId: target.id, payload: { username: target.username } });
    res.json({ relationship: 'none' });
  } catch (err) {
    console.error('Decline friend request error:', err);
    res.status(500).json({ error: 'Failed to decline friend request' });
  }
});

// DELETE /api/friends/requests/:userId — withdraw your own pending request to :userId. Their
// unread request notification is removed, since the request no longer exists.
// A request with decline history reverts to 'declined' rather than being deleted, so cancelling
// can't be used to wipe the pair's decline count. (Known edge: if the person who did the declining
// asked, then cancelled, with the pair already at the cap, the reverted row names them as the one
// declined, and they can't ask again — the other person still can.)
router.delete('/requests/:userId', async (req, res) => {
  const me: AppUser = (req as any).appUser;
  const target = await loadTarget(req, res, req.params.userId);
  if (!target) return;
  try {
    const ok = await db.transaction(async tx => {
      const row = await lockPair(tx, me.id, target.id);
      if (!row || !canCancel(row, me.id)) return false;
      if (row.declineCount > 0) {
        await tx.update(friendships).set({ status: 'declined' }).where(eq(friendships.id, row.id));
      } else {
        await tx.delete(friendships).where(eq(friendships.id, row.id));
      }
      await settleNotifications(tx, target.id, 'friend_request', me.id, 'delete');
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'No pending request to that user', code: 'request_not_found' });
    await logActivity({ type: 'friend.request_cancelled', actorUserId: me.id, subjectUserId: target.id, targetType: 'user', targetId: target.id, payload: { username: target.username } });
    res.json({ relationship: 'none' });
  } catch (err) {
    console.error('Cancel friend request error:', err);
    res.status(500).json({ error: 'Failed to cancel friend request' });
  }
});

// DELETE /api/friends/:userId — unfriend (either side). Deletes the friendship. Pods are
// independent of friends and are not touched: someone stays in your pods after an unfriend.
router.delete('/:userId', async (req, res) => {
  const me: AppUser = (req as any).appUser;
  const target = await loadTarget(req, res, req.params.userId);
  if (!target) return;
  try {
    const ok = await db.transaction(async tx => {
      const row = await lockPair(tx, me.id, target.id);
      if (!row || !canUnfriend(row, me.id)) return false;
      await tx.delete(friendships).where(eq(friendships.id, row.id));
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'You aren’t friends with that user', code: 'not_friends' });
    await logActivity({ type: 'friend.removed', actorUserId: me.id, subjectUserId: target.id, targetType: 'user', targetId: target.id, payload: { username: target.username } });
    res.json({ relationship: 'none' });
  } catch (err) {
    console.error('Unfriend error:', err);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

export default router;
