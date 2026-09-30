// End-to-end check of /api/challenges, the score hook + lock in /api/scores, the daily sweep and
// /api/notifications "Clear all", against the Neon DEV branch.
//
// Mounts the real routers on a throwaway express app behind a stub that plays the part of auth:
// it sets req.appUser (what requireAppUser leaves for the challenges/notifications routers, mounted
// behind it in index.ts) and a req.auth() that answers the test user's clerk id (what clerkMiddleware
// leaves for the scores router's own requireAppUser). The route logic, SQL, row locks and
// constraints all run for real without Clerk session tokens. The sweep is called as the function the
// cron route calls (index.ts can't be imported here — it listens on 3001).
//
// Borrows three existing users that are in no friendship and no challenge yet (so it never disturbs
// seeded data), makes two of them friends, and works on three throwaway `zz-challenge-test` machines.
// At the end it deletes every challenge among those users, the scores on the throwaway machines,
// the machines, the friendship it made, and every notification it raised for them. The venue-lock
// checks use three throwaway `zz-challenge-test` venues (one "Pinball Map linked" through a fake
// location id whose roster is planted in pm_location_cache, so no network call), removed at the end.
// Challenge recs (feature/challenge-recs): decline reasons, counter-offers (incl. a counter of a
// counter), /api/me/challenge-prefs and /api/challenges/recommendations — privacy (someone else's
// hidden residence, the "at home" label, hidden-score exclusion from level 3) and zero Pinball Map
// calls — plus the profile's challengeMe field, using two more throwaway machines and two throwaway
// residences. The borrowed users' challenge prefs / seeded_at are restored at the end.
//
//   cd artifacts/api-server && npx tsx test-challenges.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as migrate15.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { default: express } = await import('express');
const { readFileSync } = await import('node:fs');
const { default: challengesRouter } = await import('./src/routes/challenges.js');
const { default: notificationsRouter } = await import('./src/routes/notifications.js');
const { default: scoresRouter } = await import('./src/routes/scores.js');
const { default: meRouter } = await import('./src/routes/me.js');
const { default: usersRouter } = await import('./src/routes/users.js');
const { runChallengeSweep } = await import('./src/lib/challenges.js');
const { pmClient } = await import('./src/lib/pmClient.js');
const {
  db, users, friendships, notifications, challenges, challengeParticipants, challengeScores, scores, machines, venues, venueMachineHistory,
  pmLocationCache, venueInventory, userChallengeMachines, userChallengeVenues, activityEvents,
} = await import('@workspace/db');
const { and, desc, eq, inArray, or, sql } = await import('drizzle-orm');

const H = 60 * 60 * 1000;
const PHOTO = 'data:image/jpeg;base64,/9j/zz-challenge-test';

const people = await db.select().from(users)
  .where(sql`NOT EXISTS (SELECT 1 FROM friendships f WHERE f.requester_id = ${users.id} OR f.addressee_id = ${users.id})
    AND NOT EXISTS (SELECT 1 FROM challenge_participants cp WHERE cp.user_id = ${users.id})`)
  .orderBy(desc(users.id)).limit(3);
if (people.length < 3) throw new Error('Need at least 3 users with no friendships or challenges in the dev DB');
const [alice, bob, carol] = people;
const ids = people.map(p => p.id);

// Refuse to run the sweep's retention step over anyone else's data.
const [{ foreign }] = await db.select({ foreign: sql<number>`count(*)::int` }).from(notifications)
  .where(sql`read_at IS NOT NULL AND created_at < now() - interval '30 days'`);
if (foreign > 0) throw new Error(`${foreign} read notifications older than 30 days already exist on dev — the sweep would delete them. Aborting.`);

const [privateVenue] = await db.select({ id: venues.id }).from(venues)
  .where(sql`privacy_tier <> 'full' OR is_residence`).limit(1);

// Challenge prefs the borrowed users already have (normally none) — restored at the end.
const prefsBefore = {
  seeded: await db.select({ id: users.id, at: users.challengeVenuesSeededAt }).from(users).where(inArray(users.id, ids)),
  machines: await db.select().from(userChallengeMachines).where(inArray(userChallengeMachines.userId, ids)),
  venues: await db.select().from(userChallengeVenues).where(inArray(userChallengeVenues.userId, ids)),
};

const app = express();
app.use(express.json());
const stub = (req: any, _res: any, next: any) => {
  const u = people.find(p => p.id === Number(req.header('x-test-user')));
  req.appUser = u;
  req.auth = () => ({ userId: u?.clerkId ?? null, tokenType: 'session_token', sessionClaims: {} });
  next();
};
app.use('/api/challenges', stub, challengesRouter);
app.use('/api/notifications', stub, notificationsRouter);
app.use('/api/scores', stub, scoresRouter);
app.use('/api/me', stub, meRouter);
app.use('/api/users', stub, usersRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function call(as: { id: number } | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(as ? { 'x-test-user': String(as.id) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let failures = 0, passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 600)}`}`);
}

const inbox = async (who: { id: number }) => ((await call(who, 'GET', '/notifications?limit=50')).body?.items ?? []) as any[];
const kinds = async (who: { id: number }, challengeId: number) =>
  (await inbox(who)).filter(n => n.payload?.challengeId === challengeId).map(n => n.kind as string);
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const setWindow = (id: number, startsAt: Date | null, endsAt: Date) =>
  db.update(challenges).set({ startsAt, endsAt }).where(eq(challenges.id, id));

let machineIds: number[] = [];
let venueIds: number[] = [];
let friendshipId: number | null = null;
// A Pinball Map location id no real venue uses (checked below), for the planted roster.
const FAKE_PM_ID = 2_147_000_000 + Math.floor(Math.random() * 400_000);

try {
  // ── fixtures ───────────────────────────────────────────────────────────────
  const made = await db.insert(machines).values([
    { name: 'zz-challenge-test (Pro)', opdbId: 'GzzT1-Mpro1' },
    { name: 'zz-challenge-test (Premium)', opdbId: 'GzzT1-Mprm2-Aabc3' },
    { name: 'zz-challenge-test other', opdbId: null },
  ]).returning({ id: machines.id });
  machineIds = made.map(m => m.id);
  const [PRO, PREM, OTHER] = machineIds;
  const [pmClash] = await db.select({ id: venues.id }).from(venues).where(eq(venues.pinballMapId, FAKE_PM_ID)).limit(1);
  if (pmClash) throw new Error(`Fake Pinball Map id ${FAKE_PM_ID} is taken — rerun`);
  // HIST: machine history says the Premium is there (and the "other" machine was, but was removed).
  // PLAYED: no history, but alice logged a score on the "other" machine there.
  // PMV: "linked" to Pinball Map; its (planted, fresh) roster lists the Pro.
  const madeVenues = await db.insert(venues).values([
    { name: 'zz-challenge-test venue (history)' },
    { name: 'zz-challenge-test venue (played)' },
    { name: 'zz-challenge-test venue (pinball map)', pinballMapId: FAKE_PM_ID },
  ]).returning({ id: venues.id, name: venues.name });
  venueIds = madeVenues.map(v => v.id);
  const [HIST, PLAYED, PMV] = madeVenues;
  await db.insert(venueMachineHistory).values([
    { venueId: HIST.id, machineId: PREM },
    { venueId: HIST.id, machineId: OTHER, removedAt: new Date() },
  ]);
  await db.insert(scores).values({ userId: alice.id, machineId: OTHER, venueId: PLAYED.id, venueName: PLAYED.name, score: 1234, playedAt: new Date(Date.now() - 20 * 24 * H), createdAt: new Date(Date.now() - 20 * 24 * H) });
  await db.insert(pmLocationCache).values({ pmLocationId: FAKE_PM_ID, machines: [{ id: 0, machine: { id: 0, name: 'zz-challenge-test (Pro)' } }], fetchedAt: new Date() });

  const [f] = await db.insert(friendships).values({ requesterId: alice.id, addresseeId: bob.id, status: 'accepted', respondedAt: new Date() }).returning({ id: friendships.id });
  friendshipId = f.id;

  const post = (who: typeof alice, body: Record<string, unknown>) => call(who, 'POST', '/challenges', { endsAt: iso(48 * H), machineId: PRO, ...body });
  const upload = (who: typeof alice, body: Record<string, unknown>) =>
    call(who, 'POST', '/scores', { machineId: PRO, playedAt: new Date().toISOString(), photoThumbnail: PHOTO, ...body });

  // ── creation validation ────────────────────────────────────────────────────
  let r = await post(alice, { friendId: carol.id, type: 'high_score' });
  check('challenge a non-friend → 403 not_friends', r.status === 403 && r.body?.code === 'not_friends', r);
  r = await post(alice, { friendId: alice.id, type: 'high_score' });
  check('challenge yourself → 400', r.status === 400 && r.body?.code === 'cannot_challenge_self', r);
  r = await post(alice, { friendUsername: 'zz-nobody-here', type: 'high_score' });
  check('unknown username → 404 user_not_found', r.status === 404 && r.body?.code === 'user_not_found', r);
  r = await post(alice, { friendId: bob.id, type: 'darts' });
  check('bad type → 400 invalid_type', r.status === 400 && r.body?.code === 'invalid_type', r);
  r = await post(alice, { friendId: bob.id, type: 'high_score', endsAt: iso(-H) });
  check('end in the past → 400 invalid_window', r.status === 400 && r.body?.code === 'invalid_window', r);
  r = await post(alice, { friendId: bob.id, type: 'high_score', endsAt: iso(91 * 24 * H) });
  check('longer than 90 days → 400 invalid_window', r.status === 400 && r.body?.code === 'invalid_window', r);
  r = await post(alice, { friendId: bob.id, type: 'average' });
  check('average without minPlays → 400 invalid_min_plays', r.status === 400 && r.body?.code === 'invalid_min_plays', r);
  r = await post(alice, { friendId: bob.id, type: 'race' });
  check('race with no target and no score to beat → 400 race_target_required', r.status === 400 && r.body?.code === 'race_target_required', r);
  r = await post(alice, { friendId: bob.id, type: 'most_improved' });
  check('most_improved with no prior score → 409 no_baseline', r.status === 409 && r.body?.code === 'no_baseline', r);
  r = await post(alice, { friendId: bob.id, type: 'high_score', machineId: 999999999 });
  check('unknown machine → 404 machine_not_found', r.status === 404 && r.body?.code === 'machine_not_found', r);
  if (privateVenue) {
    r = await post(alice, { friendId: bob.id, type: 'high_score', venueId: privateVenue.id });
    check('lock to a private venue → 400 venue_private', r.status === 400 && r.body?.code === 'venue_private', r);
  }

  // ── venue lock: the venue must have the machine ────────────────────────────
  const lockTo = async (label: string, venueId: number, body: Record<string, unknown>, ok: boolean) => {
    const res = await post(alice, { friendId: bob.id, type: 'high_score', venueId, ...body });
    check(label, ok ? res.status === 201 && res.body?.venue?.id === venueId : res.status === 400 && res.body?.code === 'machine_not_at_venue', res);
    if (res.status === 201) await call(alice, 'POST', `/challenges/${res.body.id}/cancel`);
  };
  await lockTo('venue lock, game mode: another model of the game there (history) → 201', HIST.id, { matchMode: 'game' }, true);
  await lockTo('venue lock, exact mode: only another model there → 400 machine_not_at_venue', HIST.id, { matchMode: 'exact' }, false);
  await lockTo('venue lock: machine history marked removed → 400', HIST.id, { machineId: OTHER, matchMode: 'exact' }, false);
  await lockTo('venue lock: a score on the machine there → 201', PLAYED.id, { machineId: OTHER, matchMode: 'exact' }, true);
  await lockTo('venue lock: nothing shows the machine there → 400', PLAYED.id, { matchMode: 'exact' }, false);
  await lockTo('venue lock: Pinball Map roster lists it → 201', PMV.id, { matchMode: 'exact' }, true);
  await lockTo('venue lock: Pinball Map roster lacks it → 400', PMV.id, { machineId: OTHER, matchMode: 'exact' }, false);
  const optionIds = async (machineId: number | string, matchMode: string) =>
    new Set(((await call(alice, 'GET', `/challenges/venue-options?machineId=${machineId}&matchMode=${matchMode}`)).body ?? []).map((v: any) => v.id));
  let opts = await optionIds(PRO, 'game');
  check('venue options (Pro, game): history + Pinball Map venues, not the other', opts.has(HIST.id) && opts.has(PMV.id) && !opts.has(PLAYED.id), [...opts]);
  opts = await optionIds(PRO, 'exact');
  check('venue options (Pro, exact): Pinball Map venue only', opts.has(PMV.id) && !opts.has(HIST.id) && !opts.has(PLAYED.id), [...opts]);
  opts = await optionIds(OTHER, 'exact');
  check('venue options (other): where it was played, not where it was removed', opts.has(PLAYED.id) && !opts.has(HIST.id) && !opts.has(PMV.id), [...opts]);
  if (privateVenue) {
    const [privMachine] = await db.select({ machineId: scores.machineId }).from(scores).where(eq(scores.venueId, privateVenue.id)).limit(1);
    if (privMachine) {
      opts = await optionIds(privMachine.machineId, 'exact');
      check('venue options never include a private venue', !opts.has(privateVenue.id), [...opts]);
    }
  }
  r = await call(alice, 'GET', '/challenges/venue-options?machineId=abc');
  check('venue options without a machine → 400 invalid_machine', r.status === 400 && r.body?.code === 'invalid_machine', r);

  // ── decline ────────────────────────────────────────────────────────────────
  r = await post(alice, { friendUsername: bob.username, type: 'high_score' });
  check('create → 201 pending, starts on acceptance', r.status === 201 && r.body?.status === 'pending' && r.body?.startsAt === null && r.body?.matchGroup === 'GzzT1', r);
  let cid = r.body.id;
  check('creator view: can cancel, not accept', r.body?.me?.canCancel === true && r.body?.me?.canAccept === false, r.body?.me);
  check('bob got challenge_received', (await kinds(bob, cid)).includes('challenge_received'));
  r = await call(bob, 'GET', `/challenges/${cid}`);
  check('bob view: can accept/decline', r.body?.me?.canAccept && r.body?.me?.canDecline && !r.body?.me?.canCancel, r.body?.me);
  r = await call(carol, 'GET', `/challenges/${cid}`);
  check('privacy: a stranger gets 404 challenge_not_found', r.status === 404 && r.body?.code === 'challenge_not_found', r);
  r = await call(carol, 'POST', `/challenges/${cid}/accept`);
  check('privacy: a stranger cannot accept → 404', r.status === 404, r);
  r = await call(alice, 'POST', `/challenges/${cid}/accept`);
  check('creator cannot accept own → 409 cannot_accept', r.status === 409 && r.body?.code === 'cannot_accept', r);
  r = await call(carol, 'GET', '/challenges');
  check('stranger list does not include it', Array.isArray(r.body) && !r.body.some((c: any) => c.id === cid), r.body);
  r = await call(bob, 'GET', '/challenges?status=pending');
  check('bob pending list includes it', r.body?.some((c: any) => c.id === cid), r.body);
  r = await call(bob, 'POST', `/challenges/${cid}/decline`);
  check('bob declines → declined', r.status === 200 && r.body?.status === 'declined', r);
  check('alice got challenge_declined', (await kinds(alice, cid)).includes('challenge_declined'));
  check("bob's received marked read", (await inbox(bob)).filter(n => n.payload?.challengeId === cid && n.kind === 'challenge_received').every(n => n.readAt));
  r = await call(bob, 'POST', `/challenges/${cid}/accept`);
  check('accept after decline → 409', r.status === 409, r);
  r = await call(bob, 'GET', '/challenges?status=history');
  check('declined shows in history', r.body?.some((c: any) => c.id === cid && c.status === 'declined'), r.body);

  // ── cancel ─────────────────────────────────────────────────────────────────
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  cid = r.body.id;
  r = await call(bob, 'POST', `/challenges/${cid}/cancel`);
  check('invitee cannot cancel → 409 cannot_cancel', r.status === 409 && r.body?.code === 'cannot_cancel', r);
  r = await call(alice, 'POST', `/challenges/${cid}/cancel`);
  check('creator cancels → cancelled', r.status === 200 && r.body?.status === 'cancelled', r);
  let k = await kinds(bob, cid);
  check('bob: unread received removed, challenge_cancelled raised', !k.includes('challenge_received') && k.includes('challenge_cancelled'), k);
  r = await call(bob, 'POST', `/challenges/${cid}/accept`);
  check('accept a cancelled challenge → 409', r.status === 409, r);

  // ── expire (unanswered past its chosen start) ──────────────────────────────
  r = await post(alice, { friendId: bob.id, type: 'high_score', startsAt: iso(2 * H), endsAt: iso(30 * H) });
  check('create with a future start', r.status === 201 && r.body?.startsAt != null, r);
  cid = r.body.id;
  await setWindow(cid, new Date(Date.now() - 60_000), new Date(Date.now() + 30 * H));
  let sweep = await runChallengeSweep();
  r = await call(bob, 'GET', `/challenges/${cid}`);
  check('sweep expires it (start passed unanswered)', r.body?.status === 'expired' && sweep.expired >= 1, { r: r.body?.status, sweep });
  r = await call(bob, 'POST', `/challenges/${cid}/accept`);
  check('accept an expired challenge → 409', r.status === 409, r);

  // Lazy expiry on read: end passed, no sweep.
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  cid = r.body.id;
  await setWindow(cid, null, new Date(Date.now() - 60_000));
  r = await call(alice, 'GET', '/challenges?status=history');
  check('lazy read expires a pending one whose end passed', r.body?.some((c: any) => c.id === cid && c.status === 'expired'), r.body?.map((c: any) => [c.id, c.status]));

  // ── forfeit ────────────────────────────────────────────────────────────────
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  cid = r.body.id;
  r = await call(bob, 'POST', `/challenges/${cid}/accept`);
  check('accept → active, window starts now', r.status === 200 && r.body?.status === 'active' && r.body?.phase === 'live' && r.body?.startsAt != null, r.body);
  check('alice got challenge_accepted', (await kinds(alice, cid)).includes('challenge_accepted'));
  r = await call(alice, 'POST', `/challenges/${cid}/cancel`);
  check('cannot cancel once active → 409', r.status === 409, r);
  r = await call(bob, 'POST', `/challenges/${cid}/forfeit`);
  const byUser = (b: any) => Object.fromEntries((b?.participants ?? []).map((p: any) => [p.user.id, p.outcome]));
  check('bob forfeits → resolved, alice win, bob forfeit', r.body?.status === 'resolved' && byUser(r.body)[alice.id] === 'win' && byUser(r.body)[bob.id] === 'forfeit', r.body);
  check('both got challenge_result', (await kinds(alice, cid)).includes('challenge_result') && (await kinds(bob, cid)).includes('challenge_result'));
  r = await call(bob, 'POST', `/challenges/${cid}/forfeit`);
  check('forfeit twice → 409', r.status === 409, r);

  // ── nobody played (deadline via sweep): abandoned, not void (void is retired) ─
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  cid = r.body.id;
  await call(bob, 'POST', `/challenges/${cid}/accept`);
  await setWindow(cid, new Date(Date.now() - 3 * H), new Date(Date.now() - 60_000));
  sweep = await runChallengeSweep();
  r = await call(alice, 'GET', `/challenges/${cid}`);
  check('sweep resolves past-deadline, nobody played: abandoned (not void), both abandoned', r.body?.status === 'resolved'
    && r.body?.void === false && r.body?.abandoned === true
    && byUser(r.body)[alice.id] === 'abandoned' && byUser(r.body)[bob.id] === 'abandoned' && sweep.resolved >= 1, { body: r.body, sweep });
  const noPlayResult = (await inbox(bob)).filter(n => n.payload?.challengeId === cid && n.kind === 'challenge_result');
  check('nobody played: challenge_result says abandoned, void false', noPlayResult.length === 1
    && noPlayResult[0].payload.outcome === 'abandoned' && noPlayResult[0].payload.abandoned === true && noPlayResult[0].payload.void === false, noPlayResult);

  // ── high score: counting rules, notifications, lock, deadline ──────────────
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  const hs = r.body.id;
  await call(bob, 'POST', `/challenges/${hs}/accept`);
  let s = await upload(alice, { score: 50_000 });
  check('alice uploads (photo, in window) → 201', s.status === 201, s);
  const aliceScore = s.body.id;
  check('it is locked (challenge_scores row)', (await db.select().from(challengeScores).where(and(eq(challengeScores.challengeId, hs), eq(challengeScores.scoreId, aliceScore)))).length === 1);
  let bn = (await inbox(bob)).filter(n => n.payload?.challengeId === hs && n.kind === 'challenge_opponent_scored');
  check('bob got challenge_opponent_scored with the score', bn.length === 1 && bn[0].payload.score === 50_000 && bn[0].payload.userId === alice.id, bn);
  s = await upload(alice, { score: 60_000, machineId: PREM });
  check('a Premium-model score counts in game mode', (await db.select().from(challengeScores).where(eq(challengeScores.scoreId, s.body.id))).length === 1);
  bn = (await inbox(bob)).filter(n => n.payload?.challengeId === hs && n.kind === 'challenge_opponent_scored' && !n.readAt);
  check('opponent_scored deduped: one unread, carrying the latest score', bn.length === 1 && bn[0].payload.score === 60_000, bn);
  s = await upload(bob, { score: 99_000_000, playedAt: new Date(Date.now() - 3 * H).toISOString() });
  const backdated = s.body.id;
  s = await upload(bob, { score: 88_000_000, photoThumbnail: undefined });
  const noPhoto = s.body.id;
  s = await upload(bob, { score: 77_000_000, machineId: OTHER });
  const otherMachine = s.body.id;
  s = await upload(bob, { score: 40_000 });
  const bobCounting = s.body.id;
  const locked = new Set((await db.select({ id: challengeScores.scoreId }).from(challengeScores).where(eq(challengeScores.challengeId, hs))).map(x => x.id));
  check('backdated score does not count', !locked.has(backdated));
  check('score without a photo does not count', !locked.has(noPhoto));
  check('score on another machine does not count', !locked.has(otherMachine));
  check("bob's real score counts", locked.has(bobCounting));
  // Uploaded after the window (played inside it): created_at pushed past the end by hand, then the
  // lock row the upload hook wrote (it counted for that instant) removed.
  s = await upload(bob, { score: 66_000_000 });
  const lateUpload = s.body.id;
  const [hsWin] = await db.select({ startsAt: challenges.startsAt, endsAt: challenges.endsAt }).from(challenges).where(eq(challenges.id, hs));
  await db.update(scores).set({ playedAt: new Date(+hsWin.startsAt! + 1000), createdAt: new Date(+hsWin.endsAt + H) }).where(eq(scores.id, lateUpload));
  await db.delete(challengeScores).where(eq(challengeScores.scoreId, lateUpload));

  r = await call(alice, 'GET', `/challenges/${hs}`);
  const standing = (b: any, u: number) => b?.participants?.find((p: any) => p.user.id === u)?.standing;
  check('detail: live standings (alice leads)', standing(r.body, alice.id)?.bestScore === 60_000 && standing(r.body, alice.id)?.liveRank === 1
    && standing(r.body, alice.id)?.countingCount === 2, r.body?.participants);
  check('detail: timeLeftMs and per-participant scores', r.body?.timeLeftMs > 0 && Array.isArray(r.body?.participants?.[0]?.scores), r.body);

  r = await call(alice, 'PATCH', `/scores/${aliceScore}`, { score: 1 });
  check('lock: editing a counted score → 409 score_locked_by_challenge', r.status === 409 && r.body?.code === 'score_locked_by_challenge', r);
  r = await call(alice, 'DELETE', `/scores/${aliceScore}`);
  check('lock: deleting a counted score → 409', r.status === 409 && r.body?.code === 'score_locked_by_challenge', r);
  r = await call(bob, 'DELETE', `/scores/${noPhoto}`);
  check('a non-counting score can still be deleted → 204', r.status === 204, r);

  // Deadline: pull the end in to just now (the late upload stays created after it).
  await setWindow(hs, hsWin.startsAt, new Date(Date.now() - 1000));
  sweep = await runChallengeSweep();
  r = await call(bob, 'GET', `/challenges/${hs}`);
  check('deadline: alice wins high score (late upload ignored)', r.body?.status === 'resolved' && byUser(r.body)[alice.id] === 'win' && byUser(r.body)[bob.id] === 'loss', r.body?.participants);
  check('late upload (created after the end) did not count', !(await db.select().from(challengeScores).where(eq(challengeScores.scoreId, lateUpload))).length);
  const results = (await inbox(alice)).filter(n => n.payload?.challengeId === hs && n.kind === 'challenge_result');
  check('alice got challenge_result: win', results.length === 1 && results[0].payload.outcome === 'win', results);

  // ── race: resolves on upload ───────────────────────────────────────────────
  r = await post(alice, { friendId: bob.id, type: 'race', targetScore: 5000, matchMode: 'exact' });
  check('race with explicit target', r.status === 201 && r.body?.targetScore === 5000 && r.body?.matchGroup === null, r.body);
  const race = r.body.id;
  await call(bob, 'POST', `/challenges/${race}/accept`);
  await upload(bob, { score: 6000, machineId: PREM });
  r = await call(bob, 'GET', `/challenges/${race}`);
  check('exact mode: the Premium model does not count, still active', r.body?.status === 'active', r.body?.status);
  await upload(alice, { score: 4000 });
  r = await call(bob, 'GET', `/challenges/${race}`);
  check('below target: still active', r.body?.status === 'active');
  await upload(bob, { score: 7000 });
  const [raceRow] = await db.select().from(challenges).where(eq(challenges.id, race));
  check('race resolves immediately on the upload (no read needed)', raceRow.status === 'resolved', raceRow);
  r = await call(alice, 'GET', `/challenges/${race}`);
  check('race: bob win, alice loss', byUser(r.body)[bob.id] === 'win' && byUser(r.body)[alice.id] === 'loss', r.body?.participants);
  // bob's only counting upload was the winning one: alice gets the result, not an opponent_scored.
  check('no opponent_scored for the winning upload (result instead)', !(await kinds(alice, race)).includes('challenge_opponent_scored')
    && (await kinds(alice, race)).includes('challenge_result'), await kinds(alice, race));

  // Race default target = creator's best ("beat my score").
  r = await post(alice, { friendId: bob.id, type: 'race' });
  check('race default target = creator best on the machine (60,000 on the Premium, game mode)', r.status === 201 && r.body?.targetScore === 60_000, r.body);
  await call(alice, 'POST', `/challenges/${r.body.id}/cancel`);

  // ── race: equalling the target is not a finish; nobody finishing → abandoned ─
  r = await post(alice, { friendId: bob.id, type: 'race', targetScore: 5000, matchMode: 'exact' });
  const abandonedRace = r.body.id;
  await call(bob, 'POST', `/challenges/${abandonedRace}/accept`);
  s = await upload(alice, { score: 5000 });
  check('race: a score exactly equal to the target counts (locked)', (await db.select().from(challengeScores)
    .where(and(eq(challengeScores.challengeId, abandonedRace), eq(challengeScores.scoreId, s.body.id)))).length === 1);
  r = await call(bob, 'GET', `/challenges/${abandonedRace}`);
  check('race: equalling the target does not win — still active, not qualified', r.body?.status === 'active'
    && standing(r.body, alice.id)?.qualified === false && standing(r.body, alice.id)?.reachedTargetAt === null, r.body);
  const [arRow] = await db.select({ startsAt: challenges.startsAt }).from(challenges).where(eq(challenges.id, abandonedRace));
  await setWindow(abandonedRace, arRow.startsAt, new Date(Date.now() - 500));
  await runChallengeSweep();
  r = await call(alice, 'GET', `/challenges/${abandonedRace}`);
  check('race nobody beat: resolved, abandoned (not void), both abandoned — bob too, who never played', r.body?.status === 'resolved'
    && r.body?.abandoned === true && r.body?.void === false
    && byUser(r.body)[alice.id] === 'abandoned' && byUser(r.body)[bob.id] === 'abandoned' && r.body?.me?.outcome === 'abandoned', r.body);
  const abandonedResult = (await inbox(bob)).filter(n => n.payload?.challengeId === abandonedRace && n.kind === 'challenge_result');
  check('challenge_result carries outcome abandoned + abandoned: true', abandonedResult.length === 1
    && abandonedResult[0].payload.outcome === 'abandoned' && abandonedResult[0].payload.abandoned === true && abandonedResult[0].payload.void === false, abandonedResult);
  r = await call(alice, 'GET', `/challenges/${race}`);
  check('a normally won race is not abandoned', r.body?.abandoned === false, r.body?.abandoned);

  // ── most improved ──────────────────────────────────────────────────────────
  await db.insert(scores).values([
    { userId: alice.id, machineId: PRO, score: 100_000, playedAt: new Date(Date.now() - 10 * 24 * H), createdAt: new Date(Date.now() - 10 * 24 * H) },
  ]);
  r = await post(alice, { friendId: bob.id, type: 'most_improved' });
  check('most_improved: creator has a baseline → 201', r.status === 201, r);
  const mi = r.body.id;
  // bob has scores on the machine, but all from today (inside no window yet): played "before start"
  // only once the window starts at acceptance, so he has a baseline too (his earlier uploads).
  r = await call(bob, 'POST', `/challenges/${mi}/accept`);
  check('most_improved accept with a prior score → active, baselines frozen', r.body?.status === 'active'
    && r.body?.participants?.every((p: any) => p.baselineScore != null), r.body?.participants);
  const baseOf = (u: number) => r.body.participants.find((p: any) => p.user.id === u).baselineScore;
  check('alice baseline = best before the window (the 100,000 from 10 days ago)', baseOf(alice.id) === 100_000, baseOf(alice.id));
  await new Promise(res => setTimeout(res, 1100));
  await upload(alice, { score: 150_000 });                // +50%
  await upload(bob, { score: baseOf(bob.id) * 2 });       // +100%
  const [miRow] = await db.select({ startsAt: challenges.startsAt }).from(challenges).where(eq(challenges.id, mi));
  await setWindow(mi, miRow.startsAt, new Date(Date.now() - 500));
  r = await call(alice, 'GET', `/challenges/${mi}`);
  check('most_improved resolves lazily on read: bob (+100%) beats alice (+50%)', r.body?.status === 'resolved'
    && byUser(r.body)[bob.id] === 'win' && Math.round(r.body.participants.find((p: any) => p.user.id === alice.id).resultValue) === 50, r.body?.participants);

  // most_improved acceptance refused without a baseline: carol befriends alice for this.
  await db.insert(friendships).values({ requesterId: alice.id, addresseeId: carol.id, status: 'accepted', respondedAt: new Date() });
  r = await post(alice, { friendId: carol.id, type: 'most_improved' });
  const miCarol = r.body?.id;
  r = await call(carol, 'POST', `/challenges/${miCarol}/accept`);
  check('invitee with no prior score cannot accept most_improved → 409 no_baseline', r.status === 409 && r.body?.code === 'no_baseline', r);
  await call(alice, 'POST', `/challenges/${miCarol}/cancel`);

  // ── average ────────────────────────────────────────────────────────────────
  // Locked to the history venue: game mode, and only the Premium is there — that's enough.
  const [lockVenue] = await db.select({ id: venues.id, name: venues.name }).from(venues).where(eq(venues.id, venueIds[0]));
  r = await post(alice, { friendId: bob.id, type: 'average', minPlays: 3, venueId: lockVenue.id });
  check('average with min plays + venue lock', r.status === 201 && r.body?.minPlays === 3 && r.body?.venue?.id === lockVenue.id, r.body);
  const avg = r.body.id;
  await call(bob, 'POST', `/challenges/${avg}/accept`);
  const atVenue = { venueId: lockVenue.id, venueName: lockVenue.name };
  for (const v of [1000, 2000, 3000]) await upload(alice, { score: v, ...atVenue });   // mean 2000, qualified
  for (const v of [9000, 9000]) await upload(bob, { score: v, ...atVenue });          // mean 9000, only 2
  await upload(bob, { score: 9000 });                                                  // no venue → doesn't count
  r = await call(alice, 'GET', `/challenges/${avg}`);
  check('average standings: alice qualified, bob not (venue-less score excluded)', standing(r.body, alice.id)?.qualified === true
    && standing(r.body, bob.id)?.qualified === false && standing(r.body, bob.id)?.countingCount === 2, r.body?.participants);
  const [avgRow] = await db.select({ startsAt: challenges.startsAt }).from(challenges).where(eq(challenges.id, avg));
  await setWindow(avg, avgRow.startsAt, new Date(Date.now() - 500));
  await runChallengeSweep();
  r = await call(alice, 'GET', `/challenges/${avg}`);
  check('average: qualified alice wins, short-of-N bob loses', byUser(r.body)[alice.id] === 'win' && byUser(r.body)[bob.id] === 'loss', r.body?.participants);

  // ── ending soon (once per participant) ─────────────────────────────────────
  r = await post(alice, { friendId: bob.id, type: 'high_score', endsAt: iso(5 * H) });
  const soon = r.body.id;
  await call(bob, 'POST', `/challenges/${soon}/accept`);
  await runChallengeSweep();
  await runChallengeSweep();
  check('ending soon: once each', (await kinds(alice, soon)).filter(x => x === 'challenge_ending_soon').length === 1
    && (await kinds(bob, soon)).filter(x => x === 'challenge_ending_soon').length === 1, [await kinds(alice, soon), await kinds(bob, soon)]);
  await call(alice, 'POST', `/challenges/${soon}/forfeit`);

  // ── records ────────────────────────────────────────────────────────────────
  r = await call(alice, 'GET', '/challenges/record');
  // alice: forfeit-win, nobody-played abandoned, hs win, race loss, race abandoned, mi loss, avg win, soon forfeit
  check('record totals for alice (voids stays 0: void is retired)', r.status === 200 && r.body?.wins === 3 && r.body?.losses === 2 && r.body?.forfeits === 1
    && r.body?.noShows === 0 && r.body?.voids === 0 && r.body?.abandoned === 2 && r.body?.ties === 0 && r.body?.played === 8, r.body);
  check('record: head-to-head vs bob', r.body?.headToHead?.[0]?.opponent?.id === bob.id && r.body?.headToHead?.[0]?.played === 8
    && r.body?.headToHead?.[0]?.abandoned === 2, r.body?.headToHead);
  check('record: streaks (the nobody-played abandon broke the first run)', r.body?.currentStreak === 0 && r.body?.bestStreak === 1, r.body);
  r = await call(carol, 'GET', `/challenges/record/${encodeURIComponent(alice.username)}`);
  check("someone else's record: totals, but head-to-head only against the viewer", r.status === 200 && r.body?.wins === 3 && r.body?.headToHead?.length === 0, r.body);
  r = await call(bob, 'GET', `/challenges/record/${encodeURIComponent(alice.username)}`);
  check('…and bob sees alice vs bob', r.body?.headToHead?.length === 1 && r.body.headToHead[0].opponent.id === bob.id, r.body?.headToHead);
  r = await call(bob, 'GET', '/challenges/record/zz-nobody-here');
  check('record for unknown user → 404', r.status === 404, r);

  // ── decline reasons ────────────────────────────────────────────────────────
  const bobPart = (b: any) => b?.participants?.find((p: any) => p.user.id === bob.id);
  const declinedWith = async (reason: string | undefined) => {
    const made = await post(alice, { friendId: bob.id, type: 'high_score' });
    const res = await call(bob, 'POST', `/challenges/${made.body.id}/decline`, reason === undefined ? undefined : { reason });
    const note = (await inbox(alice)).filter(n => n.payload?.challengeId === made.body.id && n.kind === 'challenge_declined');
    return { id: made.body.id, res, note };
  };
  let d = await declinedWith('maybe');
  check('decline with an unknown reason → 400 invalid_reason', d.res.status === 400 && d.res.body?.code === 'invalid_reason', d.res);
  await call(alice, 'POST', `/challenges/${d.id}/cancel`);
  d = await declinedWith('no_thanks');
  check('decline no_thanks → declined, reason stored', d.res.status === 200 && d.res.body?.status === 'declined' && bobPart(d.res.body)?.declineReason === 'no_thanks', d.res.body);
  check('challenge_declined carries reason no_thanks', d.note.length === 1 && d.note[0].payload.reason === 'no_thanks', d.note);
  d = await declinedWith('cant_reach');
  check('decline cant_reach → declined, reason stored + in the notification', bobPart(d.res.body)?.declineReason === 'cant_reach'
    && d.note.length === 1 && d.note[0].payload.reason === 'cant_reach', { body: d.res.body, note: d.note });
  const [declEvent] = await db.select({ payload: activityEvents.payload }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.declined'), eq(activityEvents.targetId, String(d.id))));
  check('challenge.declined activity carries the reason', (declEvent?.payload as any)?.reason === 'cant_reach', declEvent);
  d = await declinedWith(undefined);
  check('decline without a reason → declined, reason null', d.res.status === 200 && bobPart(d.res.body)?.declineReason === null
    && d.note.length === 1 && d.note[0].payload.reason === null, { body: d.res.body, note: d.note });

  // ── counter-offers ─────────────────────────────────────────────────────────
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  const orig = r.body.id;
  const counterBody = { machineId: OTHER, type: 'high_score', matchMode: 'exact', endsAt: iso(72 * H) };
  r = await call(bob, 'POST', `/challenges/${orig}/counter`, { ...counterBody, type: 'darts' });
  check('counter with a bad body → 400 invalid_type', r.status === 400 && r.body?.code === 'invalid_type', r);
  let [origRow] = await db.select().from(challenges).where(eq(challenges.id, orig));
  let kids = await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.counteredFromId, orig));
  check('…nothing written: original still pending, no counter row', origRow.status === 'pending' && kids.length === 0, { origRow, kids });
  r = await call(alice, 'POST', `/challenges/${orig}/counter`, counterBody);
  check('the creator cannot counter their own → 409 cannot_counter', r.status === 409 && r.body?.code === 'cannot_counter', r);
  r = await call(carol, 'POST', `/challenges/${orig}/counter`, counterBody);
  check('a stranger cannot counter → 404', r.status === 404 && r.body?.code === 'challenge_not_found', r);
  r = await call(bob, 'GET', `/challenges/${orig}`);
  check('invitee view: canCounter', r.body?.me?.canCounter === true, r.body?.me);
  r = await call(bob, 'POST', `/challenges/${orig}/counter`, { ...counterBody, friendId: carol.id });
  check('bob counters (a friend in the body is ignored) → 201', r.status === 201 && r.body?.counter?.id > 0, r);
  const ctr = r.body?.counter ?? {};
  check('original: countered, links to the counter', r.body?.original?.status === 'countered' && r.body?.original?.phase === 'countered'
    && r.body?.original?.counteredToId === ctr.id, r.body?.original);
  check('counter: pending, created by bob, against alice, links back, exact machine', ctr.status === 'pending' && ctr.creatorId === bob.id
    && ctr.opponent?.id === alice.id && ctr.counteredFromId === orig && ctr.machine?.id === OTHER && ctr.matchGroup === null, ctr);
  const [bp] = await db.select().from(challengeParticipants).where(and(eq(challengeParticipants.challengeId, orig), eq(challengeParticipants.userId, bob.id)));
  check('bob on the original: response countered, reason cant_reach', bp?.response === 'countered' && bp?.declineReason === 'cant_reach', bp);
  const an = (await inbox(alice)).filter(n => n.payload?.challengeId === ctr.id);
  check('alice got challenge_countered (not a separate challenge_received)', an.length === 1 && an[0].kind === 'challenge_countered'
    && an[0].payload.newChallengeId === ctr.id && an[0].payload.counteredFromId === orig && an[0].payload.userId === bob.id
    && an[0].payload.machineName === 'zz-challenge-test other' && an[0].payload.originalMachineName === 'zz-challenge-test (Pro)', an);
  check("bob's invitation to the original marked read", (await inbox(bob)).filter(n => n.payload?.challengeId === orig && n.kind === 'challenge_received').every(n => n.readAt));
  const [ctrEvent] = await db.select({ payload: activityEvents.payload }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.countered'), eq(activityEvents.targetId, String(orig))));
  check('challenge.countered activity links the new challenge', (ctrEvent?.payload as any)?.newChallengeId === ctr.id, ctrEvent);
  r = await call(bob, 'POST', `/challenges/${orig}/counter`, counterBody);
  check('countering again → 409 cannot_counter', r.status === 409 && r.body?.code === 'cannot_counter', r);
  r = await call(bob, 'POST', `/challenges/${orig}/accept`);
  check('accepting a countered challenge → 409', r.status === 409, r);
  r = await call(alice, 'GET', `/challenges/${orig}`);
  check("alice's view of the original: countered, bob's answer visible", r.body?.status === 'countered' && bobPart(r.body)?.response === 'countered'
    && bobPart(r.body)?.declineReason === 'cant_reach' && r.body?.counteredToId === ctr.id, r.body);
  r = await call(alice, 'GET', '/challenges?status=history');
  check('countered shows in history', r.body?.some((c: any) => c.id === orig && c.status === 'countered'), r.body?.map((c: any) => [c.id, c.status]));
  r = await call(alice, 'GET', `/challenges/${ctr.id}`);
  check('alice may accept / decline / counter the counter', r.body?.me?.canAccept && r.body?.me?.canDecline && r.body?.me?.canCounter, r.body?.me);
  r = await call(alice, 'POST', `/challenges/${ctr.id}/counter`, { machineId: PREM, type: 'high_score', matchMode: 'exact', endsAt: iso(72 * H) });
  check('a counter can itself be countered (by alice, now the creator)', r.status === 201 && r.body?.counter?.counteredFromId === ctr.id
    && r.body?.counter?.creatorId === alice.id && r.body?.original?.status === 'countered', r);
  const ctr2 = r.body?.counter?.id;
  check("bob's challenge_countered for it", (await inbox(bob)).some(n => n.payload?.challengeId === ctr2 && n.kind === 'challenge_countered' && !n.readAt));
  r = await call(bob, 'POST', `/challenges/${ctr2}/accept`);
  check('the counter of a counter is accepted → active', r.status === 200 && r.body?.status === 'active', r.body);
  check("accepting settles bob's challenge_countered", (await inbox(bob)).filter(n => n.payload?.challengeId === ctr2 && n.kind === 'challenge_countered').every(n => n.readAt));
  r = await call(bob, 'POST', `/challenges/${ctr2}/counter`, counterBody);
  check('countering an active challenge → 409 cannot_counter', r.status === 409 && r.body?.code === 'cannot_counter', r);
  r = await call(bob, 'POST', '/challenges/999999999/counter', counterBody);
  check('countering a challenge that does not exist → 404', r.status === 404, r);

  // ── challenge prefs + recommendations (zero Pinball Map calls) ─────────────
  const madeHome = await db.insert(machines).values([{ name: 'zz-challenge-test home' }, { name: 'zz-challenge-test hidden home' }]).returning({ id: machines.id });
  machineIds.push(...madeHome.map(m => m.id));
  const [HOME_M, HIDDEN_M] = madeHome.map(m => m.id);
  const homes = await db.insert(venues).values([
    { name: 'zz-challenge-test bob residence', isResidence: true, ownerId: bob.id },
    { name: 'zz-challenge-test carol residence', isResidence: true, ownerId: carol.id, showMachinesAndScores: false },
  ]).returning({ id: venues.id, name: venues.name });
  venueIds.push(...homes.map(v => v.id));
  const [BOB_HOME, CAROL_HOME] = homes;
  await db.insert(venueInventory).values([
    { venueId: BOB_HOME.id, machineId: HOME_M, addedById: bob.id },
    { venueId: CAROL_HOME.id, machineId: HIDDEN_M, addedById: carol.id },
  ]);
  // bob played at carol's (activity hidden) lately: that score must never reach alice's level 3.
  await db.insert(scores).values({ userId: bob.id, machineId: HIDDEN_M, venueId: CAROL_HOME.id, venueName: CAROL_HOME.name, score: 4242, playedAt: new Date(Date.now() - 2 * 24 * H), createdAt: new Date(Date.now() - 2 * 24 * H) });
  // A stale cached roster still counts for a recommendation (and must not trigger a refresh).
  await db.update(pmLocationCache).set({ fetchedAt: new Date(Date.now() - 30 * 24 * H) }).where(eq(pmLocationCache.pmLocationId, FAKE_PM_ID));

  r = await call(bob, 'GET', '/me/challenge-prefs');
  check('GET prefs → 200 with limits', r.status === 200 && Array.isArray(r.body?.machines) && r.body?.limits?.machines === 3, r);
  const [seeded] = await db.select({ at: users.challengeVenuesSeededAt }).from(users).where(eq(users.id, bob.id));
  check('first read seeds: challenge_venues_seeded_at stamped', seeded?.at != null, seeded);
  const wasSeeded = prefsBefore.seeded.find(s => s.id === bob.id)?.at != null;
  if (!wasSeeded) {
    check('seeding includes his own residence (it has inventory), marked home, source auto',
      r.body?.venues?.some((v: any) => v.id === BOB_HOME.id && v.isHome && v.source === 'auto'), r.body?.venues);
  }
  r = await call(bob, 'PUT', '/me/challenge-prefs', { machineIds: [PRO, PREM, OTHER, HOME_M] });
  check('PUT more than 3 machines → 400 too_many_machines', r.status === 400 && r.body?.code === 'too_many_machines', r);
  r = await call(bob, 'PUT', '/me/challenge-prefs', { machineIds: [999999999] });
  check('PUT an unknown machine → 400 machine_not_found', r.status === 400 && r.body?.code === 'machine_not_found', r);
  r = await call(bob, 'PUT', '/me/challenge-prefs', { machineIds: 'PRO' });
  check('PUT a non-array → 400 invalid_prefs', r.status === 400 && r.body?.code === 'invalid_prefs', r);
  const [strangerHome] = await db.select({ id: venues.id }).from(venues).where(sql`(is_residence OR privacy_tier <> 'full')
    AND owner_id IS DISTINCT FROM ${bob.id} AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.venue_id = venues.id AND s.user_id = ${bob.id})`).limit(1);
  if (strangerHome) {
    r = await call(bob, 'PUT', '/me/challenge-prefs', { venueIds: [strangerHome.id] });
    check("PUT someone else's private venue you never played at → 400 venue_not_found", r.status === 400 && r.body?.code === 'venue_not_found', r);
  }
  const prefEventCount = async () => (await db.select({ id: activityEvents.id }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'profile.challenge_prefs_updated'), eq(activityEvents.actorUserId, bob.id)))).length;
  const prefEventsBefore = await prefEventCount();
  r = await call(bob, 'PUT', '/me/challenge-prefs', { machineIds: [PREM], venueIds: [PMV.id, BOB_HOME.id, CAROL_HOME.id] });
  const srcOf = (id: number) => r.body?.venues?.find((v: any) => v.id === id)?.source;
  check('PUT prefs → 200, lists replaced', r.status === 200 && JSON.stringify(r.body?.machines?.map((m: any) => m.id)) === JSON.stringify([PREM])
    && [PMV.id, BOB_HOME.id, CAROL_HOME.id].every(id => r.body?.venues?.some((v: any) => v.id === id)) && r.body?.venues?.length === 3, r.body);
  check('a hand-added venue is source added; a seeded one it kept stays auto', srcOf(PMV.id) === 'added' && (wasSeeded || srcOf(BOB_HOME.id) === 'auto'), r.body?.venues);
  check('profile.challenge_prefs_updated logged for the saved PUT', (await prefEventCount()) === prefEventsBefore + 1);

  // Challenge-location search (GET /api/me/challenge-venue-search): our venues table only, the PUT rule.
  const searchVenues = await db.insert(venues).values([
    { name: 'zz-challenge-test searchable arcade', city: 'Zzton', state: 'ZZ' },
    { name: 'zz-challenge-test carol cabin', isResidence: true, ownerId: carol.id, city: 'Zzville', state: 'ZZ' },
  ]).returning({ id: venues.id, name: venues.name });
  venueIds.push(...searchVenues.map(v => v.id));
  const [ARCADE, CABIN] = searchVenues;
  await db.update(venues).set({ city: 'Zzburg', state: 'ZZ' }).where(eq(venues.id, CAROL_HOME.id));
  const pmBeforeSearch = pmClient().stats().liveCallsToday;
  const hitIds = (body: any) => (Array.isArray(body) ? body : []).map((h: any) => h.id as number);
  r = await call(bob, 'GET', `/me/challenge-venue-search?q=${encodeURIComponent('zz challenge test searchable')}`);
  const arcadeHit = (r.body ?? []).find?.((h: any) => h.id === ARCADE.id);
  check('venue search → 200, finds a public venue by name words, with city/state', r.status === 200
    && arcadeHit?.city === 'Zzton' && arcadeHit?.state === 'ZZ' && arcadeHit?.isPrivate === false, r.body);
  r = await call(bob, 'GET', `/me/challenge-venue-search?q=${encodeURIComponent('zz challenge test cabin')}`);
  check("venue search never returns a stranger's residence (never played there)", r.status === 200 && !hitIds(r.body).includes(CABIN.id)
    && !JSON.stringify(r.body).includes(CABIN.name), r.body);
  r = await call(alice, 'GET', `/me/challenge-venue-search?q=${encodeURIComponent('zz challenge test residence')}`);
  check("venue search: alice gets neither bob's nor carol's residence", r.status === 200
    && !hitIds(r.body).includes(BOB_HOME.id) && !hitIds(r.body).includes(CAROL_HOME.id), r.body);
  r = await call(carol, 'GET', `/me/challenge-venue-search?q=${encodeURIComponent('zz challenge test cabin')}`);
  const cabinHit = (r.body ?? []).find?.((h: any) => h.id === CABIN.id);
  check('venue search: your own residence is found, marked home, with its city', cabinHit?.isHome === true && cabinHit?.city === 'Zzville', r.body);
  await db.delete(userChallengeVenues).where(and(eq(userChallengeVenues.userId, bob.id), eq(userChallengeVenues.venueId, CAROL_HOME.id)));
  r = await call(bob, 'GET', `/me/challenge-venue-search?q=${encodeURIComponent('zz challenge test carol residence')}`);
  const playedHit = (r.body ?? []).find?.((h: any) => h.id === CAROL_HOME.id);
  check("venue search: a private venue you've scored at is found by name only — no city/state", playedHit
    && playedHit.city === null && playedHit.state === null && playedHit.isPrivate === true && playedHit.isHome === false, r.body);
  r = await call(bob, 'GET', '/me/challenge-venue-search?q=z');
  check('venue search: under 2 letters → empty', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, r.body);
  r = await call(bob, 'PUT', '/me/challenge-prefs', { venueIds: [PMV.id, BOB_HOME.id, CAROL_HOME.id, ARCADE.id] });
  check('PUT adds a searched (never-suggested) public venue → 200, source added', r.status === 200
    && r.body?.venues?.find((v: any) => v.id === ARCADE.id)?.source === 'added' && r.body?.venues?.length === 4, r.body?.venues);
  r = await call(bob, 'GET', `/me/challenge-venue-search?q=${encodeURIComponent('zz challenge test searchable')}`);
  check('venue search leaves out venues already in your list', r.status === 200 && !hitIds(r.body).includes(ARCADE.id), r.body);
  check('venue search: zero Pinball Map calls', pmClient().stats().liveCallsToday === pmBeforeSearch);

  r = await call(carol, 'GET', `/challenges/recommendations/${encodeURIComponent(bob.username)}`);
  check('recommendations for a non-friend → 403 not_friends', r.status === 403 && r.body?.code === 'not_friends', r);
  r = await call(alice, 'GET', `/challenges/recommendations/${encodeURIComponent(alice.username)}`);
  check('recommendations for yourself → 400 cannot_challenge_self', r.status === 400 && r.body?.code === 'cannot_challenge_self', r);
  r = await call(alice, 'GET', '/challenges/recommendations/zz-nobody-here');
  check('recommendations for an unknown user → 404', r.status === 404 && r.body?.code === 'user_not_found', r);

  const pmBefore = pmClient().stats().liveCallsToday;
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); realLog(...a); };
  let recs: Awaited<ReturnType<typeof call>>;
  try {
    recs = await call(alice, 'GET', `/challenges/recommendations/${encodeURIComponent(bob.username)}`);
  } finally { console.log = realLog; }
  const rec = (id: number) => recs.body?.recommendations?.find((x: any) => x.machineId === id);
  const recsJson = JSON.stringify(recs.body);
  check('recommendations → 200', recs.status === 200 && recs.body?.user?.id === bob.id && Array.isArray(recs.body?.recommendations), recs);
  check('level 1: his "challenge me on" machine', rec(PREM)?.level === 1, rec(PREM));
  check('level 2 from a stale cached Pinball Map roster: the Pro at the public venue, labelled with its name',
    rec(PRO)?.level === 2 && rec(PRO)?.venueLabel === PMV.name, rec(PRO));
  check("level 2: his own residence's machine, labelled 'at home'", rec(HOME_M)?.level === 2 && rec(HOME_M)?.venueLabel === 'at home', rec(HOME_M));
  check('no private venue name anywhere in the response', !recsJson.includes(BOB_HOME.name) && !recsJson.includes(CAROL_HOME.name), recs.body);
  if (alice.role !== 'admin') {
    check("someone else's hidden residence never surfaces — not in level 2, and the score there is excluded from level 3", !rec(HIDDEN_M), rec(HIDDEN_M));
  }
  check('level 3: a machine he played lately, no venue label', rec(OTHER)?.level === 3 && !('venueLabel' in (rec(OTHER) ?? {})), rec(OTHER));
  check('viewerCanReach + viewerBest: alice played the Pro lately', rec(PRO)?.viewerCanReach === true && typeof rec(PRO)?.viewerBest === 'number', rec(PRO));
  check('zero Pinball Map calls: live count unchanged, no [PM] log line', pmClient().stats().liveCallsToday === pmBefore && !logged.some(l => l.includes('[PM')), logged);
  const reachSrc = readFileSync(new URL('./src/lib/challengeReach.ts', import.meta.url), 'utf8');
  check('challengeReach.ts never imports the roster fetcher, pmClient or the catalog', !/from '\.\/(pmRosterCache|pmClient|pinballMap|venueInventory)\.js'/.test(reachSrc));
  const [rosterRow] = await db.select({ fetchedAt: pmLocationCache.fetchedAt }).from(pmLocationCache).where(eq(pmLocationCache.pmLocationId, FAKE_PM_ID));
  check('the stale cached roster was not refreshed', +rosterRow.fetchedAt < Date.now() - 29 * 24 * H, rosterRow);

  r = await call(alice, 'GET', `/users/${encodeURIComponent(bob.username)}`);
  check('profile: a friend sees challengeMe (level 1 only)', JSON.stringify(r.body?.challengeMe?.map((m: any) => m.id)) === JSON.stringify([PREM]), r.body?.challengeMe);
  r = await call(carol, 'GET', `/users/${encodeURIComponent(bob.username)}`);
  check('profile: a non-friend gets no challengeMe', r.status === 200 && !('challengeMe' in (r.body ?? {})), Object.keys(r.body ?? {}));
  r = await call(null, 'GET', `/users/${encodeURIComponent(bob.username)}`);
  check('profile: a guest gets no challengeMe', r.status === 200 && !('challengeMe' in (r.body ?? {})), Object.keys(r.body ?? {}));
  r = await call(bob, 'GET', `/users/${encodeURIComponent(bob.username)}`);
  check('profile: your own gets no challengeMe (edit via /api/me)', r.status === 200 && !('challengeMe' in (r.body ?? {})), Object.keys(r.body ?? {}));

  r = await call(bob, 'PUT', '/me/challenge-prefs', { venueIds: [BOB_HOME.id] });
  check('PUT only venues leaves machines alone; a removed venue stays removed', r.status === 200 && r.body?.machines?.length === 1
    && r.body?.venues?.length === 1 && r.body?.venues?.[0]?.id === BOB_HOME.id, r.body);
  r = await call(bob, 'GET', '/me/challenge-prefs');
  check('…no re-seeding on the next read', r.body?.venues?.length === 1, r.body?.venues);

  // ── notification retention + clear all ─────────────────────────────────────
  const old = new Date(Date.now() - 31 * 24 * H);
  const [readOld] = await db.insert(notifications).values({ userId: carol.id, kind: 'challenge_result', payload: { challengeId: -1 }, createdAt: old, readAt: old }).returning({ id: notifications.id });
  const [unreadOld] = await db.insert(notifications).values({ userId: carol.id, kind: 'challenge_result', payload: { challengeId: -1 }, createdAt: new Date(Date.now() - 40 * 24 * H) }).returning({ id: notifications.id });
  const [readNew] = await db.insert(notifications).values({ userId: carol.id, kind: 'challenge_result', payload: { challengeId: -1 }, createdAt: new Date(Date.now() - 5 * 24 * H), readAt: new Date() }).returning({ id: notifications.id });
  sweep = await runChallengeSweep();
  const left = new Set((await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.userId, carol.id))).map(x => x.id));
  check('retention: read >30d deleted', !left.has(readOld.id) && sweep.notificationsDeleted >= 1, sweep);
  check('retention: unread kept however old; recent read kept', left.has(unreadOld.id) && left.has(readNew.id));
  r = await call(carol, 'DELETE', '/notifications');
  check('clear all → deleted count', r.status === 200 && r.body?.deleted >= 2, r);
  check('carol inbox empty after clear all', (await inbox(carol)).length === 0);
  const aliceHas = (await inbox(alice)).length;
  check("clear all only touched carol's", aliceHas > 0);
} catch (err) {
  failures++;
  console.error('UNCAUGHT', err);
} finally {
  const mine = await db.select({ id: challengeParticipants.challengeId }).from(challengeParticipants).where(inArray(challengeParticipants.userId, ids));
  const cids = [...new Set(mine.map(m => m.id))];
  if (cids.length) await db.delete(challenges).where(inArray(challenges.id, cids)); // cascades participants + challenge_scores
  if (machineIds.length) {
    await db.delete(scores).where(inArray(scores.machineId, machineIds));
  }
  // Challenge prefs back to what they were (normally: none, never seeded).
  await db.delete(userChallengeMachines).where(inArray(userChallengeMachines.userId, ids));
  await db.delete(userChallengeVenues).where(inArray(userChallengeVenues.userId, ids));
  if (prefsBefore.machines.length) await db.insert(userChallengeMachines).values(prefsBefore.machines).onConflictDoNothing();
  if (prefsBefore.venues.length) await db.insert(userChallengeVenues).values(prefsBefore.venues).onConflictDoNothing();
  for (const s of prefsBefore.seeded) await db.update(users).set({ challengeVenuesSeededAt: s.at }).where(eq(users.id, s.id));
  if (venueIds.length) {
    await db.delete(scores).where(inArray(scores.venueId, venueIds));
    await db.delete(venueMachineHistory).where(inArray(venueMachineHistory.venueId, venueIds));
    await db.delete(venueInventory).where(inArray(venueInventory.venueId, venueIds));
    await db.delete(venues).where(inArray(venues.id, venueIds));
  }
  await db.delete(pmLocationCache).where(eq(pmLocationCache.pmLocationId, FAKE_PM_ID));
  if (machineIds.length) {
    await db.delete(venueMachineHistory).where(inArray(venueMachineHistory.machineId, machineIds));
    await db.delete(machines).where(inArray(machines.id, machineIds));
  }
  await db.delete(friendships).where(and(inArray(friendships.requesterId, ids), inArray(friendships.addresseeId, ids)));
  // Only notifications raised about these users' challenges, plus the retention fixtures.
  await db.delete(notifications).where(and(
    inArray(notifications.userId, ids),
    or(
      cids.length ? sql`(${notifications.payload} ->> 'challengeId')::int IN (${sql.join(cids.map(i => sql`${i}`), sql`, `)})` : sql`false`,
      sql`${notifications.payload} ->> 'challengeId' = '-1'`,
    ),
  ));
  server.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
