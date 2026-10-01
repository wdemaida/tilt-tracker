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
// Borrows four existing users that are in no friendship and no challenge yet (so it never disturbs
// seeded data), makes some of them friends (dave stays the true non-friend until the group section),
// and works on three throwaway `zz-challenge-test` machines.
// At the end it deletes every challenge among those users, the scores on the throwaway machines,
// the machines, the friendship it made, and every notification it raised for them. The venue-lock
// checks use three throwaway `zz-challenge-test` venues (one "Pinball Map linked" through a fake
// location id whose roster is planted in pm_location_cache, so no network call), removed at the end.
// Challenge recs (feature/challenge-recs): decline reasons, counter-offers (incl. a counter of a
// counter), /api/me/challenge-prefs and /api/challenges/recommendations — privacy (someone else's
// hidden residence, the "at home" label, hidden-score exclusion from level 3) and zero Pinball Map
// calls — plus the profile's challengeMe field, using two more throwaway machines and two throwaway
// residences. The borrowed users' challenge prefs / seeded_at are restored at the end.
// Group challenges (feature/group-challenges): counters as proposals (take / keep mine, a legacy
// counter row, the DB CHECK), group validation (non-friend, cap, repeats), partial accept / decline /
// back out, Start with who's in, fixed start (sweep and score hook), two counters with supersede and
// re-invite, lapse on start / fixed start / cancel / own window, the proposal reminder, group records,
// group recommendations and the durable badge facts. Everything it creates is removed at the end,
// including the activity events about these users and challenges.
//
//   cd artifacts/api-server && npx tsx test-challenges.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as migrate15.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

// HERE test double (feature/pm-challenge-locations): every *.hereapi.com request made in this process
// is answered here — this script never calls HERE live. Canned answers describe the one throwaway
// place (`herePlace`) while that section runs; anything else gets an empty result. A Pinball Map
// request that reaches fetch is refused outright (PM_MODE stays offline: fixtures answer them).
// hereApi.ts reads HERE_API_KEY at import, so any value will do — it never leaves this process.
process.env.HERE_API_KEY ||= 'zz-test-stub';
const realFetch = globalThis.fetch;
const hereHits: string[] = [];
let herePlace: null | { id: string; title: string; lat: number; lng: number; label: string } = null;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
  if (url.hostname.endsWith('pinballmap.com')) throw new Error(`test: refusing a live Pinball Map request (${url.pathname})`);
  if (!url.hostname.endsWith('hereapi.com')) return realFetch(input, init);
  const api = url.hostname.split('.')[0];
  hereHits.push(api);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const p = herePlace;
  if (!p) return json({ items: [] });
  const position = { lat: p.lat, lng: p.lng };
  const timeZone = { name: 'America/New_York' };
  const poi = { id: p.id, title: p.title, distance: 2, position, address: { label: `${p.title}, ${p.label}` }, categories: [{ id: '200-2000-0011' }], timeZone };
  switch (api) {
    case 'geocode': return json({ items: [{ resultType: 'houseNumber', position, address: { label: p.label, city: 'Dennis', state: 'MA' }, timeZone }] });
    case 'revgeocode': return json({ items: [{ timeZone }] });
    case 'browse': case 'discover': return json({ items: [poi] });
    case 'autosuggest': return json({ items: [{ ...poi, resultType: 'place' }] });
    default: return json({ items: [] });
  }
}) as typeof fetch;

const { default: express } = await import('express');
const { readFileSync } = await import('node:fs');
const { default: challengesRouter } = await import('./src/routes/challenges.js');
const { default: notificationsRouter } = await import('./src/routes/notifications.js');
const { default: scoresRouter } = await import('./src/routes/scores.js');
const { default: meRouter } = await import('./src/routes/me.js');
const { default: usersRouter } = await import('./src/routes/users.js');
const { default: venuesRouter } = await import('./src/routes/venues.js');
const { default: uploadRouter } = await import('./src/routes/upload.js');
const { runChallengeSweep, scoreChallengeSummary } = await import('./src/lib/challenges.js');
const { pmClient } = await import('./src/lib/pmClient.js');
const { readMetric } = await import('./src/lib/badgeMetrics.js');
const {
  db, users, friendships, notifications, challenges, challengeParticipants, challengeScores, scores, machines, venues, venueMachineHistory,
  pmLocationCache, pmCatalogCache, venueInventory, userChallengeMachines, userChallengeVenues, activityEvents, userBadges,
} = await import('@workspace/db');
const { and, desc, eq, inArray, or, sql } = await import('drizzle-orm');

const H = 60 * 60 * 1000;
const PHOTO = 'data:image/jpeg;base64,/9j/zz-challenge-test';

const people = await db.select().from(users)
  .where(sql`NOT EXISTS (SELECT 1 FROM friendships f WHERE f.requester_id = ${users.id} OR f.addressee_id = ${users.id})
    AND NOT EXISTS (SELECT 1 FROM challenge_participants cp WHERE cp.user_id = ${users.id})`)
  .orderBy(desc(users.id)).limit(4);
if (people.length < 4) throw new Error('Need at least 4 users with no friendships or challenges in the dev DB');
const [alice, bob, carol, dave] = people;
const ids = people.map(p => p.id);
// DB clock at start — cleanup removes badge awards this run's scores triggered (see the end).
const [{ startedAt }] = await db.select({ startedAt: sql<string>`now()::text` }).from(users).limit(1);
// How far Neon's clock runs ahead of this machine's (accept stamps "starts when accepted" with the DB
// clock, uploads here send this machine's played_at). The checks below that depend on it allow for it.
const skewProbe = Date.now();
const [{ dbMs }] = await db.select({ dbMs: sql<number>`(extract(epoch from clock_timestamp()) * 1000)::float8` }).from(users).limit(1);
const SKEW_MS = Math.max(0, Number(dbMs) - (skewProbe + Date.now()) / 2);
console.log(`DB clock ahead of this machine by ~${Math.round(SKEW_MS)} ms`);
// The borrowed users' existing notifications — the "clear all" check empties carol's inbox, so any
// she already had (e.g. a badge an admin awarded while testing) are put back at the end.
const notificationsBefore = await db.select().from(notifications).where(inArray(notifications.userId, ids));

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
app.use('/api/venues', stub, venuesRouter);
app.use('/api/upload', stub, uploadRouter);
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
  (await inbox(who)).filter(n => n.payload?.challengeId === challengeId || (n.payload?.challengeIds ?? []).includes(challengeId)).map(n => n.kind as string);
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const setWindow = (id: number, startsAt: Date | null, endsAt: Date) =>
  db.update(challenges).set({ startsAt, endsAt }).where(eq(challenges.id, id));

let machineIds: number[] = [];
let venueIds: number[] = [];
let friendshipId: number | null = null;
// A Pinball Map location id no real venue uses (checked below), for the planted roster.
const FAKE_PM_ID = 2_147_000_000 + Math.floor(Math.random() * 400_000);

/** Counts every request through pmClient (fixture, cache or live) until stop(); `paths` in order. */
function countPmRequests() {
  const client = pmClient() as any;
  const original = client.get;
  const counter = {
    count: 0, paths: [] as string[], stop: () => { client.get = original; },
    /** Requests since index `from` whose path contains `part`. */
    since: (from: number, part: string) => counter.paths.slice(from).filter(p => p.includes(part)).length,
  };
  client.get = (...args: unknown[]) => { counter.count++; counter.paths.push(String(args[0])); return original(...args); };
  return counter;
}
// What the Pinball Map-only place section's pm-link may touch on dev, put back in `finally`.
const pmRestore: {
  location?: typeof pmLocationCache.$inferSelect | null;
  catalog?: Array<typeof pmCatalogCache.$inferSelect>;
  machines?: Array<typeof machines.$inferSelect>;
  maxMachineId?: number;
  names?: string[];
  locationHash?: string;
  catalogHash?: string;
} = {};
async function pmRowHash(table: 'pm_location_cache' | 'pm_catalog_cache', where: string): Promise<string> {
  const rows = await db.execute(sql.raw(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${table} x WHERE ${where}`));
  return String((rows as unknown as Array<{ h: string }>)[0]?.h ?? '');
}

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
  // Starts "now" on the DB clock — which may be a moment ahead of this machine's (then 'scheduled' for that moment).
  check('accept → active, window starts now', r.status === 200 && r.body?.status === 'active' && r.body?.startsAt != null
    && (r.body?.phase === 'live' || (r.body?.phase === 'scheduled' && r.body?.startsInMs <= SKEW_MS + 2000)), { body: r.body, SKEW_MS });
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
  // A played time in the future (dev score #1276, lib/playedAtClock.ts): POST refuses it outright; a
  // legacy row planted with one — lock row and all, as #1276 had — stops counting on the next sync.
  s = await upload(bob, { score: 11_000_000, playedAt: new Date(Date.now() + 2 * H).toISOString() });
  check('POST a played time 2 h in the future → 400 played_at_in_future', s.status === 400 && s.body?.code === 'played_at_in_future', s);
  s = await upload(bob, { score: 55_000_000 });
  const futureDated = s.body.id;
  check('(the planted score counted when it was uploaded — lock row written)', (await db.select().from(challengeScores)
    .where(and(eq(challengeScores.challengeId, hs), eq(challengeScores.scoreId, futureDated)))).length === 1);
  await db.update(scores).set({ playedAt: new Date(Date.now() + 2 * H) }).where(eq(scores.id, futureDated));

  r = await call(alice, 'GET', `/challenges/${hs}`);
  const standing = (b: any, u: number) => b?.participants?.find((p: any) => p.user.id === u)?.standing;
  check('detail: live standings (alice leads)', standing(r.body, alice.id)?.bestScore === 60_000 && standing(r.body, alice.id)?.liveRank === 1
    && standing(r.body, alice.id)?.countingCount === 2, r.body?.participants);
  check('future-dated legacy score: dropped from the standings (bob best 40,000, one counting)',
    standing(r.body, bob.id)?.bestScore === 40_000 && standing(r.body, bob.id)?.countingCount === 1, standing(r.body, bob.id));
  check('… and from his listed counting scores', !r.body?.participants?.find((p: any) => p.user.id === bob.id)?.scores?.some((x: any) => x.id === futureDated));
  check('… its lock row stays (append-only)', (await db.select().from(challengeScores)
    .where(and(eq(challengeScores.challengeId, hs), eq(challengeScores.scoreId, futureDated)))).length === 1);
  const futureFits = await scoreChallengeSummary({ id: futureDated, userId: bob.id });
  check('… the summary says not counted: played_in_future', futureFits.some(f => f.challengeId === hs && f.status === 'not_counted' && f.reason === 'played_in_future'), futureFits);
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
  check('deadline: alice wins high score (late upload and future-dated 55M ignored)', r.body?.status === 'resolved' && byUser(r.body)[alice.id] === 'win' && byUser(r.body)[bob.id] === 'loss', r.body?.participants);
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
  // Past the start on this machine's clock too (uploads send its played_at), however far the DB is ahead.
  await new Promise(res => setTimeout(res, 1100 + SKEW_MS));
  await upload(alice, { score: 150_000 });                // +50%
  await upload(bob, { score: baseOf(bob.id) * 2 });       // +100%
  // created_at is stamped by the DB clock: let this machine's clock pass it before ending the window
  // "just now", or bob's upload would land after the end.
  await new Promise(res => setTimeout(res, 1000 + SKEW_MS));
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
  check('record: streaks (the nobody-played abandon broke the first run); bestLossStreak 1', r.body?.currentStreak === 0 && r.body?.bestStreak === 1
    && r.body?.bestLossStreak === 1, r.body);
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
  d = await declinedWith('backed_out');
  check("decline body with reason 'backed_out' → 400 invalid_reason (only the back-out path sets it), nothing stored",
    d.res.status === 400 && d.res.body?.code === 'invalid_reason' && d.note.length === 0, d.res);
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

  // ── counter-offers = proposals to the challenger (feature/group-challenges) ─
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  const orig = r.body.id;
  const counterBody = { machineId: OTHER, type: 'high_score', matchMode: 'exact', endsAt: iso(72 * H) };
  r = await call(bob, 'POST', `/challenges/${orig}/counter`, { ...counterBody, type: 'darts' });
  check('counter with a bad body → 400 invalid_type', r.status === 400 && r.body?.code === 'invalid_type', r);
  let [origRow] = await db.select().from(challenges).where(eq(challenges.id, orig));
  let kids = await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.counteredFromId, orig));
  check('…nothing written: original still pending, no proposal row', origRow.status === 'pending' && kids.length === 0, { origRow, kids });
  r = await call(alice, 'POST', `/challenges/${orig}/counter`, counterBody);
  check('the creator cannot counter their own → 409 cannot_counter', r.status === 409 && r.body?.code === 'cannot_counter', r);
  r = await call(carol, 'POST', `/challenges/${orig}/counter`, counterBody);
  check('a stranger cannot counter → 404', r.status === 404 && r.body?.code === 'challenge_not_found', r);
  r = await call(bob, 'GET', `/challenges/${orig}`);
  check('invitee view: canCounter', r.body?.me?.canCounter === true, r.body?.me);
  r = await call(bob, 'POST', `/challenges/${orig}/counter`, { ...counterBody, friendId: carol.id, friendIds: [carol.id] });
  check('bob counters (invitees in the body are ignored) → 201', r.status === 201 && r.body?.counter?.id > 0, r);
  const ctr = r.body?.counter ?? {};
  check('original: still pending (an open proposal blocks it), no counteredToId yet', r.body?.original?.status === 'pending'
    && r.body?.original?.counteredToId === null, r.body?.original);
  check('proposal: status proposed (phase pending for old clients), creator = alice, proposedBy = bob, links back, exact machine',
    ctr.status === 'proposed' && ctr.phase === 'pending' && ctr.isProposal === true && ctr.creatorId === alice.id
    && ctr.proposedBy?.id === bob.id && ctr.counteredFromId === orig && ctr.machine?.id === OTHER && ctr.matchGroup === null, ctr);
  check("proposal participants: bob accepted, alice pending", ctr.participants?.length === 2
    && ctr.participants.find((p: any) => p.user.id === bob.id)?.response === 'accepted'
    && ctr.participants.find((p: any) => p.user.id === alice.id)?.response === 'pending', ctr.participants);
  const [bp] = await db.select().from(challengeParticipants).where(and(eq(challengeParticipants.challengeId, orig), eq(challengeParticipants.userId, bob.id)));
  check('bob on the original: response countered, reason cant_reach', bp?.response === 'countered' && bp?.declineReason === 'cant_reach', bp);
  const an = (await inbox(alice)).filter(n => n.payload?.challengeId === ctr.id);
  check('alice got challenge_countered for the proposal', an.length === 1 && an[0].kind === 'challenge_countered' && an[0].payload.proposal === true
    && an[0].payload.newChallengeId === ctr.id && an[0].payload.counteredFromId === orig && an[0].payload.userId === bob.id
    && an[0].payload.machineName === 'zz-challenge-test other' && an[0].payload.originalMachineName === 'zz-challenge-test (Pro)', an);
  check("bob's invitation to the original marked read", (await inbox(bob)).filter(n => n.payload?.challengeId === orig && n.kind === 'challenge_received').every(n => n.readAt));
  const [ctrEvent] = await db.select({ payload: activityEvents.payload }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.countered'), eq(activityEvents.targetId, String(orig))));
  check('challenge.countered activity links the proposal', (ctrEvent?.payload as any)?.newChallengeId === ctr.id, ctrEvent);
  r = await call(bob, 'POST', `/challenges/${orig}/counter`, counterBody);
  check('countering again → 409 cannot_counter', r.status === 409 && r.body?.code === 'cannot_counter', r);
  r = await call(bob, 'POST', `/challenges/${orig}/accept`);
  check('accepting after countering → 409', r.status === 409, r);
  r = await call(alice, 'GET', `/challenges/${orig}`);
  check("alice's view of the original: pending, bob's answer, the proposal listed, can't start", r.body?.status === 'pending'
    && bobPart(r.body)?.response === 'countered' && r.body?.proposals?.length === 1 && r.body.proposals[0].id === ctr.id
    && r.body.proposals[0].status === 'proposed' && r.body.proposals[0].proposedBy?.id === bob.id && r.body?.me?.canStart === false, r.body);
  r = await call(alice, 'GET', `/challenges/${ctr.id}`);
  check('alice may take / keep-mine the proposal (accept / decline), not counter or cancel it', r.body?.me?.canAccept && r.body?.me?.canDecline
    && r.body?.me?.canDecideProposal && !r.body?.me?.canCounter && !r.body?.me?.canCancel, r.body?.me);
  r = await call(bob, 'POST', `/challenges/${ctr.id}/accept`);
  check('the proposer cannot decide their own proposal → 409', r.status === 409, r);
  r = await call(bob, 'POST', `/challenges/${ctr.id}/decline`);
  check('…nor withdraw it (v1) → 409', r.status === 409, r);
  r = await call(alice, 'GET', '/challenges?status=pending');
  check("alice's pending list shows the proposal (Waiting on you)", r.body?.some((c: any) => c.id === ctr.id && c.status === 'proposed'), r.body?.map((c: any) => [c.id, c.status]));
  r = await call(alice, 'POST', `/challenges/${ctr.id}/accept`);
  check('alice takes it: 1:1 → active at once', r.status === 200 && r.body?.status === 'active' && r.body?.counteredFromId === orig
    && r.body?.proposedBy?.id === bob.id && r.body?.isProposal === false, r.body);
  [origRow] = await db.select().from(challenges).where(eq(challenges.id, orig));
  const [ctrRow] = await db.select().from(challenges).where(eq(challenges.id, ctr.id));
  check('original → countered; proposal_decided_at stamped', origRow.status === 'countered' && ctrRow.proposalDecidedAt != null, { origRow, ctrRow });
  r = await call(alice, 'GET', `/challenges/${orig}`);
  check('original view: countered, counteredToId = the taken proposal', r.body?.status === 'countered' && r.body?.counteredToId === ctr.id, r.body);
  check('bob got challenge_counter_accepted', (await inbox(bob)).some(n => n.kind === 'challenge_counter_accepted' && n.payload?.challengeId === ctr.id && n.payload?.counteredFromId === orig));
  check("alice's challenge_countered settled (read)", (await inbox(alice)).filter(n => n.payload?.challengeId === ctr.id && n.kind === 'challenge_countered').every(n => n.readAt));
  const [takeEvent] = await db.select({ payload: activityEvents.payload }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.counter_accepted'), eq(activityEvents.targetId, String(ctr.id))));
  check('challenge.counter_accepted activity', (takeEvent?.payload as any)?.counteredFromId === orig, takeEvent);
  r = await call(bob, 'POST', `/challenges/${ctr.id}/counter`, counterBody);
  check('countering an active challenge → 409 cannot_counter', r.status === 409 && r.body?.code === 'cannot_counter', r);
  r = await call(bob, 'POST', '/challenges/999999999/counter', counterBody);
  check('countering a challenge that does not exist → 404', r.status === 404, r);
  await call(bob, 'POST', `/challenges/${ctr.id}/forfeit`);

  // Keep mine (1:1): the proposal is rejected and — nobody else being left — the original ends declined.
  r = await post(alice, { friendId: bob.id, type: 'high_score' });
  const orig2 = r.body.id;
  r = await call(bob, 'POST', `/challenges/${orig2}/counter`, counterBody);
  const ctr2 = r.body?.counter?.id;
  r = await call(alice, 'POST', `/challenges/${ctr2}/decline`);
  check('keep mine: the proposal → rejected (phase declined for old clients)', r.status === 200 && r.body?.status === 'rejected' && r.body?.phase === 'declined', r.body);
  r = await call(alice, 'GET', `/challenges/${orig2}`);
  check('…1:1 original has nobody left → declined', r.body?.status === 'declined' && r.body?.proposals?.[0]?.status === 'rejected', r.body);
  check('bob got challenge_counter_rejected reason rejected', (await inbox(bob)).some(n => n.kind === 'challenge_counter_rejected' && n.payload?.challengeId === ctr2 && n.payload?.reason === 'rejected'));
  const [aliceOnCtr2] = await db.select().from(challengeParticipants).where(and(eq(challengeParticipants.challengeId, ctr2), eq(challengeParticipants.userId, alice.id)));
  check("keep mine: the challenger's row on the rejected proposal → declined, responded_at stamped, no reason", aliceOnCtr2?.response === 'declined'
    && aliceOnCtr2?.respondedAt != null && aliceOnCtr2?.declineReason == null, aliceOnCtr2);
  const rejEvents = await db.select({ actor: activityEvents.actorUserId, payload: activityEvents.payload }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.counter_rejected'), eq(activityEvents.targetId, String(ctr2))));
  check('keep mine: exactly one challenge.counter_rejected, by the challenger, reason rejected', rejEvents.length === 1
    && rejEvents[0].actor === alice.id && (rejEvents[0].payload as any)?.reason === 'rejected', rejEvents);
  r = await call(alice, 'POST', `/challenges/${ctr2}/accept`);
  check('a rejected proposal cannot be taken later → 409', r.status === 409, r);
  r = await call(alice, 'GET', '/challenges?status=history');
  check('rejected proposal + countered original show in history', r.body?.some((c: any) => c.id === ctr2 && c.status === 'rejected')
    && r.body?.some((c: any) => c.id === orig && c.status === 'countered'), r.body?.map((c: any) => [c.id, c.status]));

  // A legacy counter row (migrate22 model: created by the counterer, proposed_by_id null) is an ordinary challenge.
  const [legacy] = await db.insert(challenges).values({
    creatorId: bob.id, type: 'high_score', machineId: PRO, matchMode: 'game', matchGroup: 'GzzT1', endsAt: new Date(Date.now() + 48 * H),
    status: 'pending', counteredFromId: orig2,
  }).returning({ id: challenges.id });
  await db.insert(challengeParticipants).values([
    { challengeId: legacy.id, userId: bob.id, response: 'accepted', respondedAt: new Date() },
    { challengeId: legacy.id, userId: alice.id, response: 'pending' },
  ]);
  r = await call(alice, 'GET', `/challenges/${legacy.id}`);
  check('legacy counter row: pending, not a proposal, alice may accept / counter', r.body?.status === 'pending' && r.body?.isProposal === false
    && r.body?.counteredFromId === orig2 && r.body?.me?.canAccept && r.body?.me?.canCounter && !r.body?.me?.canDecideProposal, r.body);
  r = await call(alice, 'POST', `/challenges/${legacy.id}/accept`);
  check('legacy counter row accepted → active', r.status === 200 && r.body?.status === 'active', r.body);
  await call(alice, 'POST', `/challenges/${legacy.id}/forfeit`);

  // The DB CHECK: a proposal status must name its proposer; countered_from_id is NOT required.
  const pgCode = async (f: () => Promise<unknown>) => { try { await f(); return 'ok'; } catch (e: any) { return String(e?.code ?? e?.cause?.code ?? e?.message); } };
  let code = await pgCode(() => db.insert(challenges).values({ creatorId: alice.id, type: 'high_score', machineId: PRO, endsAt: new Date(Date.now() + H), status: 'proposed' }));
  check('CHECK: status proposed without proposed_by_id → 23514', code === '23514', code);
  code = await pgCode(() => db.insert(challenges).values({ creatorId: alice.id, type: 'high_score', machineId: PRO, endsAt: new Date(Date.now() + H), status: 'lapsed', proposedById: bob.id }));
  check('CHECK: a lapsed proposal whose original is gone (countered_from_id null) is fine', code === 'ok', code);
  code = await pgCode(() => db.insert(challenges).values({ creatorId: alice.id, type: 'high_score', machineId: PRO, endsAt: new Date(Date.now() + H), status: 'rejected', proposedById: bob.id, counteredFromId: orig2 }));
  check('unique: a second proposal by the same player on the same original → 23505', code === '23505', code);
  code = await pgCode(() => db.insert(challengeParticipants).values({ challengeId: orig2, userId: carol.id, response: 'maybe' as any }));
  check("response CHECK still refuses nonsense (and allows 'missed')", code === '23514', code);
  await db.delete(challenges).where(and(eq(challenges.creatorId, alice.id), eq(challenges.status, 'lapsed'), sql`${challenges.counteredFromId} IS NULL`));

  // ── group challenges (feature/group-challenges) ────────────────────────────
  // alice ↔ bob and alice ↔ carol are friends by now; dave is nobody's friend yet.
  const partOf = (b: any, u: number) => b?.participants?.find((p: any) => p.user.id === u);
  const respOf = (b: any, u: number) => partOf(b, u)?.response;
  const postG = (friendIds: number[], body: Record<string, unknown> = {}) => post(alice, { friendIds, type: 'high_score', ...body });
  r = await postG([bob.id, dave.id]);
  check('group: a non-friend among the invitees → 403 not_friends', r.status === 403 && r.body?.code === 'not_friends', r);
  r = await postG([bob.id, bob.id]);
  check('group: the same friend twice → 400 duplicate_invitee', r.status === 400 && r.body?.code === 'duplicate_invitee', r);
  r = await post(alice, { friendIds: [bob.id], friendUsernames: [bob.username], type: 'high_score' });
  check('group: same friend by id and by username → 400 duplicate_invitee', r.status === 400 && r.body?.code === 'duplicate_invitee', r);
  r = await postG([bob.id, carol.id, 1, 2, 3, 4, 5, 6]);
  check('group: more than 8 players → 400 too_many_players', r.status === 400 && r.body?.code === 'too_many_players', r);
  r = await postG([bob.id, alice.id]);
  check('group: yourself among the invitees → 400 cannot_challenge_self', r.status === 400 && r.body?.code === 'cannot_challenge_self', r);
  let [daveFriend] = await db.insert(friendships).values({ requesterId: dave.id, addresseeId: alice.id, status: 'accepted', respondedAt: new Date() }).returning({ id: friendships.id });

  // Partial accept, a decline dropping out, backing out, then everyone answered → it starts.
  r = await postG([bob.id, carol.id, dave.id]);
  check('group create → 201 pending, 4 players', r.status === 201 && r.body?.status === 'pending' && r.body?.participants?.length === 4
    && r.body?.playerCount === 4 && r.body?.maxPlayers === 8, r.body);
  const g1 = r.body.id;
  check('every invitee got challenge_received', (await kinds(bob, g1)).includes('challenge_received') && (await kinds(carol, g1)).includes('challenge_received')
    && (await kinds(dave, g1)).includes('challenge_received'));
  r = await call(bob, 'POST', `/challenges/${g1}/accept`);
  check('bob accepts → still pending (others to answer)', r.status === 200 && r.body?.status === 'pending' && respOf(r.body, bob.id) === 'accepted', r.body);
  r = await call(alice, 'GET', `/challenges/${g1}`);
  check('challenger: Start with who’s in is available once someone accepted', r.body?.me?.canStart === true, r.body?.me);
  r = await call(carol, 'POST', `/challenges/${g1}/decline`, { reason: 'no_thanks' });
  check('carol declines → she drops out, the group stays pending', r.body?.status === 'pending' && respOf(r.body, carol.id) === 'declined'
    && partOf(r.body, carol.id)?.declineReason === 'no_thanks', r.body);
  let decl = (await inbox(alice)).filter(n => n.payload?.challengeId === g1 && n.kind === 'challenge_declined' && n.payload?.userId === carol.id);
  check('challenge_declined carries remaining = 2', decl.length === 1 && decl[0].payload.remaining === 2 && decl[0].payload.backedOut === false
    && decl[0].payload.reason === 'no_thanks', decl);
  r = await call(bob, 'GET', `/challenges/${g1}`);
  check('an accepted player may back out while pending (canDecline)', r.body?.me?.canDecline === true && r.body?.me?.canAccept === false, r.body?.me);
  // A back-out stores 'backed_out' whatever the body says (here a chosen reason, which it overrides).
  r = await call(bob, 'POST', `/challenges/${g1}/decline`, { reason: 'no_thanks' });
  check("bob backs out → recorded declined / reason 'backed_out', still pending (dave to answer)", r.body?.status === 'pending'
    && respOf(r.body, bob.id) === 'declined' && partOf(r.body, bob.id)?.declineReason === 'backed_out', r.body);
  const [bobRow] = await db.select({ reason: challengeParticipants.declineReason }).from(challengeParticipants)
    .where(and(eq(challengeParticipants.challengeId, g1), eq(challengeParticipants.userId, bob.id)));
  check("…the stored decline_reason is 'backed_out'", bobRow?.reason === 'backed_out', bobRow);
  decl = (await inbox(alice)).filter(n => n.payload?.challengeId === g1 && n.kind === 'challenge_declined' && n.payload?.userId === bob.id);
  check("…challenge_declined says reason 'backed_out' (and backedOut)", decl.length === 1 && decl[0].payload.reason === 'backed_out'
    && decl[0].payload.backedOut === true && decl[0].payload.remaining === 1, decl);
  const [boEvent] = await db.select({ payload: activityEvents.payload }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.declined'), eq(activityEvents.targetId, String(g1)), eq(activityEvents.actorUserId, bob.id)));
  check("…challenge.declined activity carries reason 'backed_out'", (boEvent?.payload as any)?.reason === 'backed_out', boEvent);
  r = await call(bob, 'POST', `/challenges/${g1}/accept`);
  check('backed out = out: accepting again → 409', r.status === 409, r);
  r = await call(dave, 'POST', `/challenges/${g1}/accept`);
  check('dave accepts → everyone answered, one accepted → active', r.status === 200 && r.body?.status === 'active', r.body);
  check('group: challenge_started to accepted players but the actor', (await kinds(alice, g1)).includes('challenge_started')
    && !(await kinds(dave, g1)).includes('challenge_started'), [await kinds(alice, g1), await kinds(dave, g1)]);
  await call(dave, 'POST', `/challenges/${g1}/forfeit`);

  // Everyone declines → declined.
  r = await postG([bob.id, carol.id]);
  const g0 = r.body.id;
  await call(bob, 'POST', `/challenges/${g0}/decline`);
  r = await call(bob, 'GET', `/challenges/${g0}`);
  check('one of two declines → still pending', r.body?.status === 'pending', r.body?.status);
  r = await call(carol, 'POST', `/challenges/${g0}/decline`);
  check('nobody pending or accepted → declined', r.body?.status === 'declined', r.body?.status);

  // Start with who's in: pending players become missed.
  r = await postG([bob.id, carol.id, dave.id]);
  const g2 = r.body.id;
  r = await call(alice, 'POST', `/challenges/${g2}/start`);
  check('Start with nobody accepted → 409 cannot_start', r.status === 409 && r.body?.code === 'cannot_start', r);
  await call(bob, 'POST', `/challenges/${g2}/accept`);
  r = await call(bob, 'POST', `/challenges/${g2}/start`);
  check('only the challenger can Start → 409', r.status === 409 && r.body?.code === 'cannot_start', r);
  r = await call(alice, 'POST', `/challenges/${g2}/start`);
  check('Start with who’s in → active; carol and dave missed', r.status === 200 && r.body?.status === 'active'
    && respOf(r.body, carol.id) === 'missed' && respOf(r.body, dave.id) === 'missed' && r.body?.playerCount === 2, r.body);
  check('missed players got challenge_missed, their invitation settled', (await kinds(carol, g2)).includes('challenge_missed')
    && (await inbox(carol)).filter(n => n.payload?.challengeId === g2 && n.kind === 'challenge_received').every(n => n.readAt));
  check('bob got challenge_started (byChallenger)', (await inbox(bob)).some(n => n.payload?.challengeId === g2 && n.kind === 'challenge_started' && n.payload?.byChallenger === true));
  r = await call(carol, 'POST', `/challenges/${g2}/accept`);
  check('a missed player can’t join after the start → 409', r.status === 409, r);
  const [startEvent] = await db.select({ payload: activityEvents.payload }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.started'), eq(activityEvents.targetId, String(g2))));
  check('challenge.started event (start_with_whos_in, 2 players, 2 missed)', (startEvent?.payload as any)?.trigger === 'start_with_whos_in'
    && (startEvent?.payload as any)?.missed === 2, startEvent);
  await call(bob, 'POST', `/challenges/${g2}/forfeit`);

  // A group resolves with ranks; records are pairwise by rank.
  r = await postG([bob.id, carol.id, dave.id], { matchMode: 'exact' });
  const g3 = r.body.id;
  for (const u of [bob, carol, dave]) await call(u, 'POST', `/challenges/${g3}/accept`);
  r = await call(alice, 'GET', `/challenges/${g3}`);
  check('all three accepted → active', r.body?.status === 'active', r.body?.status);
  const [g3Row] = await db.select({ startsAt: challenges.startsAt }).from(challenges).where(eq(challenges.id, g3));
  // The window started on the DB clock; pull it back a minute so this machine's clock can't land an upload before it.
  await setWindow(g3, new Date(+g3Row.startsAt! - 60_000), new Date(Date.now() + 48 * H));
  await upload(alice, { score: 3_000_000 });
  await upload(bob, { score: 2_000_000 });
  await upload(carol, { score: 1_000_000 });
  const posted = (await inbox(dave)).filter(n => n.payload?.challengeId === g3 && n.kind === 'challenge_opponent_scored' && !n.readAt);
  check('one unread "X posted" per challenge, naming the newest poster', posted.length === 1 && posted[0].payload.userId === carol.id, posted);
  r = await call(dave, 'GET', `/challenges/${g3}`);
  check('live ranks for the group', standing(r.body, alice.id)?.liveRank === 1 && standing(r.body, bob.id)?.liveRank === 2
    && standing(r.body, carol.id)?.liveRank === 3, r.body?.participants);
  check('…dave, with no counting score, is not ranked (liveRank null, not 4th)', standing(r.body, dave.id) != null
    && standing(r.body, dave.id)?.liveRank === null && standing(r.body, dave.id)?.countingCount === 0, standing(r.body, dave.id));
  await setWindow(g3, new Date(+g3Row.startsAt! - 60_000), new Date(Date.now() - 500));
  await runChallengeSweep();
  r = await call(bob, 'GET', `/challenges/${g3}`);
  check('group result: alice win 1, bob loss 2, carol loss 3, dave no_show 4', r.body?.status === 'resolved'
    && partOf(r.body, alice.id)?.outcome === 'win' && partOf(r.body, alice.id)?.rank === 1
    && partOf(r.body, bob.id)?.outcome === 'loss' && partOf(r.body, bob.id)?.rank === 2
    && partOf(r.body, carol.id)?.outcome === 'loss' && partOf(r.body, carol.id)?.rank === 3
    && partOf(r.body, dave.id)?.outcome === 'no_show' && partOf(r.body, dave.id)?.rank === 4, r.body?.participants);
  const res3 = (await inbox(bob)).filter(n => n.payload?.challengeId === g3 && n.kind === 'challenge_result');
  check('challenge_result carries rank, playerCount and winners', res3.length === 1 && res3[0].payload.rank === 2 && res3[0].payload.playerCount === 4
    && res3[0].payload.winners?.length === 1 && res3[0].payload.winners[0].userId === alice.id, res3);
  r = await call(carol, 'GET', '/challenges/record');
  const h2h = (b: any, u: number) => b?.headToHead?.find((h: any) => h.opponent.id === u);
  check("carol's record: headline loss (3rd of 4); head-to-head: lost to alice and bob, beat dave (no-show)", r.body?.losses >= 1
    && h2h(r.body, alice.id)?.losses >= 1 && h2h(r.body, bob.id)?.losses === 1 && h2h(r.body, bob.id)?.wins === 0
    && h2h(r.body, dave.id)?.wins === 1 && typeof r.body?.bestLossStreak === 'number', r.body);
  r = await call(bob, 'GET', `/challenges/record/${encodeURIComponent(carol.username)}`);
  check("bob sees carol's record vs him only: carol 0–1", r.body?.headToHead?.length === 1 && h2h(r.body, bob.id)?.losses === 1, r.body?.headToHead);

  // ── one "X posted" notice per score, however many challenges it counts in (2026-09-30) ──
  // mx = alice + bob + carol (group), my = alice vs bob (1:1), both on OTHER (exact) so
  // no earlier upload in this run can land in their windows. Will saw three identical
  // "@bumper_brit posted 12,480,000" notices for one score before.
  r = await postG([bob.id, carol.id], { machineId: OTHER, matchMode: 'exact' });
  const mx = r.body.id;
  await call(bob, 'POST', `/challenges/${mx}/accept`);
  await call(carol, 'POST', `/challenges/${mx}/accept`);
  r = await post(alice, { friendId: bob.id, type: 'high_score', machineId: OTHER, matchMode: 'exact' });
  const my = r.body.id;
  await call(bob, 'POST', `/challenges/${my}/accept`);
  for (const id of [mx, my]) {
    const [row] = await db.select({ startsAt: challenges.startsAt, status: challenges.status }).from(challenges).where(eq(challenges.id, id));
    check(`collapse fixture ${id} is active`, row.status === 'active', row);
    await setWindow(id, new Date(+row.startsAt! - 60_000), new Date(Date.now() + 48 * H));
  }
  const about = (n: any, id: number) => n.payload?.challengeId === id || (n.payload?.challengeIds ?? []).includes(id);
  const unreadPosted = async (who: { id: number }) => (await inbox(who))
    .filter(n => n.kind === 'challenge_opponent_scored' && !n.readAt && (about(n, mx) || about(n, my)));
  // Before anyone posts: a live group where nobody has a counting score ranks nobody.
  r = await call(bob, 'GET', `/challenges/${mx}`);
  check('live, nobody posted yet: nobody ranked', ['alice', 'bob', 'carol'].every((_, i) => standing(r.body, [alice.id, bob.id, carol.id][i])?.liveRank === null), r.body?.participants);
  let cs = await upload(alice, { score: 4_000_000, machineId: OTHER });
  const a1 = cs.body.id;
  let up = await unreadPosted(bob);
  check('one score counting in two challenges → ONE notice for bob, listing both', up.length === 1 && up[0].payload.scoreId === a1
    && about(up[0], mx) && about(up[0], my) && up[0].payload.challengeCount === up[0].payload.challengeIds?.length
    && up[0].payload.challengeCount >= 2 && typeof up[0].payload.scoreMachineName === 'string', up);
  check('…backward compatible: top-level challengeId is one of them, with type, machine, score and the scorer',
    up.length === 1 && [mx, my].includes(up[0].payload.challengeId) && up[0].payload.challengeType === 'high_score'
    && typeof up[0].payload.machineName === 'string' && up[0].payload.score === 4_000_000 && up[0].payload.userId === alice.id
    && up[0].payload.username === alice.username, up[0]?.payload);
  up = await unreadPosted(carol);
  check('carol (in the group only) gets one notice, about the group only', up.length === 1 && about(up[0], mx) && !about(up[0], my)
    && up[0].payload.challengeCount === 1, up);
  // Unposted players are not ranked — detail and list.
  r = await call(bob, 'GET', `/challenges/${mx}`);
  check('live standings: alice (posted) ranked 1st; bob and carol (no score) unranked', standing(r.body, alice.id)?.liveRank === 1
    && standing(r.body, bob.id)?.liveRank === null && standing(r.body, carol.id)?.liveRank === null, r.body?.participants);
  r = await call(bob, 'GET', '/challenges?status=active');
  const myRow = (r.body ?? []).find((c: any) => c.id === my);
  check('list: in the 1:1, bob (no score) has no live rank — not "2nd of 2"', myRow && standing(myRow, bob.id)?.liveRank === null
    && standing(myRow, alice.id)?.liveRank === 1, myRow?.participants);
  cs = await upload(alice, { score: 4_500_000, machineId: OTHER });
  const a2 = cs.body.id;
  up = await unreadPosted(bob);
  check('a newer score from the same scorer replaces the older unread notice (no stacking)', up.length === 1 && up[0].payload.scoreId === a2
    && up[0].payload.score === 4_500_000 && about(up[0], mx) && about(up[0], my), up);
  cs = await upload(carol, { score: 1_000_000, machineId: OTHER }); // counts in mx only
  up = await unreadPosted(bob);
  const fromCarol = up.filter(n => n.payload.userId === carol.id);
  const fromAlice = up.filter(n => n.payload.userId === alice.id);
  check('another scorer in one of them: her notice takes that challenge; the older one keeps only the other', fromCarol.length === 1
    && about(fromCarol[0], mx) && !about(fromCarol[0], my) && fromAlice.length === 1 && about(fromAlice[0], my) && !about(fromAlice[0], mx)
    && fromAlice[0].payload.scoreId === a2 && fromAlice[0].payload.challengeCount === fromAlice[0].payload.challengeIds.length, up);
  check('…each challenge still has exactly one unread opponent-scored notice', [mx, my].every(id => up.filter(n => about(n, id)).length === 1), up);
  r = await call(bob, 'GET', `/challenges/${mx}`);
  check('now alice 1st, carol 2nd, bob (no score) unranked', standing(r.body, alice.id)?.liveRank === 1 && standing(r.body, carol.id)?.liveRank === 2
    && standing(r.body, bob.id)?.liveRank === null, r.body?.participants);
  // A read notice is left alone; the next score raises a fresh one.
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, bob.id), eq(notifications.kind, 'challenge_opponent_scored'),
    sql`(${notifications.payload} ->> 'challengeId')::int IN (${mx}, ${my})`));
  cs = await upload(alice, { score: 5_000_000, machineId: OTHER });
  const readKept = (await inbox(bob)).filter(n => n.kind === 'challenge_opponent_scored' && n.readAt && n.payload.scoreId === a2);
  up = await unreadPosted(bob);
  check('read notices are never rewritten; a new score raises one fresh unread', readKept.length === 1 && about(readKept[0], my) && !about(readKept[0], mx)
    && up.length === 1 && up[0].payload.scoreId === cs.body.id, { readKept, up });
  await call(bob, 'POST', `/challenges/${my}/forfeit`);
  await call(bob, 'POST', `/challenges/${mx}/forfeit`);
  await call(carol, 'POST', `/challenges/${mx}/forfeit`);

  // Fixed start: it starts with whoever accepted; the rest are missed. Sweep path, then the score-hook path.
  r = await postG([bob.id, carol.id], { startsAt: iso(2 * H), endsAt: iso(30 * H) });
  const g4 = r.body.id;
  await call(bob, 'POST', `/challenges/${g4}/accept`);
  r = await call(bob, 'GET', `/challenges/${g4}`);
  check('fixed start ahead, carol still pending → pending', r.body?.status === 'pending', r.body?.status);
  await setWindow(g4, new Date(Date.now() - 60_000), new Date(Date.now() + 30 * H));
  await runChallengeSweep();
  r = await call(alice, 'GET', `/challenges/${g4}`);
  check('fixed start passed (sweep): active with alice + bob, carol missed', r.body?.status === 'active' && respOf(r.body, carol.id) === 'missed', r.body);
  await call(bob, 'POST', `/challenges/${g4}/forfeit`);

  r = await postG([bob.id, carol.id], { startsAt: iso(2 * H), endsAt: iso(30 * H) });
  const g5 = r.body.id;
  await call(bob, 'POST', `/challenges/${g5}/accept`);
  await setWindow(g5, new Date(Date.now() - 60_000), new Date(Date.now() + 30 * H));
  s = await upload(bob, { score: 1234 });
  const [g5Row] = await db.select({ status: challenges.status }).from(challenges).where(eq(challenges.id, g5));
  check('score hook: a pending group past its fixed start starts on the upload, and the score counts (locked)', g5Row.status === 'active'
    && (await db.select().from(challengeScores).where(and(eq(challengeScores.challengeId, g5), eq(challengeScores.scoreId, s.body.id)))).length === 1, g5Row);
  await call(bob, 'POST', `/challenges/${g5}/forfeit`);

  // Two counters: taking one supersedes the other; re-invites skip ex-friends; everyone re-accepts.
  r = await postG([bob.id, carol.id, dave.id]);
  const g6 = r.body.id;
  await call(dave, 'POST', `/challenges/${g6}/accept`);
  r = await call(bob, 'POST', `/challenges/${g6}/counter`, counterBody);
  const p1 = r.body?.counter?.id;
  r = await call(carol, 'POST', `/challenges/${g6}/counter`, { ...counterBody, machineId: PREM });
  const p2 = r.body?.counter?.id;
  r = await call(alice, 'GET', `/challenges/${g6}`);
  check('two open proposals block the start (nobody pending, dave accepted)', r.body?.status === 'pending' && r.body?.proposals?.length === 2, r.body);
  r = await call(bob, 'GET', `/challenges/${g6}`);
  check('a proposer sees only their own proposal on the original', r.body?.proposals?.length === 1 && r.body.proposals[0].id === p1, r.body?.proposals);
  r = await call(dave, 'GET', `/challenges/${g6}`);
  check('another invitee sees no proposals', r.body?.proposals?.length === 0, r.body?.proposals);
  r = await call(dave, 'GET', `/challenges/${p1}`);
  check('privacy: a proposal is 404 to the other invitees', r.status === 404, r);
  await db.delete(friendships).where(eq(friendships.id, daveFriend.id));
  r = await call(alice, 'POST', `/challenges/${p1}/accept`);
  check("take bob's for everyone → pending on the new machine (carol re-invited)", r.status === 200 && r.body?.status === 'pending'
    && respOf(r.body, alice.id) === 'accepted' && respOf(r.body, bob.id) === 'accepted' && respOf(r.body, carol.id) === 'pending', r.body);
  check('…dave (no longer alice’s friend) is not re-invited', !partOf(r.body, dave.id), r.body?.participants);
  r = await call(alice, 'GET', `/challenges/${g6}`);
  check('original → countered, links to the taken one; the other proposal superseded (rejected)', r.body?.status === 'countered'
    && r.body?.counteredToId === p1 && r.body?.proposals?.find((p: any) => p.id === p2)?.status === 'rejected', r.body);
  check('carol: challenge_counter_rejected superseded + challenge_moved to the new one', (await inbox(carol)).some(n => n.kind === 'challenge_counter_rejected'
    && n.payload?.challengeId === p2 && n.payload?.reason === 'superseded')
    && (await inbox(carol)).some(n => n.kind === 'challenge_moved' && n.payload?.challengeId === p1 && n.payload?.fromChallengeId === g6));
  const [aliceOnP2] = await db.select().from(challengeParticipants).where(and(eq(challengeParticipants.challengeId, p2), eq(challengeParticipants.userId, alice.id)));
  const p2Events = await db.select({ actor: activityEvents.actorUserId }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.counter_rejected'), eq(activityEvents.targetId, String(p2))));
  check("superseded: the challenger's row on it → declined; one event, actor = the challenger (she took the other)", aliceOnP2?.response === 'declined'
    && aliceOnP2?.respondedAt != null && p2Events.length === 1 && p2Events[0].actor === alice.id, { aliceOnP2, p2Events });
  r = await call(carol, 'POST', `/challenges/${p1}/accept`);
  check('carol re-accepts → everyone in → active', r.status === 200 && r.body?.status === 'active', r.body);
  check("accepting settles carol's challenge_moved", (await inbox(carol)).filter(n => n.payload?.challengeId === p1 && n.kind === 'challenge_moved').every(n => n.readAt));
  await call(carol, 'POST', `/challenges/${p1}/forfeit`);
  await call(bob, 'POST', `/challenges/${p1}/forfeit`);
  [daveFriend] = await db.insert(friendships).values({ requesterId: dave.id, addresseeId: alice.id, status: 'accepted', respondedAt: new Date() }).returning({ id: friendships.id });

  // Re-invite: previously accepted players must re-accept; no_thanks decliners aren't asked again.
  r = await postG([bob.id, carol.id, dave.id]);
  const g7 = r.body.id;
  await call(dave, 'POST', `/challenges/${g7}/accept`);
  await call(carol, 'POST', `/challenges/${g7}/decline`, { reason: 'no_thanks' });
  r = await call(bob, 'POST', `/challenges/${g7}/counter`, counterBody);
  const p3 = r.body?.counter?.id;
  r = await call(alice, 'POST', `/challenges/${p3}/accept`);
  check('taken: dave (had accepted) re-invited as pending; carol (no_thanks) not asked again', r.body?.status === 'pending'
    && respOf(r.body, dave.id) === 'pending' && !partOf(r.body, carol.id), r.body?.participants);
  check('dave got challenge_moved', (await kinds(dave, p3)).includes('challenge_moved'));
  await call(alice, 'POST', `/challenges/${p3}/cancel`);

  // Keep the original: the proposal is rejected, the proposer stays out, and the original starts (L).
  r = await postG([bob.id, carol.id]);
  const g8 = r.body.id;
  await call(carol, 'POST', `/challenges/${g8}/accept`);
  r = await call(bob, 'POST', `/challenges/${g8}/counter`, counterBody);
  const p4 = r.body?.counter?.id;
  // The one reminder: 24 h unanswered → the sweep re-raises challenge_countered once.
  await db.update(challenges).set({ createdAt: new Date(Date.now() - 25 * H) }).where(eq(challenges.id, p4));
  const sw1 = await runChallengeSweep();
  const sw2 = await runChallengeSweep();
  const reminders = (await inbox(alice)).filter(n => n.payload?.challengeId === p4 && n.kind === 'challenge_countered' && n.payload?.reminder === true);
  const [p4Row] = await db.select({ at: challenges.proposalRemindedAt }).from(challenges).where(eq(challenges.id, p4));
  check('proposal reminder: once, after 24 h (durable marker)', reminders.length === 1 && p4Row.at != null && sw1.proposalReminders >= 1 && sw2.proposalReminders === 0,
    { reminders, p4Row, sw1, sw2 });
  r = await call(alice, 'POST', `/challenges/${p4}/decline`);
  check('keep mine → proposal rejected', r.body?.status === 'rejected', r.body?.status);
  r = await call(alice, 'GET', `/challenges/${g8}`);
  check('…the original starts with carol (bob stays out)', r.body?.status === 'active' && respOf(r.body, bob.id) === 'countered', r.body);
  await call(carol, 'POST', `/challenges/${g8}/forfeit`);

  // Proposals close when the original starts (challenger's Start → rejected 'started'; fixed start →
  // lapsed), is cancelled (lapsed), or the proposal's own window passes (lapsed, then the original re-checks).
  const openProposalOn = async (friendIds: number[], extra: Record<string, unknown> = {}) => {
    const made = await postG(friendIds, extra);
    if (friendIds.includes(carol.id)) await call(carol, 'POST', `/challenges/${made.body.id}/accept`);
    const ct = await call(bob, 'POST', `/challenges/${made.body.id}/counter`, counterBody);
    return { gid: made.body.id as number, pid: ct.body?.counter?.id as number };
  };
  const statusOf = async (id: number) => (await db.select({ s: challenges.status }).from(challenges).where(eq(challenges.id, id)))[0]?.s;
  const reasonTo = async (who: typeof bob, pid: number) => (await inbox(who)).find(n => n.kind === 'challenge_counter_rejected' && n.payload?.challengeId === pid)?.payload?.reason;
  const challengerOn = async (pid: number) => (await db.select().from(challengeParticipants)
    .where(and(eq(challengeParticipants.challengeId, pid), eq(challengeParticipants.userId, alice.id))))[0];
  const rejActors = async (pid: number) => (await db.select({ actor: activityEvents.actorUserId }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'challenge.counter_rejected'), eq(activityEvents.targetId, String(pid))))).map(e => e.actor);
  let o = await openProposalOn([bob.id, carol.id]);
  await call(alice, 'POST', `/challenges/${o.gid}/start`);
  check('Start with who’s in rejects the open proposal (reason started)', await statusOf(o.gid) === 'active' && await statusOf(o.pid) === 'rejected'
    && await reasonTo(bob, o.pid) === 'started', [await statusOf(o.gid), await statusOf(o.pid), await reasonTo(bob, o.pid)]);
  let cOn = await challengerOn(o.pid);
  check("…the challenger's row on it → declined (responded_at stamped); one event, actor = the challenger", cOn?.response === 'declined' && cOn?.respondedAt != null
    && JSON.stringify(await rejActors(o.pid)) === JSON.stringify([alice.id]), [cOn, await rejActors(o.pid)]);
  await call(carol, 'POST', `/challenges/${o.gid}/forfeit`);
  o = await openProposalOn([bob.id, carol.id], { startsAt: iso(2 * H), endsAt: iso(30 * H) });
  await setWindow(o.gid, new Date(Date.now() - 60_000), new Date(Date.now() + 30 * H));
  await runChallengeSweep();
  check('fixed start: the original starts, the proposal lapses (reason started)', await statusOf(o.gid) === 'active' && await statusOf(o.pid) === 'lapsed'
    && await reasonTo(bob, o.pid) === 'started', [await statusOf(o.gid), await statusOf(o.pid)]);
  cOn = await challengerOn(o.pid);
  check("…the challenger's row on it → missed (no responded_at); one event, actor null (system)", cOn?.response === 'missed' && cOn?.respondedAt == null
    && JSON.stringify(await rejActors(o.pid)) === JSON.stringify([null]), [cOn, await rejActors(o.pid)]);
  await call(carol, 'POST', `/challenges/${o.gid}/forfeit`);
  o = await openProposalOn([bob.id]);
  await call(alice, 'POST', `/challenges/${o.gid}/cancel`);
  check('cancel: the proposal lapses (reason cancelled)', await statusOf(o.gid) === 'cancelled' && await statusOf(o.pid) === 'lapsed'
    && await reasonTo(bob, o.pid) === 'cancelled', [await statusOf(o.gid), await statusOf(o.pid)]);
  cOn = await challengerOn(o.pid);
  check("…the challenger's row on it → missed; one event, actor = the challenger (her cancel)", cOn?.response === 'missed'
    && JSON.stringify(await rejActors(o.pid)) === JSON.stringify([alice.id]), [cOn, await rejActors(o.pid)]);
  o = await openProposalOn([bob.id, carol.id]);
  await setWindow(o.pid, null, new Date(Date.now() - 60_000));
  await runChallengeSweep();
  check("the proposal's own window passed: lapsed (expired), and the original then starts with carol", await statusOf(o.pid) === 'lapsed'
    && await reasonTo(bob, o.pid) === 'expired' && await statusOf(o.gid) === 'active', [await statusOf(o.pid), await statusOf(o.gid)]);
  cOn = await challengerOn(o.pid);
  check("…the challenger's row on it → missed; one event, actor null (system)", cOn?.response === 'missed'
    && JSON.stringify(await rejActors(o.pid)) === JSON.stringify([null]), [cOn, await rejActors(o.pid)]);
  await call(carol, 'POST', `/challenges/${o.gid}/forfeit`);

  // most_improved: a decline that makes the group start must never fail on a missing baseline.
  r = await postG([bob.id, carol.id], { type: 'most_improved' });
  const g9 = r.body.id;
  await call(bob, 'POST', `/challenges/${g9}/accept`);
  // Take alice's baseline away (every score of hers on the game, moved aside for a moment) — then carol declines.
  const aside = await db.select({ id: scores.id, machineId: scores.machineId }).from(scores)
    .where(and(eq(scores.userId, alice.id), inArray(scores.machineId, [PRO, PREM])));
  if (aside.length) await db.update(scores).set({ machineId: OTHER }).where(inArray(scores.id, aside.map(x => x.id)));
  r = await call(carol, 'POST', `/challenges/${g9}/decline`);
  check('most_improved: a decline that starts it succeeds even though the challenger lost her baseline (no creator_no_baseline)', r.status === 200
    && r.body?.status === 'active' && partOf(r.body, alice.id)?.baselineScore === null, r);
  for (const m of [PRO, PREM]) {
    const back = aside.filter(x => x.machineId === m).map(x => x.id);
    if (back.length) await db.update(scores).set({ machineId: m }).where(inArray(scores.id, back));
  }
  await call(bob, 'POST', `/challenges/${g9}/forfeit`);

  // Durable badge facts (phase 3 reads these; see the badges plan).
  const n = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)) as any)[0]?.n ?? 0);
  const countersAccepted = (u: number) => n(sql`SELECT count(*)::int AS n FROM challenges WHERE
    (proposed_by_id = ${u} AND proposal_decided_at IS NOT NULL AND status NOT IN ('proposed', 'rejected', 'lapsed'))
    OR (proposed_by_id IS NULL AND countered_from_id IS NOT NULL AND creator_id = ${u} AND status IN ('active', 'resolved'))`);
  const countersRejected = (u: number) => n(sql`SELECT count(*)::int AS n FROM challenges WHERE proposed_by_id = ${u} AND status = 'rejected'`);
  const missedCount = (u: number) => n(sql`SELECT count(*)::int AS n FROM challenge_participants WHERE user_id = ${u} AND response = 'missed'`);
  // challenges_backed_out / challenges_declined (a true decline: not a back-out, not a counter; never a proposal row).
  const backedOutCount = (u: number) => n(sql`SELECT count(*)::int AS n FROM challenge_participants cp JOIN challenges c ON c.id = cp.challenge_id
    WHERE cp.user_id = ${u} AND cp.response = 'declined' AND cp.decline_reason = 'backed_out' AND c.status NOT IN ('proposed', 'rejected', 'lapsed')`);
  const declinedCount = (u: number) => n(sql`SELECT count(*)::int AS n FROM challenge_participants cp JOIN challenges c ON c.id = cp.challenge_id
    WHERE cp.user_id = ${u} AND cp.response = 'declined' AND cp.decline_reason IS DISTINCT FROM 'backed_out' AND c.status NOT IN ('proposed', 'rejected', 'lapsed')`);
  const allDeclined = (u: number) => n(sql`SELECT count(*)::int AS n FROM challenge_participants WHERE user_id = ${u} AND response = 'declined'`);
  // bob: taken = 1:1 ctr, p1, p3 (+ the legacy row he created, accepted) = 4; rejected = ctr2, p4, the Start one = 3.
  check('badge fact counters_accepted (bob = 4, incl. the legacy row)', await countersAccepted(bob.id) === 4, await countersAccepted(bob.id));
  check('badge fact counters_rejected (bob = 3: kept-mine ×2 + started)', await countersRejected(bob.id) === 3, await countersRejected(bob.id));
  check("badge fact counters_rejected counts superseded too (carol's p2)", await countersRejected(carol.id) === 1, await countersRejected(carol.id));
  check('badge fact challenges_missed (carol: Start g2, fixed start g4, score-hook start g5 = 3; dave g2 = 1)', await missedCount(carol.id) === 3 && await missedCount(dave.id) === 1,
    [await missedCount(carol.id), await missedCount(dave.id)]);
  const bo = await backedOutCount(bob.id), dc = await declinedCount(bob.id), all = await allDeclined(bob.id);
  check('badge fact challenges_backed_out (bob = 1: g1)', bo === 1, bo);
  check('badge fact challenges_declined excludes back-outs (bob = 5 of his 6 declined rows)', dc === 5 && all === 6, { dc, bo, all });
  // Badges phase 3: the registry's metrics read exactly these facts. challenges_missed also skips
  // proposal rows (a lapsed suggestion's challenger row is 'missed' — not a challenge she missed).
  const missedNoProposals = (u: number) => n(sql`SELECT count(*)::int AS n FROM challenge_participants cp JOIN challenges c ON c.id = cp.challenge_id
    WHERE cp.user_id = ${u} AND cp.response = 'missed' AND c.status NOT IN ('proposed', 'rejected', 'lapsed')`);
  const facts: Array<[string, (u: number) => Promise<number>]> = [
    ['counters_accepted', countersAccepted], ['counters_rejected', countersRejected], ['challenges_backed_out', backedOutCount],
    ['challenges_declined', declinedCount], ['challenges_missed', missedNoProposals],
  ];
  const mismatches: unknown[] = [];
  for (const p of people) {
    for (const [key, fact] of facts) {
      const [metric, expected] = [await readMetric(db, key, p.id), await fact(p.id)];
      if (metric !== expected) mismatches.push({ user: p.username, key, metric, expected });
    }
  }
  check('badge metrics (readMetric) match the durable facts for all four players', mismatches.length === 0, mismatches);
  check('challenges_missed metric: carol = 3, dave = 1', await readMetric(db, 'challenges_missed', carol.id) === 3 && await readMetric(db, 'challenges_missed', dave.id) === 1);
  const aliceMissedRaw = await missedCount(alice.id), aliceMissed = await readMetric(db, 'challenges_missed', alice.id);
  check('…and it leaves out the challenger’s rows on lapsed suggestions', aliceMissed <= aliceMissedRaw, { aliceMissed, aliceMissedRaw });

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

  // Empty q → "Recently played": your venues by latest played_at, newest first, listed ones left out.
  const recentVenues = await db.insert(venues).values([
    { name: 'zz-challenge-test recent newest', city: 'Zzton', state: 'ZZ' },
    { name: 'zz-challenge-test recent oldest', city: 'Zzton', state: 'ZZ' },
    { name: 'zz-challenge-test carol shed', isResidence: true, ownerId: carol.id, city: 'Zzshed', state: 'ZZ' },
  ]).returning({ id: venues.id, name: venues.name });
  venueIds.push(...recentVenues.map(v => v.id));
  const [NEWEST, OLDEST, SHED] = recentVenues;
  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  await db.insert(scores).values([
    // NEWEST's latest play is the most recent even though it also has the oldest play of the three.
    { userId: bob.id, machineId: PRO, venueId: NEWEST.id, venueName: NEWEST.name, score: 11, playedAt: ago(5), createdAt: ago(5) },
    { userId: bob.id, machineId: PRO, venueId: NEWEST.id, venueName: NEWEST.name, score: 12, playedAt: ago(60 * 24 * 30), createdAt: ago(60 * 24 * 30) },
    { userId: bob.id, machineId: PRO, venueId: SHED.id, venueName: SHED.name, score: 13, playedAt: ago(10), createdAt: ago(10) },
    { userId: bob.id, machineId: PRO, venueId: OLDEST.id, venueName: OLDEST.name, score: 14, playedAt: ago(15), createdAt: ago(15) },
    // A more recent play at a venue already in bob's list must not surface it.
    { userId: bob.id, machineId: PRO, venueId: ARCADE.id, venueName: ARCADE.name, score: 15, playedAt: ago(1), createdAt: ago(1) },
  ]);
  r = await call(bob, 'GET', '/me/challenge-venue-search?q=');
  const recentIds = hitIds(r.body);
  const order = recentIds.filter(id => [NEWEST.id, SHED.id, OLDEST.id].includes(id));
  check('empty q → 200, your venues ordered by most recent play (≤6)', r.status === 200 && recentIds.length <= 6
    && JSON.stringify(order) === JSON.stringify([NEWEST.id, SHED.id, OLDEST.id]), r.body);
  check('empty q leaves out venues already in your list', [PMV.id, BOB_HOME.id, CAROL_HOME.id, ARCADE.id].every(id => !recentIds.includes(id)), r.body);
  check("empty q never includes a stranger's residence", !recentIds.includes(CABIN.id) && !JSON.stringify(r.body).includes(CABIN.name), r.body);
  const shedHit = (r.body ?? []).find?.((h: any) => h.id === SHED.id);
  check("empty q: a private venue you've scored at is name only — no city/state", shedHit
    && shedHit.city === null && shedHit.state === null && shedHit.isPrivate === true && shedHit.isHome === false, r.body);
  const newestHit = (r.body ?? []).find?.((h: any) => h.id === NEWEST.id);
  check('empty q: a public venue keeps its city/state', newestHit?.city === 'Zzton' && newestHit?.state === 'ZZ', r.body);
  r = await call(bob, 'GET', '/me/challenge-venue-search');
  check('absent q behaves like empty q', r.status === 200 && JSON.stringify(hitIds(r.body)) === JSON.stringify(recentIds), r.body);
  r = await call(alice, 'GET', '/me/challenge-venue-search?q=');
  check("empty q: alice (never played there) gets none of bob's recent venues or anyone's residence", r.status === 200
    && [NEWEST.id, OLDEST.id, SHED.id, BOB_HOME.id, CAROL_HOME.id, CABIN.id].every(id => !hitIds(r.body).includes(id)), r.body);
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

  // Group recommendations: GET /api/challenges/recommendations?users=a,b (zero Pinball Map calls).
  const pmBeforeGroup = pmClient().stats().liveCallsToday;
  r = await call(alice, 'GET', `/challenges/recommendations?users=${encodeURIComponent(bob.username)}`);
  check('group recs with one user = exactly the single-friend list', r.status === 200 && r.body?.users?.length === 1
    && JSON.stringify(r.body?.recommendations) === JSON.stringify(recs.body?.recommendations), { group: r.body?.recommendations, single: recs.body?.recommendations });
  r = await call(alice, 'GET', `/challenges/recommendations?users=${encodeURIComponent(bob.username)},${encodeURIComponent(carol.username)}`);
  const grec = (id: number) => r.body?.recommendations?.find((x: any) => x.machineId === id);
  check('group recs → 200, both users', r.status === 200 && r.body?.users?.map((u: any) => u.id).join() === [bob.id, carol.id].join(), r);
  check('group recs: the machine both can reach ranks first, with coverage 2', r.body?.recommendations?.[0]?.machineId === PRO
    && grec(PRO)?.coverage === 2 && grec(PRO)?.reachedBy?.includes(bob.id) && grec(PRO)?.reachedBy?.includes(carol.id), r.body?.recommendations);
  check("group recs: bob's own residence machine shows as atHomeOf bob, never 'at home' or the venue's name", JSON.stringify(grec(HOME_M)?.atHomeOf) === JSON.stringify([bob.id])
    && !JSON.stringify(r.body).includes('at home') && !JSON.stringify(r.body).includes(BOB_HOME.name) && !JSON.stringify(r.body).includes(CAROL_HOME.name), r.body);
  r = await call(carol, 'GET', `/challenges/recommendations?users=${encodeURIComponent(bob.username)}`);
  check('group recs for a non-friend → 403 not_friends', r.status === 403 && r.body?.code === 'not_friends', r);
  r = await call(alice, 'GET', `/challenges/recommendations?users=${encodeURIComponent(bob.username)},zz-nobody-here`);
  check('group recs with an unknown user → 404', r.status === 404 && r.body?.code === 'user_not_found', r);
  r = await call(alice, 'GET', `/challenges/recommendations?users=${encodeURIComponent(bob.username)},${encodeURIComponent(bob.username)}`);
  check('group recs with a repeat → 400 duplicate_invitee', r.status === 400 && r.body?.code === 'duplicate_invitee', r);
  r = await call(alice, 'GET', '/challenges/recommendations?users=');
  check('group recs without users → 400', r.status === 400, r);
  check('group recs: zero Pinball Map calls', pmClient().stats().liveCallsToday === pmBeforeGroup);
  const recsSrc = readFileSync(new URL('./src/lib/challengeRecs.ts', import.meta.url), 'utf8');
  check('challengeRecs.ts imports nothing Pinball Map (pure)', !/from '\.\/(pmRosterCache|pmClient|pinballMap|pinballmapApi)\.js'/.test(recsSrc) && !/from '/.test(recsSrc.replace(/^\/\/.*$/gm, '')));

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

  // ── a Pinball Map-only place as a challenge location (feature/pm-challenge-locations) ──
  // The card's flow, route by route: Near me (POST /upload/nearby-venues) / the search's Places
  // fallback (GET /venues/search) → POST /venues (409 duplicate) → GET /venues/pm-match (only for a
  // place with no Pinball Map id — a Near-me place that has one skips it) →
  // POST /venues/:id/repair/pm-link (the one roster read, into pm_location_cache) → PUT prefs →
  // recommendations read that cached roster with zero Pinball Map requests. HERE is the test double
  // above; Pinball Map answers from the offline fixtures for Red Nun Bar & Grill (#20676, Dennis MA).
  {
    const PM_FIXTURE_ID = 20676;
    const at = { lat: 41.66778, lng: -70.12377 }; // exactly the recorded closest_by_lat_lon fixture's point
    const PLACE = `zz-challenge-test red nun ${Date.now()}`;
    herePlace = { id: `here:zz-challenge-test:${Date.now()}`, title: PLACE, ...at, label: '673 Main St, Dennis, MA 02639, United States' };
    const rosterNames: string[] = JSON.parse(readFileSync(new URL('./fixtures/pm/locations_20676.json__20a9c95d.json', import.meta.url), 'utf8'))
      .body.location_machine_xrefs.map((x: any) => String(x.name ?? x.machine?.name ?? ''));
    // Rows pm-link may write or touch, put back exactly as they were at the end.
    pmRestore.location = (await db.select().from(pmLocationCache).where(eq(pmLocationCache.pmLocationId, PM_FIXTURE_ID)))[0] ?? null;
    pmRestore.locationHash = await pmRowHash('pm_location_cache', `pm_location_id = ${PM_FIXTURE_ID}`);
    pmRestore.catalog = await db.select().from(pmCatalogCache);
    pmRestore.catalogHash = await pmRowHash('pm_catalog_cache', 'true');
    pmRestore.machines = await db.select().from(machines).where(inArray(sql`lower(${machines.name})`, rosterNames.map(n => n.toLowerCase())));
    pmRestore.maxMachineId = (await db.select({ m: sql<number>`coalesce(max(${machines.id}), 0)::int` }).from(machines))[0].m;
    pmRestore.names = rosterNames;
    // A stranger's hidden residence at the very same spot: must never surface to bob.
    const [LAIR] = await db.insert(venues).values({
      name: 'zz-challenge-test carol lair', isResidence: true, privacyTier: 'hidden', ownerId: carol.id, createdById: carol.id,
      latitude: at.lat, longitude: at.lng, city: 'Dennis', state: 'MA',
    }).returning({ id: venues.id, name: venues.name });
    venueIds.push(LAIR.id);
    const pmRequests = countPmRequests();

    r = await call(bob, 'POST', '/upload/nearby-venues', at);
    const nearPlace = (r.body?.venues ?? []).find((v: any) => v.name === PLACE);
    check('Near me → 200: the Pinball Map-only place is offered as a place (no venueId) with its Pinball Map id already matched',
      r.status === 200 && nearPlace && nearPlace.venueId == null && nearPlace.pinballMapId === PM_FIXTURE_ID, r.body);
    check("Near me never offers a stranger's private venue at the same spot", !(r.body?.venues ?? []).some((v: any) => v.venueId === LAIR.id)
      && !JSON.stringify(r.body).includes(LAIR.name), r.body);
    r = await call(carol, 'POST', '/upload/nearby-venues', at);
    check('…while its owner does get it (so the filter is what kept it from bob)', (r.body?.venues ?? []).some((v: any) => v.venueId === LAIR.id), r.body);

    r = await call(bob, 'GET', `/me/challenge-venue-search?q=${encodeURIComponent(PLACE)}`);
    check('challenge-venue search has no TiltTrack match for it yet', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, r.body);
    r = await call(bob, 'GET', `/venues/search?q=${encodeURIComponent(PLACE)}&lat=${at.lat}&lng=${at.lng}`);
    check('Places fallback (GET /venues/search) offers it as a HERE place', r.status === 200 && r.body?.places?.some((p: any) => p.name === PLACE)
      && !r.body?.tiltTrack?.some((v: any) => v.name === PLACE), r.body);
    r = await call(bob, 'GET', `/venues/search?q=${encodeURIComponent('zz challenge test carol lair')}&lat=${at.lat}&lng=${at.lng}`);
    check("Places fallback never returns a stranger's private venue", r.status === 200 && !r.body?.tiltTrack?.some((v: any) => v.id === LAIR.id)
      && !JSON.stringify(r.body).includes(LAIR.name), r.body);
    r = await call(bob, 'GET', `/me/challenge-venue-search?q=${encodeURIComponent('zz challenge test carol lair')}`);
    check("…nor does the challenge-venue search", r.status === 200 && !hitIds(r.body).includes(LAIR.id), r.body);

    // The card's Near-me pick, as the client makes it: the place carries its Pinball Map id, so it's
    // POST /venues → pm-link with that id — no pm-match. Age the fixture's roster row past pm-link's
    // force window (FORCE_MIN_AGE_MS, 5 min) so the roster read is deterministic: exactly 1 request.
    // (The row is put back in `finally` — it's hash-compared.)
    await db.update(pmLocationCache).set({ fetchedAt: sql`${pmLocationCache.fetchedAt} - interval '1 hour'` })
      .where(eq(pmLocationCache.pmLocationId, PM_FIXTURE_ID));
    const addFrom = pmRequests.paths.length;
    r = await call(bob, 'POST', '/venues', { name: PLACE, address: nearPlace?.address ?? herePlace.label });
    const NEW = r.body;
    if (NEW?.id) venueIds.push(NEW.id);
    check('POST /venues creates it: public, owned and created by bob, placed, HERE id adopted', r.status === 201 && NEW?.ownerId === bob.id
      && NEW?.createdById === bob.id && NEW?.isResidence === false && NEW?.privacyTier === 'full' && NEW?.latitude === at.lat && NEW?.hereId === herePlace.id, r.body);
    r = await call(bob, 'POST', '/venues', { name: PLACE, address: herePlace.label });
    check('a second add of the same place → 409 duplicate_venue naming the new venue (the card offers "use this one")',
      r.status === 409 && r.body?.code === 'duplicate_venue' && r.body?.candidates?.some((c: any) => c.id === NEW?.id), r.body);

    r = await call(bob, 'POST', `/venues/${NEW?.id}/repair/pm-link`, { pinballMapId: nearPlace?.pinballMapId });
    check('pm-link by its creator with the Near-me id (no pm-match) → 200, roster read (fixture: 1 machine)', r.status === 200 && r.body?.venue?.pinballMapId === PM_FIXTURE_ID && r.body?.machineCount === rosterNames.length, r.body);
    const addPaths = pmRequests.paths.slice(addFrom);
    const addRoster = pmRequests.since(addFrom, `/locations/${PM_FIXTURE_ID}.json`);
    const addClosest = pmRequests.since(addFrom, 'closest_by_lat_lon');
    const addOther = addPaths.length - addRoster - pmRequests.since(addFrom, '/machines.json');
    check(`Near-me pick with a Pinball Map id: exactly 1 PM request during the add (the roster), 0 closest_by_lat_lon — made ${JSON.stringify(addPaths)}`,
      addRoster === 1 && addClosest === 0 && addOther === 0, addPaths);
    check(`…the whole section so far made 1 closest_by_lat_lon (the Near-me tap's; the second Near me hit the cell cache) — made ${pmRequests.since(0, 'closest_by_lat_lon')}`,
      pmRequests.since(0, 'closest_by_lat_lon') === 1, pmRequests.paths);
    // A search (HERE Places) pick carries no id, so the card asks pm-match once — at the place's own
    // coordinates. Here that's the Near-me cell, so the shared per-cell cache answers it: 0 requests.
    const matchFrom = pmRequests.paths.length;
    r = await call(bob, 'GET', `/venues/pm-match?lat=${at.lat}&lng=${at.lng}&name=${encodeURIComponent(PLACE)}`);
    check('pm-match (a search pick, or a Near-me place with no id — once) → the Pinball Map listing', r.status === 200 && r.body?.pinballMapId === PM_FIXTURE_ID && r.body?.linked === false, r.body);
    check('…from the per-cell cache Near me filled: 0 PM requests', pmRequests.paths.length === matchFrom, pmRequests.paths.slice(matchFrom));
    const [cachedRoster] = await db.select().from(pmLocationCache).where(eq(pmLocationCache.pmLocationId, PM_FIXTURE_ID));
    check('…and the roster is in pm_location_cache', !!cachedRoster && (cachedRoster.machines as any[]).length === rosterNames.length, cachedRoster);
    r = await call(alice, 'POST', `/venues/${NEW?.id}/repair/pm-link`, { pinballMapId: PM_FIXTURE_ID });
    check("pm-link by someone who didn't add it → 403", r.status === 403, r);
    const addFlowPmRequests = pmRequests.count;
    check(`the whole section (Near me + add) made at most 3 Pinball Map requests (closest_by_lat_lon, roster, catalog) — made ${addFlowPmRequests}`, addFlowPmRequests <= 3, pmRequests.paths);

    r = await call(bob, 'PUT', '/me/challenge-prefs', { venueIds: [BOB_HOME.id, NEW?.id] });
    check('PUT prefs accepts the venue bob just created (his own: owner_id) → 200, source added', r.status === 200
      && r.body?.venues?.find((v: any) => v.id === NEW?.id)?.source === 'added', r.body);
    r = await call(alice, 'PUT', '/me/challenge-prefs', { venueIds: [LAIR.id] });
    check("PUT refuses a stranger's private venue for alice too → 400 venue_not_found", r.status === 400 && r.body?.code === 'venue_not_found', r);

    // Prove level 2 comes from the cached roster: drop the machine history pm-link seeded.
    await db.delete(venueMachineHistory).where(eq(venueMachineHistory.venueId, NEW?.id));
    const rosterMachines = await db.select({ id: machines.id, name: machines.name }).from(machines)
      .where(inArray(sql`lower(${machines.name})`, rosterNames.map(n => n.toLowerCase())));
    const before = pmRequests.count;
    r = await call(alice, 'GET', `/challenges/recommendations/${encodeURIComponent(bob.username)}`);
    const fromRoster = rosterMachines.map(m => r.body?.recommendations?.find((x: any) => x.machineId === m.id)).filter(Boolean);
    check('recommendations: the cached roster’s machine shows up at level 2, labelled with the new venue', r.status === 200 && rosterMachines.length > 0
      && fromRoster.some((x: any) => x.level === 2 && x.venueLabel === PLACE), { rosterMachines, recs: r.body?.recommendations });
    r = await call(alice, 'GET', `/challenges/recommendations?users=${encodeURIComponent(bob.username)},${encodeURIComponent(carol.username)}`);
    check('…and in group recommendations', r.status === 200 && rosterMachines.some(m => r.body?.recommendations?.some((x: any) => x.machineId === m.id)), r.body);
    check('recommendations made zero Pinball Map requests (fixture or live)', pmRequests.count === before, { before, after: pmRequests.count });
    check(`HERE was only ever the test double (${hereHits.length} requests: ${[...new Set(hereHits)].join(', ')})`, hereHits.length > 0, hereHits);
    pmRequests.stop();
    herePlace = null;
  }

  // ── how a score fared: POST / PATCH /api/scores `challenges` (2026-09-30) ──
  // Will's #1276: an old photo's EXIF played_at fell before his challenges started, so it (rightly)
  // didn't count — and nothing said so. Every upload / edit now reports it per matching challenge.
  {
    r = await post(alice, { friendId: bob.id, type: 'high_score', matchMode: 'exact' });
    const fitExact = r.body.id;
    await call(bob, 'POST', `/challenges/${fitExact}/accept`);
    r = await post(alice, { friendId: bob.id, type: 'high_score', matchMode: 'game' });
    const fitGame = r.body.id;
    await call(bob, 'POST', `/challenges/${fitGame}/accept`);
    r = await post(alice, { friendId: bob.id, type: 'high_score' });
    const fitPending = r.body.id; // bob hasn't answered: pending, starts when accepted
    const fitIds = [fitExact, fitGame];
    const fitsIn = (b: any, cids: number[]) => ((b?.challenges ?? []) as any[]).filter(f => cids.includes(f.challengeId));
    const [fw] = await db.select({ startsAt: challenges.startsAt }).from(challenges).where(eq(challenges.id, fitExact));
    const [fw2] = await db.select({ startsAt: challenges.startsAt }).from(challenges).where(eq(challenges.id, fitGame));
    const latestStart = Math.max(+fw.startsAt!, +fw2.startsAt!);

    s = await upload(alice, { score: 3_333, playedAt: new Date(+fw.startsAt! - 150 * 24 * H).toISOString() });
    const oldPhoto = s.body.id;
    let fits = fitsIn(s.body, fitIds);
    check('upload played before the start → 201 with challenges: not_counted / played_before_start in each matching one',
      s.status === 201 && fits.length === 2 && fits.every(f => f.status === 'not_counted' && f.reason === 'played_before_start'), s.body?.challenges);
    check('…each entry has the documented shape', fits.every(f => typeof f.machineName === 'string' && f.type === 'high_score'
      && typeof f.startsAt === 'string' && typeof f.endsAt === 'string' && Array.isArray(f.opponents) && f.opponents.includes(bob.displayName)), fits);
    const pend = fitsIn(s.body, [fitPending]);
    check('…a pending challenge alice is in reads not_started', pend.length === 1 && pend[0].status === 'not_started' && pend[0].startsAt === null, s.body?.challenges);
    check('…and no lock rows for it', (await db.select().from(challengeScores).where(eq(challengeScores.scoreId, oldPhoto))).length === 0);

    r = await call(alice, 'PATCH', `/scores/${oldPhoto}`, { playedAt: new Date(latestStart + 1000).toISOString() });
    fits = fitsIn(r.body, fitIds);
    check('PATCH played_at into the window → 200, counted in both', r.status === 200 && fits.length === 2 && fits.every(f => f.status === 'counted' && f.reason === 'counted'), r.body?.challenges ?? r);
    check('…and the edit wrote the lock rows', (await db.select().from(challengeScores).where(eq(challengeScores.scoreId, oldPhoto))).length === 2);
    check('…PATCH keeps the score fields (backward compatible)', r.body?.id === oldPhoto && r.body?.score === 3_333, r.body);
    r = await call(alice, 'PATCH', `/scores/${oldPhoto}`, { playedAt: new Date(+fw.startsAt! - 150 * 24 * H).toISOString() });
    check('…now locked: editing it again → 409', r.status === 409 && r.body?.code === 'score_locked_by_challenge', r);

    s = await upload(alice, { score: 4_444, machineId: OTHER });
    check('a score on a different machine lists no challenges', s.status === 201 && Array.isArray(s.body?.challenges) && s.body.challenges.length === 0, s.body?.challenges);
    s = await upload(alice, { score: 5_555, photoThumbnail: undefined });
    fits = fitsIn(s.body, fitIds);
    check('no photo → not_counted / no_photo', fits.length === 2 && fits.every(f => f.status === 'not_counted' && f.reason === 'no_photo'), s.body?.challenges);
    s = await upload(alice, { score: 6_666, machineId: PREM });
    const prem = fitsIn(s.body, fitIds);
    check('a Premium score: counted in the game-mode one, absent from the exact one', prem.length === 1 && prem[0].challengeId === fitGame && prem[0].status === 'counted', s.body?.challenges);
    r = await call(alice, 'PATCH', `/scores/${s.body.id}`, { score: 1 });
    check('…(it counted, so it is locked)', r.status === 409, r);
    await call(alice, 'POST', `/challenges/${fitPending}/cancel`);
  }

  // ── run-wide audit: closed proposals, one event per action ─────────────────
  {
    const runCids = [...new Set((await db.select({ id: challengeParticipants.challengeId }).from(challengeParticipants)
      .where(inArray(challengeParticipants.userId, ids))).map(m => m.id))];
    const dangling = await db.select({ challengeId: challengeParticipants.challengeId, userId: challengeParticipants.userId, status: challenges.status })
      .from(challengeParticipants).innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
      .where(and(inArray(challengeParticipants.challengeId, runCids), sql`${challenges.proposedById} IS NOT NULL`,
        inArray(challenges.status, ['rejected', 'lapsed']), eq(challengeParticipants.response, 'pending')));
    const closedCount = (await db.select({ id: challenges.id }).from(challenges)
      .where(and(inArray(challenges.id, runCids), sql`${challenges.proposedById} IS NOT NULL`, inArray(challenges.status, ['rejected', 'lapsed'])))).length;
    check(`no 'pending' participant on any closed proposal (${closedCount} closed this run)`, closedCount >= 6 && dangling.length === 0, dangling);
    const cidText = runCids.map(String);
    const events = await db.select({ type: activityEvents.type, targetId: activityEvents.targetId, actor: activityEvents.actorUserId }).from(activityEvents)
      .where(and(sql`${activityEvents.createdAt} >= ${startedAt}::timestamptz`, eq(activityEvents.targetType, 'challenge'),
        inArray(activityEvents.targetId, cidText), sql`${activityEvents.type} LIKE 'challenge.%'`));
    const tally = (rows: typeof events, key: (e: typeof events[number]) => string) => {
      const m = new Map<string, number>();
      for (const e of rows) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
      return [...m].filter(([, n]) => n > 1);
    };
    check(`exactly one event per action: no (type, challenge, actor) repeats (${events.length} challenge events)`,
      events.length > 0 && tally(events, e => `${e.type}|${e.targetId}|${e.actor}`).length === 0, tally(events, e => `${e.type}|${e.targetId}|${e.actor}`));
    const once = new Set(['challenge.counter_rejected', 'challenge.counter_accepted', 'challenge.started', 'challenge.expired', 'challenge.resolved', 'challenge.created', 'challenge.cancelled']);
    const onceRepeats = tally(events.filter(e => once.has(e.type)), e => `${e.type}|${e.targetId}`);
    check('…and at most one per challenge, any actor, for created / cancelled / started / expired / resolved / counter_accepted / counter_rejected',
      onceRepeats.length === 0, onceRepeats);
  }

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
  // The Pinball Map-only place section: its pm-link wrote the fixture's roster row, may have
  // refreshed the catalog row from the fixture, and upserted the roster's machines. Put all back.
  // Rows are only rewritten when they actually changed (a Date round trip drops microseconds).
  if (pmRestore.location !== undefined && await pmRowHash('pm_location_cache', 'pm_location_id = 20676') !== pmRestore.locationHash) {
    await db.delete(pmLocationCache).where(eq(pmLocationCache.pmLocationId, 20676));
    if (pmRestore.location) await db.insert(pmLocationCache).values(pmRestore.location);
  }
  if (pmRestore.catalog && await pmRowHash('pm_catalog_cache', 'true') !== pmRestore.catalogHash) {
    await db.delete(pmCatalogCache);
    if (pmRestore.catalog.length) await db.insert(pmCatalogCache).values(pmRestore.catalog);
  }
  if (pmRestore.names?.length && pmRestore.maxMachineId != null) {
    await db.delete(machines).where(and(
      sql`${machines.id} > ${pmRestore.maxMachineId}`,
      inArray(sql`lower(${machines.name})`, pmRestore.names.map(n => n.toLowerCase())),
      sql`NOT EXISTS (SELECT 1 FROM scores s WHERE s.machine_id = ${machines.id})`,
      sql`NOT EXISTS (SELECT 1 FROM venue_machine_history h WHERE h.machine_id = ${machines.id})`,
    ));
    // upsertMachineByName only fills blanks in these columns — put back just those.
    for (const m of pmRestore.machines ?? []) {
      await db.update(machines).set({ opdbId: m.opdbId, manufacturer: m.manufacturer, year: m.year, imageUrl: m.imageUrl })
        .where(and(eq(machines.id, m.id), sql`(${machines.opdbId}, ${machines.manufacturer}, ${machines.year}, ${machines.imageUrl})
          IS DISTINCT FROM (${m.opdbId}::text, ${m.manufacturer}::text, ${m.year}::int, ${m.imageUrl}::text)`));
    }
  }
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
  // Posting scores runs the badge engine, so any live badge on dev (e.g. an admin's manual-testing
  // "first score" badge) gets awarded to the borrowed users. Remove those awards, their
  // notifications and their events — only what this run created.
  await db.delete(userBadges).where(and(inArray(userBadges.userId, ids), sql`${userBadges.earnedAt} >= ${startedAt}::timestamptz`));
  await db.delete(notifications).where(and(
    inArray(notifications.userId, ids), eq(notifications.kind, 'badge_earned'), sql`${notifications.createdAt} >= ${startedAt}::timestamptz`,
  ));
  await db.delete(activityEvents).where(and(
    sql`${activityEvents.createdAt} >= ${startedAt}::timestamptz`,
    or(
      and(eq(activityEvents.type, 'badge.earned'), inArray(activityEvents.actorUserId, ids)),
      and(eq(activityEvents.type, 'notification.sent'), inArray(activityEvents.subjectUserId, ids), sql`${activityEvents.payload} ->> 'kind' = 'badge_earned'`),
    ),
  ));
  // Every activity event this run wrote about these users or their challenges (challenge.*,
  // notification.sent, …) — the rows are only ever about the borrowed users, so nothing else goes.
  const cidText = cids.map(String);
  await db.delete(activityEvents).where(and(
    sql`${activityEvents.createdAt} >= ${startedAt}::timestamptz`,
    or(
      inArray(activityEvents.actorUserId, ids),
      inArray(activityEvents.subjectUserId, ids),
      cidText.length ? and(eq(activityEvents.targetType, 'challenge'), inArray(activityEvents.targetId, cidText)) : sql`false`,
    ),
  ));
  if (notificationsBefore.length) await db.insert(notifications).values(notificationsBefore).onConflictDoNothing();
  server.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
