// End-to-end check of the venue page's comparison scope (GET /api/venues/:id/scores ?mine / ?pod /
// &others) against the Neon DEV branch. Same harness as test-machine-scope.ts.
//
// Mounts the real venues router on a throwaway express app. A stub stands in for clerkMiddleware:
// it sets `req.auth` from an `x-test-clerk` header, so the route's own getAuth → users lookup runs
// for real without Clerk session tokens.
//
// Creates, and deletes at the end: two "__venuescope" pods (one for the owner, one for someone
// else), and one hidden home venue (switch off) with scores on it.
//
//   cd artifacts/api-server && npx tsx test-venue-scope.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as migrate13.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { default: express } = await import('express');
const { default: venuesRouter } = await import('./src/routes/venues.js');
const { db, users, pods, podMembers, scores, venues } = await import('@workspace/db');
const { eq, like, sql, inArray } = await import('drizzle-orm');

const [owner] = await db.select({ id: users.id, clerkId: users.clerkId, username: users.username, role: users.role })
  .from(users).where(eq(users.username, 'helmhead')).limit(1);
if (!owner) throw new Error('No helmhead user in the dev DB');

// A public venue the owner has played at with at least 4 other non-admin players.
const rowsOf = (r: any) => ((r as any).rows ?? r) as any[];
const [target] = rowsOf(await db.execute(sql`
  SELECT s.venue_id, v.name FROM scores s JOIN venues v ON v.id = s.venue_id JOIN users u ON u.id = s.user_id
  WHERE v.is_residence = false AND v.privacy_tier = 'full'
  GROUP BY s.venue_id, v.name
  HAVING bool_or(s.user_id = ${owner.id}) AND count(DISTINCT s.user_id) FILTER (WHERE u.role <> 'admin' AND s.user_id <> ${owner.id}) >= 4
  ORDER BY count(DISTINCT s.user_id) DESC LIMIT 1`));
if (!target) throw new Error('No public venue with the owner + 4 other non-admin players');
const venueId = Number(target.venue_id);

const players = rowsOf(await db.execute(sql`
  SELECT DISTINCT s.user_id, u.username, u.clerk_id, u.role FROM scores s JOIN users u ON u.id = s.user_id
  WHERE s.venue_id = ${venueId} AND s.user_id <> ${owner.id} AND u.role <> 'admin' ORDER BY s.user_id`));
const [memberA, memberB, outsider, otherOwner] = players;

const app = express();
app.use((req: any, _res, next) => {
  const clerkId = req.header('x-test-clerk') ?? null;
  req.auth = () => ({ tokenType: 'session_token', userId: clerkId, isAuthenticated: !!clerkId });
  next();
});
app.use('/api/venues', venuesRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function get(as: { clerkId?: string; clerk_id?: string } | null, query = '', vid = venueId) {
  const clerk = as ? (as.clerkId ?? as.clerk_id)! : undefined;
  const res = await fetch(`http://localhost:${port}/api/venues/${vid}/scores${query}`, {
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

let podId = 0, otherPodId = 0, hiddenVenueId = 0;
const hiddenScoreIds: number[] = [];
try {
  console.log(`venue ${venueId} "${target.name}", owner ${owner.username} (${owner.role}), pod = ${memberA.username} + ${memberB.username}`);

  // baseline — All, before anything is created
  const allBefore = await get(owner);
  check('all → 200', allBefore.status === 200, allBefore.status);
  check('all → scope.kind = all', allBefore.body?.scope?.kind === 'all', allBefore.body?.scope);
  check('all → every row tagged self/other only',
    allBefore.body.scores.every((s: any) => (s.username === owner.username ? s.group === 'self' : s.group === 'other')));
  check('all → totals = listing', allBefore.body.totals?.scores === allBefore.body.scores.length, allBefore.body.totals);
  const [direct] = rowsOf(await db.execute(sql`SELECT count(*)::int AS n, count(DISTINCT machine_id)::int AS m FROM scores WHERE venue_id = ${venueId}`));
  check('all → row count matches the DB (public venue, nothing hidden)', allBefore.body.scores.length === direct.n, [allBefore.body.scores.length, direct.n]);
  check('all → venue.machineCount = distinct machines played', allBefore.body.venue.machineCount === direct.m, [allBefore.body.venue.machineCount, direct.m]);
  const signedOut = await get(null);
  check('signed out, all → same rows as signed-in all', signedOut.status === 200 && signedOut.body.scores.length === allBefore.body.scores.length);
  check('signed out → every row tagged other', signedOut.body.scores.every((s: any) => s.group === 'other'));

  // mine
  const mine = await get(owner, '?mine=true');
  check('mine → only the owner', mine.status === 200 && same(usersOf(mine.body.scores), [owner.username]), [...usersOf(mine.body.scores)]);
  check('mine → count = own rows in all', mine.body.scores.length === allBefore.body.scores.filter((s: any) => s.username === owner.username).length);
  check('mine → rows identical to own rows in all (same order)',
    JSON.stringify(mine.body.scores) === JSON.stringify(allBefore.body.scores.filter((s: any) => s.username === owner.username)));
  check('mine → totals and venue header are venue-wide, not mine',
    JSON.stringify(mine.body.totals) === JSON.stringify(allBefore.body.totals) && JSON.stringify(mine.body.venue) === JSON.stringify(allBefore.body.venue));
  const mineSignedOut = await get(null, '?mine=true');
  check('mine signed out → degrades to all', mineSignedOut.body?.scope?.kind === 'all' && mineSignedOut.body.scores.length === signedOut.body.scores.length);

  // pods
  [{ id: podId }] = await db.insert(pods).values({ ownerId: owner.id, name: '__venuescope crew', color: '#2dd4bf' }).returning({ id: pods.id });
  await db.insert(podMembers).values([{ podId, userId: memberA.user_id }, { podId, userId: memberB.user_id }]);
  [{ id: otherPodId }] = await db.insert(pods).values({ ownerId: otherOwner.user_id, name: '__venuescope theirs', color: '#d95926' }).returning({ id: pods.id });
  await db.insert(podMembers).values([{ podId: otherPodId, userId: outsider.user_id }]);

  const pod = await get(owner, `?pod=${podId}`);
  check('pod → 200', pod.status === 200, pod);
  check('pod → only owner + members', same(usersOf(pod.body.scores), [owner.username, memberA.username, memberB.username]), [...usersOf(pod.body.scores)]);
  check('pod → self group is the owner', same(groupsOf(pod.body.scores, 'self'), [owner.username]));
  check('pod → pod group is the members', same(groupsOf(pod.body.scores, 'pod'), [memberA.username, memberB.username]));
  check('pod → no other rows', groupsOf(pod.body.scores, 'other').size === 0);
  check('pod → count = matching rows in all',
    pod.body.scores.length === allBefore.body.scores.filter((s: any) => [owner.username, memberA.username, memberB.username].includes(s.username)).length);
  check('pod → totals venue-wide', JSON.stringify(pod.body.totals) === JSON.stringify(allBefore.body.totals), pod.body.totals);
  check('pod → echoes the pod (id/name/color only)',
    JSON.stringify(pod.body.scope) === JSON.stringify({ kind: 'pod', pod: { id: podId, name: '__venuescope crew', color: '#2dd4bf' }, others: false }), pod.body.scope);
  check('pod → no member id list in the payload', !('members' in (pod.body.scope?.pod ?? {})) && !pod.text.includes('"userId"'));

  const podOthers = await get(owner, `?pod=${podId}&others=1`);
  check('pod+others → same rows as all', podOthers.body.scores.length === allBefore.body.scores.length, podOthers.body.scores.length);
  check('pod+others → tags self/pod/other',
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
  check("someone else's pod + others → identical 404", (await get(owner, `?pod=${otherPodId}&others=1`)).text === theirs.text);
  check('foreign pod on a nonexistent venue → same 404 (scope checked first)', (await get(owner, `?pod=${otherPodId}`, 99999999)).text === theirs.text);
  const ownerOfOther = await get({ clerk_id: otherOwner.clerk_id }, `?pod=${otherPodId}`);
  check('their own pod works for them', ownerOfOther.status === 200 && same(usersOf(ownerOfOther.body.scores), [otherOwner.username, outsider.username]), [...usersOf(ownerOfOther.body.scores ?? [])]);

  // Hidden home venue owned by memberA, switch off. memberA and otherOwner both log there.
  [{ id: hiddenVenueId }] = await db.insert(venues).values({
    name: '__venuescope hidden home', isResidence: true, privacyTier: 'hidden', showMachinesAndScores: false, ownerId: memberA.user_id,
  } as any).returning({ id: venues.id });
  const anyMachine = allBefore.body.scores[0].machineId;
  for (const u of [memberA, otherOwner]) {
    const [{ id }] = await db.insert(scores).values({
      userId: u.user_id, machineId: anyMachine, score: 123456789, playedAt: new Date(), venueId: hiddenVenueId, venueName: '__venuescope hidden home',
    } as any).returning({ id: scores.id });
    hiddenScoreIds.push(id);
  }
  const [memberAScore, otherOwnerScore] = hiddenScoreIds;
  const ids = (r: any) => new Set((r.body?.scores ?? []).map((s: any) => s.id));

  // otherOwner (non-admin) has memberA in their pod: being in a pod reveals nothing.
  await db.insert(podMembers).values({ podId: otherPodId, userId: memberA.user_id });
  for (const q of ['', '?mine=true', `?pod=${otherPodId}`, `?pod=${otherPodId}&others=1`]) {
    const r = await get({ clerk_id: otherOwner.clerk_id }, q, hiddenVenueId);
    check(`hidden venue, pod owner ${q || '(all)'} → member's score hidden, own score visible`,
      r.status === 200 && !ids(r).has(memberAScore) && ids(r).has(otherOwnerScore), r.body?.scores);
    check(`hidden venue, pod owner ${q || '(all)'} → totals count only their own`, r.body?.totals?.scores === 1, r.body?.totals);
  }
  const outsiderView = await get({ clerk_id: outsider.clerk_id }, '', hiddenVenueId);
  check('hidden venue, unrelated user → nothing', outsiderView.status === 200 && outsiderView.body.scores.length === 0 && outsiderView.body.totals.scores === 0);
  check('hidden venue, signed out → nothing', (await get(null, '', hiddenVenueId)).body.scores.length === 0);
  const venueOwnerView = await get({ clerk_id: memberA.clerk_id }, '', hiddenVenueId);
  check('hidden venue, its owner → sees both', ids(venueOwnerView).has(memberAScore) && ids(venueOwnerView).has(otherOwnerScore));
  if (owner.role === 'admin') {
    console.log('note: helmhead is an admin — admins see hidden scores by design, so the pod checks above use a non-admin pod owner');
  } else {
    check('hidden venue, helmhead pod → member score hidden', !ids(await get(owner, `?pod=${podId}`, hiddenVenueId)).has(memberAScore));
  }

  // All/Mine unchanged by the pods' existence
  const allAfter = await get(owner);
  check('all unchanged after creating pods', JSON.stringify(allAfter.body) === JSON.stringify(allBefore.body));
  const mineAfter = await get(owner, '?mine=true');
  check('mine unchanged after creating pods', JSON.stringify(mineAfter.body) === JSON.stringify(mine.body));
} finally {
  if (hiddenScoreIds.length) await db.delete(scores).where(inArray(scores.id, hiddenScoreIds));
  if (hiddenVenueId) await db.delete(venues).where(eq(venues.id, hiddenVenueId));
  const created = await db.select({ id: pods.id }).from(pods).where(like(pods.name, '\\_\\_venuescope%'));
  if (created.length) await db.delete(pods).where(inArray(pods.id, created.map(p => p.id)));
  const leftover = await db.select({ id: pods.id }).from(pods).where(like(pods.name, '\\_\\_venuescope%'));
  const leftoverVenues = await db.select({ id: venues.id }).from(venues).where(like(venues.name, '\\_\\_venuescope%'));
  console.log(`cleanup: ${leftover.length} test pods, ${leftoverVenues.length} test venues left`);
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
