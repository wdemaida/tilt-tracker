import { Router } from 'express';
import { db, users, scores, machines, venues } from '@workspace/db';
import { eq, desc, sql, and } from 'drizzle-orm';
import { getAuth } from '@clerk/express';
import { requireAuth } from '../middleware/requireAuth.js';
import { visibleScoreSql } from '../lib/venueActivity.js';
import { hasFullPhotoSql, hasThumbnailSql } from '../lib/photoStore.js';
import { logActivity, fromReq } from '../lib/activity.js';

const router = Router();

// GET /api/users/me — current user's profile (or null if not set up); token fields excluded.
// Deliberately NOT behind requireAppUser: a disabled account still gets its row (with disabledAt),
// so the app can say "this account is disabled" instead of failing mysteriously.
router.get('/me', requireAuth, async (req, res) => {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' });

  const [user] = await db
    .select({ id: users.id, clerkId: users.clerkId, username: users.username, displayName: users.displayName, role: users.role, createdAt: users.createdAt, disabledAt: users.disabledAt, disabledReason: users.disabledReason })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  res.json(user ?? null);
});

// POST /api/users/setup — create profile for new user
router.post('/setup', requireAuth, async (req, res) => {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' });

  const { username, displayName } = req.body;
  if (!username || !displayName) return res.status(400).json({ error: 'username and displayName are required' });

  const usernameClean = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!usernameClean) return res.status(400).json({ error: 'Invalid username' });

  try {
    const [existing] = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
    if (existing) {
      // The Pinball Map credential never goes to the browser, not even to its owner.
      const { pinballMapToken: _t, pinballMapEmail: _e, ...safe } = existing;
      return res.json(safe);
    }

    const [user] = await db.insert(users).values({ clerkId, username: usernameClean, displayName }).returning();
    await logActivity({
      type: 'user.first_setup', ...fromReq(req), actorUserId: user.id, targetType: 'user', targetId: user.id,
      payload: { username: user.username, displayName: user.displayName, clerkUserId: clerkId },
    });
    res.status(201).json(user);
  } catch (err: any) {
    if (err?.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: 'Failed to create profile' });
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
    const { userId: clerkId } = getAuth(req);
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

    res.json({ user: { id: user.id, username: user.username, displayName: user.displayName }, scores: userScores });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
