import { Router } from 'express';
import multer from 'multer';
import { db, badges, userBadges, users } from '@workspace/db';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { fromReq, logActivity } from '../lib/activity.js';
import { metricCatalog, metricByKey } from '../lib/badgeMetrics.js';
import {
  badgeCols, requirementText, normalizeBadgeInput, kindConsistencyError, resolveRuleRefs, activationBlocker, loadBadge,
  previewBadge, activateBadge, backfillBadge, retireBadge, grantBadge, revokeBadge, processBadgeImage, BADGE_IMAGE, BADGE_LIMITS,
  type BadgeRow, type ActionResult,
} from '../lib/badges.js';
import type { BadgeRule } from '../lib/badgeRules.js';

// Admin badges — /api/admin/badges/* (feature/badges, phase 2). Mounted inside routes/admin.ts, so
// every route here is behind requireAppUser + requireAdmin (adminAuth.test.ts enumerates them).
//
//   GET    /badges                 every badge (any status) with its award count
//   GET    /badges/metrics         the metric library (badgeMetrics.ts) — phase-3 metrics flagged unavailable
//   GET    /badges/:id             one badge + its holders (newest first, 200 max)
//   POST   /badges                 create (always draft)
//   PATCH  /badges/:id             edit; key, kind and metric are frozen once anyone has it. Turning
//                                  retroactive on for a LIVE badge backfills (response `backfill`)
//   POST   /badges/:id/image       multipart `image`, ≤ 1 MB PNG/WebP/JPEG → 256x256 WebP; bumps image_version
//   DELETE /badges/:id/image       back to the lucide icon
//   POST   /badges/:id/preview     dry run: who qualifies from history (writes nothing)
//   POST   /badges/:id/activate    go live (+ retroactive backfill)
//   POST   /badges/:id/backfill    live + retroactive: award everyone who qualifies and lacks it (idempotent)
//   POST   /badges/:id/retire      no new awards; earned ones stay
//   POST   /badges/:id/grants      { userIds, note? } manual award (badge must be live)
//   DELETE /badges/:id/grants      ?userId= (or body { userId, reason }) revoke — by hand only

const router = Router();

function intParam(v: unknown): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function send(res: any, r: ActionResult) {
  res.status(r.status).json(r.body);
}
function fail500(res: any, what: string, err: unknown) {
  console.error(`admin badges ${what} error:`, err);
  res.status(500).json({ error: `Failed to ${what}` });
}

async function awardCount(id: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(userBadges).where(eq(userBadges.badgeId, id));
  return Number(r?.n ?? 0);
}

/** The admin view of a badge: everything but the bytes. */
function adminBadge(b: BadgeRow, earnedCount: number) {
  const blocker = activationBlocker(b);
  return {
    ...b,
    imageVersion: b.hasImage ? b.imageVersion : null,
    requirement: requirementText(b),
    earnedCount,
    metricAvailable: b.kind !== 'metric' || !!metricByKey(b.metric),
    activationBlocker: blocker?.error ?? null,
    availableFrom: b.availableFrom?.toISOString() ?? null,
    availableTo: b.availableTo?.toISOString() ?? null,
    activatedAt: b.activatedAt?.toISOString() ?? null,
  };
}

router.get('/badges', async (_req, res) => {
  try {
    const rows = await db.select({ ...badgeCols, earnedCount: sql<number>`(SELECT count(*)::int FROM user_badges ub WHERE ub.badge_id = ${badges.id})` })
      .from(badges).orderBy(asc(badges.sortOrder), asc(badges.id));
    res.json({ items: rows.map(({ earnedCount, ...b }) => adminBadge(b as BadgeRow, Number(earnedCount))), limits: BADGE_LIMITS, image: BADGE_IMAGE });
  } catch (err) {
    fail500(res, 'list badges', err);
  }
});

router.get('/badges/metrics', (_req, res) => {
  res.json(metricCatalog());
});

router.get('/badges/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  try {
    const b = await loadBadge(id);
    if (!b) return void res.status(404).json({ error: 'Badge not found', code: 'badge_not_found' });
    const grantor = alias(users, 'grantor');
    const holders = await db.select({
      earnedAt: userBadges.earnedAt, note: userBadges.note, sourceScoreId: userBadges.sourceScoreId, sourceChallengeId: userBadges.sourceChallengeId,
      user: { id: users.id, username: users.username, displayName: users.displayName },
      grantedBy: { id: grantor.id, username: grantor.username, displayName: grantor.displayName },
    }).from(userBadges)
      .innerJoin(users, eq(users.id, userBadges.userId))
      .leftJoin(grantor, eq(grantor.id, userBadges.grantedById))
      .where(eq(userBadges.badgeId, id))
      .orderBy(desc(userBadges.earnedAt))
      .limit(200);
    res.json({
      badge: adminBadge(b, await awardCount(id)),
      holders: holders.map(h => ({ ...h, grantedBy: h.grantedBy?.id ? h.grantedBy : null })),
    });
  } catch (err) {
    fail500(res, 'load badge', err);
  }
});

router.post('/badges', async (req, res) => {
  const parsed = normalizeBadgeInput(req.body, false);
  if ('errors' in parsed) return void res.status(400).json({ error: 'Check the highlighted fields', code: 'invalid_badge', errors: parsed.errors });
  const v = parsed.values;
  try {
    let rule: BadgeRule | null = null;
    if (v.kind === 'rule' && v.rule) {
      const r = await resolveRuleRefs(v.rule);
      if ('error' in r) return void res.status(400).json({ error: r.error, code: 'invalid_rule', errors: { rule: r.error } });
      rule = r.rule;
    }
    const [row] = await db.insert(badges).values({
      key: v.key!, name: v.name!, description: v.description ?? '', icon: v.icon ?? 'award', color: v.color ?? '#f59e0b',
      kind: v.kind!, metric: v.kind === 'metric' ? v.metric! : null, threshold: v.kind === 'metric' ? v.threshold! : null,
      rule: rule as Record<string, unknown> | null, retroactive: v.retroactive ?? false,
      availableFrom: v.availableFrom ?? null, availableTo: v.availableTo ?? null, sortOrder: v.sortOrder ?? 0,
      status: 'draft', createdById: (req as any).appUser.id,
    }).returning({ id: badges.id });
    await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge', targetId: row.id, payload: { action: 'created', badgeKey: v.key, name: v.name, kind: v.kind } });
    res.status(201).json({ badge: adminBadge((await loadBadge(row.id))!, 0) });
  } catch (err: any) {
    if (err?.code === '23505' || err?.cause?.code === '23505') return void res.status(409).json({ error: 'That key is taken', code: 'key_taken', errors: { key: 'That key is taken' } });
    fail500(res, 'create badge', err);
  }
});

const FROZEN_ONCE_AWARDED = ['key', 'kind', 'metric'] as const;

router.patch('/badges/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  const parsed = normalizeBadgeInput(req.body, true);
  if ('errors' in parsed) return void res.status(400).json({ error: 'Check the highlighted fields', code: 'invalid_badge', errors: parsed.errors });
  const v = parsed.values;
  try {
    const b = await loadBadge(id);
    if (!b) return void res.status(404).json({ error: 'Badge not found', code: 'badge_not_found' });
    const awarded = await awardCount(id);
    if (awarded > 0) {
      const changed = FROZEN_ONCE_AWARDED.filter(k => v[k] !== undefined && v[k] !== b[k]);
      if (changed.length) {
        return void res.status(409).json({
          error: `${changed.join(', ')} can’t change once anyone has this badge`, code: 'locked_field',
          errors: Object.fromEntries(changed.map(k => [k, 'Frozen — players have this badge'])),
        });
      }
    }
    const kind = v.kind ?? b.kind;
    let rule = v.rule !== undefined ? v.rule : (b.rule as BadgeRule | null);
    if (v.rule) {
      const r = await resolveRuleRefs(v.rule);
      if ('error' in r) return void res.status(400).json({ error: r.error, code: 'invalid_rule', errors: { rule: r.error } });
      rule = r.rule;
    }
    const merged = {
      kind,
      metric: kind === 'metric' ? (v.metric !== undefined ? v.metric : b.metric) : null,
      threshold: kind === 'metric' ? (v.threshold !== undefined ? v.threshold : b.threshold) : null,
      rule: kind === 'rule' ? rule : null,
    };
    const inconsistent = kindConsistencyError(merged);
    if (inconsistent) return void res.status(400).json({ error: inconsistent, code: 'invalid_badge' });
    const from = v.availableFrom !== undefined ? v.availableFrom : b.availableFrom;
    const to = v.availableTo !== undefined ? v.availableTo : b.availableTo;
    if (from && to && +from > +to) return void res.status(400).json({ error: 'The window ends before it starts', code: 'invalid_badge', errors: { availableTo: 'Must be after the start' } });
    // A live badge must stay earnable as configured.
    if (b.status === 'live') {
      const blocker = activationBlocker(merged);
      if (blocker) return void res.status(400).json({ error: blocker.error, code: blocker.code });
    }

    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    for (const k of ['key', 'name', 'description', 'icon', 'color', 'retroactive', 'sortOrder'] as const) if (v[k] !== undefined) set[k] = v[k];
    if (v.availableFrom !== undefined) set.availableFrom = v.availableFrom;
    if (v.availableTo !== undefined) set.availableTo = v.availableTo;
    Object.assign(set, merged);
    await db.update(badges).set(set as any).where(eq(badges.id, id));
    const changes = Object.keys(req.body ?? {}).filter(k => k in set || k === 'rule');
    await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge', targetId: id, payload: { action: 'edited', badgeKey: (v.key ?? b.key), name: v.name ?? b.name, fields: changes } });

    // Retroactive switched on for a badge that's already live: activation's backfill already ran
    // (with retroactive off), so run it now. Off → on only; on → off revokes nothing (forward-only
    // from here: a rule badge counts only scores posted after activated_at). The edit is saved
    // either way — a failed backfill is reported, and "Backfill now" retries it.
    let backfill: { awarded: number; skippedWindow: boolean } | { failed: true; error: string } | null = null;
    if (b.status === 'live' && !b.retroactive && v.retroactive === true && kind !== 'manual') {
      try {
        const r = await backfillBadge(id, (req as any).appUser.id, 'retroactive_enabled');
        backfill = r.status === 200 ? r.body as { awarded: number; skippedWindow: boolean } : { failed: true, error: String(r.body.error) };
      } catch (err) {
        console.error('admin badges backfill-on-edit error:', err);
        backfill = { failed: true, error: 'The backfill failed — use Backfill now to retry' };
      }
    }
    res.json({ badge: adminBadge((await loadBadge(id))!, backfill ? await awardCount(id) : awarded), backfill });
  } catch (err: any) {
    if (err?.code === '23505' || err?.cause?.code === '23505') return void res.status(409).json({ error: 'That key is taken', code: 'key_taken', errors: { key: 'That key is taken' } });
    fail500(res, 'update badge', err);
  }
});

// ── image ────────────────────────────────────────────────────────────────────

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BADGE_IMAGE.maxBytes, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, (BADGE_IMAGE.types as readonly string[]).includes(file.mimetype)),
}).single('image');

router.post('/badges/:id/image', (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  imageUpload(req, res, async (err: any) => {
    if (err) {
      if (err?.code === 'LIMIT_FILE_SIZE') return void res.status(413).json({ error: 'Images must be 1 MB or smaller', code: 'image_too_large' });
      return void res.status(400).json({ error: 'Upload failed', code: 'bad_upload' });
    }
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return void res.status(400).json({ error: 'Send a PNG, WebP or JPEG as `image`', code: 'unsupported_type' });
    try {
      const b = await loadBadge(id);
      if (!b) return void res.status(404).json({ error: 'Badge not found', code: 'badge_not_found' });
      let webp: Buffer;
      try {
        webp = await processBadgeImage(file.buffer);
      } catch {
        return void res.status(400).json({ error: 'That file isn’t an image we can read', code: 'invalid_image' });
      }
      const [row] = await db.update(badges)
        .set({ image: webp, imageVersion: sql`${badges.imageVersion} + 1` as any, updatedAt: sql`now()` as any })
        .where(eq(badges.id, id))
        .returning({ imageVersion: badges.imageVersion });
      await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge', targetId: id, payload: { action: 'image_uploaded', badgeKey: b.key, bytesIn: file.size, bytesOut: webp.length, imageVersion: row.imageVersion } });
      res.json({ imageVersion: row.imageVersion, bytes: webp.length, width: BADGE_IMAGE.size, height: BADGE_IMAGE.size });
    } catch (e) {
      fail500(res, 'save badge image', e);
    }
  });
});

router.delete('/badges/:id/image', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  try {
    const [row] = await db.update(badges).set({ image: null, updatedAt: sql`now()` as any }).where(eq(badges.id, id)).returning({ key: badges.key });
    if (!row) return void res.status(404).json({ error: 'Badge not found', code: 'badge_not_found' });
    await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge', targetId: id, payload: { action: 'image_removed', badgeKey: row.key } });
    res.json({ imageVersion: null });
  } catch (err) {
    fail500(res, 'remove badge image', err);
  }
});

// ── lifecycle ────────────────────────────────────────────────────────────────

router.post('/badges/:id/preview', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  try { send(res, await previewBadge(id)); } catch (err) { fail500(res, 'preview badge', err); }
});

router.post('/badges/:id/activate', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  try { send(res, await activateBadge(id, (req as any).appUser.id)); } catch (err) { fail500(res, 'activate badge', err); }
});

router.post('/badges/:id/backfill', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  try { send(res, await backfillBadge(id, (req as any).appUser.id, 'manual')); } catch (err) { fail500(res, 'backfill badge', err); }
});

router.post('/badges/:id/retire', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  try { send(res, await retireBadge(id, (req as any).appUser.id)); } catch (err) { fail500(res, 'retire badge', err); }
});

router.post('/badges/:id/grants', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid badge id' });
  const raw = Array.isArray(req.body?.userIds) ? req.body.userIds : req.body?.userId != null ? [req.body.userId] : [];
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 200) : null;
  try { send(res, await grantBadge(id, raw.map(Number), (req as any).appUser.id, note)); } catch (err) { fail500(res, 'grant badge', err); }
});

router.delete('/badges/:id/grants', async (req, res) => {
  const id = intParam(req.params.id);
  const userId = intParam(req.query.userId ?? req.body?.userId);
  if (!id || !userId) return void res.status(400).json({ error: 'badge id and userId are required' });
  const reason = typeof req.query.reason === 'string' ? req.query.reason : typeof req.body?.reason === 'string' ? req.body.reason : '';
  try { send(res, await revokeBadge(id, userId, (req as any).appUser.id, reason.trim().slice(0, 500) || null)); } catch (err) { fail500(res, 'revoke badge', err); }
});

export default router;
