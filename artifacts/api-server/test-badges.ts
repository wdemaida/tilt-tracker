// End-to-end check of badges (feature/badges, phases 1–2) against the Neon DEV branch.
//
// Mounts the real routers on a throwaway express app: the admin badges router and the friend router
// behind a stub that plays requireAppUser (req.appUser from an `x-test-user` header — admin role is
// the admin router's guard, which adminAuth.test.ts covers), POST /api/scores through the real
// requireAppUser with setAuthForTests, the public badge routes behind clerkMiddleware (no token =
// guest), and the Clerk webhook handler with a throwaway Svix secret.
//
// Borrows three existing users with no friendships (so it never disturbs seeded friend data), makes a
// throwaway machine and two venues (`zz-badge-test`), backdated scores inserted directly, and badges
// keyed `zz-badge-test-*`. Nothing touches app_settings: "high-volume tier = 0" is simulated with the
// in-process retention loader. At the end it deletes everything it made — badges (awards cascade),
// the badge notifications and events, the friend rows/notifications/events among the three users,
// the marks it wrote, its scores, machine and venues.
// Badge series (feature/badge-series): a throwaway `zz-badge-test-*` series of rule tiers — the
// profile collapses to the highest earned tier, pips count only live tiers, the series color is
// applied everywhere (catalog, shelf, notification), a new metric tier auto-joins its metric's
// series, and the reorder endpoint validates + persists. The reorder touches every badge's and
// series' sort_order, so the script snapshots (sort_order, updated_at) first and restores them
// exactly at the end — Will's dev badges keep their numbers.
// Series follow-ups: migrate25's description_template seeding, series template validation, a mixed
// `zz-badge-test-mixed` series (metric tiers seated by N on create / N edit, a rule tier moved by
// PUT /badge-series/:id/order, which refuses N-tiers out of order), and the "Add tier" prefill.
// Never in the future (release/combined): a legacy score whose played_at is more than FUTURE_SKEW_MS
// after its created_at (inserted directly — the routes refuse one) earns no rule badge (preview,
// retroactive backfill and the live award path) and counts toward no score metric; one inside the
// 15-minute skew still does.
// Challenge badges (phase 3): challenges among the borrowed users, inserted directly and resolved
// through syncChallenge (the real applyResolution path) or answered through the real challenges
// router — a win awards with source_challenge_id set, a 3-win streak and a 3-loss streak award, a
// tie awards, a back-out counts as backed out and NOT declined, a counter and a taken counter award
// (counters_accepted, sourced from the proposal), an admin-voided challenge stops counting without
// revoking anything, and the backfill query (preview) agrees with the single-user reads. The
// borrowed users must have no challenges beforehand (checked); everything is deleted at the end.
//
//   cd artifacts/api-server && npx tsx test-badges.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}
process.env.PM_MODE = 'offline';

const { default: express } = await import('express');
const { clerkMiddleware } = await import('@clerk/express');
const { Webhook } = await import('svix');
const { default: sharp } = await import('sharp');
const {
  db, users, friendships, notifications, activityEvents, badges, badgeSeries, userBadges, userMetricMarks, scores, machines, venues,
  challenges, challengeParticipants,
} = await import('@workspace/db');
const { default: challengesRouter } = await import('./src/routes/challenges.js');
const { syncChallenge } = await import('./src/lib/challenges.js');
const { voidChallenge } = await import('./src/lib/adminActions.js');
const { and, eq, gt, inArray, like, or, sql } = await import('drizzle-orm');
const { setAuthForTests } = await import('./src/middleware/requireAuth.js');
const { default: adminBadgesRouter } = await import('./src/routes/adminBadges.js');
const { default: friendsRouter } = await import('./src/routes/friends.js');
const { default: scoresRouter } = await import('./src/routes/scores.js');
const { default: usersRouter } = await import('./src/routes/users.js');
const { default: badgesRouter } = await import('./src/routes/badges.js');
const { default: notificationsRouter } = await import('./src/routes/notifications.js');
const { createClerkWebhookHandler } = await import('./src/routes/clerkWebhook.js');
const { insertActivity, isActivityRecorded } = await import('./src/lib/activity.js');
const { setRetentionLoaderForTests } = await import('./src/lib/activityRetention.js');
const { awardBadges, onSignInBadges, runBadgeSweep, badgeCatalog } = await import('./src/lib/badges.js');
const { raiseNotificationsBulk } = await import('./src/lib/notify.js');
const { readMetric, metricCounts } = await import('./src/lib/badgeMetrics.js');
const { FUTURE_SKEW_MS } = await import('./src/lib/playedAtClock.js');

const people = await db.select().from(users)
  .where(sql`NOT EXISTS (SELECT 1 FROM friendships f WHERE f.requester_id = ${users.id} OR f.addressee_id = ${users.id}) AND ${users.disabledAt} IS NULL`)
  .orderBy(users.id).limit(3);
if (people.length < 3) throw new Error('Need at least 3 users with no friendships in the dev DB');
const [alice, bob, carol] = people;
const ids = people.map(p => p.id);
const [{ maxNotif }] = await db.select({ maxNotif: sql<number>`coalesce(max(id), 0)::int` }).from(notifications);
const [{ maxEvent }] = await db.select({ maxEvent: sql<number>`coalesce(max(id), 0)::bigint` }).from(activityEvents);
const [{ startedAt }] = await db.select({ startedAt: sql<string>`now()::text` }).from(users).limit(1);
console.log(`borrowing users ${ids.join(', ')}; notifications > ${maxNotif}, events > ${maxEvent}`);

const SECRET = `whsec_${Buffer.from('tilttrack-badge-test-secret-012345').toString('base64')}`;
const CLERK_IDS = new Map(people.map(p => [`zz-badge-test-${p.id}`, p]));
setAuthForTests({
  resolveClerkId: req => (req.headers['x-test-clerk'] as string | undefined) ?? null,
  loadUser: async clerkId => CLERK_IDS.get(clerkId),
});

const app = express();
const stub = (req: any, _res: any, next: any) => {
  req.appUser = people.find(p => p.id === Number(req.header('x-test-user')));
  next();
};
app.post('/hook', express.raw({ type: '*/*' }), createClerkWebhookHandler({
  secret: SECRET,
  resolveUserId: async clerkId => CLERK_IDS.get(clerkId)?.id ?? null,
  record: ev => insertActivity(ev),
  shouldRecord: isActivityRecorded,
  onSignedIn: onSignInBadges,
}));
app.use(express.json());
app.use(clerkMiddleware());
app.use('/api/admin', stub, adminBadgesRouter);
app.use('/api/friends', stub, friendsRouter);
app.use('/api/challenges', stub, challengesRouter);
app.use('/api/notifications', stub, notificationsRouter);
app.use('/api/scores', scoresRouter);
app.use('/api/users', usersRouter);
app.use('/api/badges', badgesRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function call(as: { id: number } | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) {
    headers['x-test-user'] = String(as.id);
    headers['x-test-clerk'] = `zz-badge-test-${as.id}`;
  }
  const res = await fetch(`http://localhost:${port}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* binary */ }
  return { status: res.status, body: parsed, headers: res.headers };
}
async function upload(badgeId: number, bytes: Buffer, type: string) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type }), type === 'text/plain' ? 'x.txt' : 'x.png');
  const res = await fetch(`http://localhost:${port}/api/admin/badges/${badgeId}/image`, { method: 'POST', headers: { 'x-test-user': String(alice.id) }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
}
const holds = async (userId: number, badgeId: number) =>
  (await db.select().from(userBadges).where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId)))).length;

const badgeIds: number[] = [];
const seriesIds: number[] = [];
const scoreIds: number[] = [];
// Restored exactly at the end (the reorder test rewrites every top-level sort_order).
// updated_at goes through ::text both ways (timestamptz text carries its offset, so ::timestamptz restores it exactly).
type OrderRow = { id: number; sort_order: number; updated_at: string };
const orderSnapshot = {
  badges: await db.execute(sql`SELECT id, sort_order, updated_at::text AS updated_at FROM badges`) as unknown as OrderRow[],
  series: await db.execute(sql`SELECT id, sort_order, updated_at::text AS updated_at FROM badge_series`) as unknown as OrderRow[],
};
let machineId = 0;
const extraMachineIds: number[] = [];
const venueIds: number[] = [];
const challengeIds: number[] = [];
let madeFriendship: number | null = null;
let noPriorChallenges = false; // only then may cleanup delete every challenge the borrowed users are in
const LOGIN_DAY = '2001-01-01';

async function createBadge(body: Record<string, unknown>) {
  const r = await call(alice, 'POST', '/admin/badges', body);
  if (r.status !== 201) throw new Error(`create ${body.key} failed: ${JSON.stringify(r)}`);
  badgeIds.push(r.body.badge.id);
  return r.body.badge.id as number;
}

try {
  // ── fixtures ────────────────────────────────────────────────────────────────
  const [m] = await db.insert(machines).values({ name: `zz-badge-test machine ${Date.now()}`, opdbId: 'Gzzbt-M0001' }).returning({ id: machines.id });
  machineId = m.id;
  const [la] = await db.insert(venues).values({ name: 'zz-badge-test LA', timezone: 'America/Los_Angeles', city: 'Los Angeles', state: 'CA' }).returning({ id: venues.id });
  const [ny] = await db.insert(venues).values({ name: 'zz-badge-test NY', timezone: 'America/New_York', city: 'New York', state: 'NY' }).returning({ id: venues.id });
  venueIds.push(la.id, ny.id);
  const hist = async (userId: number, venueId: number, playedAt: string, createdAt: string, score = 50_000) => {
    const [s] = await db.insert(scores).values({
      userId, machineId, score, venueId, venueName: 'zz', playedAt: new Date(playedAt), createdAt: new Date(createdAt), photoThumbnail: 'data:image/jpeg;base64,zz',
    }).returning({ id: scores.id });
    scoreIds.push(s.id);
    return s.id;
  };
  const aliceXmas = await hist(alice.id, la.id, '2025-12-26T07:00:00Z', '2025-12-26T08:00:00Z'); // 11pm PT on 12/25
  await hist(bob.id, ny.id, '2025-12-26T06:00:00Z', '2025-12-26T07:00:00Z');                    // 1am ET on 12/26
  await hist(carol.id, la.id, '2025-12-25T20:00:00Z', '2025-12-30T12:00:00Z');                   // posted 5 days later

  // ── rule badges: preview, retroactive activation, forward-only ──────────────
  const xmasRule = { machine: { machineId, matchMode: 'exact' }, localDate: { from: '2025-12-25', to: '2025-12-25' } };
  const retro = await createBadge({ key: `zz-badge-test-xmas-retro`, name: 'ZZ Xmas (retro)', kind: 'rule', rule: xmasRule, retroactive: true, icon: 'gift', color: '#ef4444' });
  const fwd = await createBadge({ key: `zz-badge-test-xmas-fwd`, name: 'ZZ Xmas (forward)', kind: 'rule', rule: xmasRule, retroactive: false });
  const big = await createBadge({ key: `zz-badge-test-big`, name: 'ZZ Big score', kind: 'rule', rule: { machine: { machineId, matchMode: 'group' }, minScore: 12_345 }, retroactive: false });

  let r = await call(alice, 'POST', `/admin/badges/${retro}/preview`);
  check('preview → only alice qualifies (PT 12/25 counts; ET 1am 12/26 and a 5-day-late post do not)',
    r.status === 200 && r.body.total === 1 && r.body.qualifying[0]?.user?.id === alice.id && r.body.qualifying[0]?.sourceScoreId === aliceXmas, r.body);
  check('preview writes nothing', await holds(alice.id, retro) === 0);

  r = await call(alice, 'POST', `/admin/badges/${retro}/activate`);
  check('activate (retroactive) → 1 awarded', r.status === 200 && r.body.awarded === 1, r.body);
  const [award] = await db.select().from(userBadges).where(and(eq(userBadges.userId, alice.id), eq(userBadges.badgeId, retro)));
  check('alice has it, sourced from the 12/25 score', award?.sourceScoreId === aliceXmas, award);
  check('bob and carol do not', await holds(bob.id, retro) === 0 && await holds(carol.id, retro) === 0);
  const [notif] = await db.select().from(notifications).where(and(eq(notifications.userId, alice.id), eq(notifications.kind, 'badge_earned'), sql`${notifications.payload} ->> 'badgeId' = ${String(retro)}`));
  check('badge_earned notification raised', notif?.payload?.badgeName === 'ZZ Xmas (retro)', notif);
  const [earnedEv] = await db.select().from(activityEvents).where(and(eq(activityEvents.type, 'badge.earned'), eq(activityEvents.targetId, String(retro))));
  check('badge.earned logged', earnedEv?.actorUserId === alice.id && (earnedEv?.payload as any)?.trigger === 'backfill', earnedEv);

  r = await call(alice, 'POST', `/admin/badges/${retro}/activate`);
  check('activating again → 409 already_live', r.status === 409 && r.body.code === 'already_live', r);

  // ── backfill notifies every recipient exactly once; the bell counts each badge ──
  const unread = async (u: { id: number }) => (await call(u, 'GET', '/notifications/unread-count')).body?.count as number;
  const badgeNotifs = async (userId: number, badgeId: number) => db.select().from(notifications).where(and(
    eq(notifications.userId, userId), eq(notifications.kind, 'badge_earned'), sql`${notifications.readAt} IS NULL`,
    sql`${notifications.payload} ->> 'badgeId' = ${String(badgeId)}`));
  const unreadBefore = Object.fromEntries(await Promise.all(people.map(async p => [p.id, await unread(p)])));
  const anyRule = { machine: { machineId, matchMode: 'exact' } };
  const everyone1 = await createBadge({ key: 'zz-badge-test-all-1', name: 'ZZ Everyone 1', kind: 'rule', rule: anyRule, retroactive: true });
  const everyone2 = await createBadge({ key: 'zz-badge-test-all-2', name: 'ZZ Everyone 2', kind: 'rule', rule: { ...anyRule, count: 1 }, retroactive: true, icon: 'star' });
  r = await call(alice, 'POST', `/admin/badges/${everyone1}/activate`);
  check('backfill to three players → awarded 3', r.status === 200 && r.body.awarded === 3, r.body);
  for (const p of people) {
    const n = await badgeNotifs(p.id, everyone1);
    check(`backfill: user ${p.id} has exactly one unread badge_earned for it`, n.length === 1 && (n[0].payload as any)?.badgeName === 'ZZ Everyone 1', n);
  }
  const sentEvents = await db.select({ subject: activityEvents.subjectUserId }).from(activityEvents).where(and(
    eq(activityEvents.type, 'notification.sent'), gt(activityEvents.id, Number(maxEvent)),
    sql`${activityEvents.payload} ->> 'badgeId' = ${String(everyone1)}`));
  check('backfill: one notification.sent event per recipient', sentEvents.length === 3 && new Set(sentEvents.map(e => e.subject)).size === 3, sentEvents);
  const earnedEvents = await db.select({ id: activityEvents.id }).from(activityEvents).where(and(eq(activityEvents.type, 'badge.earned'), eq(activityEvents.targetId, String(everyone1))));
  check('backfill: one badge.earned event per recipient', earnedEvents.length === 3, earnedEvents.length);
  // Re-raising for the same badge replaces the unread one rather than stacking a second.
  await raiseNotificationsBulk(db, 'badge_earned', [{ userId: bob.id, payload: { badgeId: everyone1, badgeName: 'ZZ Everyone 1' } }], 'badgeId');
  check('dedupe: re-raising leaves bob one unread for the badge', (await badgeNotifs(bob.id, everyone1)).length === 1);
  r = await call(alice, 'POST', `/admin/badges/${everyone2}/activate`);
  check('a second backfill → awarded 3', r.status === 200 && r.body.awarded === 3, r.body);
  for (const p of people) {
    const now = await unread(p);
    check(`unread count for user ${p.id} rose by 2 (two badges, not collapsed into one)`, now === unreadBefore[p.id] + 2, { before: unreadBefore[p.id], now });
  }

  r = await call(alice, 'POST', `/admin/badges/${fwd}/preview`);
  check('forward-only preview still reports who qualifies by history', r.body.total === 1 && r.body.retroactive === false, r.body);
  r = await call(alice, 'POST', `/admin/badges/${fwd}/activate`);
  check('forward-only activation awards nobody', r.status === 200 && r.body.awarded === 0 && await holds(alice.id, fwd) === 0, r.body);
  r = await call(alice, 'POST', `/admin/badges/${big}/activate`);
  check('forward-only "big score" awards nobody from history', r.body.awarded === 0 && await holds(alice.id, big) === 0, r.body);

  // ── retroactive switched on AFTER go-live backfills (the prod bug: Go live with retroactive
  //    unsaved → activation ran forward-only, the later save awarded nobody) ─────────────────
  const late = await createBadge({ key: 'zz-badge-test-late-retro', name: 'ZZ Late retro', kind: 'rule', rule: anyRule, retroactive: false });
  r = await call(alice, 'POST', `/admin/badges/${late}/backfill`);
  check('backfill on a draft → 409 badge_not_live', r.status === 409 && r.body.code === 'badge_not_live', r);
  r = await call(alice, 'POST', `/admin/badges/${late}/activate`);
  check('late: activate non-retroactive → 0 awarded', r.status === 200 && r.body.awarded === 0, r.body);
  r = await call(alice, 'POST', `/admin/badges/${late}/backfill`);
  check('backfill while retroactive is off → 409 not_retroactive', r.status === 409 && r.body.code === 'not_retroactive', r);
  r = await call(alice, 'PATCH', `/admin/badges/${late}`, { retroactive: true });
  check('late: PATCH retroactive true on a live badge → backfill awarded 3', r.status === 200 && r.body.backfill?.awarded === 3 && r.body.badge?.earnedCount === 3, r.body);
  check('late: all three now hold it', (await Promise.all(people.map(p => holds(p.id, late)))).every(n => n === 1));
  for (const p of people) {
    const n = await badgeNotifs(p.id, late);
    check(`late: user ${p.id} has exactly one unread badge_earned for it`, n.length === 1, n.length);
  }
  const lateEvents = async () => ({
    earned: await db.select({ payload: activityEvents.payload }).from(activityEvents).where(and(eq(activityEvents.type, 'badge.earned'), eq(activityEvents.targetId, String(late)))),
    sent: await db.select({ id: activityEvents.id }).from(activityEvents).where(and(eq(activityEvents.type, 'notification.sent'), gt(activityEvents.id, Number(maxEvent)), sql`${activityEvents.payload} ->> 'badgeId' = ${String(late)}`)),
    backfilled: await db.select({ payload: activityEvents.payload }).from(activityEvents).where(and(eq(activityEvents.type, 'admin.badge_updated'), eq(activityEvents.targetId, String(late)), sql`${activityEvents.payload} ->> 'action' = 'backfilled'`)),
  });
  let ev = await lateEvents();
  check('late: 3 badge.earned events, trigger backfill', ev.earned.length === 3 && ev.earned.every(e => (e.payload as any)?.trigger === 'backfill'), ev.earned);
  check('late: 3 notification.sent events', ev.sent.length === 3, ev.sent.length);
  check('late: admin.badge_updated backfilled {trigger: retroactive_enabled, awarded: 3}', ev.backfilled.length === 1 && (ev.backfilled[0].payload as any)?.trigger === 'retroactive_enabled' && (ev.backfilled[0].payload as any)?.awarded === 3, ev.backfilled);
  r = await call(alice, 'POST', `/admin/badges/${late}/backfill`);
  check('late: Backfill now again → 0 new', r.status === 200 && r.body.awarded === 0 && r.body.skippedWindow === false, r.body);
  ev = await lateEvents();
  check('late: no duplicate awards / notifications / earned events', ev.earned.length === 3 && ev.sent.length === 3
    && (await Promise.all(people.map(p => badgeNotifs(p.id, late)))).every(n => n.length === 1), { earned: ev.earned.length, sent: ev.sent.length });
  check('late: the manual backfill is logged with trigger manual, awarded 0', ev.backfilled.some(e => (e.payload as any)?.trigger === 'manual' && (e.payload as any)?.awarded === 0), ev.backfilled);
  r = await call(alice, 'PATCH', `/admin/badges/${late}`, { retroactive: true, name: 'ZZ Late retro 2' });
  check('late: PATCH with retroactive already true → no backfill', r.status === 200 && r.body.backfill === null, r.body);
  r = await call(alice, 'PATCH', `/admin/badges/${late}`, { retroactive: false });
  check('late: retroactive true → false revokes nobody', r.status === 200 && r.body.backfill === null && r.body.badge?.earnedCount === 3, r.body);
  const shut = await createBadge({ key: 'zz-badge-test-late-shut', name: 'ZZ Late shut', kind: 'rule', rule: anyRule, retroactive: false, availableTo: '2001-01-01T00:00:00Z' });
  await call(alice, 'POST', `/admin/badges/${shut}/activate`);
  r = await call(alice, 'PATCH', `/admin/badges/${shut}`, { retroactive: true });
  check('late: window shut → PATCH backfill skippedWindow, nobody awarded', r.status === 200 && r.body.backfill?.skippedWindow === true && r.body.backfill?.awarded === 0, r.body);
  const manualLate = await createBadge({ key: 'zz-badge-test-late-manual', name: 'ZZ Late manual', kind: 'manual' });
  await call(alice, 'POST', `/admin/badges/${manualLate}/activate`);
  r = await call(alice, 'POST', `/admin/badges/${manualLate}/backfill`);
  check('backfill on a manual badge → 400 manual_badge', r.status === 400 && r.body.code === 'manual_badge', r);

  // A new score through the real POST /api/scores: forward-only badges see only it.
  r = await call(alice, 'POST', '/scores', { machineId, score: 99_999, playedAt: new Date().toISOString(), photoThumbnail: 'data:image/jpeg;base64,zz' });
  if (r.body?.id) scoreIds.push(r.body.id);
  check('POST /api/scores → 201 with newBadges = [big]', r.status === 201 && Array.isArray(r.body.newBadges) && r.body.newBadges.length === 1 && r.body.newBadges[0].id === big, r.body?.newBadges);
  check('the new badge carries no image (icon fallback) and a requirement', r.body.newBadges?.[0]?.imageVersion === null && typeof r.body.newBadges?.[0]?.requirement === 'string', r.body.newBadges);
  check('forward-only xmas badge ignores the history and the new (non-12/25) score', await holds(alice.id, fwd) === 0);
  check('the POST response still hides the photo key', !('photoKey' in (r.body ?? {})), Object.keys(r.body ?? {}));
  const [bigAward] = await db.select().from(userBadges).where(and(eq(userBadges.userId, alice.id), eq(userBadges.badgeId, big)));
  check('big-score award sourced from the new score', bigAward?.sourceScoreId === r.body.id, bigAward);

  // Duplicates are no-ops.
  const again = await awardBadges(alice.id, { score: { id: r.body.id }, metrics: ['scores_posted'] });
  check('re-running the award is a no-op', again.length === 0 && await holds(alice.id, retro) === 1 && await holds(alice.id, big) === 1, again);

  // PATCH locks.
  r = await call(alice, 'PATCH', `/admin/badges/${retro}`, { key: 'zz-badge-test-renamed' });
  check('key is frozen once awarded → 409 locked_field', r.status === 409 && r.body.code === 'locked_field', r);
  r = await call(alice, 'PATCH', `/admin/badges/${retro}`, { name: 'ZZ Xmas (retro, renamed)', description: 'd' });
  check('name/description still editable', r.status === 200 && r.body.badge.name === 'ZZ Xmas (retro, renamed)', r);
  r = await call(alice, 'PATCH', `/admin/badges/${fwd}`, { kind: 'metric', metric: 'zz_no_such_metric', threshold: 1 });
  const [fwdRow] = await db.select({ kind: badges.kind }).from(badges).where(eq(badges.id, fwd));
  check('a live badge can’t move onto an unknown metric → 400, unchanged', r.status === 400 && fwdRow?.kind === 'rule', r);

  // ── friend metrics award to the correct side ────────────────────────────────
  const pre = async (metric: string) => Object.fromEntries(await Promise.all(people.map(async p => [p.id, await readMetric(db, metric, p.id)])));
  const metricsUsed = ['friend_requests_sent', 'your_requests_accepted', 'friend_requests_accepted_by_you', 'friend_requests_declined_by_you', 'your_requests_declined'];
  const before: Record<string, Record<number, number>> = {};
  for (const k of metricsUsed) before[k] = await pre(k);
  const fb: Record<string, number> = {};
  // Threshold = the acting side's current value + 1, so only the event under test can complete it.
  const actor: Record<string, number> = {
    friend_requests_sent: alice.id, your_requests_accepted: alice.id, friend_requests_accepted_by_you: bob.id,
    friend_requests_declined_by_you: alice.id, your_requests_declined: carol.id,
  };
  for (const k of metricsUsed) {
    fb[k] = await createBadge({ key: `zz-badge-test-${k.replace(/_/g, '-')}`, name: `ZZ ${k}`, kind: 'metric', metric: k, threshold: before[k][actor[k]] + 1 });
    r = await call(alice, 'POST', `/admin/badges/${fb[k]}/activate`);
    check(`activate ${k} (forward-only) awards nobody`, r.status === 200 && r.body.awarded === 0, r.body);
  }
  const expectHolds = async (k: string) => {
    for (const p of people) {
      const v = await readMetric(db, k, p.id);
      const threshold = before[k][actor[k]] + 1;
      const has = await holds(p.id, fb[k]);
      check(`${k}: user ${p.id} value ${v} ${has ? 'holds' : 'doesn’t hold'} (threshold ${threshold})`, !!has === (v >= threshold && (p.id === actor[k] || v > before[k][p.id])), { v, has, before: before[k][p.id] });
    }
  };
  r = await call(alice, 'POST', '/friends/requests', { userId: bob.id });
  check('alice → bob request', r.status === 201, r);
  for (let i = 0; i < 2; i++) await call(alice, 'POST', '/friends/requests', { userId: bob.id });
  check('re-sends don’t count again', await readMetric(db, 'friend_requests_sent', alice.id) === before.friend_requests_sent[alice.id] + 1);
  await expectHolds('friend_requests_sent');
  r = await call(bob, 'POST', `/friends/requests/${alice.id}/accept`);
  check('bob accepts', r.status === 200, r);
  check('accept marks: bob accepted-by-you +1, alice your-requests-accepted +1',
    await readMetric(db, 'friend_requests_accepted_by_you', bob.id) === before.friend_requests_accepted_by_you[bob.id] + 1
    && await readMetric(db, 'your_requests_accepted', alice.id) === before.your_requests_accepted[alice.id] + 1
    && await readMetric(db, 'your_requests_accepted', bob.id) === before.your_requests_accepted[bob.id]);
  await expectHolds('your_requests_accepted');
  await expectHolds('friend_requests_accepted_by_you');
  check('alice holds "your requests accepted", bob does not', await holds(alice.id, fb.your_requests_accepted) === 1 && await holds(bob.id, fb.your_requests_accepted) === 0);
  r = await call(carol, 'POST', '/friends/requests', { userId: alice.id });
  r = await call(alice, 'POST', `/friends/requests/${carol.id}/decline`);
  check('alice declines carol', r.status === 200, r);
  check('decline marks: alice declined-by-you +1, carol your-requests-declined +1',
    await readMetric(db, 'friend_requests_declined_by_you', alice.id) === before.friend_requests_declined_by_you[alice.id] + 1
    && await readMetric(db, 'your_requests_declined', carol.id) === before.your_requests_declined[carol.id] + 1);
  check('alice holds "declined by you", carol holds "your requests declined"',
    await holds(alice.id, fb.friend_requests_declined_by_you) === 1 && await holds(carol.id, fb.your_requests_declined) === 1
    && await holds(carol.id, fb.friend_requests_declined_by_you) === 0 && await holds(alice.id, fb.your_requests_declined) === 0);

  // ── simulated webhook sign-in with the high-volume tier at 0 ────────────────
  const loginsBefore = await readMetric(db, 'login_days', alice.id);
  const login = await createBadge({ key: 'zz-badge-test-logins', name: 'ZZ logins', kind: 'metric', metric: 'login_days', threshold: loginsBefore + 1 });
  await call(alice, 'POST', `/admin/badges/${login}/activate`);
  setRetentionLoaderForTests(async () => ({ highVolumeDays: 0, standardDays: 365, adminDays: -1 }));
  const hook = async (at: Date, id: string) => {
    const raw = JSON.stringify({ type: 'session.created', data: { id: `sess_${id}`, user_id: `zz-badge-test-${alice.id}`, created_at: +at, latest_activity: {} } });
    const sig = new Webhook(SECRET).sign(id, new Date(), raw);
    const res = await fetch(`http://localhost:${port}/hook`, {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': sig },
    });
    return { status: res.status, body: await res.json() };
  };
  const h1 = await hook(new Date(`${LOGIN_DAY}T15:00:00Z`), `msg_zzbadge_${Date.now()}_1`);
  check('webhook answers notRecorded with the tier at 0', h1.status === 200 && h1.body.notRecorded === 'user.signed_in', h1);
  const h2 = await hook(new Date(`${LOGIN_DAY}T23:30:00Z`), `msg_zzbadge_${Date.now()}_2`); // 18:30 ET, same day
  check('second sign-in the same Eastern day', h2.status === 200, h2);
  setRetentionLoaderForTests(null);
  check('…one login day counted', await readMetric(db, 'login_days', alice.id) === loginsBefore + 1);
  check('login badge awarded', await holds(alice.id, login) === 1);
  const [signedInEv] = await db.select({ id: activityEvents.id }).from(activityEvents).where(and(eq(activityEvents.type, 'user.signed_in'), gt(activityEvents.id, Number(maxEvent)), eq(activityEvents.actorUserId, alice.id)));
  check('…and no user.signed_in event was written', !signedInEv, signedInEv);

  // ── manual grant / revoke ───────────────────────────────────────────────────
  const manual = await createBadge({ key: 'zz-badge-test-manual', name: 'ZZ Beta Tester', kind: 'manual' });
  r = await call(alice, 'POST', `/admin/badges/${manual}/grants`, { userIds: [bob.id] });
  check('grant before live → 409 badge_not_live', r.status === 409 && r.body.code === 'badge_not_live', r);
  r = await call(alice, 'POST', `/admin/badges/${manual}/activate`);
  check('manual badge goes live, nobody awarded', r.status === 200 && r.body.awarded === 0, r.body);
  r = await call(alice, 'POST', `/admin/badges/${manual}/grants`, { userIds: [bob.id], note: 'Thanks for testing' });
  check('grant → granted 1', r.status === 200 && r.body.granted === 1, r.body);
  r = await call(alice, 'POST', `/admin/badges/${manual}/grants`, { userIds: [bob.id] });
  check('granting again → alreadyHad 1', r.body.granted === 0 && r.body.alreadyHad === 1, r.body);
  const [grantRow] = await db.select().from(userBadges).where(and(eq(userBadges.userId, bob.id), eq(userBadges.badgeId, manual)));
  check('grant row records the admin and note', grantRow?.grantedById === alice.id && grantRow?.note === 'Thanks for testing', grantRow);
  const [grantEv] = await db.select().from(activityEvents).where(and(eq(activityEvents.type, 'badge.granted'), eq(activityEvents.targetId, String(manual))));
  check('badge.granted logged (actor admin, subject bob)', grantEv?.actorUserId === alice.id && grantEv?.subjectUserId === bob.id, grantEv);
  r = await call(alice, 'DELETE', `/admin/badges/${manual}/grants?userId=${bob.id}&reason=test`);
  check('revoke → ok', r.status === 200, r);
  check('bob no longer holds it', await holds(bob.id, manual) === 0);
  const unreadLeft = await db.select().from(notifications).where(and(eq(notifications.userId, bob.id), eq(notifications.kind, 'badge_earned'), sql`${notifications.readAt} IS NULL`, sql`${notifications.payload} ->> 'badgeId' = ${String(manual)}`));
  check('its unread notification is gone', unreadLeft.length === 0, unreadLeft);
  r = await call(alice, 'DELETE', `/admin/badges/${manual}/grants?userId=${bob.id}`);
  check('revoking again → 404 not_held', r.status === 404 && r.body.code === 'not_held', r);
  r = await call(alice, 'POST', `/admin/badges/${manual}/grants`, { userIds: [bob.id], note: 'Back again' });
  check('re-grant after revoke', r.body.granted === 1, r.body);

  // ── image upload ────────────────────────────────────────────────────────────
  const png = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } } }).png().toBuffer();
  let u = await upload(retro, png, 'image/png');
  check('upload → 200, version 1, 256x256', u.status === 200 && u.body.imageVersion === 1 && u.body.width === 256, u);
  const img = await fetch(`http://localhost:${port}/api/badges/${retro}/image?v=1`);
  const imgBytes = Buffer.from(await img.arrayBuffer());
  const meta = await sharp(imgBytes).metadata();
  check('served as a 256x256 WebP', img.headers.get('content-type') === 'image/webp' && meta.format === 'webp' && meta.width === 256 && meta.height === 256, { ct: img.headers.get('content-type'), meta: { f: meta.format, w: meta.width, h: meta.height } });
  check('current ?v= is immutable-cached', /immutable/.test(img.headers.get('cache-control') ?? ''), img.headers.get('cache-control'));
  const stale = await fetch(`http://localhost:${port}/api/badges/${retro}/image?v=0`);
  check('a stale ?v= is not pinned', !/immutable/.test(stale.headers.get('cache-control') ?? ''), stale.headers.get('cache-control'));
  const huge = await sharp({ create: { width: 1400, height: 1400, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).raw().toBuffer();
  u = await upload(retro, Buffer.concat([png, huge]).subarray(0, 1024 * 1024 + 10), 'image/png');
  check('over 1 MB → 413 image_too_large', u.status === 413 && u.body?.code === 'image_too_large', u);
  u = await upload(retro, Buffer.from('hello'), 'text/plain');
  check('a non-image type → 400 unsupported_type', u.status === 400 && u.body?.code === 'unsupported_type', u);
  u = await upload(retro, Buffer.from('not really a png'), 'image/png');
  check('garbage labelled PNG → 400 invalid_image', u.status === 400 && u.body?.code === 'invalid_image', u);
  u = await upload(retro, png, 'image/png');
  check('a second upload bumps the version to 2', u.body?.imageVersion === 2, u);
  r = await call(alice, 'DELETE', `/admin/badges/${retro}/image`);
  check('delete image → back to the icon', r.status === 200 && r.body.imageVersion === null, r);
  const gone = await fetch(`http://localhost:${port}/api/badges/${retro}/image?v=2`);
  check('image now 404', gone.status === 404);
  await upload(retro, png, 'image/png');
  r = await call(alice, 'GET', `/admin/badges/${retro}`);
  check('re-upload after delete never reuses a version (3)', r.body?.badge?.imageVersion === 3 && r.body.holders?.[0]?.user?.id === alice.id, r.body?.badge);

  // ── public reads ────────────────────────────────────────────────────────────
  r = await call(null, 'GET', `/users/${encodeURIComponent(alice.username)}/badges`);
  const shelfRetro = r.body?.badges?.find((b: any) => b.id === retro);
  check('a guest reads alice’s badges', r.status === 200 && r.body.isSelf === false && !!shelfRetro, r.body);
  check('shelf entry: image version, earned date, count, public source score', shelfRetro?.imageVersion === 3 && !!shelfRetro?.earnedAt && shelfRetro?.earnedCount === 1 && shelfRetro?.sourceScore?.id === aliceXmas, shelfRetro);
  check('shelf entries carry no rule internals', shelfRetro && !('rule' in shelfRetro) && !('metric' in shelfRetro), shelfRetro && Object.keys(shelfRetro));
  r = await call(null, 'GET', `/users/${encodeURIComponent(bob.username)}/badges`);
  check('bob’s shelf shows the grant with its note', r.body?.badges?.some((b: any) => b.id === manual && b.granted && b.note === 'Back again'), r.body?.badges);
  r = await call(null, 'GET', '/users/zz-no-such-user-badges/badges');
  check('unknown user → 404', r.status === 404);
  r = await call(null, 'GET', '/badges');
  const cat = r.body?.find?.((b: any) => b.id === retro);
  check('guest catalog lists live badges with counts, no earnedAt', r.status === 200 && cat?.earnedCount === 1 && cat?.earnedAt === null && cat?.localDate?.from === '2025-12-25', cat);
  const liveIds = new Set((await db.select({ id: badges.id }).from(badges).where(eq(badges.status, 'live'))).map(b => b.id));
  check('catalog has only live badges', r.body.every((b: any) => liveIds.has(b.id)), r.body.map((b: any) => b.key));

  // ── badge series ────────────────────────────────────────────────────────────
  r = await call(alice, 'POST', '/admin/badge-series', { name: 'ZZ Badge Test Ladder', color: '#123456' });
  check('create a series → 201, keyed from its name', r.status === 201 && r.body.series?.key === 'zz-badge-test-ladder' && r.body.series?.badgeCount === 0, r.body);
  const ladder = r.body.series?.id as number;
  if (ladder) seriesIds.push(ladder);
  r = await call(alice, 'POST', '/admin/badge-series', { name: '', color: 'red' });
  check('series validation → 400 invalid_series with name + color errors', r.status === 400 && r.body.code === 'invalid_series' && r.body.errors?.name && r.body.errors?.color, r.body);
  // Four rule tiers (ordered by their tier sort_order, auto-placed 10/20/30/40): 1 and 2 earnable by
  // everyone (a score on the zz machine), 3 by nobody, 4 stays draft. Their own colors differ.
  const tier = async (n: number, rule: Record<string, unknown>, color: string) =>
    createBadge({ key: `zz-badge-test-tier-${n}`, name: `ZZ Tier ${n}`, description: `Tier ${n} desc`, kind: 'rule', rule, retroactive: true, color, seriesId: ladder });
  const tier1 = await tier(1, anyRule, '#ff0000');
  const tier2 = await tier(2, { ...anyRule, minScore: 1 }, '#00ff00');
  const tier3 = await tier(3, { ...anyRule, minScore: 999_999_999 }, '#0000ff');
  const tier4 = await tier(4, anyRule, '#ffffff');
  r = await call(alice, 'GET', '/admin/badges');
  const adminTier = (id: number) => r.body.items.find((b: any) => b.id === id);
  check('tiers auto-placed after each other in the series (10, 20, 30, 40)', [tier1, tier2, tier3, tier4].map(id => adminTier(id)?.sortOrder).join() === '10,20,30,40', [tier1, tier2, tier3, tier4].map(id => adminTier(id)?.sortOrder));
  check('admin list: tiers drawn in the series color, own color kept as ownColor', adminTier(tier2)?.color === '#123456' && adminTier(tier2)?.ownColor === '#00ff00' && adminTier(tier2)?.seriesId === ladder, adminTier(tier2));
  check('admin list: the series with its count, and in `order` as one item (no tier rows)',
    r.body.series.some((x: any) => x.id === ladder && x.badgeCount === 4) && r.body.order.some((o: any) => o.type === 'series' && o.id === ladder)
    && !r.body.order.some((o: any) => o.type === 'badge' && [tier1, tier2, tier3, tier4].includes(o.id)), r.body.order);
  const idxs = [tier1, tier2, tier3, tier4].map(id => r.body.items.findIndex((b: any) => b.id === id));
  check('admin list: tiers consecutive, lowest first', idxs.every((x, i) => i === 0 || x === idxs[i - 1] + 1), idxs);
  for (const id of [tier1, tier2, tier3]) await call(alice, 'POST', `/admin/badges/${id}/activate`);
  check('alice earned tiers 1 and 2, not 3', await holds(alice.id, tier1) === 1 && await holds(alice.id, tier2) === 1 && await holds(alice.id, tier3) === 0);
  const [tierNotif] = await db.select().from(notifications).where(and(eq(notifications.userId, alice.id), eq(notifications.kind, 'badge_earned'), sql`${notifications.payload} ->> 'badgeId' = ${String(tier2)}`));
  check('the badge_earned notification carries the series color', (tierNotif?.payload as any)?.color === '#123456', tierNotif?.payload);

  r = await call(null, 'GET', `/users/${encodeURIComponent(alice.username)}/badges`);
  const item = r.body?.items?.find((it: any) => it.type === 'series' && it.series.id === ladder);
  check('shelf: the series is ONE item, its top = the highest earned tier (2)', !!item && item.top?.id === tier2 && r.body.items.filter((it: any) => it.type === 'series' && it.series.id === ladder).length === 1, item);
  check('shelf: pips = 2 earned of 3 live tiers (the draft tier 4 isn’t a pip)', item?.earnedCount === 2 && item?.tierCount === 3 && item?.tier === 2, item && { e: item.earnedCount, n: item.tierCount, t: item.tier });
  check('shelf: the ladder lists tiers 1–3 lowest first with earn dates only for 1 and 2',
    item?.tiers?.map((t: any) => t.badge.id).join() === [tier1, tier2, tier3].join() && !!item.tiers[0].earnedAt && !!item.tiers[1].earnedAt && item.tiers[2].earnedAt === null, item?.tiers);
  check('shelf: tier entries carry requirement text and the series color, no rule internals',
    item?.tiers?.every((t: any) => typeof t.badge.requirement === 'string' && t.badge.color === '#123456' && !('rule' in t.badge)) && item?.top?.color === '#123456', item?.tiers?.[0]);
  check('shelf: tiers aren’t repeated as single items', !r.body.items.some((it: any) => it.type === 'badge' && [tier1, tier2].includes(it.badge.id)), r.body.items.map((it: any) => it.type));
  const flat2 = r.body?.badges?.find((b: any) => b.id === tier2);
  check('shelf: the flat list still has both tiers, each with series.tier', flat2?.series?.tier === 2 && flat2?.series?.tierCount === 3 && r.body.badges.some((b: any) => b.id === tier1), flat2?.series);
  r = await call(null, 'GET', '/badges');
  const catTiers = r.body.filter((b: any) => b.series?.id === ladder);
  check('catalog: the 3 live tiers, consecutive, tier 1..3 of 3, series color', catTiers.map((b: any) => b.id).join() === [tier1, tier2, tier3].join()
    && catTiers.every((b: any, i: number) => b.series.tier === i + 1 && b.series.tierCount === 3 && b.color === '#123456')
    && r.body.findIndex((b: any) => b.id === tier2) === r.body.findIndex((b: any) => b.id === tier1) + 1, catTiers.map((b: any) => [b.id, b.series]));
  // The public route resolves the viewer from a Clerk session, which this harness can't mint — so the
  // signed-in view is checked on badgeCatalog() directly.
  const mineCat = (await badgeCatalog({ id: alice.id, role: alice.role } as any)).filter(b => b.series?.id === ladder);
  check('catalog (signed in as alice): earn dates on tiers 1–2 only', !!mineCat[0]?.earnedAt && !!mineCat[1]?.earnedAt && mineCat[2]?.earnedAt === null, mineCat.map(b => b.earnedAt));

  // One color per series: recolor it and every tier follows.
  r = await call(alice, 'PATCH', `/admin/badge-series/${ladder}`, { color: '#abcdef' });
  check('recolor the series → 200', r.status === 200 && r.body.series?.color === '#abcdef', r.body);
  r = await call(null, 'GET', '/badges');
  check('…every live tier is now #abcdef in the catalog', r.body.filter((b: any) => b.series?.id === ladder).every((b: any) => b.color === '#abcdef'));
  r = await call(alice, 'PATCH', `/admin/badges/${tier3}`, { color: '#999999' });
  r = await call(null, 'GET', '/badges');
  check('a tier’s own color edit doesn’t break away from the series', r.body.find((b: any) => b.id === tier3)?.color === '#abcdef');

  // Retire a tier alice earned: it still counts for her (filled), and leaves the catalog.
  await call(alice, 'POST', `/admin/badges/${tier1}/retire`);
  r = await call(null, 'GET', `/users/${encodeURIComponent(alice.username)}/badges`);
  const item2 = r.body?.items?.find((it: any) => it.type === 'series' && it.series.id === ladder);
  check('retired-but-earned tier 1 still a filled pip (2 of 3), top still tier 2', item2?.earnedCount === 2 && item2?.tierCount === 3 && item2?.top?.id === tier2, item2 && { e: item2.earnedCount, n: item2.tierCount });
  r = await call(null, 'GET', `/users/${encodeURIComponent(bob.username)}/badges`);
  const bobItem = r.body?.items?.find((it: any) => it.type === 'series' && it.series.id === ladder);
  check('bob (earned tiers 1+2 too) sees the same ladder', bobItem?.earnedCount === 2 && bobItem?.tierCount === 3, bobItem && { e: bobItem.earnedCount, n: bobItem.tierCount });

  // Membership: a new metric badge joins its metric's series by default; null = explicitly single.
  const mKey = 'friend_requests_declined_by_you';
  const seeded = await createBadge({ key: 'zz-badge-test-m-1', name: 'ZZ M1', kind: 'metric', metric: mKey, threshold: 900_001, newSeries: { name: 'ZZ Badge Test Metric', color: '#654321' } });
  r = await call(alice, 'GET', `/admin/badges/${seeded}`);
  const mSeries = r.body.badge?.seriesId as number;
  if (mSeries) seriesIds.push(mSeries);
  check('newSeries on create → a fresh series holding the badge', !!mSeries && mSeries !== ladder && r.body.badge.color === '#654321', r.body.badge);
  const joined = await createBadge({ key: 'zz-badge-test-m-2', name: 'ZZ M2', kind: 'metric', metric: mKey, threshold: 900_002 });
  r = await call(alice, 'GET', `/admin/badges/${joined}`);
  check('a new tier on that metric (no seriesId sent) auto-joins its series', r.body.badge?.seriesId === mSeries, r.body.badge?.seriesId);
  const single = await createBadge({ key: 'zz-badge-test-m-3', name: 'ZZ M3', kind: 'metric', metric: mKey, threshold: 900_003, seriesId: null });
  r = await call(alice, 'GET', '/admin/badges');
  const maxTop = Math.max(...r.body.order.map((o: any) => o.type === 'series' ? r.body.series.find((x: any) => x.id === o.id).sortOrder : r.body.items.find((b: any) => b.id === o.id).sortOrder));
  const singleRow = r.body.items.find((b: any) => b.id === single);
  check('seriesId: null → a single, placed after the last item', singleRow?.seriesId === null && singleRow?.sortOrder === maxTop && r.body.order[r.body.order.length - 1]?.id === single, { s: singleRow?.sortOrder, maxTop, last: r.body.order.at(-1) });
  r = await call(alice, 'POST', '/admin/badges', { key: 'zz-badge-test-m-bad', name: 'x', kind: 'manual', seriesId: 999_999_999 });
  check('an unknown seriesId → 400 unknown_series', r.status === 400 && r.body.code === 'unknown_series', r.body);
  r = await call(alice, 'PATCH', `/admin/badges/${joined}`, { seriesId: null });
  check('PATCH seriesId null → leaves the series', r.status === 200 && r.body.badge.seriesId === null, r.body.badge);
  r = await call(alice, 'PATCH', `/admin/badges/${joined}`, { seriesId: mSeries });
  check('PATCH seriesId → rejoins', r.status === 200 && r.body.badge.seriesId === mSeries && r.body.badge.color === '#654321', r.body.badge);
  r = await call(alice, 'DELETE', `/admin/badge-series/${mSeries}`);
  check('deleting a non-empty series → 409 series_not_empty', r.status === 409 && r.body.code === 'series_not_empty', r.body);
  for (const id of [seeded, joined]) await call(alice, 'PATCH', `/admin/badges/${id}`, { seriesId: null });
  r = await call(alice, 'DELETE', `/admin/badge-series/${mSeries}`);
  check('…emptied, it deletes', r.status === 200 && (await db.select().from(badgeSeries).where(eq(badgeSeries.id, mSeries))).length === 0, r.body);

  // Reorder: the full top-level list, validated, one transaction, persisted.
  r = await call(alice, 'GET', '/admin/badges');
  const order0 = r.body.order as Array<{ type: string; id: number }>;
  const reversed = [...order0].reverse();
  r = await call(alice, 'PUT', '/admin/badges/order', { items: order0.slice(1) });
  check('reorder missing an item → 409 order_stale', r.status === 409 && r.body.code === 'order_stale', r.body);
  r = await call(alice, 'PUT', '/admin/badges/order', { items: [...order0, order0[0]] });
  check('reorder with a duplicate → 400 duplicate_item', r.status === 400 && r.body.code === 'duplicate_item', r.body);
  r = await call(alice, 'PUT', '/admin/badges/order', { items: [...order0.slice(1), { type: 'badge', id: tier2 }] });
  check('reorder naming a tier → 400 unknown_item', r.status === 400 && r.body.code === 'unknown_item', r.body);
  r = await call(alice, 'PUT', '/admin/badges/order', { items: 'nope' });
  check('reorder with a bad body → 400 invalid_order', r.status === 400 && r.body.code === 'invalid_order', r.body);
  const [{ n: evBefore }] = await db.select({ n: sql<number>`count(*)::int` }).from(activityEvents).where(and(eq(activityEvents.type, 'admin.badge_order_changed'), gt(activityEvents.id, Number(maxEvent))));
  r = await call(alice, 'PUT', '/admin/badges/order', { items: reversed });
  check('reorder (reversed) → 200 with changes', r.status === 200 && r.body.changed > 0, r.body);
  r = await call(alice, 'GET', '/admin/badges');
  check('…persisted: GET returns the reversed order', JSON.stringify(r.body.order) === JSON.stringify(reversed), { got: r.body.order.slice(0, 4), want: reversed.slice(0, 4) });
  const seriesPos = reversed.findIndex(o => o.type === 'series' && o.id === ladder);
  const sortOf = (o: { type: string; id: number }) => o.type === 'series' ? r.body.series.find((x: any) => x.id === o.id)?.sortOrder : r.body.items.find((b: any) => b.id === o.id)?.sortOrder;
  check('…sort orders are 10, 20, 30, …', reversed.every((o, i) => sortOf(o) === (i + 1) * 10), reversed.slice(0, 5).map(sortOf));
  check('…tiers kept their tier order', [tier1, tier2, tier3, tier4].map(id => r.body.items.find((b: any) => b.id === id)?.sortOrder).join() === '10,20,30,40');
  const [{ n: evAfter }] = await db.select({ n: sql<number>`count(*)::int` }).from(activityEvents).where(and(eq(activityEvents.type, 'admin.badge_order_changed'), gt(activityEvents.id, Number(maxEvent))));
  check('…logged as admin.badge_order_changed', evAfter === evBefore + 1, { evBefore, evAfter });
  r = await call(alice, 'PUT', '/admin/badges/order', { items: reversed });
  check('the same order again → changed 0, nothing logged', r.status === 200 && r.body.changed === 0, r.body);
  r = await call(null, 'GET', '/badges');
  const liveTop = reversed.filter(o => o.type === 'series' ? r.body.some((b: any) => b.series?.id === o.id) : r.body.some((b: any) => b.id === o.id));
  const firstIdx = (o: { type: string; id: number }) => r.body.findIndex((b: any) => (o.type === 'series' ? b.series?.id === o.id : b.id === o.id && !b.series));
  const catIdx = liveTop.map(firstIdx);
  check('the catalog follows the new order (series as a unit)', catIdx.every((x, i) => x >= 0 && (i === 0 || x > catIdx[i - 1])), catIdx);
  r = await call(null, 'GET', `/users/${encodeURIComponent(alice.username)}/badges`);
  const shelfKeys = r.body.items.map((it: any) => (it.type === 'series' ? `series:${it.series.id}` : `badge:${it.badge.id}`));
  const wantKeys = reversed.map(o => `${o.type}:${o.id}`).filter(k => shelfKeys.includes(k));
  check('alice’s shelf follows the new order', JSON.stringify(shelfKeys) === JSON.stringify(wantKeys), { shelfKeys, wantKeys });
  void seriesPos;

  // ── series: templates, in-series order, Add tier ────────────────────────────
  // migrate25 seeded a template for the starter ladders (from their lowest tier with a clean match).
  const seededTpl = await db.execute(sql`SELECT key, description_template AS t FROM badge_series WHERE key IN ('scores', 'venues', 'machines')`) as unknown as Array<{ key: string; t: string | null }>;
  check('migrate25 seeded templates with {N} (scores / venues / machines, where present)',
    seededTpl.length > 0 && seededTpl.every(x => x.t == null || x.t.includes('{N}')) && seededTpl.some(x => x.t != null), seededTpl);
  r = await call(alice, 'POST', '/admin/badge-series', { name: 'ZZ Badge Test Mixed', color: '#246810', descriptionTemplate: 'Declined {N} requests.' });
  const mixed = r.body.series?.id as number;
  if (mixed) seriesIds.push(mixed);
  check('create a series with a template → 201, stored', r.status === 201 && r.body.series?.descriptionTemplate === 'Declined {N} requests.', r.body);
  r = await call(alice, 'PATCH', `/admin/badge-series/${mixed}`, { descriptionTemplate: 'Declined requests.' });
  check('a template without {N} → 400 invalid_series', r.status === 400 && r.body.code === 'invalid_series' && r.body.errors?.descriptionTemplate, r.body);
  r = await call(alice, 'PATCH', `/admin/badge-series/${mixed}`, { descriptionTemplate: '' });
  check('an empty template clears it (null)', r.status === 200 && r.body.series?.descriptionTemplate === null, r.body);
  r = await call(alice, 'PATCH', `/admin/badge-series/${mixed}`, { descriptionTemplate: 'Declined {N} requests.' });
  check('…and it can be set again', r.status === 200 && r.body.series?.descriptionTemplate === 'Declined {N} requests.', r.body);
  r = await call(alice, 'GET', '/admin/badges');
  check('GET /admin/badges carries each series’ descriptionTemplate', r.body.series.find((x: any) => x.id === mixed)?.descriptionTemplate === 'Declined {N} requests.');

  // Mixed ladder: metric N=900,100 and N=900,010 (created high first — seated by N, not creation
  // order), then a rule tier (joins at the end).
  const mTier = (n: number, extra: Record<string, unknown> = {}) => createBadge({
    key: `zz-badge-test-mix-${n}`, name: `ZZ Mix ${n}`, kind: 'metric', metric: mKey, threshold: n, seriesId: mixed,
    description: `Declined ${n.toLocaleString('en-US')} requests.`, icon: 'star', ...extra,
  });
  const mHigh = await mTier(900_100);
  const mLow = await mTier(900_010, { icon: 'circle' });
  const mRule = await createBadge({ key: 'zz-badge-test-mix-rule', name: 'ZZ Mix rule', kind: 'rule', rule: anyRule, seriesId: mixed, icon: 'gift' });
  const mixedOrder = async () => {
    const x = await call(alice, 'GET', '/admin/badges');
    return (x.body.items as any[]).filter(b => b.seriesId === mixed).map(b => b.id as number);
  };
  check('metric tiers seat by N (the lower one first although created second); a rule tier joins at the end',
    JSON.stringify(await mixedOrder()) === JSON.stringify([mLow, mHigh, mRule]), await mixedOrder());
  r = await call(alice, 'PUT', `/admin/badge-series/${mixed}/order`, { ids: [mHigh, mLow, mRule] });
  check('in-series reorder putting a higher N first → 400 threshold_order', r.status === 400 && r.body.code === 'threshold_order', r.body);
  r = await call(alice, 'PUT', `/admin/badge-series/${mixed}/order`, { ids: [mLow, mRule] });
  check('in-series reorder missing a tier → 409 order_stale', r.status === 409 && r.body.code === 'order_stale', r.body);
  r = await call(alice, 'PUT', `/admin/badge-series/${mixed}/order`, { ids: [mLow, mHigh, mRule, tier1] });
  check('in-series reorder naming another series’ tier → 400 unknown_item', r.status === 400 && r.body.code === 'unknown_item', r.body);
  r = await call(alice, 'PUT', `/admin/badge-series/${999_999_999}/order`, { ids: [] });
  check('in-series reorder of an unknown series → 404', r.status === 404 && r.body.code === 'series_not_found', r.body);
  const [{ n: tierEvBefore }] = await db.select({ n: sql<number>`count(*)::int` }).from(activityEvents).where(and(eq(activityEvents.type, 'admin.badge_order_changed'), eq(activityEvents.targetType, 'badge_series'), eq(activityEvents.targetId, String(mixed))));
  r = await call(alice, 'PUT', `/admin/badge-series/${mixed}/order`, { ids: [mLow, mRule, mHigh] });
  check('in-series reorder: the rule tier between the metric tiers → 200, changed', r.status === 200 && r.body.changed > 0, r.body);
  check('…persisted: the mixed ladder reads low → rule → high', JSON.stringify(await mixedOrder()) === JSON.stringify([mLow, mRule, mHigh]), await mixedOrder());
  r = await call(alice, 'GET', '/admin/badges');
  check('…tier sort_orders are 10, 20, 30', [mLow, mRule, mHigh].map(id => r.body.items.find((b: any) => b.id === id)?.sortOrder).join() === '10,20,30');
  const [{ n: tierEvAfter }] = await db.select({ n: sql<number>`count(*)::int` }).from(activityEvents).where(and(eq(activityEvents.type, 'admin.badge_order_changed'), eq(activityEvents.targetType, 'badge_series'), eq(activityEvents.targetId, String(mixed))));
  check('…logged once as admin.badge_order_changed on the series', tierEvAfter === tierEvBefore + 1, { tierEvBefore, tierEvAfter });
  r = await call(alice, 'PUT', `/admin/badge-series/${mixed}/order`, { ids: [mLow, mRule, mHigh] });
  check('the same tier order again → changed 0', r.status === 200 && r.body.changed === 0, r.body);
  r = await call(alice, 'PUT', `/admin/badge-series/${mixed}/order`, { ids: [mRule, mLow, mHigh] });
  check('a rule tier can go first', r.status === 200 && JSON.stringify(await mixedOrder()) === JSON.stringify([mRule, mLow, mHigh]), await mixedOrder());
  await call(alice, 'PUT', `/admin/badge-series/${mixed}/order`, { ids: [mLow, mRule, mHigh] });

  // A new N between the two lands just before the first higher N — after the rule tier.
  const mMid = await mTier(900_050);
  check('a new metric tier seats before the first higher N (low → rule → mid → high)', JSON.stringify(await mixedOrder()) === JSON.stringify([mLow, mRule, mMid, mHigh]), await mixedOrder());
  r = await call(alice, 'PATCH', `/admin/badges/${mLow}`, { threshold: 900_500 });
  check('changing a tier’s N re-seats it (low → the top)', r.status === 200 && JSON.stringify(await mixedOrder()) === JSON.stringify([mRule, mMid, mHigh, mLow]), await mixedOrder());
  r = await call(alice, 'PATCH', `/admin/badges/${mLow}`, { name: 'ZZ Mix renamed', sortOrder: 1 });
  check('an edit that doesn’t change N leaves the order alone (a tier ignores sortOrder)', r.status === 200 && JSON.stringify(await mixedOrder()) === JSON.stringify([mRule, mMid, mHigh, mLow]), await mixedOrder());
  r = await call(alice, 'PATCH', `/admin/badges/${mLow}`, { threshold: 900_010 });
  check('…back down to the lowest N → just before the first higher N (the rule tier stays first)',
    r.status === 200 && JSON.stringify(await mixedOrder()) === JSON.stringify([mRule, mLow, mMid, mHigh]), await mixedOrder());
  r = await call(alice, 'GET', `/admin/badges`);
  const adminIdx = [mRule, mLow, mMid, mHigh].map(id => r.body.items.findIndex((b: any) => b.id === id));
  check('admin list: the mixed tiers consecutive in that order', adminIdx.every((x, i) => i === 0 || x === adminIdx[i - 1] + 1), adminIdx);

  // "Add tier": prefill from the series — metric + next N (900,010 / 900,050 / 900,100 → ×2 = 200,200
  // → capped at the 1,000,000 max), template description, icon from the top tier, series color.
  r = await call(alice, 'GET', `/admin/badge-series/${mixed}/new-tier`);
  const draft = r.body?.draft;
  check('Add tier prefill → 200 with kind/metric/series/color', r.status === 200 && draft?.seriesId === mixed && draft?.kind === 'metric' && draft?.metric === mKey && draft?.color === '#246810', draft);
  check('…next N above the highest (capped at the max)', draft?.threshold === 1_000_000 && JSON.stringify(draft?.basedOn) === JSON.stringify([900_010, 900_050, 900_100]), draft);
  check('…description from the template with the new N (1,000,000)', draft?.description === 'Declined 1,000,000 requests.' && draft?.descriptionFrom === 'template', draft);
  check('…icon from the top tier (the highest in tier order)', draft?.icon === 'star', draft);
  check('…key suggested from the top metric tier’s key', draft?.key === 'zz-badge-test-mix-1000000', draft);
  // A realistic ladder: the seeded Venues series (if present on this DB) prefills a sensible N.
  const [venuesSeries] = await db.select({ id: badgeSeries.id }).from(badgeSeries).where(eq(badgeSeries.key, 'venues'));
  if (venuesSeries) {
    r = await call(alice, 'GET', `/admin/badge-series/${venuesSeries.id}/new-tier`);
    check('Add tier on Venues → a metric tier above its top N, description rendered', r.status === 200 && r.body.draft?.kind === 'metric'
      && r.body.draft.threshold > Math.max(...r.body.draft.basedOn) && (r.body.draft.descriptionFrom !== 'template' || !r.body.draft.description.includes('{N}')), r.body.draft);
    console.log(`      (Venues prefill: N=${r.body.draft?.threshold} from [${r.body.draft?.basedOn}], “${r.body.draft?.description}”)`);
  }
  r = await call(alice, 'GET', '/admin/badge-series/999999999/new-tier');
  check('Add tier on an unknown series → 404', r.status === 404, r.body);
  r = await call(alice, 'GET', `/admin/badge-series/${ladder}/new-tier`);
  check('Add tier on a rule ladder → kind rule, rule shape + description copied from the top tier',
    r.status === 200 && r.body.draft?.kind === 'rule' && r.body.draft?.rule?.machine?.machineId === machineId && r.body.draft?.description === 'Tier 4 desc' && r.body.draft?.threshold === null, r.body.draft);
  // The prefill round-trips through create (name typed by the admin): it seats at the top.
  const added = await createBadge({ key: draft.key, name: 'ZZ Mix added', kind: draft.kind, metric: draft.metric, threshold: draft.threshold, description: draft.description, icon: draft.icon, seriesId: draft.seriesId });
  check('creating from the prefill → a draft tier at the top of the ladder', JSON.stringify(await mixedOrder()) === JSON.stringify([mRule, mLow, mMid, mHigh, added]), await mixedOrder());

  // ── one metric per series ─────────────────────────────────────────────────
  // The mixed series goes by mKey (its metric tiers); a rule tier (mRule) was already accepted.
  const otherKey = 'your_requests_declined';
  r = await call(alice, 'GET', '/admin/badges');
  check('GET /admin/badges: each series’ metric (mixed → its tiers’ metric; the rule ladder → null), no conflict',
    r.body.series.find((x: any) => x.id === mixed)?.metric === mKey && r.body.series.find((x: any) => x.id === ladder)?.metric === null
    && r.body.series.find((x: any) => x.id === mixed)?.metricConflict === null, r.body.series.filter((x: any) => x.id === mixed || x.id === ladder));
  r = await call(alice, 'POST', '/admin/badges', { key: 'zz-badge-test-om-1', name: 'ZZ Other metric', kind: 'metric', metric: otherKey, threshold: 900_020, seriesId: mixed });
  check('create a metric tier on another metric in the series → 400 series_metric_mismatch, naming the series’ metric',
    r.status === 400 && r.body.code === 'series_metric_mismatch' && r.body.seriesMetric === mKey && typeof r.body.seriesMetricLabel === 'string'
    && r.body.seriesId === mixed && r.body.seriesName === 'ZZ Badge Test Mixed' && typeof r.body.errors?.metric === 'string', r.body);
  console.log(`      (error: ${r.body.error})`);
  check('…nothing was created', (await db.select().from(badges).where(eq(badges.key, 'zz-badge-test-om-1'))).length === 0);
  const ruleOk = await createBadge({ key: 'zz-badge-test-om-rule', name: 'ZZ OM rule', kind: 'manual', seriesId: mixed });
  check('a manual tier (no threshold) still joins any series', !!ruleOk);
  // Moving an other-metric single into the series, or changing a tier's metric, is refused too.
  const om = await createBadge({ key: 'zz-badge-test-om-2', name: 'ZZ OM single', kind: 'metric', metric: otherKey, threshold: 900_021, seriesId: null });
  r = await call(alice, 'PATCH', `/admin/badges/${om}`, { seriesId: mixed });
  check('PATCH moving an other-metric badge into the series → 400 series_metric_mismatch, not moved',
    r.status === 400 && r.body.code === 'series_metric_mismatch' && (await db.select({ s: badges.seriesId }).from(badges).where(eq(badges.id, om)))[0]?.s === null, r.body);
  r = await call(alice, 'PATCH', `/admin/badges/${mMid}`, { metric: otherKey });
  check('PATCH a tier’s metric to another metric → 400 series_metric_mismatch, unchanged',
    r.status === 400 && r.body.code === 'series_metric_mismatch' && (await db.select({ m: badges.metric }).from(badges).where(eq(badges.id, mMid)))[0]?.m === mKey, r.body);
  r = await call(alice, 'PATCH', `/admin/badges/${mRule}`, { kind: 'metric', metric: otherKey, threshold: 900_030 });
  check('PATCH a rule tier into a metric tier on another metric → 400', r.status === 400 && r.body.code === 'series_metric_mismatch', r.body);
  r = await call(alice, 'PATCH', `/admin/badges/${om}`, { metric: mKey, seriesId: mixed });
  check('…with the series’ metric, the move is accepted', r.status === 200 && r.body.badge.seriesId === mixed && r.body.badge.metric === mKey, r.body.badge);
  // An empty series accepts any metric for its first tier; after that it goes by that metric.
  r = await call(alice, 'POST', '/admin/badge-series', { name: 'ZZ Badge Test OneMetric', color: '#135790' });
  const oneM = r.body.series?.id as number;
  if (oneM) seriesIds.push(oneM);
  const first = await createBadge({ key: 'zz-badge-test-om-3', name: 'ZZ OM first', kind: 'metric', metric: otherKey, threshold: 900_040, seriesId: oneM });
  check('an empty series takes any metric for its first tier', !!first);
  r = await call(alice, 'POST', '/admin/badges', { key: 'zz-badge-test-om-4', name: 'ZZ OM second', kind: 'metric', metric: mKey, threshold: 900_041, seriesId: oneM });
  check('…then refuses a second metric', r.status === 400 && r.body.code === 'series_metric_mismatch' && r.body.seriesMetric === otherKey, r.body);
  r = await call(alice, 'PATCH', `/admin/badges/${first}`, { metric: mKey });
  check('its only metric tier may still change metric (nothing else to match)', r.status === 200 && r.body.badge.metric === mKey, r.body);
  r = await call(alice, 'POST', '/admin/badges', { key: 'zz-badge-test-om-5', name: 'ZZ OM new series', kind: 'metric', metric: otherKey, threshold: 900_042, newSeries: { name: 'ZZ Badge Test OM New', color: '#975310' } });
  check('newSeries always accepts (a fresh series has no metric yet)', r.status === 201, r.body);
  if (r.status === 201) { badgeIds.push(r.body.badge.id); seriesIds.push(r.body.badge.seriesId); }
  // Data from before the rule: planted directly (the API can't make it) → flagged, never rewritten.
  await db.update(badges).set({ metric: otherKey }).where(eq(badges.id, mMid));
  r = await call(alice, 'GET', '/admin/badges');
  const conflict = r.body.series.find((x: any) => x.id === mixed)?.metricConflict;
  check('a series whose tiers already disagree → metricConflict: goes by the majority, names the odd tier + a fix hint',
    conflict?.seriesMetric === mKey && conflict.offenders?.length === 1 && conflict.offenders[0].id === mMid && /move it out of the series/.test(conflict.message), conflict);
  console.log(`      (warning: ${conflict?.message})`);
  check('…and nothing was changed by listing it', (await db.select({ m: badges.metric }).from(badges).where(eq(badges.id, mMid)))[0]?.m === otherKey);
  r = await call(alice, 'PATCH', `/admin/badges/${mMid}`, { name: 'ZZ Mix mid renamed' });
  check('an unrelated edit to the odd tier (rename) is allowed', r.status === 200, r.body);
  r = await call(alice, 'PATCH', `/admin/badges/${mMid}`, { metric: mKey });
  check('fixing its metric to the series’ one → 200, conflict gone', r.status === 200
    && (await call(alice, 'GET', '/admin/badges')).body.series.find((x: any) => x.id === mixed)?.metricConflict === null, r.body);

  // ── a played time in the future never counts toward a badge (every rule, every score metric) ──
  {
    const [fm] = await db.insert(machines).values({ name: `zz-badge-test future machine ${Date.now()}`, opdbId: 'Gzzbt-M0002' }).returning({ id: machines.id });
    extraMachineIds.push(fm.id);
    const [fv] = await db.insert(venues).values({ name: 'zz-badge-test future venue', timezone: 'America/New_York' }).returning({ id: venues.id });
    venueIds.push(fv.id);
    const metricKeys = ['scores_posted', 'distinct_machines', 'distinct_venues'];
    const read = async (u: { id: number }) => Object.fromEntries(await Promise.all(metricKeys.map(async k => [k, await readMetric(db, k, u.id)]))) as Record<string, number>;
    const carolBefore = await read(carol), bobBefore = await read(bob);
    const plant = async (userId: number, playedAt: Date, createdAt: Date) => {
      const [s] = await db.insert(scores).values({
        userId, machineId: fm.id, score: 4_242_424, venueId: fv.id, venueName: 'zz', playedAt, createdAt, photoThumbnail: 'data:image/jpeg;base64,zz',
      }).returning({ id: scores.id });
      scoreIds.push(s.id);
      return s.id;
    };
    const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
    const futureId = await plant(carol.id, new Date(+t0 + 2 * 86_400_000), t0);        // "played" two days after it was logged
    const edgeId = await plant(bob.id, new Date(+t0 + FUTURE_SKEW_MS - 60_000), t0);   // 14 min ahead: clock skew, still counts
    const carolAfter = await read(carol), bobAfter = await read(bob);
    check('future-dated legacy score counts toward no score metric (scores_posted / distinct_machines / distinct_venues)',
      metricKeys.every(k => carolAfter[k] === carolBefore[k]), { carolBefore, carolAfter });
    check('…while one 14 min ahead (inside the skew) counts toward each', metricKeys.every(k => bobAfter[k] === bobBefore[k] + 1), { bobBefore, bobAfter });
    const backfillQuery = await metricCounts(db, 'scores_posted', { userIds: [carol.id], min: carolBefore.scores_posted + 1 });
    check('…and the backfill form of the metric query (HAVING value >= N) agrees', !backfillQuery.has(carol.id), [...backfillQuery]);
    const futureBadge = await createBadge({ key: 'zz-badge-test-future', name: 'ZZ Future', kind: 'rule', rule: { machine: { machineId: fm.id, matchMode: 'exact' } }, retroactive: true });
    r = await call(alice, 'POST', `/admin/badges/${futureBadge}/preview`);
    check('rule badge with no posting window: preview → only bob (carol’s future-dated score is ignored)',
      r.status === 200 && r.body.total === 1 && r.body.qualifying[0]?.user?.id === bob.id && r.body.qualifying[0]?.sourceScoreId === edgeId, r.body);
    r = await call(alice, 'POST', `/admin/badges/${futureBadge}/activate`);
    check('…retroactive activation → awarded 1 (bob), carol gets nothing', r.status === 200 && r.body.awarded === 1 && await holds(bob.id, futureBadge) === 1 && await holds(carol.id, futureBadge) === 0, r.body);
    const live = await awardBadges(carol.id, { score: { id: futureId }, metrics: ['scores_posted'] });
    check('…the live award path (awardBadges on that score) agrees', !live.some(b => b.id === futureBadge) && await holds(carol.id, futureBadge) === 0, live);
  }

  // ── challenge badges (phase 3) ─────────────────────────────────────────────
  const [{ priorChallenges }] = await db.select({ priorChallenges: sql<number>`count(*)::int` }).from(challengeParticipants).where(inArray(challengeParticipants.userId, ids));
  if (priorChallenges > 0) {
    check(`challenge badges need borrowed users with no challenges (they have ${priorChallenges} participant rows)`, false);
  } else {
    noPriorChallenges = true;
    const HOUR = 3_600_000;
    const at = (msFromNow: number) => new Date(Date.now() + msFromNow);
    const chBadge = async (key: string, metric: string, threshold: number) => {
      const id = await createBadge({ key: `zz-badge-test-ch-${key}`, name: `ZZ ${key}`, kind: 'metric', metric, threshold, retroactive: false });
      const a = await call(alice, 'POST', `/admin/badges/${id}/activate`);
      if (a.status !== 200) throw new Error(`activate ${key}: ${JSON.stringify(a)}`);
      return id;
    };
    const wins1 = await chBadge('wins-1', 'challenge_wins', 1);
    const streak3 = await chBadge('win-streak-3', 'win_streak_achieved', 3);
    const lossStreak3 = await chBadge('loss-streak-3', 'loss_streak_achieved', 3);
    const tie1 = await chBadge('ties-1', 'challenges_tied', 1);
    const declined1 = await chBadge('declined-1', 'challenges_declined', 1);
    const backedOut1 = await chBadge('backed-out-1', 'challenges_backed_out', 1);
    const countered1 = await chBadge('countered-1', 'challenges_countered', 1);
    const countersAccepted1 = await chBadge('counters-accepted-1', 'counters_accepted', 1);
    const award = async (userId: number, badgeId: number) =>
      (await db.select().from(userBadges).where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId))))[0];

    // A high_score challenge that ended in the past with one counting score per player, so the next
    // syncChallenge resolves it on its deadline (applyResolution — the real trigger path). Each gets
    // its own 2-hour window, further back each time, so no score counts in two of them.
    let slot = 0;
    const played = async (players: Array<{ id: number; score: number }>) => {
      const end = -(1 + 3 * slot++) * HOUR;
      const [c] = await db.insert(challenges).values({
        creatorId: players[0].id, type: 'high_score', machineId, matchMode: 'exact', startsAt: at(end - 2 * HOUR), endsAt: at(end), status: 'active',
      }).returning({ id: challenges.id });
      challengeIds.push(c.id);
      await db.insert(challengeParticipants).values(players.map(p => ({ challengeId: c.id, userId: p.id, response: 'accepted' as const, respondedAt: at(end - 2 * HOUR) })));
      for (const p of players) await hist(p.id, la.id, at(end - HOUR).toISOString(), at(end - HOUR).toISOString(), p.score);
      const s = await syncChallenge(c.id);
      if (s?.status !== 'resolved') throw new Error(`challenge ${c.id} did not resolve: ${JSON.stringify(s)}`);
      return c.id;
    };

    const c1 = await played([{ id: alice.id, score: 90_000 }, { id: bob.id, score: 10_000 }]);
    const w = await award(alice.id, wins1);
    check('a resolved challenge awards wins-1 to the winner, sourced from that challenge', w?.sourceChallengeId === c1, w);
    check('…not to the loser', !(await award(bob.id, wins1)));
    const [wNotif] = await db.select().from(notifications).where(and(eq(notifications.userId, alice.id), eq(notifications.kind, 'badge_earned'), sql`${notifications.payload} ->> 'badgeId' = ${String(wins1)}`));
    check('…with a badge_earned notification', !!wNotif, wNotif);
    const [wEv] = await db.select().from(activityEvents).where(and(eq(activityEvents.type, 'badge.earned'), eq(activityEvents.targetId, String(wins1)), eq(activityEvents.actorUserId, alice.id)));
    check('…and badge.earned (trigger challenge, sourceChallengeId)', (wEv?.payload as any)?.trigger === 'challenge' && (wEv?.payload as any)?.sourceChallengeId === c1, wEv);
    check('no streak badge after one win', !(await award(alice.id, streak3)));

    await played([{ id: alice.id, score: 90_000 }, { id: bob.id, score: 10_000 }]);
    const c3 = await played([{ id: bob.id, score: 10_000 }, { id: alice.id, score: 90_000 }]);
    const s3 = await award(alice.id, streak3);
    check('three wins in a row award the win-streak-3 badge (sourced from the third)', s3?.sourceChallengeId === c3 && await readMetric(db, 'win_streak_achieved', alice.id) === 3, s3);
    const l3 = await award(bob.id, lossStreak3);
    check('three losses in a row award the loss-streak-3 badge to the loser', l3?.sourceChallengeId === c3 && await readMetric(db, 'loss_streak_achieved', bob.id) === 3, l3);
    check('wins-1 was awarded once (earned once)', (await db.select().from(userBadges).where(eq(userBadges.badgeId, wins1))).length === 1);

    const c4 = await played([{ id: alice.id, score: 50_000 }, { id: carol.id, score: 50_000 }]);
    check('a tie awards ties-1 to both players', (await award(alice.id, tie1))?.sourceChallengeId === c4 && (await award(carol.id, tie1))?.sourceChallengeId === c4);
    check('…and a tie is not a win (carol has no wins-1)', !(await award(carol.id, wins1)));
    check('…and a tie ends a win streak (alice’s best stays 3)', await readMetric(db, 'win_streak_achieved', alice.id) === 3);

    // Admin void: it stops counting; nothing is revoked (no automatic revocation).
    const c5 = await played([{ id: carol.id, score: 99_000 }, { id: alice.id, score: 1_000 }]);
    const carolWon = await readMetric(db, 'challenge_wins', carol.id);
    check('carol wins one → wins-1', carolWon === 1 && (await award(carol.id, wins1))?.sourceChallengeId === c5, carolWon);
    const v = await voidChallenge(alice, c5, 'zz-badge-test void');
    check('admin void → the win stops counting (challenge_wins 0, alice’s loss gone too)',
      v.status === 200 && await readMetric(db, 'challenge_wins', carol.id) === 0 && await readMetric(db, 'challenge_losses', alice.id) === 0, v);
    check('…but carol keeps the badge she earned (no automatic revocation)', !!(await award(carol.id, wins1)));

    // Back-out vs a true decline, through the real decline route. A pending group: alice (creator),
    // bob accepted, carol invited.
    const [g] = await db.insert(challenges).values({ creatorId: alice.id, type: 'high_score', machineId, matchMode: 'exact', endsAt: at(48 * HOUR), status: 'pending' }).returning({ id: challenges.id });
    challengeIds.push(g.id);
    await db.insert(challengeParticipants).values([
      { challengeId: g.id, userId: alice.id, response: 'accepted', respondedAt: at(0) },
      { challengeId: g.id, userId: bob.id, response: 'accepted', respondedAt: at(0) },
      { challengeId: g.id, userId: carol.id, response: 'pending' },
    ]);
    r = await call(bob, 'POST', `/challenges/${g.id}/decline`, { reason: 'no_thanks' });
    check('bob backs out (200)', r.status === 200, r);
    check('…counts for challenges_backed_out, NOT challenges_declined',
      await readMetric(db, 'challenges_backed_out', bob.id) === 1 && await readMetric(db, 'challenges_declined', bob.id) === 0 && await readMetric(db, 'challenges_passed', bob.id) === 0);
    check('…awards backed-out-1 (sourced from the group), not declined-1',
      (await award(bob.id, backedOut1))?.sourceChallengeId === g.id && !(await award(bob.id, declined1)));
    r = await call(carol, 'POST', `/challenges/${g.id}/decline`, { reason: 'cant_reach' });
    check('carol’s plain decline awards declined-1', r.status === 200 && (await award(carol.id, declined1))?.sourceChallengeId === g.id
      && await readMetric(db, 'challenges_cant_reach', carol.id) === 1, r);

    // A counter-offer, then the challenger takes it (counters_accepted for the proposer). A counter
    // needs the pair to be friends.
    const [pair] = await db.select({ id: friendships.id }).from(friendships).where(sql`${friendships.status} = 'accepted' AND least(${friendships.requesterId}, ${friendships.addresseeId}) = ${Math.min(alice.id, bob.id)} AND greatest(${friendships.requesterId}, ${friendships.addresseeId}) = ${Math.max(alice.id, bob.id)}`);
    if (!pair) {
      await db.delete(friendships).where(or(and(eq(friendships.requesterId, alice.id), eq(friendships.addresseeId, bob.id)), and(eq(friendships.requesterId, bob.id), eq(friendships.addresseeId, alice.id))));
      const [f] = await db.insert(friendships).values({ requesterId: alice.id, addresseeId: bob.id, status: 'accepted', respondedAt: new Date() }).returning({ id: friendships.id });
      madeFriendship = f.id;
    }
    const [o] = await db.insert(challenges).values({ creatorId: alice.id, type: 'high_score', machineId, matchMode: 'exact', endsAt: at(48 * HOUR), status: 'pending' }).returning({ id: challenges.id });
    challengeIds.push(o.id);
    await db.insert(challengeParticipants).values([
      { challengeId: o.id, userId: alice.id, response: 'accepted', respondedAt: at(0) },
      { challengeId: o.id, userId: bob.id, response: 'pending' },
    ]);
    r = await call(bob, 'POST', `/challenges/${o.id}/counter`, { type: 'high_score', machineId, matchMode: 'exact', endsAt: at(24 * HOUR).toISOString() });
    const proposalId = r.body?.counter?.id as number | undefined;
    if (proposalId) challengeIds.push(proposalId);
    check('bob counters (201) → countered-1, sourced from the original', r.status === 201 && (await award(bob.id, countered1))?.sourceChallengeId === o.id, r);
    check('…the counter is not a decline, and no counters_accepted yet',
      await readMetric(db, 'challenges_declined', bob.id) === 0 && await readMetric(db, 'counters_accepted', bob.id) === 0 && !(await award(bob.id, countersAccepted1)));
    r = await call(alice, 'POST', `/challenges/${proposalId}/accept`);
    check('alice takes the suggestion → counters_accepted 1, counters-accepted-1 sourced from the proposal',
      r.status === 200 && await readMetric(db, 'counters_accepted', bob.id) === 1 && (await award(bob.id, countersAccepted1))?.sourceChallengeId === proposalId, r);

    // The backfill query (preview) agrees with the single-user reads, and excludes the voided win.
    const bf = await createBadge({ key: 'zz-badge-test-ch-backfill', name: 'ZZ wins backfill', kind: 'metric', metric: 'challenge_wins', threshold: 1, retroactive: true });
    r = await call(alice, 'POST', `/admin/badges/${bf}/preview`);
    const q = (r.body?.qualifying ?? []) as Array<{ user: { id: number }; value?: number }>;
    const bulk = await metricCounts(db, 'challenge_wins', { min: 1 });
    let agree = q.length <= bulk.size; // the preview lists at most PREVIEW_LIMIT; `total` is all of them
    for (const x of q) if (x.value != null && x.value !== await readMetric(db, 'challenge_wins', x.user.id)) agree = false;
    for (const [u, value] of bulk) if (value !== await readMetric(db, 'challenge_wins', u)) agree = false;
    check('backfill (preview) of a challenge_wins badge matches the single-user reads', r.status === 200 && agree && r.body.total === bulk.size, { total: r.body?.total, bulk: bulk.size });
    check('…alice qualifies with 3 wins; carol (voided win only) does not',
      q.some(x => x.user.id === alice.id) && bulk.get(alice.id) === 3 && !q.some(x => x.user.id === carol.id), q.filter(x => ids.includes(x.user.id)));
    for (const k of ['challenges_backed_out', 'counters_accepted', 'win_streak_achieved', 'loss_streak_achieved']) {
      const all = await metricCounts(db, k, { min: 1 });
      let same = true;
      for (const [u, value] of all) if (value !== await readMetric(db, k, u)) same = false;
      check(`backfill form of ${k} agrees with the single-user reads`, same);
    }
  }

  // ── retire; the sweep ──────────────────────────────────────────────────────
  r = await call(alice, 'POST', `/admin/badges/${big}/retire`);
  check('retire → ok; earned one stays', r.status === 200 && await holds(alice.id, big) === 1, r);
  const sweep = await runBadgeSweep();
  check('daily sweep runs', typeof sweep.users === 'number' && typeof sweep.awarded === 'number', sweep);
  r = await call(alice, 'GET', '/admin/badges/metrics');
  check('metrics endpoint lists every metric as available, challenge metrics included',
    r.body.some((x: any) => x.key === 'scores_posted' && x.available) && r.body.some((x: any) => x.key === 'challenge_wins' && x.available)
    && r.body.some((x: any) => x.key === 'counters_rejected' && x.available) && r.body.every((x: any) => x.available), r.body);
} catch (err) {
  failures++;
  console.error('FAIL  threw:', err);
} finally {
  // ── cleanup ─────────────────────────────────────────────────────────────────
  setRetentionLoaderForTests(null);
  // Challenges among the borrowed users (they had none — checked), before their scores: challenge_scores
  // cascades with the challenge, and a locked score can't be deleted while it has a row there.
  const theirs = noPriorChallenges
    ? await db.select({ id: challengeParticipants.challengeId }).from(challengeParticipants).where(inArray(challengeParticipants.userId, ids))
    : [];
  const allChallengeIds = [...new Set([...challengeIds, ...theirs.map(x => x.id)])];
  if (allChallengeIds.length) {
    await db.delete(activityEvents).where(and(gt(activityEvents.id, Number(maxEvent)), eq(activityEvents.targetType, 'challenge'), inArray(activityEvents.targetId, allChallengeIds.map(String))));
    await db.delete(challenges).where(inArray(challenges.id, allChallengeIds)); // participants + challenge_scores cascade
  }
  if (madeFriendship) await db.delete(friendships).where(eq(friendships.id, madeFriendship));
  // Put every pre-existing badge's and series' sort_order (and updated_at) back exactly.
  for (const b of orderSnapshot.badges) await db.execute(sql`UPDATE badges SET sort_order = ${b.sort_order}, updated_at = ${b.updated_at}::timestamptz WHERE id = ${b.id}`);
  for (const x of orderSnapshot.series) await db.execute(sql`UPDATE badge_series SET sort_order = ${x.sort_order}, updated_at = ${x.updated_at}::timestamptz WHERE id = ${x.id}`);
  const zz = await db.select({ id: badges.id }).from(badges).where(like(badges.key, 'zz-badge-test-%'));
  const allBadgeIds = [...new Set([...badgeIds, ...zz.map(b => b.id)])];
  if (allBadgeIds.length) {
    const idText = allBadgeIds.map(String);
    await db.delete(notifications).where(and(eq(notifications.kind, 'badge_earned'), inArray(sql`${notifications.payload} ->> 'badgeId'`, idText)));
    await db.delete(activityEvents).where(or(
      and(eq(activityEvents.targetType, 'badge'), inArray(activityEvents.targetId, idText)),
      and(eq(activityEvents.type, 'notification.sent'), sql`${activityEvents.payload} ->> 'kind' = 'badge_earned'`, inArray(sql`${activityEvents.payload} ->> 'badgeId'`, idText)),
    ));
    await db.delete(badges).where(inArray(badges.id, allBadgeIds)); // user_badges cascade
  }
  const zzSeries = await db.select({ id: badgeSeries.id }).from(badgeSeries).where(like(badgeSeries.key, 'zz-badge-test-%'));
  const allSeriesIds = [...new Set([...seriesIds, ...zzSeries.map(x => x.id)])];
  if (allSeriesIds.length) {
    await db.delete(activityEvents).where(and(eq(activityEvents.targetType, 'badge_series'), inArray(activityEvents.targetId, allSeriesIds.map(String))));
    await db.delete(badgeSeries).where(inArray(badgeSeries.id, allSeriesIds));
  }
  // Awards of anyone's *other* live badges (an admin's manual testing state, e.g. a live "send a
  // friend request" badge) that this run's friend events / scores triggered for the borrowed users.
  await db.delete(userBadges).where(and(inArray(userBadges.userId, ids), sql`${userBadges.earnedAt} >= ${startedAt}::timestamptz`));
  await db.delete(friendships).where(and(inArray(friendships.requesterId, ids), inArray(friendships.addresseeId, ids)));
  await db.delete(notifications).where(and(inArray(notifications.userId, ids), gt(notifications.id, maxNotif)));
  await db.delete(activityEvents).where(and(gt(activityEvents.id, Number(maxEvent)), or(inArray(activityEvents.actorUserId, ids), inArray(activityEvents.subjectUserId, ids))));
  // Marks this script wrote: friend marks among the three, and the 2001-01-01 login day.
  const refs = ids.flatMap(i => [String(i), ...[1, 2, 3, 4].map(n => `${i}:${n}`)]);
  await db.delete(userMetricMarks).where(and(
    inArray(userMetricMarks.userId, ids),
    or(
      and(eq(userMetricMarks.metric, 'login_days'), eq(userMetricMarks.ref, LOGIN_DAY)),
      and(inArray(userMetricMarks.metric, ['friend_requests_sent', 'your_requests_accepted', 'friend_requests_accepted_by_you', 'friend_requests_declined_by_you', 'your_requests_declined']),
        inArray(userMetricMarks.ref, refs), gt(userMetricMarks.at, sql`now() - interval '1 hour'`)),
    ),
  ));
  if (scoreIds.length) {
    await db.delete(activityEvents).where(and(eq(activityEvents.targetType, 'score'), inArray(activityEvents.targetId, scoreIds.map(String))));
    await db.delete(scores).where(inArray(scores.id, scoreIds));
  }
  if (machineId) {
    await db.delete(scores).where(eq(scores.machineId, machineId));
    await db.delete(machines).where(eq(machines.id, machineId));
  }
  if (extraMachineIds.length) {
    await db.delete(scores).where(inArray(scores.machineId, extraMachineIds));
    await db.delete(machines).where(inArray(machines.id, extraMachineIds));
  }
  if (venueIds.length) await db.delete(venues).where(inArray(venues.id, venueIds));
  const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(badges).where(like(badges.key, 'zz-badge-test-%'));
  const [leftF] = await db.select({ n: sql<number>`count(*)::int` }).from(friendships).where(and(inArray(friendships.requesterId, ids), inArray(friendships.addresseeId, ids)));
  const [leftS] = await db.select({ n: sql<number>`count(*)::int` }).from(badgeSeries).where(like(badgeSeries.key, 'zz-badge-test-%'));
  console.log(`cleanup: ${left.n} zz badges, ${leftS.n} zz series, ${leftF.n} test friendships left`);
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
