// End-to-end check of the machine page's comparison scope (GET /api/machines/:name ?mine / ?pod /
// ?friends / &others) against the Neon DEV branch.
//
// Mounts the real machines router on a throwaway express app. A stub stands in for clerkMiddleware:
// it sets `req.auth` from an `x-test-clerk` header, so the route's own getAuth → users lookup runs
// for real without Clerk session tokens.
//
// Creates, and deletes at the end: two "__scopetest" pods (one for the owner, one for someone else),
// one hidden home venue with a single score on it belonging to a pod member, and a few temporary
// friendships (only ones it inserted — seeded friendships are left alone).
//
//   cd artifacts/api-server && npx tsx test-machine-scope.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as migrate13.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { default: express } = await import('express');
const { default: machinesRouter } = await import('./src/routes/machines.js');
const { db, users, pods, podMembers, scores, venues, machines, friendships } = await import('@workspace/db');
const { eq, like, sql, inArray } = await import('drizzle-orm');

// The owner: helmhead if present (the dev DB's real account), else the first user with scores.
const [owner] = await db.select({ id: users.id, clerkId: users.clerkId, username: users.username, role: users.role })
  .from(users).where(eq(users.username, 'helmhead')).limit(1);
if (!owner) throw new Error('No helmhead user in the dev DB');
if (owner.role === 'admin') console.log('note: owner is an admin — admins see hidden scores, so the hidden-venue check uses a non-admin owner below');

// A machine the owner has played that has at least 4 other players on it.
const [target] = await db.execute<{ machine_id: number; name: string }>(sql`
  SELECT s.machine_id, m.name FROM scores s JOIN machines m ON m.id = s.machine_id
  GROUP BY s.machine_id, m.name
  HAVING bool_or(s.user_id = ${owner.id}) AND count(DISTINCT s.user_id) >= 5
  ORDER BY count(DISTINCT s.user_id) DESC LIMIT 1`).then(r => (r as any).rows ?? r);
if (!target) throw new Error('No machine with the owner + 4 other players');
const machineName = target.name;

const players = await db.execute<{ user_id: number; username: string; clerk_id: string; role: string }>(sql`
  SELECT DISTINCT s.user_id, u.username, u.clerk_id, u.role FROM scores s JOIN users u ON u.id = s.user_id
  WHERE s.machine_id = ${target.machine_id} AND s.user_id <> ${owner.id} ORDER BY s.user_id`).then(r => ((r as any).rows ?? r) as any[]);
const nonAdmins = players.filter(p => p.role !== 'admin');
const [memberA, memberB, outsider, otherOwner] = nonAdmins;
if (!otherOwner) throw new Error('Need 4 non-admin other players on the target machine');

const app = express();
app.use((req: any, _res, next) => {
  const clerkId = req.header('x-test-clerk') ?? null;
  req.auth = () => ({ tokenType: 'session_token', userId: clerkId, isAuthenticated: !!clerkId });
  next();
});
app.use('/api/machines', machinesRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function get(as: { clerkId?: string; clerk_id?: string } | null, query = '') {
  const clerk = as ? (as.clerkId ?? as.clerk_id)! : undefined;
  const res = await fetch(`http://localhost:${port}/api/machines/${encodeURIComponent(machineName)}${query}`, {
    headers: clerk ? { 'x-test-clerk': clerk } : {},
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 400)}`}`);
}
const usersOf = (rows: any[]) => new Set(rows.map(r => r.username));
const groupsOf = (rows: any[], g: string) => new Set(rows.filter(r => r.group === g).map(r => r.username));
const same = (a: Set<string>, b: string[]) => a.size === b.length && b.every(x => a.has(x));
const rowsOf = (r: any) => ((r as any).rows ?? r) as any[];
const friendUsernamesOf = async (id: number) => new Set(rowsOf(await db.execute(sql`
  SELECT u.username FROM friendships f
  JOIN users u ON u.id = CASE WHEN f.requester_id = ${id} THEN f.addressee_id ELSE f.requester_id END
  WHERE f.status = 'accepted' AND (f.requester_id = ${id} OR f.addressee_id = ${id})`)).map((r: any) => r.username as string));

let podId = 0, otherPodId = 0, hiddenVenueId = 0, hiddenScoreId = 0;
const createdFriendshipIds: number[] = [];
try {
  console.log(`machine "${machineName}", owner ${owner.username}, pod = ${memberA.username} + ${memberB.username}`);

  // baseline — All, before anything is created
  const allBefore = await get(owner);
  check('all → 200', allBefore.status === 200, allBefore.status);
  check('all → scope.kind = all', allBefore.body?.scope?.kind === 'all', allBefore.body?.scope);
  check('all → every row tagged self/other only',
    allBefore.body.scores.every((s: any) => (s.username === owner.username ? s.group === 'self' : s.group === 'other')));
  const signedOut = await get(null);
  check('signed out, all → same row count as signed-in all (no hidden scores in play)',
    signedOut.status === 200 && signedOut.body.scores.length === allBefore.body.scores.length, signedOut.body?.scores?.length);
  check('signed out → every row tagged other', signedOut.body.scores.every((s: any) => s.group === 'other'));

  // mine
  const mine = await get(owner, '?mine=true');
  check('mine → only the owner', mine.status === 200 && same(usersOf(mine.body.scores), [owner.username]), [...usersOf(mine.body.scores)]);
  check('mine → count = own rows in all', mine.body.scores.length === allBefore.body.scores.filter((s: any) => s.username === owner.username).length);
  const mineSignedOut = await get(null, '?mine=true');
  check('mine signed out → degrades to all', mineSignedOut.body?.scope?.kind === 'all' && mineSignedOut.body.scores.length === signedOut.body.scores.length);

  // pods
  [{ id: podId }] = await db.insert(pods).values({ ownerId: owner.id, name: '__scopetest crew', color: '#2dd4bf' }).returning({ id: pods.id });
  await db.insert(podMembers).values([{ podId, userId: memberA.user_id }, { podId, userId: memberB.user_id }]);
  [{ id: otherPodId }] = await db.insert(pods).values({ ownerId: otherOwner.user_id, name: '__scopetest theirs', color: '#d95926' }).returning({ id: pods.id });
  await db.insert(podMembers).values([{ podId: otherPodId, userId: outsider.user_id }]);

  const pod = await get(owner, `?pod=${podId}`);
  check('pod → 200', pod.status === 200, pod);
  check('pod → only owner + members', same(usersOf(pod.body.scores), [owner.username, memberA.username, memberB.username]), [...usersOf(pod.body.scores)]);
  check('pod → self group is the owner', same(groupsOf(pod.body.scores, 'self'), [owner.username]));
  check('pod → pod group is the members', same(groupsOf(pod.body.scores, 'pod'), [memberA.username, memberB.username]));
  check('pod → no other rows', groupsOf(pod.body.scores, 'other').size === 0);
  check('pod → echoes the pod (id/name/color only)',
    JSON.stringify(pod.body.scope) === JSON.stringify({ kind: 'pod', pod: { id: podId, name: '__scopetest crew', color: '#2dd4bf' }, others: false }), pod.body.scope);
  check('pod → no member id list in the payload', !('members' in (pod.body.scope?.pod ?? {})) && !pod.text.includes('"userId"'));

  const podOthers = await get(owner, `?pod=${podId}&others=1`);
  check('pod+others → same rows as all', podOthers.body.scores.length === allBefore.body.scores.length, podOthers.body.scores.length);
  check('pod+others → others tagged other',
    podOthers.body.scores.every((s: any) =>
      s.group === (s.username === owner.username ? 'self' : [memberA.username, memberB.username].includes(s.username) ? 'pod' : 'other')));
  check('pod+others → scope.others = true', podOthers.body.scope?.others === true);

  // someone else's pod / nonexistent / malformed / signed out — all identical 404s
  const theirs = await get(owner, `?pod=${otherPodId}`);
  const missing = await get(owner, `?pod=99999999`);
  const junk = await get(owner, `?pod=abc`);
  const anon = await get(null, `?pod=${podId}`);
  check("someone else's pod → 404 pod_not_found", theirs.status === 404 && theirs.body?.code === 'pod_not_found', theirs);
  check('nonexistent pod → identical 404', missing.status === 404 && missing.text === theirs.text, missing);
  check('malformed pod id → identical 404', junk.status === 404 && junk.text === theirs.text, junk);
  check('signed-out with pod → identical 404', anon.status === 404 && anon.text === theirs.text, anon);
  const theirsOthers = await get(owner, `?pod=${otherPodId}&others=1`);
  check("someone else's pod + others → identical 404", theirsOthers.status === 404 && theirsOthers.text === theirs.text);
  const ownerOfOther = await get({ clerk_id: otherOwner.clerk_id }, `?pod=${otherPodId}`);
  check('their own pod works for them', ownerOfOther.status === 200 && same(usersOf(ownerOfOther.body.scores), [otherOwner.username, outsider.username]), [...usersOf(ownerOfOther.body.scores ?? [])]);

  // hidden home venue: memberA posts a score at their own residence with the switch off
  [{ id: hiddenVenueId }] = await db.insert(venues).values({
    name: '__scopetest hidden home', isResidence: true, privacyTier: 'hidden', showMachinesAndScores: false, ownerId: memberA.user_id,
  } as any).returning({ id: venues.id });
  [{ id: hiddenScoreId }] = await db.insert(scores).values({
    userId: memberA.user_id, machineId: target.machine_id, score: 123456789, playedAt: new Date(), venueId: hiddenVenueId, venueName: '__scopetest hidden home',
  } as any).returning({ id: scores.id });

  const hasHidden = (r: any) => r.body?.scores?.some((s: any) => s.id === hiddenScoreId);
  if (owner.role === 'admin') {
    console.log('SKIP  hidden-venue checks for helmhead (admin sees everything by design)');
  } else {
    check('pod → member\'s hidden-venue score stays hidden from the pod owner', !hasHidden(await get(owner, `?pod=${podId}`)));
    check('pod+others → still hidden', !hasHidden(await get(owner, `?pod=${podId}&others=1`)));
    check('all → still hidden', !hasHidden(await get(owner)));
  }
  // Same check with a non-admin pod owner, so it runs regardless of helmhead's role.
  await db.insert(podMembers).values({ podId: otherPodId, userId: memberA.user_id });
  check('non-admin owner, pod → member\'s hidden-venue score hidden', !hasHidden(await get({ clerk_id: otherOwner.clerk_id }, `?pod=${otherPodId}`)));
  check('non-admin owner, pod+others → hidden', !hasHidden(await get({ clerk_id: otherOwner.clerk_id }, `?pod=${otherPodId}&others=1`)));
  check('the member themselves still sees it', hasHidden(await get({ clerk_id: memberA.clerk_id })));
  check('signed out → hidden', !hasHidden(await get(null)));


  // ── friends (feature/friends) ──
  // Temporarily befriend memberA + memberB (accepted) and leave the owner a PENDING request from the
  // outsider, which must not count. A pair that already has a row (a seeded friendship) is left
  // alone — the expected friend set is read back from the DB, so seeded friends are just part of it.
  let pendingCreated = false;
  for (const [a, b, status] of [[owner.id, memberA.user_id, 'accepted'], [owner.id, memberB.user_id, 'accepted'], [outsider.user_id, owner.id, 'pending']] as const) {
    const ins = await db.insert(friendships).values({ requesterId: a, addresseeId: b, status, respondedAt: status === 'accepted' ? new Date() : null })
      .onConflictDoNothing().returning({ id: friendships.id });
    createdFriendshipIds.push(...ins.map(r => r.id));
    if (status === 'pending' && ins.length) pendingCreated = true;
  }
  const friendNames = await friendUsernamesOf(owner.id);
  const everyone = await get(owner);
  const onList = usersOf(everyone.body.scores);
  const expectedFriends = [...friendNames].filter(u => onList.has(u));
  const fr = await get(owner, '?friends=1');
  check('friends → 200', fr.status === 200, fr);
  check('friends → echoes { kind: friends, others: false } only', JSON.stringify(fr.body?.scope) === JSON.stringify({ kind: 'friends', others: false }), fr.body?.scope);
  check('friends → only owner + accepted friends', same(usersOf(fr.body.scores), [owner.username, ...expectedFriends]), [...usersOf(fr.body.scores)]);
  check('friends → self group is the owner', same(groupsOf(fr.body.scores, 'self'), [owner.username]));
  check('friends → friend group is the friends', same(groupsOf(fr.body.scores, 'friend'), expectedFriends), [...groupsOf(fr.body.scores, 'friend')]);
  check('friends → no other rows', groupsOf(fr.body.scores, 'other').size === 0);
  if (pendingCreated && !friendNames.has(outsider.username)) {
    check('friends → a pending request does not count', !usersOf(fr.body.scores).has(outsider.username));
  }
  check('friends → no user ids in the payload', !fr.text.includes('"userId"'));
  const frOthers = await get(owner, '?friends=1&others=1');
  check('friends+others → same rows as all', frOthers.body.scores.length === everyone.body.scores.length, [frOthers.body.scores.length, everyone.body.scores.length]);
  check('friends+others → tags self/friend/other',
    frOthers.body.scores.every((s: any) => s.group === (s.username === owner.username ? 'self' : friendNames.has(s.username) ? 'friend' : 'other')));
  check('friends+others → scope.others = true', frOthers.body.scope?.others === true);
  const frAnon = await get(null, '?friends=1');
  check('friends signed out → degrades to all', frAnon.status === 200 && frAnon.body?.scope?.kind === 'all');
  // otherOwner (non-admin) befriends memberA: being someone's friend reveals nothing their switch hides.
  const insOther = await db.insert(friendships).values({ requesterId: otherOwner.user_id, addresseeId: memberA.user_id, status: 'accepted' })
    .onConflictDoNothing().returning({ id: friendships.id });
  createdFriendshipIds.push(...insOther.map(r => r.id));
  check("non-admin, friends → friend's hidden-venue score hidden", !hasHidden(await get({ clerk_id: otherOwner.clerk_id }, '?friends=1')));
  check("non-admin, friends+others → hidden", !hasHidden(await get({ clerk_id: otherOwner.clerk_id }, '?friends=1&others=1')));

  // All/Mine unchanged by the pods' (and friendships') existence (hidden score excluded for comparison)
  const allAfter = await get(owner);
  const strip = (r: any) => JSON.stringify(r.body.scores.filter((s: any) => s.id !== hiddenScoreId));
  check('all unchanged after creating pods', strip(allAfter) === JSON.stringify(allBefore.body.scores));
  const mineAfter = await get(owner, '?mine=true');
  check('mine unchanged after creating pods', JSON.stringify(mineAfter.body.scores) === JSON.stringify(mine.body.scores));
} finally {
  if (createdFriendshipIds.length) await db.delete(friendships).where(inArray(friendships.id, createdFriendshipIds));
  if (hiddenScoreId) await db.delete(scores).where(eq(scores.id, hiddenScoreId));
  if (hiddenVenueId) await db.delete(venues).where(eq(venues.id, hiddenVenueId));
  const created = await db.select({ id: pods.id }).from(pods).where(like(pods.name, '\\_\\_scopetest%'));
  if (created.length) await db.delete(pods).where(inArray(pods.id, created.map(p => p.id)));
  const leftover = await db.select({ id: pods.id }).from(pods).where(like(pods.name, '\\_\\_scopetest%'));
  const leftoverVenues = await db.select({ id: venues.id }).from(venues).where(like(venues.name, '\\_\\_scopetest%'));
  console.log(`cleanup: ${leftover.length} test pods, ${leftoverVenues.length} test venues left`);
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
