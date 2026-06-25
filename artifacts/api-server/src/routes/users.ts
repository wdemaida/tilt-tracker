import { Router } from 'express';
import { db, users, scores, machines } from '@workspace/db';
import { eq, desc } from 'drizzle-orm';
import { getAuth } from '@clerk/express';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// GET /api/users/me — current user's profile (or null if not set up); token fields excluded
router.get('/me', requireAuth, async (req, res) => {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' });

  const [user] = await db
    .select({ id: users.id, clerkId: users.clerkId, username: users.username, displayName: users.displayName, role: users.role, createdAt: users.createdAt })
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
    if (existing) return res.json(existing);

    const [user] = await db.insert(users).values({ clerkId, username: usernameClean, displayName }).returning();
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

    const userScores = await db
      .select({
        id: scores.id,
        score: scores.score,
        playedAt: scores.playedAt,
        type: scores.type,
        venueName: scores.venueName,
        photoUrl: scores.photoUrl,
        machineName: machines.name,
      })
      .from(scores)
      .innerJoin(machines, eq(scores.machineId, machines.id))
      .where(eq(scores.userId, user.id))
      .orderBy(desc(scores.playedAt));

    res.json({ user: { id: user.id, username: user.username, displayName: user.displayName }, scores: userScores });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
