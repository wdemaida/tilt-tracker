// End-to-end check of activity-log retention and the admin photo-orphan endpoints against the Neon
// DEV branch.
//
// Mounts the REAL admin router on a throwaway express app (auth via the `x-test-clerk` header, like
// test-admin.ts). Creates two throwaway users (`zz-retention-test-…`, one admin), inserts synthetic
// activity events backdated into each tier, and checks: the settings endpoints (guards, validation,
// the admin.settings_changed event), the per-tier counts / would-delete estimate, and that a
// retention run deletes exactly what's past each tier's limit (batched, with a tiny batch size) and
// keeps the rest. Then the photo-orphan endpoints with a FAKE store (no bucket touched): dry run
// deletes nothing, a real run deletes the orphan and keeps the key a score references, and the
// weekly schedule is then "not due".
//
// NOTE: the retention run is the real purge — on the dev branch it also deletes any genuine dev
// events past the default limits (the log only started 2026-09-26, so there normally are none; the
// script prints how many non-test rows were eligible first). The app_settings rows it touches
// (activity_retention, photo_orphans_last_run) are restored to what they were. Everything else it
// created — users, machine, score, its events and the system.activity_retention rows its runs logged —
// is deleted at the end.
//
//   cd artifacts/api-server && npx tsx test-retention.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { default: express } = await import('express');
const { setAuthForTests } = await import('./src/middleware/requireAuth.js');
const { setClerkAdminForTests } = await import('./src/lib/clerkAdmin.js');
const { setPhotoStoreForTests } = await import('./src/lib/photoStore.js');
const { default: adminRouter } = await import('./src/routes/admin.js');
const { runActivityRetention, RETENTION_SETTING_KEY } = await import('./src/lib/activityRetention.js');
const { PHOTO_ORPHANS_SETTING_KEY, runScheduledOrphanSweep } = await import('./src/lib/photoOrphans.js');
const { db, users, machines, scores, activityEvents, appSettings } = await import('@workspace/db');
const { and, eq, gt, inArray, or, sql, desc } = await import('drizzle-orm');

const TAG = `zz-retention-test-${Date.now().toString(36)}`;
const clerkIds = { admin: `${TAG}-admin`, user: `${TAG}-user` };

setAuthForTests({ resolveClerkId: req => (req.headers['x-test-clerk'] as string | undefined) ?? null });
setClerkAdminForTests({ listUsers: async ids => ids.map(id => ({ id, lastSignInAt: null, lastActiveAt: null, banned: false })), ban: async () => {}, unban: async () => {} });

// Fake R2 store: the dev bucket's name (so the env check passes), but nothing leaves this process.
const REFERENCED_KEY = 'scores/2147480001/aaaaaaaa-0000-4000-8000-000000000001.jpg';
const ORPHAN_KEY = 'scores/2147480002/bbbbbbbb-0000-4000-8000-000000000002.jpg';
const FRESH_KEY = 'scores/2147480003/cccccccc-0000-4000-8000-000000000003.jpg';
const bucket = new Map<string, { key: string; lastModified: Date; size: number }>();
const fakeDeletes: string[] = [];
function resetBucket() {
  bucket.clear();
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  bucket.set(REFERENCED_KEY, { key: REFERENCED_KEY, lastModified: old, size: 1000 });
  bucket.set(ORPHAN_KEY, { key: ORPHAN_KEY, lastModified: old, size: 2000 });
  bucket.set(FRESH_KEY, { key: FRESH_KEY, lastModified: new Date(), size: 3000 });
}
setPhotoStoreForTests({
  bucket: 'tilttrack-photos-dev',
  presignPut: async () => '', presignGet: async () => '', head: async () => null,
  delete: async (key: string) => { fakeDeletes.push(key); bucket.delete(key); },
  list: async (prefix: string) => ({ objects: [...bucket.values()].filter(o => o.key.startsWith(prefix)) }),
} as any);

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(as ? { 'x-test-clerk': as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 600)}`}`);
}

const created = { userIds: [] as number[], machineId: 0, scoreId: 0 };
const [{ maxId: startMaxId }] = await db.select({ maxId: sql<number>`coalesce(max(${activityEvents.id}), 0)`.mapWith(Number) }).from(activityEvents);
const savedSettings = await db.select().from(appSettings).where(inArray(appSettings.key, [RETENTION_SETTING_KEY, PHOTO_ORPHANS_SETTING_KEY]));

try {
  const [admin, user] = await db.insert(users).values([
    { clerkId: clerkIds.admin, username: `${TAG}-admin`.replace(/-/g, '_'), displayName: 'ZZ Retention Admin', role: 'admin' },
    { clerkId: clerkIds.user, username: `${TAG}-user`.replace(/-/g, '_'), displayName: 'ZZ Retention User' },
  ]).returning();
  created.userIds.push(admin.id, user.id);
  await db.delete(appSettings).where(inArray(appSettings.key, [RETENTION_SETTING_KEY, PHOTO_ORPHANS_SETTING_KEY]));

  // ── synthetic events, backdated (created_at is naive UTC) ───────────────────
  const ev = async (label: string, type: string, daysAgo: number) => {
    const [row] = await db.insert(activityEvents).values({
      type, actorUserId: user.id, payload: { zzRetentionTest: TAG, label },
      createdAt: sql`((now() AT TIME ZONE 'UTC') - make_interval(days => ${daysAgo}))` as any,
    }).returning({ id: activityEvents.id });
    return row.id;
  };
  const ids = {
    signedIn100: await ev('signedIn100', 'user.signed_in', 100),          // high-volume, past 90 → delete
    signedIn10: await ev('signedIn10', 'user.signed_in', 10),             // high-volume, recent → keep
    notif95: await ev('notif95', 'notification.sent', 95),                // high-volume → delete
    score400: await ev('score400', 'score.created', 400),                 // standard, past 365 → delete
    score100: await ev('score100', 'score.created', 100),                 // standard, within 365 → keep
    unknown400: await ev('unknown400', 'zz.unknown_type', 400),           // unknown = standard → delete
    disabled5000: await ev('disabled5000', 'admin.user_disabled', 5000),  // admin, forever → keep (run 1)
    future5000: await ev('future5000', 'admin.zz_future_action', 5000),   // admin prefix → keep (run 1)
    signedUp5000: await ev('signedUp5000', 'user.signed_up', 5000),       // admin tier → keep (run 1)
    signedUp100: await ev('signedUp100', 'user.signed_up', 100),          // admin tier → keep always
  };
  // Extra old high-volume rows so a tiny batch size has to loop.
  for (let i = 0; i < 7; i++) await ev(`bulk${i}`, 'user.signed_in', 200);
  const alive = async () => new Set((await db.select({ id: activityEvents.id }).from(activityEvents)
    .where(sql`${activityEvents.payload}->>'zzRetentionTest' = ${TAG}`)).map(r => r.id));

  // ── settings endpoints ─────────────────────────────────────────────────────
  check('guest → 401 on GET settings', (await call(null, 'GET', '/admin/settings/retention')).status === 401);
  check('user → 403 on GET settings', (await call(clerkIds.user, 'GET', '/admin/settings/retention')).status === 403);
  check('user → 403 on PUT settings', (await call(clerkIds.user, 'PUT', '/admin/settings/retention', { highVolumeDays: 30, standardDays: 365, adminDays: 0 })).status === 403);
  check('user → 403 on photo-orphans run', (await call(clerkIds.user, 'POST', '/admin/photo-orphans/run', { dryRun: false })).status === 403);

  const g = await call(clerkIds.admin, 'GET', '/admin/settings/retention');
  check('GET settings → defaults when nothing stored', g.status === 200 && g.body.isDefault === true
    && g.body.settings.highVolumeDays === 90 && g.body.settings.standardDays === 365 && g.body.settings.adminDays === 0, g.body);
  const tier = (t: string) => g.body.tiers.find((x: any) => x.tier === t);
  check('tier status: high-volume eligible ≥ 9 (2 synthetic + 7 bulk)', tier('high_volume')?.eligible >= 9, g.body.tiers);
  check('tier status: standard eligible ≥ 2', tier('standard')?.eligible >= 2, g.body.tiers);
  check('tier status: admin eligible 0 (keep forever), rows ≥ 4', tier('admin')?.eligible === 0 && tier('admin')?.rows >= 4 && tier('admin')?.days === null, g.body.tiers);
  check('tier status: oldest admin event is an ISO string ~5000 days back',
    typeof tier('admin')?.oldest === 'string' && tier('admin').oldest.endsWith('Z') && Date.now() - Date.parse(tier('admin').oldest) > 4999 * 86_400_000, tier('admin'));
  check('typesByTier lists user.signed_in as high-volume', g.body.typesByTier.high_volume.includes('user.signed_in'), g.body.typesByTier);
  const nonTestEligible = g.body.tiers.reduce((n: number, t: any) => n + t.eligible, 0) - 11;
  console.log(`info  non-test dev rows eligible for the purge: ${nonTestEligible}`);

  const bad = [
    { highVolumeDays: 6, standardDays: 365, adminDays: 0 },
    { highVolumeDays: 90, standardDays: 29, adminDays: 0 },
    { highVolumeDays: 90, standardDays: 365, adminDays: 100 },
    { highVolumeDays: '90', standardDays: 365, adminDays: 0 },
    { highVolumeDays: 90, standardDays: 365 },
  ];
  for (const b of bad) {
    const r = await call(clerkIds.admin, 'PUT', '/admin/settings/retention', b);
    check(`PUT ${JSON.stringify(b)} → 400 invalid_settings`, r.status === 400 && r.body.code === 'invalid_settings', r);
  }
  check('invalid PUTs stored nothing', (await db.select().from(appSettings).where(eq(appSettings.key, RETENTION_SETTING_KEY))).length === 0);

  const put = await call(clerkIds.admin, 'PUT', '/admin/settings/retention', { highVolumeDays: 90, standardDays: 365, adminDays: 0 });
  check('PUT valid → 200, stored, updatedBy = admin', put.status === 200 && put.body.isDefault === false && put.body.updatedBy?.id === admin.id, put.body);
  const [changed] = await db.select().from(activityEvents)
    .where(and(eq(activityEvents.type, 'admin.settings_changed'), eq(activityEvents.actorUserId, admin.id))).orderBy(desc(activityEvents.id)).limit(1);
  check('admin.settings_changed logged with before/after', !!changed && (changed.payload as any).before?.standardDays === 365
    && (changed.payload as any).after?.highVolumeDays === 90 && changed.targetId === RETENTION_SETTING_KEY, changed);

  // ── run 1: defaults (admin tier kept forever), tiny batches ─────────────────
  const r1 = await runActivityRetention({ batchSize: 2 });
  let a = await alive();
  check('run 1: high-volume past 90d deleted (signed_in 100d, notification 95d, 7 bulk)',
    !a.has(ids.signedIn100) && !a.has(ids.notif95) && r1.deleted.high_volume >= 9, { r1, alive: [...a] });
  check('run 1: high-volume within 90d kept', a.has(ids.signedIn10));
  check('run 1: standard past 365d deleted (score 400d, unknown type 400d)', !a.has(ids.score400) && !a.has(ids.unknown400) && r1.deleted.standard >= 2, r1);
  check('run 1: standard within 365d kept', a.has(ids.score100));
  check('run 1: admin tier kept forever (admin action, admin.* prefix, signed_up)',
    a.has(ids.disabled5000) && a.has(ids.future5000) && a.has(ids.signedUp5000) && a.has(ids.signedUp100) && r1.deleted.admin === 0, r1);
  check('run 1: no errors, not capped', r1.errors.length === 0 && r1.capped === false, r1);
  const [runEvent] = await db.select().from(activityEvents)
    .where(and(eq(activityEvents.type, 'system.activity_retention'), gt(activityEvents.id, startMaxId))).orderBy(desc(activityEvents.id)).limit(1);
  check('run 1: system.activity_retention logged with per-tier counts', !!runEvent && (runEvent.payload as any).deleted?.high_volume === r1.deleted.high_volume, runEvent);

  // ── the cap ─────────────────────────────────────────────────────────────────
  for (let i = 0; i < 5; i++) await ev(`cap${i}`, 'user.signed_in', 300);
  const rc = await runActivityRetention({ batchSize: 2, maxBatches: 1, log: false });
  check('capped run: deletes one batch per tier and reports capped', rc.deleted.high_volume === 2 && rc.capped === true, rc);
  await runActivityRetention({ log: false });

  // ── run 2: admin tier 365 days ──────────────────────────────────────────────
  const put2 = await call(clerkIds.admin, 'PUT', '/admin/settings/retention', { highVolumeDays: 90, standardDays: 365, adminDays: 365 });
  check('PUT adminDays 365 → 200', put2.status === 200 && put2.body.settings.adminDays === 365, put2.body);
  const g2 = await call(clerkIds.admin, 'GET', '/admin/settings/retention');
  check('estimate now counts the 5000-day admin rows', g2.body.tiers.find((x: any) => x.tier === 'admin')?.eligible >= 3, g2.body.tiers);
  const r2 = await runActivityRetention();
  a = await alive();
  check('run 2: admin tier past 365d deleted', !a.has(ids.disabled5000) && !a.has(ids.future5000) && !a.has(ids.signedUp5000) && r2.deleted.admin >= 3, r2);
  check('run 2: admin tier within 365d kept', a.has(ids.signedUp100));
  check('run 2: recent rows in other tiers still kept', a.has(ids.signedIn10) && a.has(ids.score100));
  const g3 = await call(clerkIds.admin, 'GET', '/admin/settings/retention');
  check('GET after a run shows lastRun', !!g3.body.lastRun?.at && typeof g3.body.lastRun.total === 'number', g3.body.lastRun);

  // ── photo orphans (fake store) ──────────────────────────────────────────────
  const [machine] = await db.insert(machines).values({ name: `${TAG} machine` }).returning();
  created.machineId = machine.id;
  const [score] = await db.insert(scores).values({ userId: user.id, machineId: machine.id, score: 1, playedAt: new Date(), photoKey: REFERENCED_KEY }).returning();
  created.scoreId = score.id;
  resetBucket();

  const st = await call(clerkIds.admin, 'GET', '/admin/photo-orphans');
  check('GET photo-orphans: configured, no mismatch, due, never ran', st.status === 200 && st.body.configured === true && st.body.envMismatch === null && st.body.dueNow === true && st.body.lastRun === null, st.body);

  const dry = await call(clerkIds.admin, 'POST', '/admin/photo-orphans/run', { dryRun: true });
  check('dry run: finds 1 orphan, deletes nothing', dry.status === 200 && dry.body.dryRun === true && dry.body.orphans === 1 && dry.body.deleted === 0 && fakeDeletes.length === 0, dry.body);
  check('dry run response carries no photo keys', !dry.raw.includes('.jpg') && Array.isArray(dry.body.sampleScoreIds) && dry.body.sampleScoreIds[0] === 2147480002, dry.raw);
  const noBody = await call(clerkIds.admin, 'POST', '/admin/photo-orphans/run');
  check('no body = dry run (safe default)', noBody.status === 200 && noBody.body.dryRun === true && fakeDeletes.length === 0, noBody.body);
  const stDry = await call(clerkIds.admin, 'GET', '/admin/photo-orphans');
  check('after dry runs: lastRun recorded, still due (dry runs do not count)', stDry.body.lastRun?.dryRun === true && stDry.body.dueNow === true && stDry.body.lastDeleteRunAt === null, stDry.body);

  const real = await call(clerkIds.admin, 'POST', '/admin/photo-orphans/run', { dryRun: false });
  check('real run: deletes the orphan only', real.status === 200 && real.body.deleted === 1 && fakeDeletes.length === 1 && fakeDeletes[0] === ORPHAN_KEY, { body: real.body, fakeDeletes });
  check('real run: referenced key and fresh upload survive', bucket.has(REFERENCED_KEY) && bucket.has(FRESH_KEY));
  const [runLog] = await db.select().from(activityEvents)
    .where(and(eq(activityEvents.type, 'admin.photo_orphans_run'), eq(activityEvents.actorUserId, admin.id))).orderBy(desc(activityEvents.id)).limit(1);
  check('admin.photo_orphans_run logged (no keys in it)', !!runLog && (runLog.payload as any).deleted === 1 && !JSON.stringify(runLog.payload).includes('.jpg'), runLog);
  const stReal = await call(clerkIds.admin, 'GET', '/admin/photo-orphans');
  check('after a real run: not due, next run ~7 days out', stReal.body.dueNow === false && !!stReal.body.nextDueAt
    && Math.abs(Date.parse(stReal.body.nextDueAt) - Date.now() - 7 * 86_400_000) < 3_600_000, stReal.body);
  const sched = await runScheduledOrphanSweep();
  check('scheduled sweep the same day → skipped not_due', !sched.ran && sched.reason === 'not_due', sched);

  const ov = await call(clerkIds.admin, 'GET', '/admin/overview');
  check('overview health shows the retention + orphan last runs',
    ov.status === 200 && !!ov.body.health.cron.activityRetention?.at && ov.body.health.cron.photoOrphans?.lastRun?.deleted === 1, ov.body?.health?.cron);

  setPhotoStoreForTests(null);
  const off = await call(clerkIds.admin, 'POST', '/admin/photo-orphans/run', { dryRun: true });
  check('R2 not configured → 503 r2_not_configured', off.status === 503 && off.body.code === 'r2_not_configured', off);
  const offSched = await runScheduledOrphanSweep();
  check('scheduled sweep with R2 off → skipped gracefully', !offSched.ran && offSched.reason === 'r2_not_configured', offSched);
} catch (err) {
  failures++;
  console.error('FAIL  unexpected error:', err);
} finally {
  const ids = created.userIds;
  await db.delete(activityEvents).where(or(
    sql`${activityEvents.payload}->>'zzRetentionTest' = ${TAG}`,
    ids.length ? inArray(activityEvents.actorUserId, ids) : undefined,
    ids.length ? inArray(activityEvents.subjectUserId, ids) : undefined,
    and(inArray(activityEvents.type, ['system.activity_retention', 'system.photo_orphans']), gt(activityEvents.id, startMaxId)),
  ));
  if (created.scoreId) await db.delete(scores).where(eq(scores.id, created.scoreId));
  if (created.machineId) await db.delete(machines).where(eq(machines.id, created.machineId));
  if (ids.length) await db.delete(users).where(inArray(users.id, ids));
  await db.delete(appSettings).where(inArray(appSettings.key, [RETENTION_SETTING_KEY, PHOTO_ORPHANS_SETTING_KEY]));
  if (savedSettings.length) await db.insert(appSettings).values(savedSettings);
  const leftovers = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(users).where(sql`${users.clerkId} LIKE ${`${TAG}%`}`);
  console.log(`cleanup: ${leftovers[0].n === 0 ? 'done' : `LEFT ${leftovers[0].n} users behind`}; app_settings restored (${savedSettings.length} row(s))`);
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
