// End-to-end check of played-time provenance (src/lib/playedAtProvenance.ts) through the real
// /api/scores router against the Neon DEV branch: POST with a valid /api/upload token → 'photo',
// a moved time → 400 played_at_mismatch, someone else's / a forged token → 400, a video claim →
// 'video', no token → 'manual'; PATCH of a photo score's played time by its owner → 403
// played_at_locked (other fields still editable, re-sending the same minute is fine), by an admin →
// 400 without a reason, 200 with one (row stamped, source kept, `admin.played_at_corrected` logged),
// and still locked to the owner afterwards; manual and legacy (null) scores stay editable. A played
// time in the future (lib/playedAtClock.ts) → 400 played_at_in_future on POST, PATCH and admin
// correction alike; 10 minutes ahead (phone clock skew) is fine.
//
// Creates `zz-provenance-test-*` users, one machine and one venue (America/Chicago), and deletes
// everything it made at the end — scores, badge awards / marks / notifications its scores raised,
// and every activity event about those users. Tokens are signed with the same key the server uses
// (CLERK_SECRET_KEY-derived, or PLAYED_AT_TOKEN_SECRET), exactly as /api/upload would — the upload
// route itself isn't called (it would cost an Anthropic read per run).
//
//   cd artifacts/api-server && npx tsx test-score-provenance.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { default: express } = await import('express');
const { setAuthForTests } = await import('./src/middleware/requireAuth.js');
const { default: scoresRouter } = await import('./src/routes/scores.js');
const { signPlayedAtToken } = await import('./src/lib/playedAtProvenance.js');
const {
  db, users, machines, venues, scores, notifications, activityEvents, userBadges, userMetricMarks,
} = await import('@workspace/db');
const { and, eq, inArray, or, sql, desc } = await import('drizzle-orm');

const TAG = `zz-provenance-test-${Date.now().toString(36)}`;
const clerkIds = { admin: `${TAG}-admin`, alice: `${TAG}-alice`, bob: `${TAG}-bob` };
setAuthForTests({ resolveClerkId: req => (req.headers['x-test-clerk'] as string | undefined) ?? null });

const created = { userIds: [] as number[], machineId: 0, venueId: 0 };

const app = express();
app.use(express.json());
// GET /api/scores reads the caller through Clerk's getAuth (req.auth), not requireAppUser.
app.use((req: any, _res: any, next: any) => {
  const clerkId = (req.headers['x-test-clerk'] as string | undefined) ?? null;
  req.auth = () => ({ userId: clerkId, tokenType: 'session_token', sessionClaims: {} });
  next();
});
app.use('/api/scores', scoresRouter);
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
  return { status: res.status, body: parsed };
}

let failures = 0, passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 600)}`}`);
}
async function row(id: number) {
  const [r] = await db.select({
    source: scores.playedAtSource, correctedBy: scores.playedAtCorrectedById, correctedAt: scores.playedAtCorrectedAt,
    playedAt: sql<string>`${scores.playedAt}::text`, score: scores.score,
  }).from(scores).where(eq(scores.id, id));
  return r;
}

const THUMB = 'data:image/jpeg;base64,/9j/zz-provenance-test';
// The camera clock /api/upload would return, and the instant the browser sends for it at a Chicago
// venue (CDT, −5): 11:30pm May 2 → 04:30Z May 3.
const NAIVE = '2026-05-02T23:30:17';
const AS_SENT = '2026-05-03T04:30:00.000Z';
const TODAY = new Date().toISOString();

try {
  const [admin, alice, bob] = await db.insert(users).values([
    { clerkId: clerkIds.admin, username: `${TAG}-admin`.replace(/-/g, '_'), displayName: 'ZZ Provenance Admin', role: 'admin' },
    { clerkId: clerkIds.alice, username: `${TAG}-alice`.replace(/-/g, '_'), displayName: 'ZZ Provenance Alice' },
    { clerkId: clerkIds.bob, username: `${TAG}-bob`.replace(/-/g, '_'), displayName: 'ZZ Provenance Bob' },
  ]).returning();
  created.userIds.push(admin.id, alice.id, bob.id);
  const [machine] = await db.insert(machines).values({ name: `${TAG} machine` }).returning();
  created.machineId = machine.id;
  const [venue] = await db.insert(venues).values({ name: `${TAG} venue`, timezone: 'America/Chicago' }).returning();
  created.venueId = venue.id;
  const base = { machineId: machine.id, score: 1_000_000, venueId: venue.id, photoThumbnail: THUMB };
  const token = signPlayedAtToken(clerkIds.alice, NAIVE, 'photo');
  if (!token) throw new Error('No played-time signing key (CLERK_SECRET_KEY / PLAYED_AT_TOKEN_SECRET) in .env');

  // ── POST ────────────────────────────────────────────────────────────────────
  let r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: AS_SENT, playedAtToken: token, playedAtSource: 'photo' });
  check('POST with a valid token → 201', r.status === 201, r);
  const photoId = r.body?.id as number;
  check('… stored as photo', (await row(photoId))?.source === 'photo', await row(photoId));
  check('… the response says photo', r.body?.playedAtSource === 'photo', r.body?.playedAtSource);
  check('… no admin marker', (await row(photoId))?.correctedBy == null);

  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: TODAY, playedAtToken: token });
  check('POST with the token but a moved time → 400 played_at_mismatch', r.status === 400 && r.body?.code === 'played_at_mismatch', r);
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: '2026-05-03T05:30:00.000Z', playedAtToken: token });
  check('POST an hour off (the wrong zone) → 400 played_at_mismatch', r.status === 400 && r.body?.code === 'played_at_mismatch', r);
  r = await call(clerkIds.bob, 'POST', '/scores', { ...base, playedAt: AS_SENT, playedAtToken: token });
  check('POST with someone else\'s token → 400 played_at_token_invalid', r.status === 400 && r.body?.code === 'played_at_token_invalid', r);
  const [head, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(head, 'base64url').toString()), t: TODAY.slice(0, 19) })).toString('base64url');
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: TODAY, playedAtToken: `${forged}.${mac}` });
  check('POST with a re-written token → 400 played_at_token_invalid', r.status === 400 && r.body?.code === 'played_at_token_invalid', r);
  const [{ n: stray }] = await db.select({ n: sql<number>`count(*)::int` }).from(scores).where(eq(scores.machineId, machine.id));
  check('… none of the refused POSTs wrote a score', stray === 1, stray);

  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: TODAY, playedAtSource: 'photo' });
  check('POST claiming photo without a token → manual', r.status === 201 && (await row(r.body.id))?.source === 'manual', r);
  const manualId = r.body?.id as number;
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: TODAY, playedAtSource: 'video' });
  check('POST with a video claim (mvhd) → video', r.status === 201 && (await row(r.body.id))?.source === 'video', r);
  const videoId = r.body?.id as number;
  const vtoken = signPlayedAtToken(clerkIds.alice, NAIVE, 'video');
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: AS_SENT, playedAtToken: vtoken });
  check('POST with a video (creationdate) token → video', r.status === 201 && (await row(r.body.id))?.source === 'video', r);
  // No venue: the browser used its own zone, so any real offset passes, a months-off time doesn't.
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, venueId: undefined, playedAt: '2026-05-03T03:30:00.000Z', playedAtToken: token });
  check('POST with no venue, the camera clock at −4 → photo', r.status === 201 && (await row(r.body.id))?.source === 'photo', r);
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, venueId: undefined, playedAt: TODAY, playedAtToken: token });
  check('POST with no venue, moved to today → 400 played_at_mismatch', r.status === 400 && r.body?.code === 'played_at_mismatch', r);

  // ── PATCH ───────────────────────────────────────────────────────────────────
  const before = await row(photoId);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${photoId}`, { playedAt: TODAY });
  check('owner moves a photo score\'s time → 403 played_at_locked', r.status === 403 && r.body?.code === 'played_at_locked', r);
  check('… unchanged', (await row(photoId))?.playedAt === before.playedAt, await row(photoId));
  r = await call(clerkIds.alice, 'PATCH', `/scores/${photoId}`, { playedAt: TODAY, playedAtReason: 'please' });
  check('… a reason doesn\'t help a non-admin → 403', r.status === 403, r);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${photoId}`, { score: 1_000_001, playedAt: AS_SENT, type: 'casual' });
  check('owner edits the score and re-sends the same minute → 200', r.status === 200, r);
  const after = await row(photoId);
  check('… score changed, played time (seconds and all) untouched', after.score === 1_000_001 && after.playedAt === before.playedAt, { before, after });
  r = await call(clerkIds.alice, 'PATCH', `/scores/${videoId}`, { playedAt: '2026-01-01T12:00:00.000Z' });
  check('owner moves a video score\'s time → 403 played_at_locked', r.status === 403 && r.body?.code === 'played_at_locked', r);

  r = await call(clerkIds.admin, 'PATCH', `/scores/${photoId}`, { playedAt: TODAY });
  check('admin moves it without a reason → 400 reason_required', r.status === 400 && r.body?.code === 'reason_required', r);
  r = await call(clerkIds.admin, 'PATCH', `/scores/${photoId}`, { playedAt: '2026-05-03T05:30:00.000Z', playedAtReason: '  camera clock an hour slow  ' });
  check('admin moves it with a reason → 200', r.status === 200, r);
  const corrected = await row(photoId);
  check('… time moved', corrected.playedAt !== before.playedAt, corrected);
  check('… source kept (photo), admin + time stamped', corrected.source === 'photo' && corrected.correctedBy === admin.id && corrected.correctedAt != null, corrected);
  const [ev] = await db.select().from(activityEvents)
    .where(and(eq(activityEvents.type, 'admin.played_at_corrected'), eq(activityEvents.targetId, String(photoId)))).orderBy(desc(activityEvents.id)).limit(1);
  check('… admin.played_at_corrected logged (actor admin, subject alice, reason, before/after)',
    ev?.actorUserId === admin.id && ev?.subjectUserId === alice.id && (ev?.payload as any)?.reason === 'camera clock an hour slow'
      && !!(ev?.payload as any)?.from && !!(ev?.payload as any)?.to && (ev?.payload as any)?.source === 'photo', ev);
  const [edited] = await db.select().from(activityEvents)
    .where(and(eq(activityEvents.type, 'score.edited'), eq(activityEvents.targetId, String(photoId)))).orderBy(desc(activityEvents.id)).limit(1);
  check('… and the usual score.edited (byAdmin)', (edited?.payload as any)?.byAdmin === true && !!(edited?.payload as any)?.changes?.playedAt, edited);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${photoId}`, { playedAt: TODAY });
  check('still locked to the owner after the correction → 403', r.status === 403, r);
  r = await call(clerkIds.bob, 'PATCH', `/scores/${photoId}`, { score: 5 });
  check('someone else can\'t edit it at all → 403 Forbidden', r.status === 403 && r.body?.code === undefined, r);

  r = await call(clerkIds.alice, 'PATCH', `/scores/${manualId}`, { playedAt: '2026-06-01T12:00:00.000Z' });
  check('owner moves a manual score\'s time → 200', r.status === 200, r);
  check('… moved, no admin marker', (await row(manualId)).playedAt.startsWith('2026-06-01') && (await row(manualId)).correctedBy == null, await row(manualId));
  const [legacy] = await db.insert(scores).values({ userId: alice.id, machineId: machine.id, score: 42, playedAt: new Date('2026-05-02T23:30:00Z'), venueId: venue.id }).returning();
  check('a legacy score has a null source', (await row(legacy.id)).source == null);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${legacy.id}`, { playedAt: TODAY });
  check('owner moves a legacy (null) score\'s time → 200', r.status === 200, r);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${manualId}`, { playedAt: 'not a date' });
  check('PATCH with a junk playedAt → 400 invalid_played_at', r.status === 400 && r.body?.code === 'invalid_played_at', r);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${manualId}`, { playedAt: '2026-06-01T12:00:30.000Z' });
  check('PATCH with only the same minute (nothing to write) → 200', r.status === 200, r);
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: 'nope' });
  check('POST with a junk playedAt → 400 invalid_played_at', r.status === 400 && r.body?.code === 'invalid_played_at', r);

  // ── never in the future (lib/playedAtClock.ts, 15 min of skew) ─────────────
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const countOnMachine = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(scores).where(eq(scores.machineId, machine.id)))[0].n;
  const n0 = await countOnMachine();
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: inMin(60) });
  check('POST an hour in the future → 400 played_at_in_future', r.status === 400 && r.body?.code === 'played_at_in_future', r);
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: inMin(16) });
  check('POST 16 minutes ahead → 400 played_at_in_future', r.status === 400 && r.body?.code === 'played_at_in_future', r);
  check('… neither wrote a score', (await countOnMachine()) === n0);
  r = await call(clerkIds.alice, 'POST', '/scores', { ...base, playedAt: inMin(10) });
  check('POST 10 minutes ahead (a fast phone clock) → 201', r.status === 201, r);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${manualId}`, { playedAt: inMin(600) });
  check('owner PATCHes a manual score 10 h into the future → 400 played_at_in_future', r.status === 400 && r.body?.code === 'played_at_in_future', r);
  check('… unchanged', (await row(manualId)).playedAt.startsWith('2026-06-01'), await row(manualId));
  const beforeFuture = await row(photoId);
  r = await call(clerkIds.admin, 'PATCH', `/scores/${photoId}`, { playedAt: inMin(600), playedAtReason: 'testing the future' });
  check('admin correction into the future → 400 played_at_in_future', r.status === 400 && r.body?.code === 'played_at_in_future', r);
  check('… unchanged', (await row(photoId)).playedAt === beforeFuture.playedAt, await row(photoId));
  r = await call(clerkIds.admin, 'PATCH', `/scores/${manualId}`, { playedAt: inMin(600) });
  check('admin PATCH of a manual score into the future → 400', r.status === 400 && r.body?.code === 'played_at_in_future', r);
  // Logged two days ago: a time yesterday is in the past but after it was logged — impossible too.
  const [old] = await db.insert(scores).values({ userId: alice.id, machineId: machine.id, score: 43, playedAt: new Date(Date.now() - 3 * 86_400_000), createdAt: new Date(Date.now() - 2 * 86_400_000), venueId: venue.id }).returning();
  r = await call(clerkIds.alice, 'PATCH', `/scores/${old.id}`, { playedAt: new Date(Date.now() - 86_400_000).toISOString() });
  check('PATCH to after the score was logged (yesterday, logged 2 days ago) → 400 played_at_in_future', r.status === 400 && r.body?.code === 'played_at_in_future', r);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${old.id}`, { playedAt: new Date(Date.now() - 2.5 * 86_400_000).toISOString() });
  check('… to before it was logged → 200', r.status === 200, r);
  // A legacy row already dated in the future (like dev #1276): its other fields stay editable, and
  // re-sending its (future) time unchanged is not a change.
  const futureAt = new Date(Math.floor((Date.now() + 10 * 3_600_000) / 60_000) * 60_000);
  const [ahead] = await db.insert(scores).values({ userId: alice.id, machineId: machine.id, score: 44, playedAt: futureAt, venueId: venue.id }).returning();
  r = await call(clerkIds.alice, 'PATCH', `/scores/${ahead.id}`, { score: 45, playedAt: futureAt.toISOString() });
  check('legacy future-dated row: edit the score, re-send its time unchanged → 200', r.status === 200 && (await row(ahead.id)).score === 45, r);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${ahead.id}`, { playedAt: new Date(+futureAt + 60_000).toISOString() });
  check('… moving it to another future time → 400', r.status === 400 && r.body?.code === 'played_at_in_future', r);

  // The GET list carries the source (the edit dialog reads it).
  r = await call(clerkIds.alice, 'GET', '/scores?mine=true');
  const listed = Array.isArray(r.body) ? r.body.find((s: any) => s.id === photoId) : null;
  check('GET /api/scores carries playedAtSource', listed?.playedAtSource === 'photo', listed);
} catch (err) {
  failures++;
  console.error('ERROR', err);
} finally {
  const ids = created.userIds;
  if (ids.length) {
    await db.delete(activityEvents).where(or(inArray(activityEvents.actorUserId, ids), inArray(activityEvents.subjectUserId, ids)));
    await db.delete(notifications).where(inArray(notifications.userId, ids));
    await db.delete(userBadges).where(inArray(userBadges.userId, ids));
    await db.delete(userMetricMarks).where(inArray(userMetricMarks.userId, ids));
    await db.delete(scores).where(inArray(scores.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }
  if (created.venueId) await db.delete(venues).where(eq(venues.id, created.venueId));
  if (created.machineId) await db.delete(machines).where(eq(machines.id, created.machineId));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(sql`${users.clerkId} LIKE ${`${TAG}%`}`);
  console.log(`cleanup: ${n === 0 ? 'done' : `LEFT ${n} users behind`}`);
  server.close();
  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nALL ${passes} PASSED`);
  process.exit(failures ? 1 : 0);
}
