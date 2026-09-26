// End-to-end check of the /api/friends and /api/notifications routes against the Neon DEV branch.
//
// Mounts the real routers on a throwaway express app behind a stub that plays the part of
// requireAppUser (sets req.appUser from an `x-test-user` header), so the route logic, SQL, row locks
// and constraints are exercised for real without needing Clerk session tokens. Unauthenticated
// requests to the real server are requireAppUser's job (401), which is existing code.
//
// Borrows three existing users that are in no friendship yet (so it never disturbs seeded data),
// and at the end deletes every friendship among them and every notification it raised for them.
//
//   cd artifacts/api-server && npx tsx test-friends.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as migrate14.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { default: express } = await import('express');
const { default: friendsRouter } = await import('./src/routes/friends.js');
const { default: notificationsRouter } = await import('./src/routes/notifications.js');
const { db, users, friendships, notifications } = await import('@workspace/db');
const { and, desc, inArray, sql } = await import('drizzle-orm');

const people = await db.select({ id: users.id, username: users.username, displayName: users.displayName })
  .from(users)
  .where(sql`NOT EXISTS (SELECT 1 FROM friendships f WHERE f.requester_id = ${users.id} OR f.addressee_id = ${users.id})`)
  .orderBy(desc(users.id)).limit(3);
if (people.length < 3) throw new Error('Need at least 3 users with no friendships in the dev DB');
const [alice, bob, carol] = people;
const ids = people.map(p => p.id);

const app = express();
app.use(express.json());
const stub = (req: any, _res: any, next: any) => {
  req.appUser = people.find(p => p.id === Number(req.header('x-test-user')));
  next();
};
app.use('/api/friends', stub, friendsRouter);
app.use('/api/notifications', stub, notificationsRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function call(as: { id: number }, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': String(as.id) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
}

const unread = async (who: { id: number }) => (await call(who, 'GET', '/notifications/unread-count')).body?.count as number;
const inbox = async (who: { id: number }) => ((await call(who, 'GET', '/notifications?limit=50')).body?.items ?? []) as any[];
const statusWith = async (who: { id: number }, other: { username: string }) =>
  (await call(who, 'GET', `/friends/with/${encodeURIComponent(other.username)}`)).body?.relationship as string;
const pairRow = async (a: number, b: number) => (await db.select().from(friendships)
  .where(sql`least(requester_id, addressee_id) = ${Math.min(a, b)} AND greatest(requester_id, addressee_id) = ${Math.max(a, b)}`))[0];

try {
  // ── sending, re-sending, notifications ─────────────────────────────────────
  let r = await call(alice, 'POST', '/friends/requests', { userId: bob.id });
  check('send → 201 sent', r.status === 201 && r.body?.result === 'sent' && r.body?.relationship === 'outgoing', r);
  check('bob has 1 unread', await unread(bob) === 1);
  let items = await inbox(bob);
  check('bob\'s notification is a friend_request from alice', items[0]?.kind === 'friend_request' && items[0]?.payload?.userId === alice.id && items[0]?.payload?.username === alice.username, items[0]);
  const firstNotifId = items[0]?.id;

  const createdBefore = (await pairRow(alice.id, bob.id))!.createdAt;
  await new Promise(res => setTimeout(res, 20));
  for (let i = 0; i < 3; i++) {
    r = await call(alice, 'POST', '/friends/requests', { userId: bob.id });
    check(`re-send #${i + 1} while pending → 200 resent`, r.status === 200 && r.body?.result === 'resent', r);
  }
  const rowsForPair = await db.select().from(friendships).where(and(inArray(friendships.requesterId, [alice.id, bob.id]), inArray(friendships.addresseeId, [alice.id, bob.id])));
  check('still exactly one friendship row', rowsForPair.length === 1, rowsForPair);
  check('re-send refreshed created_at', +rowsForPair[0].createdAt > +createdBefore, rowsForPair[0]);
  check('still 1 unread for bob (replaced, not stacked)', await unread(bob) === 1);
  items = await inbox(bob);
  check('re-raised notification is a new row at the top', items[0]?.id !== firstNotifId && items.filter(n => n.kind === 'friend_request').length === 1, items);

  check('alice sees outgoing', await statusWith(alice, bob) === 'outgoing');
  check('bob sees incoming', await statusWith(bob, alice) === 'incoming');
  check('with/self → self', await statusWith(alice, alice) === 'self');

  r = await call(alice, 'GET', '/friends');
  check('alice list: bob outgoing', r.body?.outgoing?.some((o: any) => o.user.id === bob.id) && !r.body?.incoming?.length, r.body);
  check('list entries carry public basics only', Object.keys(r.body?.outgoing?.[0]?.user ?? {}).sort().join() === 'displayName,id,username', r.body?.outgoing);
  r = await call(bob, 'GET', '/friends');
  check('bob list: alice incoming', r.body?.incoming?.some((o: any) => o.user.id === alice.id), r.body);
  r = await call(carol, 'GET', '/friends');
  check('carol sees none of it', !r.body?.incoming?.length && !r.body?.outgoing?.length && !r.body?.friends?.length, r.body);

  // Only the addressee may respond; only the requester may cancel.
  r = await call(alice, 'POST', `/friends/requests/${bob.id}/accept`);
  check('requester cannot accept own request → 404', r.status === 404 && r.body?.code === 'request_not_found', r);
  r = await call(carol, 'POST', `/friends/requests/${alice.id}/accept`);
  check('stranger accept → 404', r.status === 404, r);
  r = await call(bob, 'DELETE', `/friends/requests/${alice.id}`);
  check('addressee cannot cancel → 404', r.status === 404, r);

  // ── decline cap: 3 declines total, counting the first ──────────────────────
  for (let n = 1; n <= 3; n++) {
    r = await call(bob, 'POST', `/friends/requests/${alice.id}/decline`);
    check(`decline #${n} → 200`, r.status === 200, r);
    check(`decline #${n} leaves no unread for bob`, await unread(bob) === 0);
    if (n < 3) {
      check(`after decline #${n} alice sees none (never "declined")`, await statusWith(alice, bob) === 'none');
      r = await call(alice, 'GET', '/friends');
      check(`after decline #${n} it isn't in alice's outgoing`, !r.body?.outgoing?.length, r.body);
      r = await call(alice, 'POST', '/friends/requests', { userId: bob.id });
      check(`re-ask after decline #${n} → 201 sent`, r.status === 201 && r.body?.result === 'sent', r);
      check('bob notified again', await unread(bob) === 1);
    }
  }
  check('decline_count is 3', (await pairRow(alice.id, bob.id))?.declineCount === 3);
  check('alice now sees unavailable', await statusWith(alice, bob) === 'unavailable');
  r = await call(alice, 'POST', '/friends/requests', { userId: bob.id });
  check('4th ask → 403 request_unavailable', r.status === 403 && r.body?.code === 'request_unavailable', r);
  check('…and no notification', await unread(bob) === 0);
  r = await call(alice, 'GET', `/friends/search?q=${encodeURIComponent(bob.username)}`);
  check('search shows bob as unavailable', r.body?.find((u: any) => u.id === bob.id)?.relationship === 'unavailable', r.body);

  // The decliner may reach out: roles flip, history kept.
  check('bob (the decliner) sees none', await statusWith(bob, alice) === 'none');
  r = await call(bob, 'POST', '/friends/requests', { userId: alice.id });
  check('decliner asks → 201 sent', r.status === 201, r);
  let row = await pairRow(alice.id, bob.id);
  check('roles flipped, count kept', row?.requesterId === bob.id && row?.addresseeId === alice.id && row?.status === 'pending' && row?.declineCount === 3, row);
  check('alice notified of bob\'s request', await unread(alice) === 1);
  r = await call(alice, 'POST', `/friends/requests/${bob.id}/accept`);
  check('alice accepts → friends', r.status === 200 && r.body?.relationship === 'friends', r);
  check('bob gets friend_accepted', (await inbox(bob))[0]?.kind === 'friend_accepted');
  check('alice\'s request notification settled (read)', await unread(alice) === 0);
  check('both see friends', await statusWith(alice, bob) === 'friends' && await statusWith(bob, alice) === 'friends');
  r = await call(alice, 'POST', '/friends/requests', { userId: bob.id });
  check('asking a friend → 200 already_friends', r.status === 200 && r.body?.result === 'already_friends', r);

  // ── reverse request = acceptance ───────────────────────────────────────────
  r = await call(carol, 'POST', '/friends/requests', { userId: alice.id });
  check('carol → alice sent', r.status === 201, r);
  r = await call(alice, 'POST', '/friends/requests', { userId: carol.id });
  check('alice → carol while carol → alice pending → accepted', r.status === 200 && r.body?.result === 'accepted' && r.body?.relationship === 'friends', r);
  row = await pairRow(alice.id, carol.id);
  check('one row, accepted, carol still the requester', row?.status === 'accepted' && row?.requesterId === carol.id, row);
  check('carol gets friend_accepted', (await inbox(carol))[0]?.kind === 'friend_accepted');
  check('alice\'s request from carol marked read', await unread(alice) === 0);
  r = await call(alice, 'GET', '/friends');
  check('alice has 2 friends', r.body?.friends?.length === 2, r.body);

  // ── unfriend ───────────────────────────────────────────────────────────────
  r = await call(carol, 'DELETE', `/friends/${alice.id}`);
  check('unfriend (addressee side) → 200', r.status === 200, r);
  check('row deleted', !(await pairRow(alice.id, carol.id)));
  r = await call(carol, 'DELETE', `/friends/${alice.id}`);
  check('unfriend again → 404 not_friends', r.status === 404 && r.body?.code === 'not_friends', r);

  // ── cancel ─────────────────────────────────────────────────────────────────
  r = await call(carol, 'POST', '/friends/requests', { userId: bob.id });
  check('carol → bob sent', r.status === 201, r);
  check('bob has an unread request', (await inbox(bob)).some(n => n.kind === 'friend_request' && !n.readAt && n.payload.userId === carol.id));
  r = await call(carol, 'DELETE', `/friends/requests/${bob.id}`);
  check('carol cancels → 200', r.status === 200, r);
  check('cancel with no decline history deletes the row', !(await pairRow(bob.id, carol.id)));
  check('cancel removes bob\'s unread request notification', !(await inbox(bob)).some(n => n.kind === 'friend_request' && n.payload.userId === carol.id));
  r = await call(carol, 'DELETE', `/friends/requests/${bob.id}`);
  check('cancel again → 404', r.status === 404, r);

  // Cancelling can't wipe a decline history.
  await call(carol, 'POST', '/friends/requests', { userId: bob.id });
  await call(bob, 'POST', `/friends/requests/${carol.id}/decline`);
  await call(carol, 'POST', '/friends/requests', { userId: bob.id });
  r = await call(carol, 'DELETE', `/friends/requests/${bob.id}`);
  row = await pairRow(bob.id, carol.id);
  check('cancel after a decline keeps the row as declined with its count', r.status === 200 && row?.status === 'declined' && row?.declineCount === 1, row);

  // ── validation ─────────────────────────────────────────────────────────────
  r = await call(alice, 'POST', '/friends/requests', { userId: alice.id });
  check('friend yourself → 400', r.status === 400 && r.body?.code === 'cannot_friend_self', r);
  r = await call(alice, 'POST', '/friends/requests', { userId: 999999999 });
  check('unknown user → 404', r.status === 404 && r.body?.code === 'user_not_found', r);
  r = await call(alice, 'POST', '/friends/requests', {});
  check('missing userId → 400', r.status === 400, r);
  r = await call(alice, 'GET', `/friends/search?q=${encodeURIComponent(alice.username)}`);
  check('search excludes self', r.status === 200 && !r.body.some((u: any) => u.id === alice.id), r.body);
  r = await call(alice, 'GET', '/friends/search?q=%25');
  check('"%" is literal in search', r.status === 200 && Array.isArray(r.body), r);

  // ── notifications: privacy, mark read, paging ──────────────────────────────
  const bobItems = await inbox(bob);
  r = await call(alice, 'POST', `/notifications/${bobItems[0].id}/read`);
  check("marking someone else's notification → 404", r.status === 404 && r.body?.code === 'notification_not_found', r);
  const unreadBob = bobItems.find(n => !n.readAt);
  if (unreadBob) {
    r = await call(bob, 'POST', `/notifications/${unreadBob.id}/read`);
    check('mark one read → 200 with readAt', r.status === 200 && !!r.body?.readAt, r);
  }
  await call(carol, 'POST', '/friends/requests', { userId: bob.id }); // carol is under the cap: re-raises
  check('bob unread ≥ 1 before read-all', await unread(bob) >= 1);
  r = await call(bob, 'POST', '/notifications/read-all');
  check('read-all → 200', r.status === 200 && r.body?.updated >= 1, r);
  check('bob unread = 0 after read-all', await unread(bob) === 0);
  const page1 = await call(bob, 'GET', '/notifications?limit=1');
  check('limit=1 page has 1 item and a cursor', page1.body?.items?.length === 1 && page1.body?.nextBefore != null, page1.body);
  const page2 = await call(bob, 'GET', `/notifications?limit=1&before=${page1.body?.nextBefore}`);
  check('next page is older', page2.body?.items?.[0]?.id < page1.body?.items?.[0]?.id, page2.body);
  r = await call(carol, 'GET', '/notifications?limit=50');
  check("carol's inbox holds only carol's rows", r.body.items.every((n: any) => !bobItems.some(b => b.id === n.id)), r.body);
} finally {
  await db.delete(friendships).where(and(inArray(friendships.requesterId, ids), inArray(friendships.addresseeId, ids)));
  // Only notifications between the three test users — i.e. the ones this script raised.
  await db.delete(notifications).where(and(
    inArray(notifications.userId, ids),
    sql`(${notifications.payload} ->> 'userId')::int IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`,
  ));
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
