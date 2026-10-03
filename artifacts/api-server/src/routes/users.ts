import { Router } from 'express';
import { db, users, scores, machines, venues } from '@workspace/db';
import { eq, desc, sql, and } from 'drizzle-orm';
import { getAuth } from '@clerk/express';
import { requireAuth, requireAppUser, callerClerkId } from '../middleware/requireAuth.js';
import { visibleScoreSql } from '../lib/venueActivity.js';
import { hasFullPhotoSql, hasThumbnailSql } from '../lib/photoStore.js';
import { logActivity, fromReq } from '../lib/activity.js';
import { challengeMeFor } from '../lib/challengeReach.js';
import { userBadgeShelf } from '../lib/badges.js';
import { resolveViewer } from './badges.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { normalizeDisplayName } from '../lib/profileFields.js';
import { kickAvatarResyncIfStale, resyncAvatar } from '../lib/profileAvatar.js';

const router = Router();

// What GET/PATCH /me return — never the Pinball Map credential.
const meColumns = {
  id: users.id, clerkId: users.clerkId, username: users.username, displayName: users.displayName, role: users.role,
  createdAt: users.createdAt, disabledAt: users.disabledAt, disabledReason: users.disabledReason,
  imageUrl: users.imageUrl, imageSyncedAt: users.imageSyncedAt,
};
const meView = ({ imageSyncedAt: _s, ...rest }: { imageSyncedAt: Date | null } & Record<string, unknown>) => rest;

// GET /api/users/me — current user's profile (or null if not set up); token fields excluded.
// Deliberately NOT behind requireAppUser: a disabled account still gets its row (with disabledAt),
// so the app can say "this account is disabled" instead of failing mysteriously.
// Also kicks a background resync of the profile photo from Clerk when it's never been synced or is
// over 24 h old (profileAvatar.ts) — this response carries the stored value, the next one the fresh one.
router.get('/me', requireAuth, async (req, res) => {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' });

  const [user] = await db
    .select(meColumns)
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (user && !user.disabledAt) kickAvatarResyncIfStale({ clerkId, imageSyncedAt: user.imageSyncedAt });
  res.json(user ? meView(user) : null);
});

// PATCH /api/users/me — edit your own profile. Only the display name: the username is locked once
// chosen (400 username_locked), and the photo goes to Clerk directly (then POST /me/avatar/sync).
// Same normalizer as setup and the admin edit (profileFields.ts). requireAppUser answers 401 without
// a session and 403 for a disabled account or no profile.
router.patch('/me', requireAppUser, async (req, res) => {
  const me = (req as any).appUser as { id: number; displayName: string };
  const body = (req.body ?? {}) as Record<string, unknown>;
  if ('username' in body) return void res.status(400).json({ error: 'Your username can’t be changed', code: 'username_locked' });
  if (!('displayName' in body)) return void res.status(400).json({ error: 'Nothing to update', code: 'nothing_to_update' });
  const name = normalizeDisplayName(body.displayName);
  if (!name.ok) return void res.status(400).json({ error: name.error, code: name.code, field: 'displayName' });

  try {
    const [updated] = await db.update(users).set({ displayName: name.value }).where(eq(users.id, me.id)).returning(meColumns);
    if (name.value !== me.displayName) {
      await logActivity({
        type: 'profile.updated', ...fromReq(req), actorUserId: me.id, targetType: 'user', targetId: me.id,
        payload: { fields: ['displayName'], before: { displayName: me.displayName }, after: { displayName: name.value } },
      });
    }
    res.json(meView(updated));
  } catch (err) {
    console.error('PATCH /users/me error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/users/me/avatar/sync — re-read your photo from Clerk now. The browser calls it right after
// uploading or removing a photo (Clerk's user.setProfileImage), so the change shows without waiting for
// the user.updated webhook. 10 per hour per user; each is one Clerk Backend API call.
const avatarSyncLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
router.post('/me/avatar/sync', requireAppUser, async (req, res) => {
  const me = (req as any).appUser as { id: number; clerkId: string };
  const gate = avatarSyncLimiter.hit(me.id);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
    return void res.status(429).json({ error: 'Too many photo refreshes — try again later', code: 'rate_limited' });
  }
  const r = await resyncAvatar(me.clerkId, { force: true });
  if (!r.ok) return void res.status(502).json({ error: 'Couldn’t reach the sign-in service — try again', code: 'clerk_unavailable' });
  try {
    const [row] = await db.select(meColumns).from(users).where(eq(users.id, me.id)).limit(1);
    if (r.changed) {
      await logActivity({
        type: 'profile.updated', ...fromReq(req), actorUserId: me.id, targetType: 'user', targetId: me.id,
        payload: { fields: ['photo'], hasPhoto: !!row?.imageUrl },
      });
    }
    res.json(meView(row));
  } catch (err) {
    console.error('POST /users/me/avatar/sync error:', err);
    res.status(500).json({ error: 'Failed to refresh photo' });
  }
});

// POST /api/users/setup — create profile for new user
router.post('/setup', requireAuth, async (req, res) => {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' });

  const { username } = req.body;
  if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username and displayName are required' });
  const name = normalizeDisplayName(req.body.displayName);
  if (!name.ok) return res.status(400).json({ error: name.error, code: name.code, field: 'displayName' });
  const displayName = name.value;

  const usernameClean = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!usernameClean) return res.status(400).json({ error: 'Invalid username' });

  try {
    const [existing] = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
    if (existing) {
      // The Pinball Map credential never goes to the browser, not even to its owner.
      const { pinballMapToken: _t, pinballMapEmail: _e, ...safe } = existing;
      return res.json(safe);
    }

    const [created] = await db.insert(users).values({ clerkId, username: usernameClean, displayName }).returning();
    await logActivity({
      type: 'user.first_setup', ...fromReq(req), actorUserId: created.id, targetType: 'user', targetId: created.id,
      payload: { username: created.username, displayName: created.displayName, clerkUserId: clerkId },
    });
    // A Google/OAuth sign-up usually arrives with a photo; pick it up in the background.
    void resyncAvatar(clerkId);
    const { pinballMapToken: _t, pinballMapEmail: _e, ...user } = created;
    res.status(201).json(user);
  } catch (err: any) {
    if (err?.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// GET /api/users/:username/badges — the profile's badge shelf, in the admin's sort order (`items`
// collapses each series to its highest earned tier + pips; `badges` stays flat). Public: anyone who can
// view the profile (guests included) sees it, no friend or pod check. Source scores are linked only
// when the viewer may see them; source challenges only for participants (lib/badges.ts).
router.get('/:username/badges', async (req, res) => {
  try {
    const shelf = await userBadgeShelf(req.params.username, await resolveViewer(req));
    if (!shelf) return res.status(404).json({ error: 'User not found' });
    res.json(shelf);
  } catch (err) {
    console.error('User badges error:', err);
    res.status(500).json({ error: 'Failed to load badges' });
  }
});

// GET /api/users/:username — public profile with scores
router.get('/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Who's looking — a profile viewed by its own user shows every score; anyone else doesn't see
    // scores at a home venue whose owner keeps them private (venueActivity.ts).
    const clerkId = callerClerkId(req);
    const [viewer] = clerkId
      ? await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1)
      : [];

    const userScores = await db
      .select({
        id: scores.id,
        score: scores.score,
        playedAt: scores.playedAt,
        type: scores.type,
        venueId: scores.venueId,
        venueName: scores.venueName,
        // Withheld for hidden-tier venues, matching redactVenue. Done in SQL because this route has
        // no requester plumbing; the owner therefore falls back to their own clock here, which reads
        // the same unless they're travelling.
        venueTimezone: sql<string | null>`CASE WHEN ${venues.privacyTier} = 'hidden' THEN NULL ELSE ${venues.timezone} END`,
        venueIsResidence: venues.isResidence,
        photoUrl: scores.photoUrl,
        hasFullPhoto: hasFullPhotoSql,
        hasThumbnail: hasThumbnailSql,
        machineName: machines.name,
        machineImageUrl: machines.imageUrl,
      })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .leftJoin(venues, eq(scores.venueId, venues.id))
      .where(and(eq(scores.userId, user.id), visibleScoreSql(viewer)))
      .orderBy(desc(scores.playedAt));

    // "Challenge me on" — only for an accepted friend (guests, strangers and the user themselves get
    // no field; the owner edits theirs through /api/me/challenge-prefs).
    const challengeMe = await challengeMeFor(user.id, viewer?.id);

    res.json({
      // The photo goes to signed-in viewers only (with a profile), never to signed-out visitors.
      user: { id: user.id, username: user.username, displayName: user.displayName, ...(viewer ? { imageUrl: user.imageUrl } : {}) },
      scores: userScores,
      ...(challengeMe ? { challengeMe: challengeMe.map(m => ({ id: m.machineId, name: m.name, variant: m.variant, imageUrl: m.imageUrl })) } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
