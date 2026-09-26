// Full-size score photos (Cloudflare R2) — see lib/photoStore.ts for the storage side.
//
//   POST /api/scores/:id/photo/upload-url  owner only → { key, url, expiresIn } (presigned PUT, 5 min)
//   POST /api/scores/:id/photo/confirm     owner only, { key, width?, height? } → { hasFullPhoto: true }
//   GET  /api/scores/:id/photo             anyone who can see the score (guests included)
//                                          → { url, width, height, expiresAt, thumbnail, canUpload }
//                                          url: presigned GET (~10 min), or null for a thumbnail-only
//                                          score, which then carries its data-URL `thumbnail` (most
//                                          lists don't ship thumbnails). canUpload: the viewer owns the
//                                          score, R2 is on, and an upload would be accepted (not a
//                                          replacement on a challenge-locked score). 404 when the score
//                                          has neither photo or isn't visible to the viewer.
//
// Uploads work on any of the owner's scores, however old — nothing here depends on the score having
// just been created (the viewer's "Upload the full-size photo" button relies on that).
//
// GET answers JSON rather than a 302: an <img src> can't carry the Clerk bearer token, and the
// visibility check needs to know who's asking (a hidden home-venue score is visible to its owner and
// author). The client fetches this with useApi() — which sends no token for guests — and puts the
// signed URL in the <img>. Keys are never returned by any list.
//
// Mounted at /api/scores ahead of the scores router; its paths don't overlap with that router's.

import { Router } from 'express';
import { getAuth } from '@clerk/express';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { db, scores, users } from '@workspace/db';
import { requireAppUser } from '../middleware/requireAuth.js';
import { visibleScoreSql } from '../lib/venueActivity.js';
import { scoreLockedByChallenge, SCORE_LOCKED } from '../lib/challenges.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import {
  getPhotoStore, newPhotoKey, verifyUpload, sanitizeDimension, deletePhotoBestEffort,
  UPLOAD_URL_TTL_S, VIEW_URL_TTL_S,
} from '../lib/photoStore.js';

const router = Router();

// A score gets one full-size photo, maybe a retry or two — these are generous for real use and
// still stop a script minting URLs in a loop.
const uploadUrlLimiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });
const confirmLimiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });
// Viewing is open to guests, so it's keyed per user when signed in, else per client IP.
const viewLimiter = createRateLimiter({ limit: 240, windowMs: 10 * 60_000 });

const DISABLED = { error: 'Full-size photos are not available right now', code: 'photos_disabled' } as const;

function tooMany(res: any, retryAfterMs: number) {
  res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  res.status(429).json({ error: 'Too many photo requests — try again in a few minutes', code: 'rate_limited' });
}

// The app doesn't set `trust proxy`; on Render the proxy appends the real client address as the LAST
// X-Forwarded-For entry (earlier ones are client-supplied). Same rule as routes/pinballmap.ts.
function clientIp(req: any): string {
  const xff = req.headers?.['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  return list[list.length - 1] ?? req.ip ?? 'unknown';
}

async function resolveViewer(req: any): Promise<{ id: number; role: string } | undefined> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return undefined;
  const [user] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user;
}

function scoreIdParam(req: any): number | null {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// POST /api/scores/:id/photo/upload-url
router.post('/:id/photo/upload-url', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const store = getPhotoStore();
  if (!store) return void res.status(503).json(DISABLED);
  const id = scoreIdParam(req);
  if (id == null) return void res.status(404).json({ error: 'Score not found' });

  const limit = uploadUrlLimiter.hit(appUser.id);
  if (!limit.allowed) return void tooMany(res, limit.retryAfterMs);

  try {
    const [score] = await db.select({ userId: scores.userId, photoKey: scores.photoKey }).from(scores).where(eq(scores.id, id)).limit(1);
    if (!score) return void res.status(404).json({ error: 'Score not found' });
    if (score.userId !== appUser.id) return void res.status(403).json({ error: 'You can only add a photo to your own score' });
    // The first full-size photo may be attached to a locked score (a challenge can lock it the moment
    // it's saved, before the background upload finishes); replacing one is a change, and locked
    // scores don't change.
    if (score.photoKey && await scoreLockedByChallenge(id)) return void res.status(409).json(SCORE_LOCKED);

    const key = newPhotoKey(id);
    const url = await store.presignPut(key);
    res.json({ key, url, expiresIn: UPLOAD_URL_TTL_S });
  } catch (err: any) {
    console.error(`[photos] upload-url for score ${id} failed:`, err?.name ?? '', err?.message ?? err);
    res.status(500).json({ error: 'Could not start the photo upload' });
  }
});

// POST /api/scores/:id/photo/confirm
router.post('/:id/photo/confirm', requireAppUser, async (req, res) => {
  const appUser = (req as any).appUser;
  const store = getPhotoStore();
  if (!store) return void res.status(503).json(DISABLED);
  const id = scoreIdParam(req);
  if (id == null) return void res.status(404).json({ error: 'Score not found' });

  const limit = confirmLimiter.hit(appUser.id);
  if (!limit.allowed) return void tooMany(res, limit.retryAfterMs);

  const { key } = req.body ?? {};
  try {
    const [score] = await db.select({ userId: scores.userId }).from(scores).where(eq(scores.id, id)).limit(1);
    if (!score) return void res.status(404).json({ error: 'Score not found' });
    if (score.userId !== appUser.id) return void res.status(403).json({ error: 'You can only add a photo to your own score' });

    const check = await verifyUpload(store, id, key);
    if (!check.ok) return void res.status(check.status).json({ error: check.error, code: check.code });

    const width = sanitizeDimension(req.body?.width);
    const height = sanitizeDimension(req.body?.height);
    const outcome = await db.transaction(async tx => {
      const [row] = await tx.select({ photoKey: scores.photoKey }).from(scores).where(eq(scores.id, id)).for('update');
      if (!row) return { kind: 'gone' as const };
      if (row.photoKey === key) return { kind: 'same' as const };
      if (row.photoKey && await scoreLockedByChallenge(id)) return { kind: 'locked' as const };
      await tx.update(scores)
        .set({ photoKey: key, photoBytes: check.bytes, photoWidth: width, photoHeight: height })
        .where(eq(scores.id, id));
      return { kind: 'set' as const, previous: row.photoKey };
    });

    if (outcome.kind === 'gone') {
      await deletePhotoBestEffort(key, `confirm score ${id} (score deleted meanwhile)`, store);
      return void res.status(404).json({ error: 'Score not found' });
    }
    if (outcome.kind === 'locked') {
      await deletePhotoBestEffort(key, `confirm score ${id} (locked by challenge)`, store);
      return void res.status(409).json(SCORE_LOCKED);
    }
    if (outcome.kind === 'set' && outcome.previous) {
      await deletePhotoBestEffort(outcome.previous, `replace photo on score ${id}`, store);
    }
    res.json({ hasFullPhoto: true });
  } catch (err: any) {
    console.error(`[photos] confirm for score ${id} failed:`, err?.name ?? '', err?.message ?? err);
    res.status(500).json({ error: 'Could not save the photo' });
  }
});

// GET /api/scores/:id/photo
router.get('/:id/photo', async (req, res) => {
  // A thumbnail-only score needs no R2, so "disabled" is decided per row below.
  const store = getPhotoStore();
  const id = scoreIdParam(req);
  if (id == null) return void res.status(404).json({ error: 'Photo not found' });

  try {
    const viewer = await resolveViewer(req);
    const limit = viewLimiter.hit(viewer ? `u:${viewer.id}` : `ip:${clientIp(req)}`);
    if (!limit.allowed) return void tooMany(res, limit.retryAfterMs);

    // Same visibility rule as every score listing: a score at a home venue whose owner keeps
    // activity private is a 404 to everyone but the owner, its author and admins.
    const [row] = await db
      .select({
        userId: scores.userId,
        photoKey: scores.photoKey,
        width: scores.photoWidth,
        height: scores.photoHeight,
        thumbnail: scores.photoThumbnail,
      })
      .from(scores)
      .where(and(
        eq(scores.id, id),
        or(isNotNull(scores.photoKey), isNotNull(scores.photoThumbnail)),
        visibleScoreSql(viewer),
      ))
      .limit(1);
    if (!row) return void res.status(404).json({ error: 'Photo not found' });
    if (row.photoKey && !store) return void res.status(503).json(DISABLED);

    // Mirrors upload-url's rules, so the viewer never offers a button that would be refused.
    const canUpload = !!store && !!viewer && viewer.id === row.userId
      && (!row.photoKey || !(await scoreLockedByChallenge(id)));

    res.set('Cache-Control', 'private, no-store');
    if (!row.photoKey) {
      return void res.json({ url: null, width: null, height: null, expiresAt: null, thumbnail: row.thumbnail, canUpload });
    }
    const url = await store!.presignGet(row.photoKey);
    res.json({
      url,
      width: row.width,
      height: row.height,
      expiresAt: new Date(Date.now() + VIEW_URL_TTL_S * 1000).toISOString(),
      thumbnail: null,
      canUpload,
    });
  } catch (err: any) {
    console.error(`[photos] view for score ${id} failed:`, err?.name ?? '', err?.message ?? err);
    res.status(500).json({ error: 'Could not load the photo' });
  }
});

export default router;
