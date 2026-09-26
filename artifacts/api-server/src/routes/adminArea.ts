import { Router } from 'express';
import {
  db, users, scores, machines, venues, friendships, pods, podMembers, challenges, challengeParticipants,
  notifications, activityEvents, statHistory,
} from '@workspace/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ACTIVITY_TYPES, categoryOf, fromReq, logActivity, type ActivityCategory } from '../lib/activity.js';
import {
  loadRetentionSettings, saveRetentionSettings, validateRetentionSettings, retentionStatus, typesInTier,
  RETENTION_LIMITS, RETENTION_SETTING_KEY, DEFAULT_TIER, ADMIN_PREFIX,
} from '../lib/activityRetention.js';
import {
  loadOrphanRunState, runPhotoOrphanSweep, publicOrphanResult, envMismatch, orphanSweepDue, ORPHAN_RUN_INTERVAL_MS,
} from '../lib/photoOrphans.js';
import { getClerkActivity } from '../lib/clerkAdmin.js';
import {
  disableUser, enableUser, deleteScoreAsAdmin, deleteFullPhotoAsAdmin, deleteThumbnailAsAdmin, voidChallenge,
  removeFriendship, deleteNotification, clearUserNotifications, locksFor, type ActionResult,
} from '../lib/adminActions.js';
import { getCatalogStatus } from '../lib/pinballMap.js';
import { pmClient } from '../lib/pmClient.js';
import { missingR2Vars, getPhotoStore } from '../lib/photoStore.js';

// The admin area — /api/admin/* (mounted inside routes/admin.ts, so every route here is behind
// requireAppUser + requireAdmin; the unit test enumerates this router's routes and checks that).
//
// PRIVACY: admin-only data. Never return users.pinball_map_token, scores.photo_key or any other
// secret — rows here are built from explicit column lists, never `select()` of a whole table
// that has one. Emails aren't stored by TiltTrack and aren't fetched from Clerk.
//
// Reads are keyset-paged on id (`before` = the last id you got; `nextBefore` null = done).

const router = Router();

const PAGE = 50;
const MAX_PAGE = 100;

function intParam(v: unknown): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function pageSize(v: unknown): number {
  return Math.min(Math.max(Number(v) || PAGE, 1), MAX_PAGE);
}
function dateParam(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(+d) ? null : d;
}
function send(res: any, r: ActionResult) {
  res.status(r.status).json(r.body);
}
function fail500(res: any, what: string, err: unknown) {
  console.error(`admin ${what} error:`, err);
  res.status(500).json({ error: `Failed to ${what}` });
}
function page<T extends { id: number }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextBefore: rows.length > limit ? items[items.length - 1].id : null };
}

const userRef = { id: users.id, username: users.username, displayName: users.displayName };

// "Today" is the America/New_York calendar day (the app's home zone, like the stat snapshot).
// created_at columns are naive UTC, so the boundary is converted back to naive UTC.
const ET_MIDNIGHT = sql`((date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC')`;
const utcAgo = (days: number) => sql`((now() AT TIME ZONE 'UTC') - make_interval(days => ${days}))`;

// ── overview ─────────────────────────────────────────────────────────────────

router.get('/overview', async (_req, res) => {
  try {
    const [counts] = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM users)::int AS users,
        (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL)::int AS disabled_users,
        (SELECT count(*) FROM users WHERE created_at >= ${utcAgo(7)})::int AS new_users_7d,
        (SELECT count(*) FROM scores)::int AS scores,
        (SELECT count(*) FROM scores WHERE created_at >= ${ET_MIDNIGHT})::int AS scores_today,
        (SELECT count(*) FROM scores WHERE created_at >= ${utcAgo(7)})::int AS scores_7d,
        (SELECT count(*) FROM scores WHERE photo_key IS NOT NULL)::int AS full_photos,
        (SELECT count(*) FROM scores WHERE photo_thumbnail IS NOT NULL)::int AS thumbnails,
        (SELECT count(*) FROM friendships WHERE status = 'accepted')::int AS friendships,
        (SELECT count(*) FROM friendships WHERE status = 'pending')::int AS pending_requests,
        (SELECT count(*) FROM pods)::int AS pods,
        (SELECT count(*) FROM challenges WHERE status = 'active')::int AS active_challenges,
        (SELECT count(*) FROM challenges WHERE status = 'pending')::int AS pending_challenges,
        (SELECT count(*) FROM notifications WHERE created_at >= ${ET_MIDNIGHT})::int AS notifications_today,
        (SELECT count(*) FROM notifications WHERE read_at IS NULL)::int AS notifications_unread,
        (SELECT count(*) FROM activity_events)::int AS events,
        (SELECT min(created_at) FROM activity_events) AS events_since,
        (SELECT count(DISTINCT uid) FROM (
          SELECT actor_user_id AS uid FROM activity_events WHERE actor_user_id IS NOT NULL AND created_at >= ${utcAgo(7)}
          UNION SELECT user_id FROM scores WHERE created_at >= ${utcAgo(7)}) a)::int AS active_7d_app,
        (SELECT count(DISTINCT uid) FROM (
          SELECT actor_user_id AS uid FROM activity_events WHERE actor_user_id IS NOT NULL AND created_at >= ${utcAgo(30)}
          UNION SELECT user_id FROM scores WHERE created_at >= ${utcAgo(30)}) a)::int AS active_30d_app
    `) as any[];

    // Clerk's last_active_at for everyone (batched + cached 60 s in clerkAdmin.ts).
    const all = await db.select({ clerkId: users.clerkId }).from(users);
    const clerk = await getClerkActivity(all.map(u => u.clerkId));
    let active7: number | null = null;
    let active30: number | null = null;
    if (clerk.size) {
      const now = Date.now();
      const within = (days: number) => [...clerk.values()].filter(a => a?.lastActiveAt && now - +new Date(a.lastActiveAt) <= days * 86_400_000).length;
      active7 = within(7);
      active30 = within(30);
    }

    // System health — read-only, never calls Pinball Map (same sources as /api/admin/health).
    const pm = pmClient().stats();
    let catalog: { machineCount: number; fetchedAt: string | null; stale: boolean; lastError: string | null } | null = null;
    try {
      const c = await getCatalogStatus();
      catalog = { machineCount: c.machineCount, fetchedAt: c.fetchedAt ? c.fetchedAt.toISOString() : null, stale: !!c.stale, lastError: c.lastError ?? null };
    } catch { /* shown as unknown */ }
    const lastRuns = await db
      .select({ type: activityEvents.type, at: sql<string>`max(${activityEvents.createdAt})` })
      .from(activityEvents)
      .where(inArray(activityEvents.type, ['system.stat_snapshot', 'system.challenge_sweep', 'system.activity_retention']))
      .groupBy(activityEvents.type);
    const [snap] = await db.select({ at: sql<string | null>`max(${statHistory.createdAt})` }).from(statHistory);
    const [lastRetention, orphanState] = await Promise.all([lastRetentionRun(), loadOrphanRunState()]);

    res.json({
      counts,
      activeUsers: { clerk7d: active7, clerk30d: active30, app7d: counts.active_7d_app, app30d: counts.active_30d_app },
      health: {
        pm: { mode: pm.mode, liveCallsToday: pm.liveCallsToday, breakerOpenUntil: pm.breakerOpenUntil ? new Date(pm.breakerOpenUntil).toISOString() : null, breakerReason: pm.breakerReason, catalog },
        r2: { configured: missingR2Vars().length === 0 },
        clerkWebhook: { configured: !!process.env.CLERK_WEBHOOK_SIGNING_SECRET },
        clerkApi: { reachable: clerk.size > 0 || all.length === 0 },
        cron: {
          statSnapshot: lastRuns.find(r => r.type === 'system.stat_snapshot')?.at ?? snap?.at ?? null,
          challengeSweep: lastRuns.find(r => r.type === 'system.challenge_sweep')?.at ?? null,
          activityRetention: lastRetention,
          photoOrphans: orphanSummary(orphanState),
        },
      },
    });
  } catch (err) { fail500(res, 'load overview', err); }
});

// ── users ────────────────────────────────────────────────────────────────────

// Correlated subqueries name the outer row explicitly: in a single-table select Drizzle renders
// ${users.id} as a bare "id", which inside "FROM scores s" would bind to s.id instead.
const OUTER_USER_ID = sql.raw('"users"."id"');
const OUTER_POD_ID = sql.raw('"pods"."id"');
const scoreCountSql = sql<number>`(SELECT count(*) FROM scores s WHERE s.user_id = ${OUTER_USER_ID})`.mapWith(Number);
const lastScoreSql = sql<string | null>`(SELECT max(s.created_at) FROM scores s WHERE s.user_id = ${OUTER_USER_ID})`;
const friendCountSql = sql<number>`(SELECT count(*) FROM friendships f WHERE f.status = 'accepted' AND (f.requester_id = ${OUTER_USER_ID} OR f.addressee_id = ${OUTER_USER_ID}))`.mapWith(Number);

// GET /api/admin/users?q=&filter=all|disabled|admins — everyone (TiltTrack is small), newest first.
router.get('/users', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 50) : '';
  const filter = req.query.filter;
  try {
    const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    const rows = await db
      .select({
        id: users.id, username: users.username, displayName: users.displayName, role: users.role,
        createdAt: users.createdAt, pinballMapUsername: users.pinballMapUsername,
        disabledAt: users.disabledAt, disabledReason: users.disabledReason, clerkId: users.clerkId,
        scoreCount: scoreCountSql, lastScoreAt: lastScoreSql, friendCount: friendCountSql,
      })
      .from(users)
      .where(and(
        q ? sql`(lower(${users.username}) LIKE ${like} OR lower(${users.displayName}) LIKE ${like})` : undefined,
        filter === 'disabled' ? isNotNull(users.disabledAt) : filter === 'admins' ? eq(users.role, 'admin') : undefined,
      ))
      .orderBy(desc(users.createdAt))
      .limit(500);
    const clerk = await getClerkActivity(rows.map(r => r.clerkId));
    res.json({
      clerkAvailable: clerk.size > 0 || rows.length === 0,
      items: rows.map(({ clerkId, ...r }) => ({ ...r, clerk: clerk.get(clerkId) ?? null })),
    });
  } catch (err) { fail500(res, 'load users', err); }
});

// GET /api/admin/users/:id — everything the user detail page shows (first activity page included).
router.get('/users/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'User not found' });
  try {
    const [u] = await db.select({
      id: users.id, username: users.username, displayName: users.displayName, role: users.role, createdAt: users.createdAt,
      clerkId: users.clerkId, pinballMapUsername: users.pinballMapUsername,
      hasPmToken: sql<boolean>`(${users.pinballMapToken} IS NOT NULL)`,
      disabledAt: users.disabledAt, disabledReason: users.disabledReason, disabledById: users.disabledById,
    }).from(users).where(eq(users.id, id)).limit(1);
    if (!u) return void res.status(404).json({ error: 'User not found' });

    const other = alias(users, 'other');
    const [clerkMap, counts, friendRows, ownedPods, memberOf, challengeRows, recentScores, disabledBy] = await Promise.all([
      getClerkActivity([u.clerkId]),
      db.execute(sql`
        SELECT
          (SELECT count(*) FROM scores WHERE user_id = ${id})::int AS scores,
          (SELECT count(*) FROM scores WHERE user_id = ${id} AND photo_key IS NOT NULL)::int AS full_photos,
          (SELECT count(*) FROM notifications WHERE user_id = ${id})::int AS notifications,
          (SELECT count(*) FROM notifications WHERE user_id = ${id} AND read_at IS NULL)::int AS unread_notifications,
          (SELECT count(*) FROM venues WHERE owner_id = ${id})::int AS owned_venues`) as Promise<any[]>,
      db.select({
        id: friendships.id, status: friendships.status, declineCount: friendships.declineCount,
        createdAt: friendships.createdAt, respondedAt: friendships.respondedAt,
        outgoing: sql<boolean>`(${friendships.requesterId} = ${id})`, other: { id: other.id, username: other.username, displayName: other.displayName },
      }).from(friendships)
        .innerJoin(other, eq(other.id, sql`CASE WHEN ${friendships.requesterId} = ${id} THEN ${friendships.addresseeId} ELSE ${friendships.requesterId} END`))
        .where(or(eq(friendships.requesterId, id), eq(friendships.addresseeId, id)))
        .orderBy(desc(friendships.createdAt)),
      db.select({
        id: pods.id, name: pods.name, color: pods.color, createdAt: pods.createdAt,
        memberCount: sql<number>`(SELECT count(*) FROM pod_members pm WHERE pm.pod_id = ${OUTER_POD_ID})`.mapWith(Number),
      }).from(pods).where(eq(pods.ownerId, id)).orderBy(asc(pods.name)),
      db.select({ podId: pods.id, name: pods.name, owner: userRef })
        .from(podMembers).innerJoin(pods, eq(pods.id, podMembers.podId)).innerJoin(users, eq(users.id, pods.ownerId))
        .where(eq(podMembers.userId, id)).orderBy(asc(pods.name)),
      challengeList(and(sql`${challenges.id} IN (SELECT challenge_id FROM challenge_participants WHERE user_id = ${id})`)!, 50),
      scoreList(eq(scores.userId, id), 20),
      u.disabledById
        ? db.select(userRef).from(users).where(eq(users.id, u.disabledById)).limit(1)
        : Promise.resolve([]),
    ]);
    const activity = await activityPage({ userId: id, limit: 30 });
    const { clerkId, disabledById, ...profile } = u;
    res.json({
      user: { ...profile, clerkUserId: clerkId, disabledBy: disabledBy[0] ?? null },
      clerk: clerkMap.get(clerkId) ?? null,
      clerkAvailable: clerkMap.size > 0,
      counts: counts[0],
      friendships: friendRows,
      pods: { owned: ownedPods, memberOf },
      challenges: challengeRows.items,
      recentScores: recentScores.items,
      activity,
    });
  } catch (err) { fail500(res, 'load user', err); }
});

router.post('/users/:id/disable', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'User not found' });
  try { send(res, await disableUser((req as any).appUser, id, req.body?.reason, fromReq(req))); } catch (err) { fail500(res, 'disable user', err); }
});

router.post('/users/:id/enable', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'User not found' });
  try { send(res, await enableUser((req as any).appUser, id, fromReq(req))); } catch (err) { fail500(res, 'enable user', err); }
});

router.delete('/users/:id/notifications', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'User not found' });
  try { send(res, await clearUserNotifications((req as any).appUser, id, fromReq(req))); } catch (err) { fail500(res, 'clear notifications', err); }
});

// ── activity ─────────────────────────────────────────────────────────────────

interface ActivityQuery {
  type?: string; category?: string; userId?: number | null; targetType?: string; targetId?: string;
  from?: Date | null; to?: Date | null; before?: number | null; limit?: number;
}

async function activityPage(q: ActivityQuery) {
  const limit = q.limit ?? PAGE;
  const actor = alias(users, 'actor');
  const subject = alias(users, 'subject');
  const cat = q.category && q.category in ACTIVITY_TYPES ? ACTIVITY_TYPES[q.category as ActivityCategory] as readonly string[] : null;
  const rows = await db
    .select({
      id: activityEvents.id, createdAt: activityEvents.createdAt, type: activityEvents.type,
      targetType: activityEvents.targetType, targetId: activityEvents.targetId, payload: activityEvents.payload,
      ip: activityEvents.ip, userAgent: activityEvents.userAgent,
      actor: { id: actor.id, username: actor.username, displayName: actor.displayName },
      subject: { id: subject.id, username: subject.username, displayName: subject.displayName },
    })
    .from(activityEvents)
    .leftJoin(actor, eq(actor.id, activityEvents.actorUserId))
    .leftJoin(subject, eq(subject.id, activityEvents.subjectUserId))
    .where(and(
      q.type ? eq(activityEvents.type, q.type) : undefined,
      cat ? inArray(activityEvents.type, [...cat]) : undefined,
      q.userId ? or(eq(activityEvents.actorUserId, q.userId), eq(activityEvents.subjectUserId, q.userId)) : undefined,
      q.targetType ? eq(activityEvents.targetType, q.targetType) : undefined,
      q.targetId ? eq(activityEvents.targetId, q.targetId) : undefined,
      q.from ? gte(activityEvents.createdAt, q.from) : undefined,
      q.to ? lte(activityEvents.createdAt, q.to) : undefined,
      q.before ? lt(activityEvents.id, q.before) : undefined,
    ))
    .orderBy(desc(activityEvents.id))
    .limit(limit + 1);
  const p = page(rows.map(r => ({
    ...r,
    category: categoryOf(r.type),
    // A left join with no match gives an object of nulls; make it null.
    actor: r.actor?.id != null ? r.actor : null,
    subject: r.subject?.id != null ? r.subject : null,
  })), limit);
  return p;
}

// GET /api/admin/activity?type=&category=&userId=&targetType=&targetId=&from=&to=&before=&limit=
router.get('/activity', async (req, res) => {
  try {
    res.json(await activityPage({
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      userId: intParam(req.query.userId),
      targetType: typeof req.query.targetType === 'string' ? req.query.targetType : undefined,
      targetId: typeof req.query.targetId === 'string' ? req.query.targetId : undefined,
      from: dateParam(req.query.from),
      to: dateParam(req.query.to),
      before: intParam(req.query.before),
      limit: pageSize(req.query.limit),
    }));
  } catch (err) { fail500(res, 'load activity', err); }
});

router.get('/activity/types', (_req, res) => {
  res.json(ACTIVITY_TYPES);
});

// ── maintenance: activity-log retention + photo orphan sweep ─────────────────

/** The newest system.activity_retention event: when it ran and what it deleted. */
async function lastRetentionRun() {
  const [row] = await db.select({ at: activityEvents.createdAt, payload: activityEvents.payload })
    .from(activityEvents).where(eq(activityEvents.type, 'system.activity_retention'))
    .orderBy(desc(activityEvents.id)).limit(1);
  if (!row) return null;
  const p = row.payload as Record<string, any>;
  return { at: row.at, deleted: p.deleted ?? null, total: p.total ?? 0, capped: !!p.capped, errors: Array.isArray(p.errors) ? p.errors.length : 0 };
}

function orphanSummary(state: Awaited<ReturnType<typeof loadOrphanRunState>>) {
  const r = state.lastRun;
  const nextDueAt = state.lastDeleteRunAt ? new Date(+new Date(state.lastDeleteRunAt) + ORPHAN_RUN_INTERVAL_MS).toISOString() : null;
  return {
    lastRun: r ? {
      at: r.at, trigger: r.trigger, dryRun: r.dryRun, listed: r.listed, orphans: r.orphans, orphanBytes: r.orphanBytes,
      deleted: r.deleted, failed: r.failed, skippedReferenced: r.skippedReferenced, capped: r.capped,
    } : null,
    lastDeleteRunAt: state.lastDeleteRunAt,
    nextDueAt,
    dueNow: orphanSweepDue(state.lastDeleteRunAt, Date.now()),
  };
}

async function retentionView() {
  const view = await loadRetentionSettings();
  const [tiers, lastRun, updatedBy] = await Promise.all([
    retentionStatus(view.settings),
    lastRetentionRun(),
    view.updatedById ? db.select(userRef).from(users).where(eq(users.id, view.updatedById)).limit(1) : Promise.resolve([]),
  ]);
  return {
    settings: view.settings,
    defaults: view.defaults,
    limits: RETENTION_LIMITS,
    isDefault: view.isDefault,
    updatedAt: view.updatedAt,
    updatedBy: updatedBy[0] ?? null,
    tiers,
    typesByTier: { high_volume: typesInTier('high_volume'), standard: typesInTier('standard'), admin: typesInTier('admin') },
    defaultTier: DEFAULT_TIER,
    adminPrefix: ADMIN_PREFIX,
    lastRun,
  };
}

// GET /api/admin/settings/retention — settings, per-tier counts / oldest / would-delete, last run.
router.get('/settings/retention', async (_req, res) => {
  try { res.json(await retentionView()); } catch (err) { fail500(res, 'load retention settings', err); }
});

// PUT /api/admin/settings/retention {highVolumeDays, standardDays, adminDays}
router.put('/settings/retention', async (req, res) => {
  const v = validateRetentionSettings(req.body);
  if (!v.ok) return void res.status(400).json({ error: Object.values(v.errors)[0], code: 'invalid_settings', errors: v.errors });
  try {
    const before = (await loadRetentionSettings()).settings;
    await saveRetentionSettings(v.value, (req as any).appUser.id);
    await logActivity({
      type: 'admin.settings_changed', ...fromReq(req), targetType: 'setting', targetId: RETENTION_SETTING_KEY,
      payload: { setting: RETENTION_SETTING_KEY, before, after: v.value },
    });
    res.json(await retentionView());
  } catch (err) { fail500(res, 'save retention settings', err); }
});

// GET /api/admin/photo-orphans — whether the sweep can run here, last run, next scheduled run.
router.get('/photo-orphans', async (_req, res) => {
  try {
    const store = getPhotoStore();
    res.json({
      configured: !!store,
      envMismatch: store ? envMismatch(process.env.DATABASE_URL, store.bucket) : null,
      ...orphanSummary(await loadOrphanRunState()),
    });
  } catch (err) { fail500(res, 'load photo orphan status', err); }
});

// POST /api/admin/photo-orphans/run {dryRun} — dry run unless dryRun === false (explicitly).
router.post('/photo-orphans/run', async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  try {
    const outcome = await runPhotoOrphanSweep({ dryRun, trigger: 'admin', actorUserId: (req as any).appUser.id });
    if (!outcome.ran) {
      const status = outcome.reason === 'r2_not_configured' ? 503 : 409;
      return void res.status(status).json({ error: outcome.detail ?? 'Full-size photos (R2) are not configured', code: outcome.reason });
    }
    const result = publicOrphanResult(outcome.result);
    await logActivity({ type: 'admin.photo_orphans_run', ...fromReq(req), payload: { ...result, sampleScoreIds: undefined } });
    res.json(result);
  } catch (err) { fail500(res, 'run photo orphan sweep', err); }
});

// ── social ───────────────────────────────────────────────────────────────────

// GET /api/admin/friendships?status=pending|accepted|declined&before=
router.get('/friendships', async (req, res) => {
  const status = typeof req.query.status === 'string' && ['pending', 'accepted', 'declined'].includes(req.query.status) ? req.query.status as 'pending' : null;
  const limit = pageSize(req.query.limit);
  const before = intParam(req.query.before);
  try {
    const requester = alias(users, 'requester');
    const addressee = alias(users, 'addressee');
    const rows = await db.select({
      id: friendships.id, status: friendships.status, declineCount: friendships.declineCount,
      createdAt: friendships.createdAt, respondedAt: friendships.respondedAt,
      requester: { id: requester.id, username: requester.username, displayName: requester.displayName },
      addressee: { id: addressee.id, username: addressee.username, displayName: addressee.displayName },
    }).from(friendships)
      .innerJoin(requester, eq(requester.id, friendships.requesterId))
      .innerJoin(addressee, eq(addressee.id, friendships.addresseeId))
      .where(and(status ? eq(friendships.status, status) : undefined, before ? lt(friendships.id, before) : undefined))
      .orderBy(desc(friendships.id))
      .limit(limit + 1);
    const summary = await db.select({ status: friendships.status, n: sql<number>`count(*)`.mapWith(Number), declines: sql<number>`coalesce(sum(${friendships.declineCount}), 0)`.mapWith(Number) })
      .from(friendships).groupBy(friendships.status);
    res.json({ ...page(rows, limit), summary });
  } catch (err) { fail500(res, 'load friendships', err); }
});

router.delete('/friendships/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'Friendship not found' });
  try { send(res, await removeFriendship((req as any).appUser, id, fromReq(req))); } catch (err) { fail500(res, 'remove friendship', err); }
});

async function challengeList(where: SQL | undefined, limit: number, before?: number | null) {
  const creator = alias(users, 'creator');
  const rows = await db.select({
    id: challenges.id, type: challenges.type, status: challenges.status, createdAt: challenges.createdAt,
    startsAt: challenges.startsAt, endsAt: challenges.endsAt, resolvedAt: challenges.resolvedAt,
    targetScore: challenges.targetScore, minPlays: challenges.minPlays,
    adminCancelledAt: challenges.adminCancelledAt, adminCancelReason: challenges.adminCancelReason,
    machine: { id: machines.id, name: machines.name },
    venue: { id: venues.id, name: venues.name },
    creator: { id: creator.id, username: creator.username, displayName: creator.displayName },
  }).from(challenges)
    .innerJoin(machines, eq(machines.id, challenges.machineId))
    .innerJoin(creator, eq(creator.id, challenges.creatorId))
    .leftJoin(venues, eq(venues.id, challenges.venueId))
    .where(and(where, before ? lt(challenges.id, before) : undefined))
    .orderBy(desc(challenges.id))
    .limit(limit + 1);
  const ids = rows.map(r => r.id);
  const parts = ids.length ? await db.select({
    challengeId: challengeParticipants.challengeId, response: challengeParticipants.response,
    outcome: challengeParticipants.outcome, rank: challengeParticipants.rank, user: userRef,
  }).from(challengeParticipants).innerJoin(users, eq(users.id, challengeParticipants.userId))
    .where(inArray(challengeParticipants.challengeId, ids)) : [];
  return page(rows.map(r => ({
    ...r,
    venue: r.venue?.id != null ? r.venue : null,
    participants: parts.filter(p => p.challengeId === r.id).map(({ challengeId, ...p }) => p),
  })), limit);
}

// GET /api/admin/challenges?status=pending|active|resolved|declined|cancelled|expired&before=
router.get('/challenges', async (req, res) => {
  const statuses = ['pending', 'active', 'resolved', 'declined', 'cancelled', 'expired'];
  const status = typeof req.query.status === 'string' && statuses.includes(req.query.status) ? req.query.status : null;
  try {
    res.json(await challengeList(status ? eq(challenges.status, status as any) : undefined, pageSize(req.query.limit), intParam(req.query.before)));
  } catch (err) { fail500(res, 'load challenges', err); }
});

router.post('/challenges/:id/void', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'Challenge not found' });
  try { send(res, await voidChallenge((req as any).appUser, id, req.body?.reason, fromReq(req))); } catch (err) { fail500(res, 'void challenge', err); }
});

// GET /api/admin/notifications?userId=&unread=1&kind=&before=
router.get('/notifications', async (req, res) => {
  const userId = intParam(req.query.userId);
  const limit = pageSize(req.query.limit);
  const before = intParam(req.query.before);
  const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
  try {
    const rows = await db.select({
      id: notifications.id, kind: notifications.kind, payload: notifications.payload,
      createdAt: notifications.createdAt, readAt: notifications.readAt, user: userRef,
    }).from(notifications).innerJoin(users, eq(users.id, notifications.userId))
      .where(and(
        userId ? eq(notifications.userId, userId) : undefined,
        req.query.unread === '1' ? isNull(notifications.readAt) : undefined,
        kind ? eq(notifications.kind, kind) : undefined,
        before ? lt(notifications.id, before) : undefined,
      ))
      .orderBy(desc(notifications.id))
      .limit(limit + 1);
    const [summary] = await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
             count(*) FILTER (WHERE created_at >= ${ET_MIDNIGHT})::int AS today
      FROM notifications`) as any[];
    res.json({ ...page(rows, limit), summary });
  } catch (err) { fail500(res, 'load notifications', err); }
});

router.delete('/notifications/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'Notification not found' });
  try { send(res, await deleteNotification((req as any).appUser, id, fromReq(req))); } catch (err) { fail500(res, 'delete notification', err); }
});

// ── scores & photos ──────────────────────────────────────────────────────────

async function scoreList(where: SQL | undefined, limit: number, before?: number | null) {
  const rows = await db.select({
    id: scores.id, score: scores.score, playedAt: scores.playedAt, createdAt: scores.createdAt, type: scores.type,
    venueId: scores.venueId, venueName: scores.venueName,
    photoThumbnail: scores.photoThumbnail,
    hasFullPhoto: sql<boolean>`(${scores.photoKey} IS NOT NULL)`.mapWith(Boolean),
    photoBytes: scores.photoBytes,
    machine: { id: machines.id, name: machines.name },
    user: userRef,
  }).from(scores)
    .innerJoin(machines, eq(machines.id, scores.machineId))
    .innerJoin(users, eq(users.id, scores.userId))
    .where(and(where, before ? lt(scores.id, before) : undefined))
    .orderBy(desc(scores.id))
    .limit(limit + 1);
  const locks = await locksFor(rows.map(r => r.id));
  return page(rows.map(r => ({ ...r, lockedBy: locks.get(r.id) ?? [] })), limit);
}

// GET /api/admin/scores?userId=&photo=full|thumb|none&before= — newest uploads first.
router.get('/scores', async (req, res) => {
  const userId = intParam(req.query.userId);
  const photo = req.query.photo;
  try {
    res.json(await scoreList(and(
      userId ? eq(scores.userId, userId) : undefined,
      photo === 'full' ? isNotNull(scores.photoKey)
        : photo === 'thumb' ? isNotNull(scores.photoThumbnail)
          : photo === 'none' ? and(isNull(scores.photoKey), isNull(scores.photoThumbnail)) : undefined,
    ), pageSize(req.query.limit), intParam(req.query.before)));
  } catch (err) { fail500(res, 'load scores', err); }
});

router.delete('/scores/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'Score not found' });
  try { send(res, await deleteScoreAsAdmin((req as any).appUser, id, fromReq(req))); } catch (err) { fail500(res, 'delete score', err); }
});

router.delete('/scores/:id/photo', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'Score not found' });
  try { send(res, await deleteFullPhotoAsAdmin((req as any).appUser, id, fromReq(req))); } catch (err) { fail500(res, 'delete photo', err); }
});

router.delete('/scores/:id/thumbnail', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return void res.status(404).json({ error: 'Score not found' });
  try { send(res, await deleteThumbnailAsAdmin((req as any).appUser, id, fromReq(req))); } catch (err) { fail500(res, 'delete thumbnail', err); }
});

export default router;
