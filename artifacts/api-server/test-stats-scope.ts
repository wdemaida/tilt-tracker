// End-to-end check of the Stats page's comparison scope (GET /api/stats and
// GET /api/stats/history/:key with ?mine / ?pod / &others) against the Neon DEV branch. Same
// harness as test-venue-scope.ts: the real stats router on a throwaway express app, with a stub
// standing in for clerkMiddleware (req.auth from an `x-test-clerk` header), so requireAppUser's
// own users lookup runs for real.
//
// Creates, and deletes at the end: two "__statsscope" pods (one for helmhead, one for a non-admin
// owner), and two hidden home venues (switch off): one with two scores on it, one with only a pod
// member's score.
//
//   cd artifacts/api-server && npx tsx test-stats-scope.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as migrate13.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { default: express } = await import('express');
const { default: statsRouter } = await import('./src/routes/stats.js');
const { db, users, pods, podMembers, scores, venues } = await import('@workspace/db');
const { eq, like, sql, inArray } = await import('drizzle-orm');

const rowsOf = (r: any) => ((r as any).rows ?? r) as any[];

const [owner] = await db.select({ id: users.id, clerkId: users.clerkId, username: users.username, role: users.role })
  .from(users).where(eq(users.username, 'helmhead')).limit(1);
if (!owner) throw new Error('No helmhead user in the dev DB');

// Four non-admin players with scores: two pod members, an outsider, and a second (non-admin) pod owner.
const players = rowsOf(await db.execute(sql`
  SELECT u.id AS user_id, u.username, u.clerk_id FROM users u JOIN scores s ON s.user_id = u.id
  WHERE u.role <> 'admin' AND u.id <> ${owner.id} AND u.clerk_id IS NOT NULL
  GROUP BY u.id, u.username, u.clerk_id ORDER BY count(*) DESC LIMIT 4`));
if (players.length < 4) throw new Error('Need 4 non-admin players with scores in the dev DB');
const [memberA, memberB, outsider, otherOwner] = players;

const app = express();
app.use((req: any, _res, next) => {
  const clerkId = req.header('x-test-clerk') ?? null;
  req.auth = () => ({ tokenType: 'session_token', userId: clerkId, isAuthenticated: !!clerkId });
  next();
});
app.use('/api/stats', statsRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function get(as: { clerkId?: string; clerk_id?: string } | null, path = '', query = '') {
  const clerk = as ? (as.clerkId ?? as.clerk_id)! : undefined;
  const res = await fetch(`http://localhost:${port}/api/stats${path}${query}`, {
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
const countFor = async (ids: number[]) => {
  const [r] = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM scores WHERE user_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`));
  return r.n as number;
};
const venuesFor = async (ids: number[]) => {
  const [r] = rowsOf(await db.execute(sql`SELECT count(DISTINCT s.venue_id)::int AS n FROM scores s JOIN machines m ON m.id = s.machine_id WHERE s.user_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`));
  return r.n as number;
};
// Everything but the scope echo and the per-group split — what "the same numbers" means.
const numbers = (b: any) => { const { scope: _s, split: _p, mostPlayed, ...rest } = b; return JSON.stringify({ ...rest, mostPlayed: mostPlayed.map((m: any) => [m.name, m.plays]) }); };
const last = (r: any) => r.body?.points?.at(-1)?.value;

let podId = 0, otherPodId = 0;
const hiddenVenueIds: number[] = [];
const hiddenScoreIds: number[] = [];
try {
  console.log(`owner ${owner.username} (${owner.role}); pod = ${memberA.username} + ${memberB.username}; outsider ${outsider.username}; non-admin owner ${otherOwner.username}`);

  // ── All / Mine, before any pod exists ──
  const all = await get(owner);
  check('all → 200, scope all', all.status === 200 && all.body.scope?.kind === 'all', all);
  const [{ n: everyScore }] = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM scores s JOIN machines m ON m.id = s.machine_id`));
  if (owner.role === 'admin') check('all (admin) → every score counted', all.body.totalGames === everyScore, [all.body.totalGames, everyScore]);
  check('all → ?mine=false is the same', numbers((await get(owner, '', '?mine=false')).body) === numbers(all.body));
  if (owner.role === 'admin') {
    const [{ n: everyVenue }] = rowsOf(await db.execute(sql`SELECT count(DISTINCT s.venue_id)::int AS n FROM scores s JOIN machines m ON m.id = s.machine_id`));
    check('all (admin) → venuesPlayed = distinct venues with a score', all.body.venuesPlayed === everyVenue, [all.body.venuesPlayed, everyVenue]);
  }
  check('all → venuesPlayed ≤ site-wide venue count', typeof all.body.venuesPlayed === 'number' && all.body.venuesPlayed <= all.body.totalVenues, [all.body.venuesPlayed, all.body.totalVenues]);
  check('all → split is self + other only', all.body.split.pod.plays === 0 && all.body.split.self.plays + all.body.split.other.plays === all.body.totalGames, all.body.split);

  const mine = await get(owner, '', '?mine=true');
  check('mine → only the owner', mine.status === 200 && mine.body.scope?.kind === 'mine' && mine.body.totalGames === await countFor([owner.id]), mine.body.totalGames);
  check('mine → equals the self split in all', mine.body.totalGames === all.body.split.self.plays && mine.body.totalVisits === all.body.split.self.visits);
  check('mine → venuesPlayed = your distinct venues', mine.body.venuesPlayed === await venuesFor([owner.id]), mine.body.venuesPlayed);
  check('mine → site-wide facts unchanged', mine.body.totalVenues === all.body.totalVenues && mine.body.totalMachinesInSystem === all.body.totalMachinesInSystem);

  // ── pods ──
  [{ id: podId }] = await db.insert(pods).values({ ownerId: owner.id, name: '__statsscope crew', color: '#2dd4bf' }).returning({ id: pods.id });
  await db.insert(podMembers).values([{ podId, userId: memberA.user_id }, { podId, userId: memberB.user_id }]);
  [{ id: otherPodId }] = await db.insert(pods).values({ ownerId: otherOwner.user_id, name: '__statsscope theirs', color: '#d95926' }).returning({ id: pods.id });
  await db.insert(podMembers).values([{ podId: otherPodId, userId: outsider.user_id }]);

  const pod = await get(owner, '', `?pod=${podId}`);
  const podExpected = await countFor([owner.id, memberA.user_id, memberB.user_id]);
  check('pod → 200', pod.status === 200, pod);
  check('pod → totals = you + members', pod.body.totalGames === podExpected, [pod.body.totalGames, podExpected]);
  check('pod → split self = mine, pod = members, other = 0',
    pod.body.split.self.plays === mine.body.totalGames
    && pod.body.split.pod.plays === await countFor([memberA.user_id, memberB.user_id])
    && pod.body.split.other.plays === 0, pod.body.split);
  check('pod → venuesPlayed = distinct venues of you + members', pod.body.venuesPlayed === await venuesFor([owner.id, memberA.user_id, memberB.user_id]), pod.body.venuesPlayed);
  check('pod → visits = self + pod visits', pod.body.totalVisits === pod.body.split.self.visits + pod.body.split.pod.visits);
  check('pod → mostPlayed has no other plays', pod.body.mostPlayed.every((m: any) => m.byGroup.other === 0 && m.byGroup.self + m.byGroup.pod === m.plays));
  check('pod → site-wide facts unchanged', pod.body.totalVenues === all.body.totalVenues && pod.body.totalMachinesInSystem === all.body.totalMachinesInSystem);
  check('pod → echoes the pod (id/name/color only)',
    JSON.stringify(pod.body.scope) === JSON.stringify({ kind: 'pod', pod: { id: podId, name: '__statsscope crew', color: '#2dd4bf' }, others: false }), pod.body.scope);
  check('pod → no member ids in the payload', !pod.text.includes('"userId"') && !pod.text.includes('"members"'));

  const podOthers = await get(owner, '', `?pod=${podId}&others=1`);
  check('pod+others → every number equals all', numbers(podOthers.body) === numbers(all.body));
  check('pod+others → split self + pod = pod scope, + other = all',
    podOthers.body.split.self.plays + podOthers.body.split.pod.plays === pod.body.totalGames
    && podOthers.body.split.other.plays === all.body.totalGames - pod.body.totalGames, podOthers.body.split);
  check('pod+others → mostPlayed groups add up', podOthers.body.mostPlayed.every((m: any) => m.byGroup.self + m.byGroup.pod + m.byGroup.other === m.plays));

  // ── trend history ──
  const hAll = await get(owner, '/history/total_plays', '?days=90');
  check('history all → snapshots', hAll.status === 200 && hAll.body.source === 'snapshot', hAll.body?.source);
  const hMine = await get(owner, '/history/total_plays', '?days=365&mine=true');
  check('history mine → live, ends at your total', hMine.body?.source === 'live' && last(hMine) === mine.body.totalGames, [hMine.body?.source, last(hMine), mine.body.totalGames]);
  const hPod = await get(owner, '/history/total_plays', `?days=365&pod=${podId}`);
  const hPodOthers = await get(owner, '/history/total_plays', `?days=90&pod=${podId}&others=1`);
  check('history pod+others → snapshots, same series as all',
    hPodOthers.status === 200 && hPodOthers.body.source === 'snapshot' && JSON.stringify(hPodOthers.body.points) === JSON.stringify(hAll.body.points),
    [hPodOthers.body?.source, hPodOthers.body?.points?.length, hAll.body?.points?.length]);
  check('history pod+others → still echoes the pod scope', hPodOthers.body?.scope?.kind === 'pod' && hPodOthers.body.scope.others === true, hPodOthers.body?.scope);
  const hPodOthersMachines = await get(owner, '/history/machines_with_score', `?days=90&pod=${podId}&others=1`);
  const hAllMachines = await get(owner, '/history/machines_with_score', '?days=90');
  check('history pod+others machines → snapshots too', hPodOthersMachines.body?.source === 'snapshot' && JSON.stringify(hPodOthersMachines.body.points) === JSON.stringify(hAllMachines.body.points));
  check('history pod → live, ends at the pod total', hPod.body?.source === 'live' && last(hPod) === pod.body.totalGames, [last(hPod), pod.body.totalGames]);
  const hPodVisits = await get(owner, '/history/total_visits', `?days=365&pod=${podId}`);
  check('history pod visits → ends at the pod visits', last(hPodVisits) === pod.body.totalVisits, [last(hPodVisits), pod.body.totalVisits]);
  const hPodMachines = await get(owner, '/history/machines_with_score', `?days=365&pod=${podId}`);
  check('history pod machines → ends at uniqueMachines', last(hPodMachines) === pod.body.uniqueMachines, [last(hPodMachines), pod.body.uniqueMachines]);
  const hPodMonth = await get(owner, '/history/plays', `?pod=${podId}`);
  check('history pod plays-this-month → ends at this month', last(hPodMonth) === pod.body.playHabits.playsThisMonth, [last(hPodMonth), pod.body.playHabits.playsThisMonth]);
  const venuesAll = await get(owner, '/history/total_venues', '');
  const venuesPod = await get(owner, '/history/total_venues', `?pod=${podId}`);
  check('history total_venues → snapshots in every scope', venuesPod.body?.source === 'snapshot' && JSON.stringify(venuesPod.body.points) === JSON.stringify(venuesAll.body.points));
  check('history unknown key → 404', (await get(owner, '/history/__nope', `?pod=${podId}`)).status === 404);

  // ── someone else's pod / nonexistent / malformed — identical 404s, on every endpoint ──
  const theirs = await get(owner, '', `?pod=${otherPodId}`);
  check("someone else's pod → 404 pod_not_found", theirs.status === 404 && theirs.body?.code === 'pod_not_found', theirs);
  for (const [label, path, q] of [
    ['nonexistent pod', '', '?pod=99999999'],
    ['malformed pod id', '', '?pod=abc'],
    ["someone else's pod + others", '', `?pod=${otherPodId}&others=1`],
    ["someone else's pod, history", '/history/total_plays', `?pod=${otherPodId}`],
    ["someone else's pod, site-wide history key", '/history/total_venues', `?pod=${otherPodId}`],
    ["someone else's pod, unknown history key", '/history/__nope', `?pod=${otherPodId}`],
    ['nonexistent pod, history', '/history/total_plays', '?pod=99999999'],
  ] as const) {
    const r = await get(owner, path, q);
    check(`${label} → identical 404`, r.status === 404 && r.text === theirs.text, r);
  }
  check('signed out → 401 (stats need a profile)', (await get(null, '', `?pod=${podId}`)).status === 401);
  const ownerOfOther = await get({ clerk_id: otherOwner.clerk_id }, '', `?pod=${otherPodId}`);
  check('their own pod works for them', ownerOfOther.status === 200 && ownerOfOther.body.totalGames === await countFor([otherOwner.user_id, outsider.user_id]), ownerOfOther.body?.totalGames);

  // ── All/Mine unchanged by the pods' existence (checked before the hidden venue changes the counts) ──
  const allAfter = numbers((await get(owner)).body);
  check('all unchanged after creating pods', allAfter === numbers(all.body), [allAfter, numbers(all.body)]);
  check('mine unchanged after creating pods', numbers((await get(owner, '', '?mine=true')).body) === numbers(mine.body));

  // ── hidden home venue: memberA's, switch off. memberA and otherOwner both log there. ──
  // otherOwner (non-admin) adds memberA to their pod: being in a pod reveals nothing.
  await db.insert(podMembers).values({ podId: otherPodId, userId: memberA.user_id });
  const asOther = { clerk_id: otherOwner.clerk_id };
  const before: Record<string, any> = {};
  const scopesFor = ['', '?mine=true', `?pod=${otherPodId}`, `?pod=${otherPodId}&others=1`];
  for (const q of scopesFor) before[q] = (await get(asOther, '', q)).body;
  const trendBefore = last(await get(asOther, '/history/total_plays', `?days=365&pod=${otherPodId}`));
  const outsiderBefore = (await get({ clerk_id: outsider.clerk_id }, '', '')).body.totalGames;
  const memberMineBefore = (await get({ clerk_id: memberA.clerk_id }, '', '?mine=true')).body.totalGames;

  // Home 1: memberA and otherOwner both log there. Home 2: only memberA does.
  const memberVenuesBefore = (await get({ clerk_id: memberA.clerk_id }, '', '?mine=true')).body.venuesPlayed;
  const [{ id: anyMachine }] = rowsOf(await db.execute(sql`SELECT machine_id AS id FROM scores LIMIT 1`));
  for (const [name, loggers] of [['__statsscope hidden home', [memberA, otherOwner]], ['__statsscope hidden home 2', [memberA]]] as const) {
    const [{ id: venueId }] = await db.insert(venues).values({
      name, isResidence: true, privacyTier: 'hidden', showMachinesAndScores: false, ownerId: memberA.user_id,
    } as any).returning({ id: venues.id });
    hiddenVenueIds.push(venueId);
    for (const u of loggers) {
      const [{ id }] = await db.insert(scores).values({
        userId: u.user_id, machineId: anyMachine, score: 123456789, playedAt: new Date(), venueId, venueName: name,
      } as any).returning({ id: scores.id });
      hiddenScoreIds.push(id);
    }
  }

  for (const q of scopesFor) {
    const r = await get(asOther, '', q);
    check(`hidden venue, non-admin pod owner ${q || '(all)'} → only their own new score counted`,
      r.status === 200 && r.body.totalGames === before[q].totalGames + 1, [before[q].totalGames, r.body?.totalGames]);
  }
  for (const q of scopesFor) {
    const r = await get(asOther, '', q);
    check(`hidden venues, non-admin pod owner ${q || '(all)'} → venuesPlayed +1 (the home they logged at; not the member-only one)`,
      r.body?.venuesPlayed === before[q].venuesPlayed + 1, [before[q].venuesPlayed, r.body?.venuesPlayed]);
    check(`hidden venues ${q || '(all)'} → the member-only home's name never appears`, !r.text.includes('__statsscope hidden home 2'));
  }
  check('hidden venues → their owner counts both', (await get({ clerk_id: memberA.clerk_id }, '', '?mine=true')).body.venuesPlayed === memberVenuesBefore + 2);
  const podAfter = (await get(asOther, '', `?pod=${otherPodId}`)).body;
  check("hidden venue → member's hidden score not in the pod split", podAfter.split.pod.plays === before[`?pod=${otherPodId}`].split.pod.plays, podAfter.split);
  const trendAfter = last(await get(asOther, '/history/total_plays', `?days=365&pod=${otherPodId}`));
  check('hidden venue → live pod trend counts only their own', trendAfter === trendBefore + 1, [trendBefore, trendAfter]);
  check('hidden venue → its author still counts their own', (await get({ clerk_id: memberA.clerk_id }, '', '?mine=true')).body.totalGames === memberMineBefore + 2);
  const outsiderAll = (await get({ clerk_id: outsider.clerk_id }, '', '')).body.totalGames;
  check('hidden venue → unrelated user counts neither', outsiderAll === outsiderBefore, [outsiderBefore, outsiderAll]);
  if (owner.role === 'admin') console.log('note: helmhead is an admin — admins see hidden scores by design, so the hidden checks use a non-admin pod owner');

} finally {
  if (hiddenScoreIds.length) await db.delete(scores).where(inArray(scores.id, hiddenScoreIds));
  if (hiddenVenueIds.length) await db.delete(venues).where(inArray(venues.id, hiddenVenueIds));
  const created = await db.select({ id: pods.id }).from(pods).where(like(pods.name, '\\_\\_statsscope%'));
  if (created.length) await db.delete(pods).where(inArray(pods.id, created.map(p => p.id)));
  const leftover = await db.select({ id: pods.id }).from(pods).where(like(pods.name, '\\_\\_statsscope%'));
  const leftoverVenues = await db.select({ id: venues.id }).from(venues).where(like(venues.name, '\\_\\_statsscope%'));
  console.log(`cleanup: ${leftover.length} test pods, ${leftoverVenues.length} test venues left`);
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
