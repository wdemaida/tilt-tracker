import { db, badges, badgeSeries, userBadges, users, scores, machines, venues, notifications, challengeParticipants, activityEvents, type Badge } from '@workspace/db';
import { and, asc, desc, eq, gte, inArray, isNull, lte, notExists, or, sql, type SQL } from 'drizzle-orm';
import sharp from 'sharp';
import { buildActivityRow, isActivityRecorded, logActivity, type Executor } from './activity.js';
import { raiseNotificationsBulk } from './notify.js';
import { canSeeScore, type Viewer } from './venueActivity.js';
import {
  METRICS, PENDING_METRICS, metricByKey, metricCounts, readMetric, describeMetric, recordMarks, friendMarks,
  loginMark, metricsFor, type FriendEvent,
} from './badgeMetrics.js';
import { normalizeRule, ruleSatisfied, describeRule, type BadgeRule, type RuleScore } from './badgeRules.js';
import { orderBadges, tierNumbers, collapseShelf, normalizeSeriesInput, type SeriesRef } from './badgeSeries.js';

// Badges — the engine (feature/badges). Every award goes through here, whatever earned it:
//
//   awardBadges(userId, { metrics, score })  a trigger fired: re-check the LIVE badges it could affect
//                                            (metric badges on the metrics that changed; rule badges
//                                            when a score was posted). Skips badges the user has and
//                                            badges outside their availability window. Never throws.
//   previewBadge / activateBadge            admin dry run / go live (+ retroactive backfill)
//   backfillBadge                           backfill a live retroactive badge (Backfill now, or a PATCH turning retroactive on)
//   grantBadge / revokeBadge                admin manual awards (no automatic revocation, ever)
//   runBadgeSweep                           daily safety net from runDailyHousekeeping
//
// Triggers wired today: POST /api/scores, the friend routes (marks + both users), the Clerk
// webhook's session.created (login_days mark, written even when the retention gate skips the
// event), the daily sweep.
// TODO(phase 3): challenge triggers — call awardBadges(userId, { metrics: metricsFor('challenge'),
// challengeId }) for every participant from applyResolution() (lib/challenges.ts) and from the
// decline / counter routes (routes/challenges.ts), and set source_challenge_id on the award (the
// `challengeId` option is accepted and stored already). Phases 1–2 deliberately don't touch those files.
//
// Every new award inserts user_badges ON CONFLICT DO NOTHING (earned once — the PK), raises a
// `badge_earned` notification and logs `badge.earned` (or `badge.granted`).

// ── shapes ───────────────────────────────────────────────────────────────────

/**
 * Every badge column except the image bytes. `color` is the color the badge is drawn in — its
 * series' color when it's a tier (one color per series, so tiers can't drift), else its own;
 * `ownColor` is the badge's own column (the admin editor's value for a single).
 */
export const badgeCols = {
  id: badges.id, key: badges.key, name: badges.name, description: badges.description, icon: badges.icon,
  color: sql<string>`coalesce((SELECT bs.color FROM badge_series bs WHERE bs.id = ${badges.seriesId}), ${badges.color})`,
  ownColor: badges.color, seriesId: badges.seriesId,
  imageVersion: badges.imageVersion, hasImage: sql<boolean>`(${badges.image} IS NOT NULL)`,
  kind: badges.kind, metric: badges.metric, threshold: badges.threshold, rule: badges.rule, retroactive: badges.retroactive,
  status: badges.status, availableFrom: badges.availableFrom, availableTo: badges.availableTo, activatedAt: badges.activatedAt,
  sortOrder: badges.sortOrder, createdById: badges.createdById, createdAt: badges.createdAt, updatedAt: badges.updatedAt,
};
export type BadgeRow = Omit<Badge, 'image'> & { hasImage: boolean; ownColor: string };

/** What earns it, in plain English. */
export function requirementText(b: Pick<BadgeRow, 'kind' | 'metric' | 'threshold' | 'rule'>): string {
  if (b.kind === 'metric' && b.metric) return describeMetric(b.metric, b.threshold ?? 1);
  if (b.kind === 'rule' && b.rule) return describeRule(b.rule as BadgeRule);
  return 'Awarded by the TiltTrack team';
}

/** The public face of a badge — no rule internals, no admin fields. */
export function publicBadge(b: BadgeRow) {
  return {
    id: b.id, key: b.key, name: b.name, description: b.description, icon: b.icon, color: b.color,
    imageVersion: b.hasImage ? b.imageVersion : null,
    seriesId: b.seriesId ?? null,
    requirement: requirementText(b),
    availableFrom: b.availableFrom?.toISOString() ?? null,
    availableTo: b.availableTo?.toISOString() ?? null,
    // The play-date window of a date rule, for "Earn it on Dec 25" (venue-local dates, YYYY-MM-DD).
    localDate: b.kind === 'rule' ? ((b.rule as BadgeRule | null)?.localDate ?? null) : null,
    retired: b.status === 'retired',
  };
}
export type PublicBadge = ReturnType<typeof publicBadge>;

const windowOpenSql = (now: Date) => and(
  or(isNull(badges.availableFrom), lte(badges.availableFrom, now)),
  or(isNull(badges.availableTo), gte(badges.availableTo, now)),
);

export function windowOpen(b: Pick<BadgeRow, 'availableFrom' | 'availableTo'>, now: Date): boolean {
  return (!b.availableFrom || +b.availableFrom <= +now) && (!b.availableTo || +b.availableTo >= +now);
}

// ── rule scores ──────────────────────────────────────────────────────────────

/**
 * Candidate scores for a rule, narrowed in SQL (everything but the local-time conditions, which
 * need each venue's zone and are checked in TypeScript by ruleSatisfied). `since` = only scores
 * posted at or after it (a forward-only badge's activation).
 */
export async function loadRuleScores(ex: Executor, rule: BadgeRule, opts: { userIds?: number[]; since?: Date | null } = {}): Promise<Array<RuleScore & { userId: number }>> {
  const conds: SQL[] = [];
  if (opts.userIds) {
    if (!opts.userIds.length) return [];
    conds.push(inArray(scores.userId, opts.userIds));
  }
  if (opts.since) conds.push(gte(scores.createdAt, opts.since));
  if (rule.minScore != null) conds.push(gte(scores.score, rule.minScore));
  if (rule.scoreType) conds.push(eq(scores.type, rule.scoreType));
  if (rule.venueId != null) conds.push(eq(scores.venueId, rule.venueId));
  if (rule.requiresPhoto) conds.push(sql`(${scores.photoUrl} IS NOT NULL OR ${scores.photoThumbnail} IS NOT NULL)`);
  if (rule.city) conds.push(sql`lower(trim(${venues.city})) = ${rule.city.trim().toLowerCase()}`);
  if (rule.state) conds.push(sql`lower(trim(${venues.state})) = ${rule.state.trim().toLowerCase()}`);
  if (rule.machine) {
    const group = rule.machine.matchMode === 'group' ? rule.machine.matchGroup : null;
    conds.push(group
      ? sql`(${scores.machineId} = ${rule.machine.machineId} OR split_part(${machines.opdbId}, '-', 1) = ${group})`
      : eq(scores.machineId, rule.machine.machineId));
  }
  if (rule.localDate) {
    // A local date is within a day of the UTC one; the exact check happens per venue zone.
    conds.push(sql`${scores.playedAt} >= ${rule.localDate.from}::date - 1 AND ${scores.playedAt} < ${rule.localDate.to}::date + 2`);
  }
  const rows = await ex
    .select({
      id: scores.id, userId: scores.userId, machineId: scores.machineId, opdbId: machines.opdbId, venueId: scores.venueId,
      venueCity: venues.city, venueState: venues.state, venueTimezone: venues.timezone,
      score: scores.score, type: scores.type, playedAt: scores.playedAt, createdAt: scores.createdAt,
      hasPhoto: sql<boolean>`(${scores.photoUrl} IS NOT NULL OR ${scores.photoThumbnail} IS NOT NULL)`,
    })
    .from(scores)
    .innerJoin(machines, eq(machines.id, scores.machineId))
    .leftJoin(venues, eq(venues.id, scores.venueId))
    .where(conds.length ? and(...conds) : undefined);
  return rows.map(r => ({ ...r, score: Number(r.score), hasPhoto: !!r.hasPhoto }));
}

/** A forward-only rule badge only counts scores posted after it went live. */
const ruleSince = (b: Pick<BadgeRow, 'retroactive' | 'activatedAt'>) => (b.retroactive ? null : b.activatedAt ?? null);

// ── awarding ─────────────────────────────────────────────────────────────────

export interface AwardInput {
  userId: number;
  badgeId: number;
  sourceScoreId?: number | null;
  sourceChallengeId?: number | null;
  grantedById?: number | null;
  note?: string | null;
}

/**
 * Insert awards (ON CONFLICT DO NOTHING) and, for each one that was new, raise `badge_earned` and
 * log it. Returns the new rows. Throws on DB errors — awardBadges wraps it.
 */
async function insertAwards(inputs: AwardInput[], byId: Map<number, BadgeRow>, ctx: { trigger: string; actorUserId?: number | null }) {
  const out: AwardInput[] = [];
  for (let i = 0; i < inputs.length; i += 500) {
    const chunk = inputs.slice(i, i + 500);
    const rows = await db.insert(userBadges).values(chunk.map(a => ({
      userId: a.userId, badgeId: a.badgeId, sourceScoreId: a.sourceScoreId ?? null, sourceChallengeId: a.sourceChallengeId ?? null,
      grantedById: a.grantedById ?? null, note: a.note ?? null,
    }))).onConflictDoNothing().returning({ userId: userBadges.userId, badgeId: userBadges.badgeId });
    const fresh = new Set(rows.map(r => `${r.userId}:${r.badgeId}`));
    out.push(...chunk.filter(a => fresh.has(`${a.userId}:${a.badgeId}`)));
  }
  if (!out.length) return out;
  // Every recipient is notified — trigger, grant and retroactive backfill alike — in bulk, deduped
  // on badgeId (one unread badge_earned per user per badge; a revoke-then-regrant replaces rather
  // than stacks). One statement per 500 recipients, not three round trips per recipient: a backfill
  // used to spend ~200 ms per player here, inside the admin's Go live request.
  try {
    await raiseNotificationsBulk(db, 'badge_earned', out.map(a => ({ userId: a.userId, payload: badgeNotificationPayload(byId.get(a.badgeId)!, a) })), 'badgeId');
  } catch (err) {
    console.error('[badges] notification failed:', err);
  }
  await logAwardEvents(out, byId, ctx);
  return out;
}

/** The `badge_earned` payload (NotificationsPage renders it; the toast reads badgeId to dedupe). */
export function badgeNotificationPayload(b: BadgeRow, a: Pick<AwardInput, 'grantedById'>): Record<string, unknown> {
  return {
    badgeId: b.id, badgeName: b.name, icon: b.icon, color: b.color, imageVersion: b.hasImage ? b.imageVersion : null,
    ...(a.grantedById ? { granted: true } : {}),
  };
}

/** `badge.earned` / `badge.granted`, bulk-inserted. Never throws (logActivity's contract). */
async function logAwardEvents(out: AwardInput[], byId: Map<number, BadgeRow>, ctx: { trigger: string }) {
  try {
    const recorded = new Map<string, boolean>();
    const rows = [];
    for (const a of out) {
      const b = byId.get(a.badgeId)!;
      const granted = a.grantedById != null;
      const type = granted ? 'badge.granted' : 'badge.earned';
      if (!recorded.has(type)) recorded.set(type, await isActivityRecorded(type));
      if (!recorded.get(type)) continue;
      rows.push(buildActivityRow({
        type,
        actorUserId: granted ? a.grantedById : a.userId,
        subjectUserId: granted ? a.userId : null,
        targetType: 'badge', targetId: b.id,
        payload: { badgeKey: b.key, name: b.name, trigger: ctx.trigger, sourceScoreId: a.sourceScoreId ?? null, ...(a.note ? { note: a.note } : {}) },
      }));
    }
    for (let i = 0; i < rows.length; i += 500) await db.insert(activityEvents).values(rows.slice(i, i + 500));
  } catch (err: any) {
    console.error('[activity] failed to log badge awards:', err?.message ?? err);
  }
}

/**
 * A trigger fired for `userId`: award any live badge it completes. `metrics` = the metric keys that
 * may have changed; `score` = a score was just posted (rule badges). Returns the badges newly
 * earned (for the POST /api/scores response). NEVER throws — a badge problem must not fail the
 * action that triggered it (same contract as onScoreCreated).
 */
export async function awardBadges(
  userId: number,
  opts: { metrics?: string[]; score?: { id: number } | null; challengeId?: number | null; now?: Date; trigger?: string },
): Promise<PublicBadge[]> {
  try {
    const now = opts.now ?? new Date();
    const which: SQL[] = [];
    const metrics = (opts.metrics ?? []).filter(k => metricByKey(k));
    if (metrics.length) which.push(and(eq(badges.kind, 'metric'), inArray(badges.metric, metrics))!);
    if (opts.score) which.push(eq(badges.kind, 'rule'));
    if (!which.length) return [];

    const candidates = await db.select(badgeCols).from(badges).where(and(
      eq(badges.status, 'live'),
      windowOpenSql(now),
      or(...which),
      notExists(db.select({ one: sql`1` }).from(userBadges).where(and(eq(userBadges.badgeId, badges.id), eq(userBadges.userId, userId)))),
    )) as BadgeRow[];
    if (!candidates.length) return [];

    const values = new Map<string, number>();
    const awards: AwardInput[] = [];
    for (const b of candidates) {
      if (b.kind === 'metric' && b.metric && b.threshold != null) {
        if (!values.has(b.metric)) values.set(b.metric, await readMetric(db, b.metric, userId));
        if (values.get(b.metric)! >= b.threshold) awards.push({ userId, badgeId: b.id, sourceChallengeId: opts.challengeId ?? null });
      } else if (b.kind === 'rule' && b.rule) {
        const rule = b.rule as BadgeRule;
        const res = ruleSatisfied(rule, await loadRuleScores(db, rule, { userIds: [userId], since: ruleSince(b) }));
        if (res.met) awards.push({ userId, badgeId: b.id, sourceScoreId: res.sourceScoreId });
      }
    }
    if (!awards.length) return [];
    const byId = new Map(candidates.map(b => [b.id, b]));
    const fresh = await insertAwards(awards, byId, { trigger: opts.trigger ?? (opts.score ? 'score' : 'metric') });
    return fresh.map(a => publicBadge(byId.get(a.badgeId)!));
  } catch (err) {
    console.error('[badges] awardBadges failed:', err);
    return [];
  }
}

/** POST /api/scores: the score metrics and every rule badge. Never throws. */
export function onScoreBadges(score: { id: number; userId: number }): Promise<PublicBadge[]> {
  return awardBadges(score.userId, { metrics: metricsFor('score'), score, trigger: 'score' });
}

/** A friend event: write its marks, then re-check both users. Never throws. */
export async function onFriendBadges(ev: FriendEvent): Promise<void> {
  try {
    const marks = friendMarks(ev);
    await recordMarks(db, marks);
    const byUser = new Map<number, string[]>();
    for (const m of marks) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m.metric]);
    for (const [uid, keys] of byUser) await awardBadges(uid, { metrics: keys, trigger: 'friend' });
  } catch (err) {
    console.error('[badges] friend hook failed:', err);
  }
}

/** A sign-in (Clerk webhook): one login_days mark per Eastern day. Never throws. */
export async function onSignInBadges(userId: number, at: Date = new Date()): Promise<void> {
  try {
    await recordMarks(db, [loginMark(userId, at)], at);
    await awardBadges(userId, { metrics: ['login_days'], trigger: 'login' });
  } catch (err) {
    console.error('[badges] sign-in hook failed:', err);
  }
}

// ── daily sweep ──────────────────────────────────────────────────────────────

/**
 * Safety net: re-check every metric badge for users active in the last day (posted a score or got
 * a mark), in case a trigger was missed (a crash between insert and award, a badge that went live
 * after the event). Bounded by activity, not by the user table.
 */
export async function runBadgeSweep(now = new Date()): Promise<{ users: number; awarded: number }> {
  const since = new Date(+now - 25 * 3_600_000);
  const active = await db.execute(sql`
    SELECT user_id FROM scores WHERE created_at >= ${since.toISOString()}::timestamptz AT TIME ZONE 'UTC'
    UNION
    SELECT user_id FROM user_metric_marks WHERE at >= ${since.toISOString()}::timestamptz AT TIME ZONE 'UTC'`) as unknown as Array<{ user_id: number }>;
  const keys = METRICS.map(m => m.key);
  let awarded = 0;
  for (const { user_id } of active) awarded += (await awardBadges(Number(user_id), { metrics: keys, now, trigger: 'sweep' })).length;
  return { users: active.length, awarded };
}

// ── admin: preview / activate / retire / grant / revoke ──────────────────────

export interface ActionResult { status: number; body: Record<string, unknown> }
const fail = (status: number, code: string, error: string): ActionResult => ({ status, body: { error, code } });

export async function loadBadge(id: number): Promise<BadgeRow | undefined> {
  const [b] = await db.select(badgeCols).from(badges).where(eq(badges.id, id)).limit(1);
  return b as BadgeRow | undefined;
}

/** Why this badge can't be earned automatically as configured, or null. */
export function activationBlocker(b: { kind: string; metric: string | null; threshold: number | null; rule: unknown }): { code: string; error: string } | null {
  if (b.kind === 'metric') {
    if (!b.metric || b.threshold == null) return { code: 'invalid_badge', error: 'A metric badge needs a metric and a threshold' };
    if (!metricByKey(b.metric)) {
      return PENDING_METRICS.some(p => p.key === b.metric)
        ? { code: 'metric_unavailable', error: 'That metric arrives with the challenge hooks (phase 3) — it can’t go live yet' }
        : { code: 'unknown_metric', error: `Unknown metric ${b.metric}` };
    }
  }
  if (b.kind === 'rule') {
    const r = normalizeRule(b.rule);
    if ('errors' in r) return { code: 'invalid_rule', error: r.errors.join('; ') };
  }
  return null;
}

interface Qualifier { userId: number; value?: number; sourceScoreId?: number | null }

/** Everyone who meets the badge today, from history (metric: one GROUP BY; rule: SQL-narrowed scores). */
async function qualifiers(b: BadgeRow, opts: { since?: Date | null } = {}): Promise<Qualifier[]> {
  if (b.kind === 'metric' && b.metric && b.threshold != null) {
    const counts = await metricCounts(db, b.metric, { min: b.threshold });
    return [...counts].map(([userId, value]) => ({ userId, value }));
  }
  if (b.kind === 'rule' && b.rule) {
    const rule = b.rule as BadgeRule;
    const byUser = new Map<number, RuleScore[]>();
    for (const s of await loadRuleScores(db, rule, { since: opts.since ?? null })) {
      byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
    }
    const out: Qualifier[] = [];
    for (const [userId, list] of byUser) {
      const r = ruleSatisfied(rule, list);
      if (r.met) out.push({ userId, sourceScoreId: r.sourceScoreId, value: r.progress });
    }
    return out;
  }
  return [];
}

const PREVIEW_LIMIT = 200;

/**
 * Dry run: who qualifies from history right now. Writes nothing. For a forward-only badge the list
 * is who *would* have qualified — they won't get it at activation (the UI says so).
 */
export async function previewBadge(id: number, now = new Date()): Promise<ActionResult> {
  const b = await loadBadge(id);
  if (!b) return fail(404, 'badge_not_found', 'Badge not found');
  if (b.kind === 'manual') return { status: 200, body: { kind: 'manual', total: 0, newCount: 0, qualifying: [], retroactive: b.retroactive, outsideWindow: !windowOpen(b, now) } };
  const blocker = activationBlocker(b);
  if (blocker) return fail(400, blocker.code, blocker.error);
  const q = await qualifiers(b);
  const holders = new Set((await db.select({ userId: userBadges.userId }).from(userBadges).where(eq(userBadges.badgeId, id))).map(r => r.userId));
  const shown = q.sort((x, y) => (y.value ?? 0) - (x.value ?? 0) || x.userId - y.userId).slice(0, PREVIEW_LIMIT);
  const people = shown.length
    ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, shown.map(s => s.userId)))
    : [];
  const byId = new Map(people.map(p => [p.id, p]));
  return {
    status: 200,
    body: {
      kind: b.kind,
      retroactive: b.retroactive,
      outsideWindow: !windowOpen(b, now),
      total: q.length,
      newCount: q.filter(x => !holders.has(x.userId)).length,
      qualifying: shown.filter(s => byId.has(s.userId)).map(s => ({
        user: byId.get(s.userId), value: s.value ?? null, sourceScoreId: s.sourceScoreId ?? null, alreadyHas: holders.has(s.userId),
      })),
    },
  };
}

/** Go live. With `retroactive`, everyone who already qualifies is awarded now (bulk, not per user). */
export async function activateBadge(id: number, adminId: number, now = new Date()): Promise<ActionResult> {
  const b = await loadBadge(id);
  if (!b) return fail(404, 'badge_not_found', 'Badge not found');
  if (b.status === 'live') return fail(409, 'already_live', 'This badge is already live');
  const blocker = activationBlocker(b);
  if (blocker) return fail(400, blocker.code, blocker.error);
  const [updated] = await db.update(badges)
    .set({ status: 'live', activatedAt: sql`coalesce(${badges.activatedAt}, now())` as any, updatedAt: sql`now()` as any })
    .where(and(eq(badges.id, id), sql`${badges.status} <> 'live'`))
    .returning({ id: badges.id });
  if (!updated) return fail(409, 'already_live', 'This badge is already live');

  const { awarded, skippedWindow } = b.retroactive && b.kind !== 'manual'
    ? await backfillLive((await loadBadge(id))!, now)
    : { awarded: 0, skippedWindow: false };
  await logActivity({
    type: 'admin.badge_updated', actorUserId: adminId, targetType: 'badge', targetId: id,
    payload: { action: 'activated', badgeKey: b.key, name: b.name, retroactive: b.retroactive, awarded, skippedWindow },
  });
  return { status: 200, body: { badge: publicBadge((await loadBadge(id))!), awarded, skippedWindow } };
}

/**
 * The retroactive backfill: award everyone who qualifies from history and lacks the badge — one
 * bulk insert (ON CONFLICT DO NOTHING), one notification per *new* recipient, `badge.earned` with
 * trigger 'backfill'. Idempotent: holders are skipped and never re-notified, so running it twice
 * (or concurrently) awards nobody twice. Nothing happens while the availability window is shut.
 */
async function backfillLive(b: BadgeRow, now: Date): Promise<{ awarded: number; skippedWindow: boolean }> {
  if (!windowOpen(b, now)) return { awarded: 0, skippedWindow: true };
  const q = await qualifiers(b);
  const fresh = await insertAwards(q.map(x => ({ userId: x.userId, badgeId: b.id, sourceScoreId: x.sourceScoreId ?? null })),
    new Map([[b.id, b]]), { trigger: 'backfill' });
  return { awarded: fresh.length, skippedWindow: false };
}

/**
 * Backfill a LIVE retroactive badge now. Two callers: the admin's explicit "Backfill now"
 * (`reason: 'manual'`, POST /api/admin/badges/:id/backfill) and a PATCH that turns retroactive on
 * for a badge that's already live (`reason: 'retroactive_enabled'`) — before that fix, backfill only
 * ran inside activation, so switching retroactive on after going live awarded nobody.
 * Logs `admin.badge_updated {action: 'backfilled'}`.
 */
export async function backfillBadge(id: number, adminId: number, reason: 'manual' | 'retroactive_enabled', now = new Date()): Promise<ActionResult> {
  const b = await loadBadge(id);
  if (!b) return fail(404, 'badge_not_found', 'Badge not found');
  if (b.kind === 'manual') return fail(400, 'manual_badge', 'A manual badge has nothing to backfill — grant it by hand');
  if (b.status !== 'live') return fail(409, 'badge_not_live', 'Only a live badge can be backfilled — going live backfills a retroactive badge');
  if (!b.retroactive) return fail(409, 'not_retroactive', 'Turn Retroactive on (and save) to award from history');
  const blocker = activationBlocker(b);
  if (blocker) return fail(400, blocker.code, blocker.error);
  const { awarded, skippedWindow } = await backfillLive(b, now);
  await logActivity({
    type: 'admin.badge_updated', actorUserId: adminId, targetType: 'badge', targetId: id,
    payload: { action: 'backfilled', badgeKey: b.key, name: b.name, trigger: reason, awarded, skippedWindow },
  });
  return { status: 200, body: { awarded, skippedWindow } };
}

export async function retireBadge(id: number, adminId: number): Promise<ActionResult> {
  const b = await loadBadge(id);
  if (!b) return fail(404, 'badge_not_found', 'Badge not found');
  if (b.status === 'retired') return fail(409, 'already_retired', 'This badge is already retired');
  await db.update(badges).set({ status: 'retired', updatedAt: sql`now()` as any }).where(eq(badges.id, id));
  await logActivity({
    type: 'admin.badge_updated', actorUserId: adminId, targetType: 'badge', targetId: id,
    payload: { action: 'retired', badgeKey: b.key, name: b.name, previousStatus: b.status },
  });
  return { status: 200, body: { ok: true } };
}

/** Manual award to named users (any kind of badge, but it must be live). */
export async function grantBadge(id: number, userIds: number[], adminId: number, note: string | null): Promise<ActionResult> {
  const b = await loadBadge(id);
  if (!b) return fail(404, 'badge_not_found', 'Badge not found');
  if (b.status !== 'live') return fail(409, 'badge_not_live', 'Only a live badge can be granted — take it live first');
  const ids = [...new Set(userIds)].filter(n => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return fail(400, 'invalid_users', 'Pick at least one user');
  const found = (await db.select({ id: users.id }).from(users).where(inArray(users.id, ids))).map(r => r.id);
  if (found.length !== ids.length) return fail(404, 'user_not_found', 'One or more users were not found');
  const fresh = await insertAwards(ids.map(userId => ({ userId, badgeId: id, grantedById: adminId, note })), new Map([[id, b]]), { trigger: 'grant' });
  return { status: 200, body: { granted: fresh.length, alreadyHad: ids.length - fresh.length } };
}

export async function revokeBadge(id: number, userId: number, adminId: number, reason: string | null): Promise<ActionResult> {
  const b = await loadBadge(id);
  if (!b) return fail(404, 'badge_not_found', 'Badge not found');
  const [gone] = await db.delete(userBadges).where(and(eq(userBadges.badgeId, id), eq(userBadges.userId, userId)))
    .returning({ earnedAt: userBadges.earnedAt, grantedById: userBadges.grantedById });
  if (!gone) return fail(404, 'not_held', 'That user doesn’t have this badge');
  // The bell shouldn't point at a badge they no longer have.
  await db.delete(notifications).where(and(
    eq(notifications.userId, userId), eq(notifications.kind, 'badge_earned'), isNull(notifications.readAt),
    sql`${notifications.payload} ->> 'badgeId' = ${String(id)}`,
  ));
  await logActivity({
    type: 'badge.revoked', actorUserId: adminId, subjectUserId: userId, targetType: 'badge', targetId: id,
    payload: { badgeKey: b.key, name: b.name, earnedAt: gone.earnedAt, wasGranted: gone.grantedById != null, reason: reason || null },
  });
  return { status: 200, body: { ok: true } };
}

// ── public reads ─────────────────────────────────────────────────────────────

async function earnedCounts(badgeIds?: number[]): Promise<Map<number, number>> {
  const rows = await db.select({ badgeId: userBadges.badgeId, n: sql<number>`count(*)::int` }).from(userBadges)
    .where(badgeIds ? (badgeIds.length ? inArray(userBadges.badgeId, badgeIds) : sql`false`) : undefined)
    .groupBy(userBadges.badgeId);
  return new Map(rows.map(r => [r.badgeId, Number(r.n)]));
}

/** Every series, for ordering and the public `series` field. */
export async function loadSeries(): Promise<SeriesRef[]> {
  return db.select({ id: badgeSeries.id, key: badgeSeries.key, name: badgeSeries.name, color: badgeSeries.color, sortOrder: badgeSeries.sortOrder, descriptionTemplate: badgeSeries.descriptionTemplate })
    .from(badgeSeries).orderBy(asc(badgeSeries.sortOrder), asc(badgeSeries.id));
}

/** The public `series` field of a tier: which ladder, and where in it ("Tier 2 of 4"). */
export type PublicSeriesRef = { id: number; key: string; name: string; color: string; tier: number; tierCount: number };
function seriesField(b: Pick<BadgeRow, 'id' | 'seriesId'>, byId: Map<number, SeriesRef>, tiers: Map<number, { tier: number; tierCount: number }>): PublicSeriesRef | null {
  const s = b.seriesId != null ? byId.get(b.seriesId) : undefined;
  const t = tiers.get(b.id);
  return s && t ? { id: s.id, key: s.key, name: s.name, color: s.color, ...t } : null;
}

/**
 * GET /api/badges — the live catalog in the shared order (series as a unit, tiers consecutive, in
 * tier order), with how many players have each and the viewer’s own earn dates. Still a flat
 * array: a tier carries `series` (tier N of the series' live tiers), so the page groups consecutive
 * tiers into a ladder and an older client just lists them.
 */
export async function badgeCatalog(viewer?: Viewer) {
  const series = await loadSeries();
  const rows = orderBadges(await db.select(badgeCols).from(badges).where(eq(badges.status, 'live')) as BadgeRow[], series);
  const counts = await earnedCounts(rows.map(r => r.id));
  const mine = viewer
    ? new Map((await db.select({ badgeId: userBadges.badgeId, earnedAt: userBadges.earnedAt }).from(userBadges).where(eq(userBadges.userId, viewer.id)))
      .map(r => [r.badgeId, r.earnedAt]))
    : new Map<number, Date>();
  const byId = new Map(series.map(s => [s.id, s]));
  const tiers = tierNumbers(rows);
  return rows.map(b => ({
    ...publicBadge(b), series: seriesField(b, byId, tiers), earnedCount: counts.get(b.id) ?? 0, earnedAt: mine.get(b.id)?.toISOString() ?? null,
  }));
}

/**
 * GET /api/users/:username/badges — public: anyone who can view the profile sees the badges, no
 * friend or pod check. A source score is linked only when the viewer may see it (canSeeScore); a
 * source challenge only for its participants (the challenge record is totals-only for others).
 *
 * `badges` is every earned badge (flat, in the shared order — older clients render it as is);
 * `items` is the shelf as the profile draws it: one entry per series — its highest earned tier, the
 * pips (earned tiers filled, remaining live tiers hollow) and the whole ladder — and each single.
 */
export async function userBadgeShelf(username: string, viewer?: Viewer) {
  const [user] = await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(eq(users.username, username)).limit(1);
  if (!user) return null;
  const series = await loadSeries();
  const rows = orderBadges(await db.select({ ...badgeCols, earnedAt: userBadges.earnedAt, sourceScoreId: userBadges.sourceScoreId, sourceChallengeId: userBadges.sourceChallengeId, note: userBadges.note, granted: sql<boolean>`(${userBadges.grantedById} IS NOT NULL)` })
    .from(userBadges).innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .where(eq(userBadges.userId, user.id)), series);
  const counts = await earnedCounts(rows.map(r => r.id));

  const scoreIds = rows.map(r => r.sourceScoreId).filter((x): x is number => x != null);
  const sources = scoreIds.length
    ? await db.select({
      id: scores.id, userId: scores.userId, score: scores.score, machineName: machines.name,
      venueOwnerId: venues.ownerId, isResidence: venues.isResidence, privacyTier: venues.privacyTier, showMachinesAndScores: venues.showMachinesAndScores, venueId: scores.venueId,
    }).from(scores).innerJoin(machines, eq(machines.id, scores.machineId)).leftJoin(venues, eq(venues.id, scores.venueId)).where(inArray(scores.id, scoreIds))
    : [];
  const visibleScore = new Map(sources.filter(s => canSeeScore(s, s.venueId == null ? null : {
    ownerId: s.venueOwnerId ?? null, isResidence: !!s.isResidence, privacyTier: s.privacyTier ?? 'full', showMachinesAndScores: s.showMachinesAndScores ?? true,
  }, viewer)).map(s => [s.id, { id: s.id, score: Number(s.score), machineName: s.machineName }]));

  const challengeIds = rows.map(r => r.sourceChallengeId).filter((x): x is number => x != null);
  const mineChallenges = viewer && challengeIds.length
    ? new Set((await db.select({ id: challengeParticipants.challengeId }).from(challengeParticipants)
      .where(and(eq(challengeParticipants.userId, viewer.id), inArray(challengeParticipants.challengeId, challengeIds)))).map(r => r.id))
    : new Set<number>();

  // Every tier of each series they've earned anything in (any status — collapseShelf keeps the live
  // ones and the ones they earned).
  const seriesIds = [...new Set(rows.map(r => r.seriesId).filter((x): x is number => x != null))];
  const tierRows = seriesIds.length ? await db.select(badgeCols).from(badges).where(inArray(badges.seriesId, seriesIds)) as BadgeRow[] : [];
  const items = collapseShelf(rows, tierRows, series);

  const entry = (r: (typeof rows)[number], seriesRef: PublicSeriesRef | null) => ({
    ...publicBadge(r as unknown as BadgeRow),
    series: seriesRef,
    earnedAt: r.earnedAt.toISOString(),
    earnedCount: counts.get(r.id) ?? 0,
    granted: !!r.granted,
    note: r.note,
    sourceScore: r.sourceScoreId != null ? visibleScore.get(r.sourceScoreId) ?? null : null,
    sourceChallengeId: r.sourceChallengeId != null && mineChallenges.has(r.sourceChallengeId) ? r.sourceChallengeId : null,
  });
  // A tier's number is its place in the ladder this viewer sees (live tiers + the ones they earned).
  const ladderTier = new Map<number, PublicSeriesRef>();
  for (const it of items) {
    if (it.type !== 'series') continue;
    it.tiers.forEach((t, i) => ladderTier.set(t.badge.id, { ...it.series, tier: i + 1, tierCount: it.tierCount }));
  }
  const tierRef = (id: number) => ladderTier.get(id) ?? null;

  return {
    user,
    isSelf: viewer?.id === user.id,
    badges: rows.map(r => entry(r, tierRef(r.id))),
    items: items.map(it => it.type === 'badge'
      ? { type: 'badge' as const, badge: entry(it.badge, null) }
      : {
        type: 'series' as const,
        series: it.series,
        top: entry(it.top, tierRef(it.top.id)),
        tier: it.tier,
        tierCount: it.tierCount,
        earnedCount: it.earnedCount,
        tiers: it.tiers.map(t => ({
          badge: { ...publicBadge(t.badge), series: tierRef(t.badge.id) },
          earnedAt: t.earned ? t.earned.earnedAt.toISOString() : null,
        })),
      }),
  };
}

// ── admin validation ─────────────────────────────────────────────────────────

export const BADGE_LIMITS = { name: 60, description: 300, key: 48, threshold: 1_000_000 } as const;
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

export interface BadgeInput {
  key?: string; name?: string; description?: string; icon?: string; color?: string;
  kind?: 'metric' | 'rule' | 'manual'; metric?: string | null; threshold?: number | null; rule?: BadgeRule | null;
  retroactive?: boolean; availableFrom?: Date | null; availableTo?: Date | null; sortOrder?: number;
  /** The series it's a tier of (null = a single). Omitted on create = the metric's series, if it has exactly one. */
  seriesId?: number | null;
  /** Create a series and put the badge in it (instead of `seriesId`). */
  newSeries?: { name: string; color: string };
}

function dateOrNull(v: unknown): Date | null | 'bad' {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') return 'bad';
  const d = new Date(v);
  return Number.isNaN(+d) ? 'bad' : d;
}

/**
 * Validate a create (`partial` false) or PATCH body. Pure — unit-tested. The rule's machine /
 * venue ids are checked against the DB by the route (resolveRuleRefs).
 */
export function normalizeBadgeInput(body: unknown, partial: boolean): { values: BadgeInput } | { errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const v: BadgeInput = {};
  const errors: Record<string, string> = {};
  const has = (k: string) => b[k] !== undefined;

  if (has('key') || !partial) {
    const key = typeof b.key === 'string' ? b.key.trim().toLowerCase() : '';
    if (!KEY_RE.test(key)) errors.key = 'Key: 2–48 lowercase letters, digits and dashes';
    else v.key = key;
  }
  if (has('name') || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > BADGE_LIMITS.name) errors.name = `Name: 1–${BADGE_LIMITS.name} characters`;
    else v.name = name;
  }
  if (has('description')) {
    if (typeof b.description !== 'string' || b.description.trim().length > BADGE_LIMITS.description) errors.description = `Description: up to ${BADGE_LIMITS.description} characters`;
    else v.description = b.description.trim();
  }
  if (has('icon')) {
    if (typeof b.icon !== 'string' || !ICON_RE.test(b.icon)) errors.icon = 'Icon: a lucide icon name';
    else v.icon = b.icon;
  }
  if (has('color')) {
    const c = typeof b.color === 'string' ? b.color.trim().toLowerCase() : '';
    if (!COLOR_RE.test(c)) errors.color = 'Color: #rrggbb';
    else v.color = c;
  }
  if (has('kind') || !partial) {
    if (!['metric', 'rule', 'manual'].includes(b.kind)) errors.kind = 'Kind: metric, rule or manual';
    else v.kind = b.kind;
  }
  if (has('metric')) {
    if (b.metric === null) v.metric = null;
    else if (typeof b.metric !== 'string' || !(metricByKey(b.metric) || PENDING_METRICS.some(p => p.key === b.metric))) errors.metric = 'Unknown metric';
    else v.metric = b.metric;
  }
  if (has('threshold')) {
    if (b.threshold === null) v.threshold = null;
    else if (!Number.isSafeInteger(b.threshold) || b.threshold < 1 || b.threshold > BADGE_LIMITS.threshold) errors.threshold = `Threshold: 1–${BADGE_LIMITS.threshold.toLocaleString('en-US')}`;
    else v.threshold = b.threshold;
  }
  if (has('rule')) {
    if (b.rule === null) v.rule = null;
    else {
      const r = normalizeRule(b.rule);
      if ('errors' in r) errors.rule = r.errors.join('; ');
      else v.rule = r.rule;
    }
  }
  if (has('retroactive')) {
    if (typeof b.retroactive !== 'boolean') errors.retroactive = 'Retroactive: true or false';
    else v.retroactive = b.retroactive;
  }
  for (const k of ['availableFrom', 'availableTo'] as const) {
    if (has(k)) {
      const d = dateOrNull(b[k]);
      if (d === 'bad') errors[k] = 'Not a date';
      else v[k] = d;
    }
  }
  if (has('sortOrder')) {
    if (!Number.isSafeInteger(b.sortOrder) || Math.abs(b.sortOrder) > 1_000_000) errors.sortOrder = 'Sort order: a whole number';
    else v.sortOrder = b.sortOrder;
  }
  if (has('seriesId')) {
    if (b.seriesId === null) v.seriesId = null;
    else if (!Number.isSafeInteger(b.seriesId) || b.seriesId <= 0) errors.seriesId = 'Series: pick one or none';
    else v.seriesId = b.seriesId;
  }
  if (has('newSeries') && b.newSeries !== null) {
    const s = normalizeSeriesInput(b.newSeries, false);
    if ('errors' in s) Object.assign(errors, { seriesName: s.errors.name, seriesColor: s.errors.color });
    else v.newSeries = s.values as { name: string; color: string };
    if (v.seriesId != null) errors.seriesId = 'Pick an existing series or a new one, not both';
  }
  for (const k of Object.keys(errors)) if (errors[k] === undefined) delete errors[k];
  if (v.availableFrom && v.availableTo && +v.availableFrom > +v.availableTo) errors.availableTo = 'Must be after the start';

  // Kind-specific requirements — only checkable here when the body carries the kind (a create).
  if (!partial && v.kind) {
    if (v.kind === 'metric' && (!v.metric || v.threshold == null)) errors.metric = errors.metric ?? 'A metric badge needs a metric and a threshold';
    if (v.kind === 'rule' && !v.rule) errors.rule = errors.rule ?? 'A rule badge needs a rule';
  }
  return Object.keys(errors).length ? { errors } : { values: v };
}

/** The merged badge a PATCH would produce must still be consistent for its kind. */
export function kindConsistencyError(merged: { kind: string; metric: string | null; threshold: number | null; rule: unknown }): string | null {
  if (merged.kind === 'metric' && (!merged.metric || merged.threshold == null)) return 'A metric badge needs a metric and a threshold';
  if (merged.kind === 'rule' && !merged.rule) return 'A rule badge needs a rule';
  return null;
}

/** Fill a rule's machine (OPDB group + display name) from the DB and check its venue exists. */
export async function resolveRuleRefs(rule: BadgeRule): Promise<{ rule: BadgeRule } | { error: string }> {
  const out: BadgeRule = { ...rule };
  if (rule.machine) {
    const [m] = await db.select({ id: machines.id, name: machines.name, opdbId: machines.opdbId }).from(machines).where(eq(machines.id, rule.machine.machineId)).limit(1);
    if (!m) return { error: 'That machine doesn’t exist' };
    const group = m.opdbId ? m.opdbId.split('-')[0].trim() : null;
    out.machine = { ...rule.machine, name: m.name, matchGroup: rule.machine.matchMode === 'group' && group && /^G[A-Za-z0-9]{2,}$/.test(group) ? group : null };
  }
  if (rule.venueId != null) {
    const [v] = await db.select({ id: venues.id }).from(venues).where(eq(venues.id, rule.venueId)).limit(1);
    if (!v) return { error: 'That venue doesn’t exist' };
  }
  return { rule: out };
}

// ── images ───────────────────────────────────────────────────────────────────

export const BADGE_IMAGE = { maxBytes: 1024 * 1024, size: 256, types: ['image/png', 'image/webp', 'image/jpeg'] } as const;

/**
 * Re-encode an upload to a 256x256 WebP. The artwork is fitted inside the square (transparent
 * padding for non-square art) rather than cropped, so nothing inside the brief's safe circle is cut.
 * Throws on anything sharp can't decode.
 */
export async function processBadgeImage(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(BADGE_IMAGE.size, BADGE_IMAGE.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90, alphaQuality: 100 })
    .toBuffer();
}

/** Reads only the bytes (never part of any list select). */
export async function loadBadgeImage(id: number): Promise<{ image: Buffer; imageVersion: number } | null> {
  const [row] = await db.select({ image: badges.image, imageVersion: badges.imageVersion }).from(badges).where(eq(badges.id, id)).limit(1);
  return row?.image ? { image: row.image, imageVersion: row.imageVersion } : null;
}
