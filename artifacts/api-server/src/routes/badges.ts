import { Router } from 'express';
import { getAuth } from '@clerk/express';
import { db, users } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { badgeCatalog, loadBadgeImage } from '../lib/badges.js';
import type { Viewer } from '../lib/venueActivity.js';

// Public badge reads (feature/badges) — optional auth, guests included, like the photo view.
// Badges are public on every profile: no friend or pod check anywhere here.
//
//   GET /api/badges                 the catalog of live badges: requirement text, availability window,
//                                   how many players have each, and (signed in) the viewer's earn date
//   GET /api/badges/:id/image?v=N   the badge's 256x256 WebP; immutable for a year when `v` is the
//                                   current version (every upload bumps it, so the URL changes)
//   GET /api/users/:username/badges lives in users.ts (userBadgeShelf)

const router = Router();

/** Who's asking, if anyone. Never throws for a guest. */
export async function resolveViewer(req: any): Promise<Viewer | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return u;
}

router.get('/', async (req, res) => {
  try {
    res.json(await badgeCatalog(await resolveViewer(req)));
  } catch (err) {
    console.error('Badge catalog error:', err);
    res.status(500).json({ error: 'Failed to load badges' });
  }
});

router.get('/:id/image', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return void res.status(404).json({ error: 'Not found' });
  try {
    const img = await loadBadgeImage(id);
    if (!img) return void res.status(404).json({ error: 'No image', code: 'no_image' });
    const current = String(req.query.v ?? '') === String(img.imageVersion);
    res.setHeader('Content-Type', 'image/webp');
    // A stale or missing ?v= still gets the current image, but must not be pinned under that URL.
    res.setHeader('Cache-Control', current ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(img.image);
  } catch (err) {
    console.error('Badge image error:', err);
    res.status(500).json({ error: 'Failed to load image' });
  }
});

export default router;
