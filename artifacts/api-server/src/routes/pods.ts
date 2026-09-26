import { Router } from 'express';
import { db, pods, podMembers, users } from '@workspace/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { normalizePodColor, normalizePodName, nextPodColor, POD_NAME_MAX } from '../lib/podColor.js';
import { isUniqueViolation } from '../lib/venueAddress.js';
import { createRateLimiter } from '../lib/rateLimit.js';

// Pods — private groupings of other users (feature/pods, step 2).
//
// PRIVACY RULE: a pod is visible to its owner and nobody else — not its name, not its color, not
// its members, not even that it exists. Members are never told. So:
//  - every route is signed-in only and scoped to `owner_id = <caller>`;
//  - a pod id the caller doesn't own answers **404, never 403** (a 403 would confirm the id exists);
//  - no route answers "which pods is user X in" for anyone but X's own pods as owner.
// Adding a `visibility` column later must not loosen any of this by default.

// Mounted behind requireAppUser in index.ts (`app.use('/api/pods', requireAppUser, podsRouter)`),
// so every handler can rely on req.appUser. Kept out of this file so test-pods.ts can mount the
// same router behind a stub.
const router = Router();

type MemberView = { id: number; username: string; displayName: string; addedAt: Date };
type PodView = {
  id: number; name: string; color: string; createdAt: Date; updatedAt: Date;
  memberCount: number; members: MemberView[];
};

// The caller's pods (all, or just `onlyId`), each with its members' public basics. Members are only
// username/displayName — the same fields any public profile already shows.
async function loadOwnedPods(ownerId: number, onlyId?: number): Promise<PodView[]> {
  const rows = await db
    .select({ id: pods.id, name: pods.name, color: pods.color, createdAt: pods.createdAt, updatedAt: pods.updatedAt })
    .from(pods)
    .where(onlyId === undefined ? eq(pods.ownerId, ownerId) : and(eq(pods.ownerId, ownerId), eq(pods.id, onlyId)))
    .orderBy(asc(sql`lower(${pods.name})`), asc(pods.id));
  if (rows.length === 0) return [];

  const members = await db
    .select({ podId: podMembers.podId, id: users.id, username: users.username, displayName: users.displayName, addedAt: podMembers.addedAt })
    .from(podMembers)
    .innerJoin(users, eq(podMembers.userId, users.id))
    .where(inArray(podMembers.podId, rows.map(r => r.id)))
    .orderBy(asc(sql`lower(${users.displayName})`), asc(users.id));

  const byPod = new Map<number, MemberView[]>();
  for (const { podId, ...m } of members) {
    const list = byPod.get(podId) ?? [];
    list.push(m);
    byPod.set(podId, list);
  }
  return rows.map(r => {
    const list = byPod.get(r.id) ?? [];
    return { ...r, memberCount: list.length, members: list };
  });
}

// Loads one pod the caller owns, or answers 404 and returns null. Non-numeric ids are 404 too, so
// the response never distinguishes "malformed" from "someone else's" from "doesn't exist".
async function loadOwnedPod(req: any, res: any): Promise<PodView | null> {
  const id = Number(req.params.id);
  const pod = Number.isInteger(id) && id > 0 ? (await loadOwnedPods(req.appUser.id, id))[0] : undefined;
  if (!pod) {
    res.status(404).json({ error: 'Pod not found', code: 'pod_not_found' });
    return null;
  }
  return pod;
}

const nameError = { error: `Pod name is required (up to ${POD_NAME_MAX} characters)`, code: 'invalid_name' };
const colorError = { error: 'Color must be a hex color like #fe7b32', code: 'invalid_color' };
const nameTaken = { error: 'You already have a pod with that name', code: 'name_taken' };

// GET /api/pods — the caller's pods with member counts and members.
router.get('/', async (req, res) => {
  try {
    res.json(await loadOwnedPods((req as any).appUser.id));
  } catch (err) {
    console.error('List pods error:', err);
    res.status(500).json({ error: 'Failed to load your pods' });
  }
});

// GET /api/pods/user-search?q= — member picker. Matches username or display name (prefix matches
// first), excludes the caller, at most 10 results. Only public profile fields. Rate-limited per user
// so it can't be used to page through the whole user table quickly.
const userSearchLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

router.get('/user-search', async (req, res) => {
  const appUser = (req as any).appUser;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 1 || q.length > 50) return res.json([]);

  const { allowed, retryAfterMs } = userSearchLimiter.hit(appUser.id);
  if (!allowed) {
    res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many searches — try again in a minute', code: 'rate_limited' });
  }

  const escaped = q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`);
  const prefix = `${escaped}%`;
  const contains = `%${escaped}%`;
  try {
    const rows = await db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(and(
        ne(users.id, appUser.id),
        sql`(lower(${users.username}) LIKE ${contains} OR lower(${users.displayName}) LIKE ${contains})`,
      ))
      .orderBy(
        sql`CASE WHEN lower(${users.username}) LIKE ${prefix} OR lower(${users.displayName}) LIKE ${prefix} THEN 0 ELSE 1 END`,
        asc(sql`lower(${users.displayName})`),
      )
      .limit(10);
    res.json(rows);
  } catch (err) {
    console.error('Pod user search error:', err);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// POST /api/pods — body { name, color? }. Color defaults to the next unused palette color.
router.post('/', async (req, res) => {
  const appUser = (req as any).appUser;
  const name = normalizePodName(req.body?.name);
  if (!name) return res.status(400).json(nameError);

  let color: string | null;
  if (req.body?.color === undefined || req.body?.color === null || req.body?.color === '') {
    const used = await db.select({ color: pods.color }).from(pods).where(eq(pods.ownerId, appUser.id));
    color = nextPodColor(used.map(u => u.color));
  } else {
    color = normalizePodColor(req.body.color);
    if (!color) return res.status(400).json(colorError);
  }

  try {
    const [created] = await db.insert(pods).values({ ownerId: appUser.id, name, color }).returning({ id: pods.id });
    const [pod] = await loadOwnedPods(appUser.id, created.id);
    res.status(201).json(pod);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json(nameTaken);
    console.error('Create pod error:', err);
    res.status(500).json({ error: 'Failed to create pod' });
  }
});

// PATCH /api/pods/:id — body { name?, color? }.
router.patch('/:id', async (req, res) => {
  const appUser = (req as any).appUser;
  const pod = await loadOwnedPod(req, res);
  if (!pod) return;

  const patch: { name?: string; color?: string; updatedAt: Date } = { updatedAt: new Date() };
  if (req.body?.name !== undefined) {
    const name = normalizePodName(req.body.name);
    if (!name) return res.status(400).json(nameError);
    patch.name = name;
  }
  if (req.body?.color !== undefined) {
    const color = normalizePodColor(req.body.color);
    if (!color) return res.status(400).json(colorError);
    patch.color = color;
  }
  if (patch.name === undefined && patch.color === undefined) {
    return res.status(400).json({ error: 'Nothing to update — send name and/or color' });
  }

  try {
    await db.update(pods).set(patch).where(and(eq(pods.id, pod.id), eq(pods.ownerId, appUser.id)));
    const [updated] = await loadOwnedPods(appUser.id, pod.id);
    res.json(updated);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json(nameTaken);
    console.error('Update pod error:', err);
    res.status(500).json({ error: 'Failed to update pod' });
  }
});

// DELETE /api/pods/:id — members go with it (ON DELETE CASCADE).
router.delete('/:id', async (req, res) => {
  const appUser = (req as any).appUser;
  const pod = await loadOwnedPod(req, res);
  if (!pod) return;
  try {
    await db.delete(pods).where(and(eq(pods.id, pod.id), eq(pods.ownerId, appUser.id)));
    res.status(204).end();
  } catch (err) {
    console.error('Delete pod error:', err);
    res.status(500).json({ error: 'Failed to delete pod' });
  }
});

// POST /api/pods/:id/members — body { userId }. Idempotent: adding an existing member is 200.
router.post('/:id/members', async (req, res) => {
  const appUser = (req as any).appUser;
  const pod = await loadOwnedPod(req, res);
  if (!pod) return;

  const userId = Number(req.body?.userId);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'userId is required', code: 'invalid_user' });
  if (userId === appUser.id) {
    return res.status(400).json({ error: 'You can’t add yourself to your own pod', code: 'cannot_add_self' });
  }

  try {
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!target) return res.status(404).json({ error: 'User not found', code: 'user_not_found' });

    const inserted = await db.insert(podMembers).values({ podId: pod.id, userId })
      .onConflictDoNothing().returning({ userId: podMembers.userId });
    if (inserted.length) await db.update(pods).set({ updatedAt: new Date() }).where(eq(pods.id, pod.id));
    const [updated] = await loadOwnedPods(appUser.id, pod.id);
    res.status(inserted.length ? 201 : 200).json(updated);
  } catch (err) {
    console.error('Add pod member error:', err);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// DELETE /api/pods/:id/members/:userId
router.delete('/:id/members/:userId', async (req, res) => {
  const appUser = (req as any).appUser;
  const pod = await loadOwnedPod(req, res);
  if (!pod) return;

  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user id', code: 'invalid_user' });

  try {
    const removed = await db.delete(podMembers)
      .where(and(eq(podMembers.podId, pod.id), eq(podMembers.userId, userId)))
      .returning({ userId: podMembers.userId });
    if (!removed.length) return res.status(404).json({ error: 'That user isn’t in this pod', code: 'not_a_member' });
    await db.update(pods).set({ updatedAt: new Date() }).where(eq(pods.id, pod.id));
    const [updated] = await loadOwnedPods(appUser.id, pod.id);
    res.json(updated);
  } catch (err) {
    console.error('Remove pod member error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

export default router;
