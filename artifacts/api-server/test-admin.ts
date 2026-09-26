// End-to-end check of the admin area and activity logging against the Neon DEV branch.
//
// Mounts the REAL routers (admin, friends, scores, notifications, challenges, the Clerk webhook) on a
// throwaway express app. requireAppUser is the real middleware reading the real users table; only
// "which Clerk user is this" comes from an `x-test-clerk` header (setAuthForTests), so no Clerk
// session tokens are needed. Clerk ban/unban is faked (the throwaway users don't exist in Clerk) and
// so is the R2 store (records deletes, touches no bucket).
//
// Creates three throwaway users (clerk ids `zz-admin-test-…`, one of them an admin), a throwaway
// machine, scores, a friendship, a challenge and notifications — and at the end deletes exactly those
// rows and every activity event that mentions them.
//
//   cd artifacts/api-server && npx tsx test-admin.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as migrate19.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

// A throwaway Svix secret for the webhook part (never a real one).
const WEBHOOK_SECRET = `whsec_${Buffer.from('tilttrack-test-admin-secret-0123').toString('base64')}`;
process.env.CLERK_WEBHOOK_SIGNING_SECRET = WEBHOOK_SECRET;

const { default: express } = await import('express');
const { Webhook } = await import('svix');
const { setAuthForTests } = await import('./src/middleware/requireAuth.js');
const { setClerkAdminForTests } = await import('./src/lib/clerkAdmin.js');
const { setPhotoStoreForTests } = await import('./src/lib/photoStore.js');
const { default: adminRouter } = await import('./src/routes/admin.js');
const { default: friendsRouter } = await import('./src/routes/friends.js');
const { default: scoresRouter } = await import('./src/routes/scores.js');
const { default: notificationsRouter } = await import('./src/routes/notifications.js');
const { default: challengesRouter } = await import('./src/routes/challenges.js');
const { clerkWebhookHandler } = await import('./src/routes/clerkWebhook.js');
const { requireAppUser } = await import('./src/middleware/requireAuth.js');
const {
  db, users, machines, scores, friendships, notifications, challenges, challengeParticipants, challengeScores, activityEvents,
  pods, podMembers,
} = await import('@workspace/db');
const { and, eq, inArray, or, sql, desc } = await import('drizzle-orm');

const TAG = `zz-admin-test-${Date.now().toString(36)}`;
const clerkIds = { admin: `${TAG}-admin`, alice: `${TAG}-alice`, bob: `${TAG}-bob` };

setAuthForTests({ resolveClerkId: req => (req.headers['x-test-clerk'] as string | undefined) ?? null });
const bans: Array<{ id: string; banned: boolean }> = [];
setClerkAdminForTests({
  listUsers: async ids => ids.map(id => ({ id, lastSignInAt: Date.now() - 3_600_000, lastActiveAt: Date.now() - 60_000, banned: bans.filter(b => b.id === id).at(-1)?.banned ?? false })),
  ban: async id => { bans.push({ id, banned: true }); },
  unban: async id => { bans.push({ id, banned: false }); },
});
const deletedObjects: string[] = [];
setPhotoStoreForTests({
  presignPut: async () => 'https://example.invalid/put', presignGet: async () => 'https://example.invalid/get',
  head: async () => null, delete: async (key: string) => { deletedObjects.push(key); }, list: async () => [],
} as any);

const created = { userIds: [] as number[], machineId: 0, scoreIds: [] as number[], challengeIds: [] as number[] };

const app = express();
app.post('/api/webhooks/clerk', express.raw({ type: '*/*' }), clerkWebhookHandler);
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/friends', requireAppUser, friendsRouter);
app.use('/api/notifications', requireAppUser, notificationsRouter);
app.use('/api/challenges', requireAppUser, challengesRouter);
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

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 600)}`}`);
}
async function eventsOf(type: string, where?: any) {
  return db.select().from(activityEvents).where(and(eq(activityEvents.type, type), where)).orderBy(desc(activityEvents.id));
}

try {
  // ── fixtures ────────────────────────────────────────────────────────────────
  const [admin, alice, bob] = await db.insert(users).values([
    { clerkId: clerkIds.admin, username: `${TAG}-admin`.replace(/-/g, '_'), displayName: 'ZZ Admin Test', role: 'admin' },
    { clerkId: clerkIds.alice, username: `${TAG}-alice`.replace(/-/g, '_'), displayName: 'ZZ Alice Test' },
    { clerkId: clerkIds.bob, username: `${TAG}-bob`.replace(/-/g, '_'), displayName: 'ZZ Bob Test' },
  ]).returning();
  created.userIds.push(admin.id, alice.id, bob.id);
  const [machine] = await db.insert(machines).values({ name: `${TAG} machine` }).returning();
  created.machineId = machine.id;

  // ── guards ─────────────────────────────────────────────────────────────────
  check('guest → 401 on admin overview', (await call(null, 'GET', '/admin/overview')).status === 401);
  check('regular user → 403 on admin overview', (await call(clerkIds.alice, 'GET', '/admin/overview')).status === 403);
  check('regular user → 403 on admin delete', (await call(clerkIds.alice, 'DELETE', '/admin/scores/1')).status === 403);

  // ── friend + notification events ───────────────────────────────────────────
  let r = await call(clerkIds.alice, 'POST', '/friends/requests', { userId: bob.id });
  check('friend request sent', r.status === 201, r);
  check('friend.request_sent logged (actor alice, subject bob)', (await eventsOf('friend.request_sent', eq(activityEvents.actorUserId, alice.id)))[0]?.subjectUserId === bob.id);
  const sent = await eventsOf('notification.sent', eq(activityEvents.subjectUserId, bob.id));
  check('notification.sent logged for bob (kind friend_request)', sent[0]?.payload?.kind === 'friend_request', sent[0]);
  r = await call(clerkIds.bob, 'POST', `/friends/requests/${alice.id}/accept`);
  check('friend request accepted', r.status === 200, r);
  check('friend.request_accepted logged', (await eventsOf('friend.request_accepted', eq(activityEvents.actorUserId, bob.id))).length === 1);

  // ── score events ───────────────────────────────────────────────────────────
  const thumb = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==';
  r = await call(clerkIds.alice, 'POST', '/scores', { machineId: machine.id, score: 1234567, playedAt: new Date().toISOString(), photoThumbnail: thumb });
  check('score created', r.status === 201, r);
  const scoreA = r.body.id as number;
  created.scoreIds.push(scoreA);
  check('score.created logged', (await eventsOf('score.created', eq(activityEvents.targetId, String(scoreA))))[0]?.actorUserId === alice.id);
  r = await call(clerkIds.alice, 'PATCH', `/scores/${scoreA}`, { score: 1234568 });
  const edited = (await eventsOf('score.edited', eq(activityEvents.targetId, String(scoreA))))[0];
  check('score.edited logged with the change', r.status === 200 && (edited?.payload as any)?.changes?.score?.to === 1234568, edited);
  r = await call(clerkIds.alice, 'POST', '/scores', { machineId: machine.id, score: 999, playedAt: new Date().toISOString() });
  const scoreB = r.body.id as number;
  created.scoreIds.push(scoreB);

  // ── webhook: signed sign-in, idempotent retry, bad signature ───────────────
  const body = JSON.stringify({ type: 'session.created', data: { id: 'sess_zz', user_id: clerkIds.alice, created_at: Date.now(), latest_activity: { browser_name: 'Edge', is_mobile: false, ip_address: '203.0.113.9' } } });
  const svixId = `msg_${TAG}`;
  const signedAt = new Date();
  const sig = new Webhook(WEBHOOK_SECRET).sign(svixId, signedAt, body);
  const hook = (b: string, s: string) => fetch(`http://localhost:${port}/api/webhooks/clerk`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': svixId, 'svix-timestamp': String(Math.floor(+signedAt / 1000)), 'svix-signature': s }, body: b,
  });
  let hr = await hook(body, sig);
  check('webhook session.created → 200', hr.status === 200, await hr.text());
  hr = await hook(body, sig);
  const dup = await hr.json() as any;
  check('webhook retry → 200 duplicate', hr.status === 200 && dup.duplicate === true, dup);
  const signIns = await db.select().from(activityEvents).where(eq(activityEvents.svixId, svixId));
  check('exactly one user.signed_in row, actor alice, ip recorded', signIns.length === 1 && signIns[0].actorUserId === alice.id && signIns[0].ip === '203.0.113.9', signIns);
  hr = await hook(body.replace('sess_zz', 'sess_evil'), sig);
  check('webhook tampered body → 400', hr.status === 400);

  // ── admin reads ────────────────────────────────────────────────────────────
  r = await call(clerkIds.admin, 'GET', '/admin/overview');
  check('overview answers with counts + health', r.status === 200 && typeof r.body.counts.users === 'number' && 'r2' in r.body.health, r);
  r = await call(clerkIds.admin, 'GET', `/admin/users?q=${encodeURIComponent(TAG.replace(/-/g, '_'))}`);
  const aliceRow = r.body.items?.find((u: any) => u.id === alice.id);
  check('users list finds the throwaway users with counts + Clerk activity',r.status === 200 && r.body.items.length === 3 && aliceRow?.scoreCount === 2 && aliceRow?.friendCount === 1 && !!aliceRow?.clerk?.lastSignInAt, r.body);
  check('users list never returns clerk ids or PM tokens', !JSON.stringify(r.body).includes(clerkIds.alice) && !JSON.stringify(r.body).includes('pinballMapToken'));
  const [pod] = await db.insert(pods).values({ ownerId: alice.id, name: `${TAG} pod`, color: '#fe7b32' }).returning();
  await db.insert(podMembers).values({ podId: pod.id, userId: bob.id });
  r = await call(clerkIds.admin, 'GET', `/admin/users/${alice.id}`);
  check('user detail: friendships, pods, scores, activity', r.status === 200 && r.body.friendships.length === 1 && r.body.recentScores.length === 2
    && r.body.activity.items.length > 0 && r.body.pods.owned[0]?.memberCount === 1, r.body);
  r = await call(clerkIds.admin, 'GET', `/admin/users/${bob.id}`);
  check('user detail: pods they are in', r.body.pods?.memberOf?.[0]?.owner?.id === alice.id, r.body.pods);
  r = await call(clerkIds.admin, 'GET', `/admin/activity?userId=${alice.id}&limit=2`);
  check('activity is keyset-paged', r.status === 200 && r.body.items.length === 2 && typeof r.body.nextBefore === 'number', r.body);
  const next = await call(clerkIds.admin, 'GET', `/admin/activity?userId=${alice.id}&limit=2&before=${r.body.nextBefore}`);
  check('next page continues below the cursor', next.body.items.every((e: any) => e.id < r.body.nextBefore));
  r = await call(clerkIds.admin, 'GET', `/admin/activity?category=friend&userId=${bob.id}`);
  check('category filter', r.status === 200 && r.body.items.length >= 2 && r.body.items.every((e: any) => e.category === 'friend'), r.body);
  r = await call(clerkIds.admin, 'GET', `/admin/scores?userId=${alice.id}`);
  check('scores list with thumbnails', r.status === 200 && r.body.items.length === 2 && r.body.items.some((s: any) => s.photoThumbnail === thumb), r.body);
  check('scores list never returns photo keys', !JSON.stringify(r.body).includes('photoKey'));
  r = await call(clerkIds.admin, 'GET', `/admin/notifications?userId=${bob.id}`);
  check('notifications list', r.status === 200 && r.body.items.length >= 1 && typeof r.body.summary.total === 'number', r.body);
  r = await call(clerkIds.admin, 'GET', '/admin/friendships?status=accepted');
  check('friendships list', r.status === 200 && r.body.items.some((f: any) => f.requester.id === alice.id && f.addressee.id === bob.id), r.body.summary);

  // ── disable / enable ───────────────────────────────────────────────────────
  r = await call(clerkIds.admin, 'POST', `/admin/users/${admin.id}/disable`, { reason: 'x' });
  check('admin can’t disable self → 400', r.status === 400 && r.body.code === 'cannot_disable_self', r);
  const [otherAdmin] = await db.insert(users).values({ clerkId: `${TAG}-admin2`, username: `${TAG}_admin2`.replace(/-/g, '_'), displayName: 'ZZ Admin2', role: 'admin' }).returning();
  created.userIds.push(otherAdmin.id);
  r = await call(clerkIds.admin, 'POST', `/admin/users/${otherAdmin.id}/disable`, {});
  check('admin can’t disable another admin → 403', r.status === 403 && r.body.code === 'cannot_disable_admin', r);
  r = await call(clerkIds.admin, 'POST', `/admin/users/${bob.id}/disable`, { reason: 'spam test' });
  check('disable bob → 200, banned in Clerk', r.status === 200 && r.body.clerkBanned === true && bans.at(-1)?.id === clerkIds.bob && bans.at(-1)?.banned, r);
  r = await call(clerkIds.bob, 'GET', '/friends');
  check('disabled bob → 403 account_disabled on app routes', r.status === 403 && r.body.code === 'account_disabled', r);
  r = await call(clerkIds.bob, 'POST', '/scores', { machineId: machine.id, score: 5, playedAt: new Date().toISOString() });
  check('disabled bob can’t post a score', r.status === 403);
  check('admin.user_disabled logged with admin as actor', (await eventsOf('admin.user_disabled', eq(activityEvents.subjectUserId, bob.id)))[0]?.actorUserId === admin.id);
  r = await call(clerkIds.admin, 'POST', `/admin/users/${bob.id}/enable`);
  check('enable bob → 200, unbanned', r.status === 200 && bans.at(-1)?.banned === false, r);
  check('bob works again', (await call(clerkIds.bob, 'GET', '/friends')).status === 200);

  // ── challenge lock, void, delete ───────────────────────────────────────────
  const now = new Date();
  const [ch] = await db.insert(challenges).values({
    creatorId: alice.id, type: 'high_score', machineId: machine.id, matchMode: 'exact', status: 'resolved',
    startsAt: new Date(+now - 3_600_000), endsAt: new Date(+now - 60_000), resolvedAt: now,
  }).returning();
  created.challengeIds.push(ch.id);
  await db.insert(challengeParticipants).values([
    { challengeId: ch.id, userId: alice.id, response: 'accepted', outcome: 'win', rank: 1, resultValue: '1234568' },
    { challengeId: ch.id, userId: bob.id, response: 'accepted', outcome: 'no_show', rank: 2 },
  ]);
  await db.insert(challengeScores).values({ challengeId: ch.id, scoreId: scoreA });
  const recBefore = await call(clerkIds.alice, 'GET', '/challenges/record');
  check('alice’s record counts the resolved challenge', recBefore.status === 200 && recBefore.body.wins === 1, recBefore.body);

  r = await call(clerkIds.admin, 'DELETE', `/admin/scores/${scoreA}`);
  check('admin delete of a challenge-locked score → 409 naming the challenge', r.status === 409 && r.body.code === 'score_locked_by_challenge' && r.body.challengeIds?.includes(ch.id), r);
  r = await call(clerkIds.admin, 'DELETE', `/admin/scores/${scoreA}/thumbnail`);
  check('thumbnail delete on a locked score → 409', r.status === 409, r);
  await db.update(scores).set({ photoKey: `scores/${scoreA}/zz-test.jpg`, photoBytes: 10 }).where(eq(scores.id, scoreA));
  r = await call(clerkIds.admin, 'DELETE', `/admin/scores/${scoreA}/photo`);
  const [afterPhoto] = await db.select({ photoKey: scores.photoKey }).from(scores).where(eq(scores.id, scoreA));
  check('full-photo delete allowed on a locked score: columns cleared, object deleted', r.status === 200 && afterPhoto.photoKey === null && deletedObjects.includes(`scores/${scoreA}/zz-test.jpg`), r);

  r = await call(clerkIds.admin, 'POST', `/admin/challenges/${ch.id}/void`, { reason: 'test void' });
  check('void challenge → cancelled, lock released', r.status === 200 && r.body.status === 'cancelled' && r.body.releasedScoreIds?.includes(scoreA), r);
  const [chAfter] = await db.select().from(challenges).where(eq(challenges.id, ch.id));
  check('challenge row stamped admin_cancelled_*', chAfter.status === 'cancelled' && chAfter.adminCancelledById === admin.id && chAfter.adminCancelReason === 'test void', chAfter);
  const partsAfter = await db.select().from(challengeParticipants).where(eq(challengeParticipants.challengeId, ch.id));
  check('outcomes cleared', partsAfter.every(p => p.outcome === null && p.rank === null));
  const recAfter = await call(clerkIds.alice, 'GET', '/challenges/record');
  check('voided challenge drops out of the record', recAfter.status === 200 && recAfter.body.wins === 0, recAfter.body);
  const voidedNotes = await db.select().from(notifications).where(and(eq(notifications.kind, 'challenge_voided'), inArray(notifications.userId, [alice.id, bob.id])));
  check('both participants got challenge_voided', voidedNotes.length === 2);
  const voidEv = (await eventsOf('admin.challenge_voided', eq(activityEvents.targetId, String(ch.id))))[0];
  check('admin.challenge_voided keeps the previous outcomes', voidEv?.actorUserId === admin.id && (voidEv.payload as any).previousStatus === 'resolved' && (voidEv.payload as any).participants?.some((p: any) => p.outcome === 'win'), voidEv);
  r = await call(clerkIds.admin, 'POST', `/admin/challenges/${ch.id}/void`, {});
  check('voiding twice → 409 challenge_closed', r.status === 409, r);

  r = await call(clerkIds.admin, 'DELETE', `/admin/scores/${scoreA}/thumbnail`);
  check('thumbnail delete now allowed', r.status === 200, r);
  r = await call(clerkIds.admin, 'DELETE', `/admin/scores/${scoreA}`);
  check('score delete now allowed', r.status === 200, r);
  created.scoreIds = created.scoreIds.filter(i => i !== scoreA);
  check('admin.score_deleted logged', (await eventsOf('admin.score_deleted', eq(activityEvents.targetId, String(scoreA))))[0]?.subjectUserId === alice.id);

  // ── social management ──────────────────────────────────────────────────────
  const [bobNote] = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.userId, bob.id)).limit(1);
  r = await call(clerkIds.admin, 'DELETE', `/admin/notifications/${bobNote.id}`);
  check('delete one notification', r.status === 200, r);
  r = await call(clerkIds.admin, 'DELETE', `/admin/users/${alice.id}/notifications`);
  check('clear a user’s notifications', r.status === 200 && r.body.deleted >= 1, r);
  const [fr] = await db.select({ id: friendships.id }).from(friendships).where(or(and(eq(friendships.requesterId, alice.id), eq(friendships.addresseeId, bob.id)), and(eq(friendships.requesterId, bob.id), eq(friendships.addresseeId, alice.id))));
  r = await call(clerkIds.admin, 'DELETE', `/admin/friendships/${fr.id}`);
  check('remove friendship', r.status === 200, r);
  check('admin.friendship_removed logged', (await eventsOf('admin.friendship_removed', eq(activityEvents.targetId, String(fr.id))))[0]?.actorUserId === admin.id);

  // ── nothing secret in any event we wrote ───────────────────────────────────
  const mine = await db.select().from(activityEvents).where(or(inArray(activityEvents.actorUserId, created.userIds), inArray(activityEvents.subjectUserId, created.userIds)));
  const blob = JSON.stringify(mine.map(e => e.payload));
  check(`no tokens / keys / emails in ${mine.length} event payloads`, !/token|password|photoKey|@example|whsec_/i.test(blob), blob.slice(0, 300));
} catch (err) {
  failures++;
  console.error('FAIL  unexpected error:', err);
} finally {
  // ── cleanup: only what this script created ─────────────────────────────────
  const ids = created.userIds;
  if (ids.length) {
    await db.delete(activityEvents).where(or(
      inArray(activityEvents.actorUserId, ids),
      inArray(activityEvents.subjectUserId, ids),
      and(eq(activityEvents.targetType, 'clerk_user'), sql`${activityEvents.targetId} LIKE ${`${TAG}%`}`),
      created.challengeIds.length ? and(eq(activityEvents.targetType, 'challenge'), inArray(activityEvents.targetId, created.challengeIds.map(String))) : undefined,
    ));
    if (created.challengeIds.length) await db.delete(challenges).where(inArray(challenges.id, created.challengeIds));
    await db.delete(notifications).where(inArray(notifications.userId, ids));
    await db.delete(friendships).where(or(inArray(friendships.requesterId, ids), inArray(friendships.addresseeId, ids)));
    await db.delete(scores).where(inArray(scores.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }
  if (created.machineId) await db.delete(machines).where(eq(machines.id, created.machineId));
  const leftovers = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(users).where(sql`${users.clerkId} LIKE ${`${TAG}%`}`);
  console.log(`cleanup: ${leftovers[0].n === 0 ? 'done' : `LEFT ${leftovers[0].n} users behind`}`);
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
