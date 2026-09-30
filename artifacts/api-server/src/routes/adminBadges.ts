import { Router } from 'express';
import multer from 'multer';
import { db, badges, badgeSeries, userBadges, users } from '@workspace/db';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { fromReq, logActivity } from '../lib/activity.js';
import { metricCatalog, metricByKey } from '../lib/badgeMetrics.js';
import {
  badgeCols, requirementText, normalizeBadgeInput, kindConsistencyError, resolveRuleRefs, activationBlocker, loadBadge,
  previewBadge, activateBadge, backfillBadge, retireBadge, grantBadge, revokeBadge, processBadgeImage, BADGE_IMAGE, BADGE_LIMITS,
  loadSeries, type BadgeRow, type ActionResult,
} from '../lib/badges.js';
import {
  orderBadges, topLevelOrder, validateOrder, sortOrdersFor, nextSortOrder, normalizeSeriesInput, seriesKeyFor, SERIES_LIMITS,
} from '../lib/badgeSeries.js';
import type { Executor } from '../lib/activity.js';
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
//   PUT    /badges/order           { items: [{ type: 'series' | 'badge', id }] } — the full top-level
//                                  order (every series + every single, once each); tiers follow their series
//   POST   /badge-series           { name, color } create an (empty) series at the end
//   PATCH  /badge-series/:id       { name?, color? } — the color applies to every tier
//   DELETE /badge-series/:id       only an empty series (409 series_not_empty)
//
// Series (feature/badge-series): a badge's `seriesId` puts it in a ladder. POST /badges with no
// `seriesId` joins the metric's series when that metric has exactly one; `seriesId: null` = a single;
// `newSeries: { name, color }` creates one. New singles go after the last item; a new rule/manual
// tier goes after its series' last tier (metric tiers order by threshold).

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

/** A refusal from inside a transaction: rolled back, then answered with this status/body. */
class Refusal {
  constructor(public status: number, public body: Record<string, unknown>) {}
}

/** The highest top-level sort_order — series and single badges share one ordering space. */
async function maxTopOrder(ex: Executor): Promise<number | null> {
  const [r] = await ex.execute(sql`SELECT greatest((SELECT max(sort_order) FROM badge_series), (SELECT max(sort_order) FROM badges WHERE series_id IS NULL)) AS m`) as unknown as Array<{ m: number | null }>;
  return r?.m == null ? null : Number(r.m);
}
/** The highest sort_order among a series' tiers (rule/manual tiers order by it). */
async function maxTierOrder(ex: Executor, seriesId: number, exceptBadgeId?: number): Promise<number | null> {
  const [r] = await ex.select({ m: sql<number | null>`max(${badges.sortOrder})` }).from(badges)
    .where(and(eq(badges.seriesId, seriesId), exceptBadgeId ? sql`${badges.id} <> ${exceptBadgeId}` : undefined));
  return r?.m == null ? null : Number(r.m);
}
/** The series a metric's badges are in, when there's exactly one — a new tier on it joins that ladder. */
async function seriesOfMetric(ex: Executor, metric: string): Promise<number | null> {
  const rows = await ex.selectDistinct({ id: badges.seriesId }).from(badges)
    .where(and(eq(badges.kind, 'metric'), eq(badges.metric, metric), isNotNull(badges.seriesId)));
  return rows.length === 1 ? rows[0].id : null;
}
async function seriesExists(ex: Executor, id: number): Promise<boolean> {
  return (await ex.select({ id: badgeSeries.id }).from(badgeSeries).where(eq(badgeSeries.id, id)).limit(1)).length > 0;
}
/** A new series at the end of the shared order, keyed from its name. */
async function createSeries(ex: Executor, v: { name: string; color: string }) {
  const taken = new Set((await ex.select({ key: badgeSeries.key }).from(badgeSeries)).map(r => r.key));
  const [row] = await ex.insert(badgeSeries).values({
    key: seriesKeyFor(v.name, taken), name: v.name, color: v.color, sortOrder: nextSortOrder(await maxTopOrder(ex)),
  }).returning();
  return row;
}
/** Where `seriesId` (or null = a single) puts a badge that's joining it: after the last tier / item. */
async function placement(ex: Executor, seriesId: number | null, badgeId?: number): Promise<number> {
  return nextSortOrder(seriesId != null ? await maxTierOrder(ex, seriesId, badgeId) : await maxTopOrder(ex));
}
function refused(res: any, err: unknown): boolean {
  if (err instanceof Refusal) { res.status(err.status).json(err.body); return true; }
  return false;
}
const unknownSeries = () => new Refusal(400, { error: 'That series doesn’t exist', code: 'unknown_series', errors: { seriesId: 'That series doesn’t exist' } });

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
    const series = await loadSeries();
    const rows = orderBadges(await db.select({ ...badgeCols, earnedCount: sql<number>`(SELECT count(*)::int FROM user_badges ub WHERE ub.badge_id = ${badges.id})` })
      .from(badges), series);
    const counts = new Map<number, number>();
    for (const r of rows) if (r.seriesId != null) counts.set(r.seriesId, (counts.get(r.seriesId) ?? 0) + 1);
    res.json({
      // In the shared order, each series' tiers together (lowest first).
      items: rows.map(({ earnedCount, ...b }) => adminBadge(b as BadgeRow, Number(earnedCount))),
      series: series.map(s => ({ ...s, badgeCount: counts.get(s.id) ?? 0 })),
      // The draggable rows: every series (empty ones too) and every single, in order.
      order: topLevelOrder(rows, series),
      limits: { ...BADGE_LIMITS, seriesName: SERIES_LIMITS.name }, image: BADGE_IMAGE,
    });
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
    const row = await db.transaction(async tx => {
      // Series: a new one, a named one, explicitly none, or (omitted) the metric's own ladder.
      let seriesId: number | null = null;
      let created: { id: number; key: string; name: string } | null = null;
      if (v.newSeries) {
        created = await createSeries(tx, v.newSeries);
        seriesId = created.id;
      } else if (v.seriesId !== undefined) {
        if (v.seriesId != null && !(await seriesExists(tx, v.seriesId))) throw unknownSeries();
        seriesId = v.seriesId;
      } else if (v.kind === 'metric' && v.metric) {
        seriesId = await seriesOfMetric(tx, v.metric);
      }
      const [inserted] = await tx.insert(badges).values({
        key: v.key!, name: v.name!, description: v.description ?? '', icon: v.icon ?? 'award', color: v.color ?? '#f59e0b',
        kind: v.kind!, metric: v.kind === 'metric' ? v.metric! : null, threshold: v.kind === 'metric' ? v.threshold! : null,
        rule: rule as Record<string, unknown> | null, retroactive: v.retroactive ?? false,
        availableFrom: v.availableFrom ?? null, availableTo: v.availableTo ?? null,
        // Auto-placed: a single after the last item, a tier after its series' last tier.
        sortOrder: v.sortOrder ?? await placement(tx, seriesId),
        seriesId, status: 'draft', createdById: (req as any).appUser.id,
      }).returning({ id: badges.id });
      if (created) {
        await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge_series', targetId: created.id, payload: { action: 'series_created', seriesKey: created.key, name: created.name, viaBadge: v.key } }, { tx });
      }
      await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge', targetId: inserted.id, payload: { action: 'created', badgeKey: v.key, name: v.name, kind: v.kind, seriesId } }, { tx });
      return inserted;
    });
    res.status(201).json({ badge: adminBadge((await loadBadge(row.id))!, 0) });
  } catch (err: any) {
    if (refused(res, err)) return;
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
    await db.transaction(async tx => {
      // Moving into / out of / between series: a new series, a named one, or null (a single).
      let target = b.seriesId ?? null;
      if (v.newSeries) {
        const created = await createSeries(tx, v.newSeries);
        target = created.id;
        await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge_series', targetId: created.id, payload: { action: 'series_created', seriesKey: created.key, name: created.name, viaBadge: b.key } }, { tx });
      } else if (v.seriesId !== undefined) {
        if (v.seriesId != null && !(await seriesExists(tx, v.seriesId))) throw unknownSeries();
        target = v.seriesId;
      }
      if (target !== (b.seriesId ?? null)) {
        set.seriesId = target;
        // Re-placed where it lands: after the series' last tier, or (leaving a series) after the last item.
        if (v.sortOrder === undefined) set.sortOrder = await placement(tx, target, id);
      }
      await tx.update(badges).set(set as any).where(eq(badges.id, id));
      const changes = [...new Set([...Object.keys(req.body ?? {}).filter(k => k in set || k === 'rule' || k === 'newSeries'), ...('seriesId' in set ? ['seriesId'] : [])])];
      await logActivity({
        type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge', targetId: id,
        payload: { action: 'edited', badgeKey: (v.key ?? b.key), name: v.name ?? b.name, fields: changes, ...('seriesId' in set ? { seriesFrom: b.seriesId ?? null, seriesTo: set.seriesId } : {}) },
      }, { tx });
    });

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
    if (refused(res, err)) return;
    if (err?.code === '23505' || err?.cause?.code === '23505') return void res.status(409).json({ error: 'That key is taken', code: 'key_taken', errors: { key: 'That key is taken' } });
    fail500(res, 'update badge', err);
  }
});

// ── order + series ───────────────────────────────────────────────────────────

/** The current top-level order (every series, every single), read inside `ex`. */
async function currentOrder(ex: Executor) {
  const series = await ex.select({ id: badgeSeries.id, key: badgeSeries.key, name: badgeSeries.name, color: badgeSeries.color, sortOrder: badgeSeries.sortOrder }).from(badgeSeries);
  const rows = await ex.select({ id: badges.id, seriesId: badges.seriesId, sortOrder: badges.sortOrder, kind: badges.kind, threshold: badges.threshold }).from(badges);
  return topLevelOrder(rows, series);
}

// The whole top-level order in one call (drag-and-drop and the move up/down buttons both send it).
// Refused unless it lists every series and every single exactly once — a stale page gets 409
// order_stale rather than a half-applied order. One transaction; sort_orders become 10, 20, 30, ...
router.put('/badges/order', async (req, res) => {
  try {
    const out = await db.transaction(async tx => {
      // Serialize reorders (and anything else taking this lock) so two admins can't interleave.
      await tx.execute(sql`LOCK TABLE badge_series IN SHARE ROW EXCLUSIVE MODE`);
      const check = validateOrder(req.body, await currentOrder(tx));
      if (!check.ok) throw new Refusal(check.code === 'order_stale' ? 409 : 400, { error: check.error, code: check.code });
      const placed = sortOrdersFor(check.items);
      const values = (type: 'series' | 'badge') => placed.filter(p => p.type === type).map(p => sql`(${p.id}::int, ${p.sortOrder}::int)`);
      let changed = 0;
      const bv = values('badge'), sv = values('series');
      if (bv.length) {
        changed += (await tx.execute(sql`UPDATE badges b SET sort_order = v.o, updated_at = now() FROM (VALUES ${sql.join(bv, sql`, `)}) AS v(id, o)
          WHERE b.id = v.id AND b.series_id IS NULL AND b.sort_order IS DISTINCT FROM v.o RETURNING b.id`) as unknown as unknown[]).length;
      }
      if (sv.length) {
        changed += (await tx.execute(sql`UPDATE badge_series s SET sort_order = v.o, updated_at = now() FROM (VALUES ${sql.join(sv, sql`, `)}) AS v(id, o)
          WHERE s.id = v.id AND s.sort_order IS DISTINCT FROM v.o RETURNING s.id`) as unknown as unknown[]).length;
      }
      if (changed) {
        await logActivity({
          type: 'admin.badge_order_changed', ...fromReq(req), targetType: 'badge',
          payload: { items: placed.length, changed, order: placed.map(p => `${p.type === 'series' ? 's' : 'b'}${p.id}`).join(' ') },
        }, { tx });
      }
      return { order: check.items, changed };
    });
    res.json(out);
  } catch (err) {
    if (refused(res, err)) return;
    fail500(res, 'reorder badges', err);
  }
});

router.post('/badge-series', async (req, res) => {
  const parsed = normalizeSeriesInput(req.body, false);
  if ('errors' in parsed) return void res.status(400).json({ error: 'Check the highlighted fields', code: 'invalid_series', errors: parsed.errors });
  try {
    const row = await db.transaction(async tx => {
      const created = await createSeries(tx, parsed.values as { name: string; color: string });
      await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge_series', targetId: created.id, payload: { action: 'series_created', seriesKey: created.key, name: created.name } }, { tx });
      return created;
    });
    res.status(201).json({ series: { ...row, badgeCount: 0 } });
  } catch (err) {
    fail500(res, 'create series', err);
  }
});

// A series has one color: changing it here recolors every tier (they read the series' color).
router.patch('/badge-series/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid series id' });
  const parsed = normalizeSeriesInput(req.body, true);
  if ('errors' in parsed) return void res.status(400).json({ error: 'Check the highlighted fields', code: 'invalid_series', errors: parsed.errors });
  try {
    const [before] = await db.select().from(badgeSeries).where(eq(badgeSeries.id, id)).limit(1);
    if (!before) return void res.status(404).json({ error: 'Series not found', code: 'series_not_found' });
    const [row] = await db.update(badgeSeries).set({ ...parsed.values, updatedAt: sql`now()` as any }).where(eq(badgeSeries.id, id)).returning();
    const fields = (Object.keys(parsed.values) as Array<'name' | 'color'>).filter(k => parsed.values[k] !== before[k]);
    if (fields.length) {
      await logActivity({
        type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge_series', targetId: id,
        payload: { action: 'series_edited', seriesKey: row.key, name: row.name, fields, ...(fields.includes('color') ? { colorFrom: before.color, colorTo: row.color } : {}) },
      });
    }
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(badges).where(eq(badges.seriesId, id));
    res.json({ series: { ...row, badgeCount: Number(n?.n ?? 0) } });
  } catch (err) {
    fail500(res, 'update series', err);
  }
});

// Only an empty series can be deleted — move its tiers out (or into another series) first, so nothing
// changes on anyone's profile by surprise.
router.delete('/badge-series/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(400).json({ error: 'Invalid series id' });
  try {
    const out = await db.transaction(async tx => {
      const [row] = await tx.select().from(badgeSeries).where(eq(badgeSeries.id, id)).limit(1).for('update');
      if (!row) throw new Refusal(404, { error: 'Series not found', code: 'series_not_found' });
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(badges).where(eq(badges.seriesId, id));
      if (Number(n?.n ?? 0) > 0) throw new Refusal(409, { error: 'Move its badges out of the series first', code: 'series_not_empty' });
      await tx.delete(badgeSeries).where(eq(badgeSeries.id, id));
      await logActivity({ type: 'admin.badge_updated', ...fromReq(req), targetType: 'badge_series', targetId: id, payload: { action: 'series_deleted', seriesKey: row.key, name: row.name } }, { tx });
      return { ok: true };
    });
    res.json(out);
  } catch (err) {
    if (refused(res, err)) return;
    fail500(res, 'delete series', err);
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
