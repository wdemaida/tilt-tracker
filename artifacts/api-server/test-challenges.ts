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
// the machines, the friendship it made, and every notification it raised for them.
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
const { default: challengesRouter } = await import('./src/routes/challenges.js');
const { default: notificationsRouter } = await import('./src/routes/notifications.js');
const { default: scoresRouter } = await import('./src/routes/scores.js');
const { runChallengeSweep } = await import('./src/lib/challenges.js');
const { db, users, friendships, notifications, challenges, challengeParticipants, challengeScores, scores, machines, venues } = await import('@workspace/db');
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

const [publicVenue] = await db.select({ id: venues.id, name: venues.name }).from(venues)
  .where(sql`privacy_tier = 'full' AND NOT is_residence`).limit(1);
const [privateVenue] = await db.select({ id: venues.id }).from(venues)
  .where(sql`privacy_tier <> 'full' OR is_residence`).limit(1);

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
let friendshipId: number | null = null;

try {
  // ── fixtures ───────────────────────────────────────────────────────────────
  const made = await db.insert(machines).values([
    { name: 'zz-challenge-test (Pro)', opdbId: 'GzzT1-Mpro1' },
    { name: 'zz-challenge-test (Premium)', opdbId: 'GzzT1-Mprm2-Aabc3' },
    { name: 'zz-challenge-test other', opdbId: null },
  ]).returning({ id: machines.id });
  machineIds = made.map(m => m.id);
  const [PRO, PREM, OTHER] = machineIds;
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

  // ── both no-show (deadline via sweep) ──────────────────────────────────────
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  cid = r.body.id;
  await call(bob, 'POST', `/challenges/${cid}/accept`);
  await setWindow(cid, new Date(Date.now() - 3 * H), new Date(Date.now() - 60_000));
  sweep = await runChallengeSweep();
  r = await call(alice, 'GET', `/challenges/${cid}`);
  check('sweep resolves past-deadline: void, both no_show', r.body?.status === 'resolved' && r.body?.void === true
    && byUser(r.body)[alice.id] === 'no_show' && byUser(r.body)[bob.id] === 'no_show' && sweep.resolved >= 1, { body: r.body, sweep });

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
  r = await post(alice, { friendId: bob.id, type: 'average', minPlays: 3, venueId: publicVenue?.id });
  check('average with min plays + venue lock', r.status === 201 && r.body?.minPlays === 3 && r.body?.venue?.id === publicVenue?.id, r.body);
  const avg = r.body.id;
  await call(bob, 'POST', `/challenges/${avg}/accept`);
  const atVenue = { venueId: publicVenue?.id, venueName: publicVenue?.name };
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
  // alice: forfeit-win, void no_show, hs win, race loss, race abandoned, mi loss, avg win, soon forfeit
  check('record totals for alice', r.status === 200 && r.body?.wins === 3 && r.body?.losses === 2 && r.body?.forfeits === 1
    && r.body?.noShows === 1 && r.body?.voids === 1 && r.body?.abandoned === 1 && r.body?.ties === 0 && r.body?.played === 8, r.body);
  check('record: head-to-head vs bob', r.body?.headToHead?.[0]?.opponent?.id === bob.id && r.body?.headToHead?.[0]?.played === 8
    && r.body?.headToHead?.[0]?.abandoned === 1, r.body?.headToHead);
  check('record: streaks', r.body?.currentStreak === 0 && r.body?.bestStreak === 2, r.body);
  r = await call(carol, 'GET', `/challenges/record/${encodeURIComponent(alice.username)}`);
  check("someone else's record: totals, but head-to-head only against the viewer", r.status === 200 && r.body?.wins === 3 && r.body?.headToHead?.length === 0, r.body);
  r = await call(bob, 'GET', `/challenges/record/${encodeURIComponent(alice.username)}`);
  check('…and bob sees alice vs bob', r.body?.headToHead?.length === 1 && r.body.headToHead[0].opponent.id === bob.id, r.body?.headToHead);
  r = await call(bob, 'GET', '/challenges/record/zz-nobody-here');
  check('record for unknown user → 404', r.status === 404, r);

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
