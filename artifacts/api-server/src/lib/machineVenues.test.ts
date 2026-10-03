// Run: npx tsx --test src/lib/machineVenues.test.ts   (from artifacts/api-server)
//
// The Machines page "X Venues" pill and modal (machineVenues.ts): venues where a score on the machine
// has been logged that the viewer may see. The SQL is rendered by drizzle's PgDialect and executed
// against an in-process PGlite (real Postgres, WASM) — no server, nothing dialled; the dummy
// DATABASE_URL only satisfies @workspace/db's import-time check. Covers the privacy matrix (owner /
// friend / stranger / admin / guest × every private tier × the show-publicly switch), hidden-score
// visibility (visibleScoreSql), per-venue score count + last played, ordering, pill = modal count, and
// that the module can't reach Pinball Map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  machineVenueCounts, venuesForMachine, shapeMachineVenues, visibleVenueActivitySql,
} = await import('./machineVenues.js');
const { canSeeVenueActivity } = await import('./venueActivity.js');
const { PgDialect } = await import('drizzle-orm/pg-core');
const { PGlite } = await import('@electric-sql/pglite');

type Tier = 'full' | 'city_state' | 'hidden';
interface VenueFx {
  id: number; name: string; address: string | null; ownerId: number | null; isResidence: boolean;
  privacyTier: Tier; showMachinesAndScores: boolean;
}

const OWNER = 1, FRIEND = 2, STRANGER = 3, ADMIN = 4, PLAYER = 5;
const MM = 1, AFM = 2, TOM = 3, LONELY = 4;

const pg = new PGlite();
await pg.exec(`
  CREATE TABLE machines (id integer PRIMARY KEY, name text NOT NULL UNIQUE);
  CREATE TABLE venues (id integer PRIMARY KEY, name text NOT NULL, address text, owner_id integer,
    is_residence boolean NOT NULL, privacy_tier text NOT NULL, show_machines_and_scores boolean NOT NULL);
  CREATE TABLE scores (id serial PRIMARY KEY, user_id integer NOT NULL, machine_id integer NOT NULL,
    venue_id integer, played_at timestamptz NOT NULL);
`);
for (const [id, name] of [[MM, 'Medieval Madness'], [AFM, 'Attack from Mars'], [TOM, 'Theater of Magic'], [LONELY, 'Lonely Machine']] as const) {
  await pg.query('INSERT INTO machines VALUES ($1, $2)', [id, name]);
}

const venues: VenueFx[] = [];
const addVenue = async (v: VenueFx) => {
  venues.push(v);
  await pg.query('INSERT INTO venues VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [v.id, v.name, v.address, v.ownerId, v.isResidence, v.privacyTier, v.showMachinesAndScores]);
};
const addScore = (userId: number, machineId: number, venueId: number | null, playedAt: string) =>
  pg.query('INSERT INTO scores (user_id, machine_id, venue_id, played_at) VALUES ($1, $2, $3, $4)',
    [userId, machineId, venueId, playedAt]);

// Public venues. The switch is ignored on a public venue, so 10's `false` changes nothing.
await addVenue({ id: 10, name: 'Bar', address: '1 Main St, Boston, MA 02110', ownerId: STRANGER, isResidence: false, privacyTier: 'full', showMachinesAndScores: false });
await addVenue({ id: 11, name: 'Arcade', address: '2 Elm St, Portland, OR 97201', ownerId: null, isResidence: false, privacyTier: 'full', showMachinesAndScores: true });
await addVenue({ id: 12, name: 'Quiet Bar', address: '3 Oak St, Chicago, IL 60601', ownerId: null, isResidence: false, privacyTier: 'full', showMachinesAndScores: true });
await addScore(PLAYER, MM, 10, '2026-09-01T20:00:00Z');
await addScore(STRANGER, MM, 10, '2026-09-10T20:00:00Z');
await addScore(PLAYER, MM, 11, '2026-09-20T20:00:00Z');
await addScore(PLAYER, AFM, 12, '2026-07-04T20:00:00Z'); // 12 never had MM played → not an MM venue
await addScore(PLAYER, MM, null, '2026-09-25T20:00:00Z'); // no venue → counts nowhere

// Every private kind × switch, all OWNER's, each with an MM score by OWNER (older than the public ones).
let vid = 20;
const privateVenues: VenueFx[] = [];
for (const [isResidence, privacyTier] of [[true, 'full'], [true, 'city_state'], [true, 'hidden'], [false, 'hidden'], [false, 'city_state']] as const) {
  for (const show of [true, false]) {
    const v: VenueFx = { id: vid++, name: `Home ${vid}`, address: '99 Secret Ln, Somerville, MA 02144', ownerId: OWNER, isResidence, privacyTier, showMachinesAndScores: show };
    await addVenue(v);
    privateVenues.push(v);
    await addScore(OWNER, MM, v.id, '2026-08-01T20:00:00Z');
  }
}
// A private venue owned by FRIEND, switch on, with an MM score by FRIEND.
const friendHome: VenueFx = { id: 40, name: 'Friend Home', address: null, ownerId: FRIEND, isResidence: true, privacyTier: 'hidden', showMachinesAndScores: true };
await addVenue(friendHome);
privateVenues.push(friendHome);
await addScore(FRIEND, MM, 40, '2026-08-15T20:00:00Z');

// STRANGER logged TOM at OWNER's switch-off home (the only TOM score). The author sees their own score
// elsewhere, but the venue's activity is hidden from them — so it isn't counted for them either.
const switchOffHome = privateVenues.find(v => v.ownerId === OWNER && !v.showMachinesAndScores)!;
await addScore(STRANGER, TOM, switchOffHome.id, '2026-09-30T20:00:00Z');

const dialect = new PgDialect();
const exec = async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
  const { sql, params } = dialect.sqlToQuery(q);
  return (await pg.query(sql, params as unknown[])).rows;
};

const viewers = {
  signedOut: undefined,
  owner: { id: OWNER, role: 'user' },
  friend: { id: FRIEND, role: 'user' },
  stranger: { id: STRANGER, role: 'user' },
  admin: { id: ADMIN, role: 'admin' },
};

test('visibleVenueActivitySql matches canSeeVenueActivity for every venue and viewer', async () => {
  for (const [name, viewer] of Object.entries(viewers)) {
    const where = dialect.sqlToQuery(visibleVenueActivitySql(viewer, 'v'));
    const { rows } = await pg.query<{ id: number }>(`SELECT id FROM venues v WHERE ${where.sql} ORDER BY id`, where.params as unknown[]);
    const fromJs = venues.filter(v => canSeeVenueActivity(v, viewer)).map(v => v.id);
    assert.deepEqual(rows.map(r => r.id), fromJs, name);
  }
});

for (const [name, viewer] of Object.entries(viewers)) {
  test(`Medieval Madness venues — ${name}`, async () => {
    const view = await venuesForMachine(exec, MM, viewer);
    const countable = privateVenues.filter(v => canSeeVenueActivity(v, viewer));
    const own = countable.filter(v => viewer && v.ownerId === viewer.id);
    const others = countable.filter(v => !(viewer && v.ownerId === viewer.id));

    // Public venues by name, most recently played first; 12 (only AFM) and venue-less scores absent.
    const listed = view.venues.map(v => v.id);
    assert.deepEqual(listed.filter(id => id < 20), [11, 10]);
    // Own private venues listed (as home); others' never named.
    assert.deepEqual(listed.filter(id => id >= 20).sort(), own.map(v => v.id).sort());
    for (const r of view.venues) assert.equal(r.home, r.id >= 20);
    assert.equal(view.privateCount, others.length);
    assert.equal(view.venueCount, 2 + countable.length);
    // No listed row is someone else's private venue.
    for (const r of view.venues) {
      const v = venues.find(x => x.id === r.id)!;
      const isPrivate = v.isResidence || v.privacyTier !== 'full';
      assert.ok(!isPrivate || v.ownerId === viewer?.id, `${r.name} leaked to ${name}`);
    }
    // Score count + last played per listed venue.
    const bar = view.venues.find(v => v.id === 10)!;
    assert.equal(bar.scoreCount, 2);
    assert.equal(bar.lastPlayedAt, '2026-09-10T20:00:00.000Z');
    const arcade = view.venues.find(v => v.id === 11)!;
    assert.equal(arcade.scoreCount, 1);
    assert.equal(arcade.lastPlayedAt, '2026-09-20T20:00:00.000Z');
    // Sorted by last played, newest first.
    const times = view.venues.map(v => v.lastPlayedAt);
    assert.deepEqual(times, [...times].sort().reverse());

    // The pill: same number from the one GROUP BY query.
    const counts = await machineVenueCounts(exec, viewer);
    assert.equal(counts.get(MM), view.venueCount);
  });
}

test('the switch: off hides a private venue from friend/stranger/guest entirely, owner/admin still count it', async () => {
  const stranger = await venuesForMachine(exec, MM, viewers.stranger);
  const guest = await venuesForMachine(exec, MM, viewers.signedOut);
  const owner = await venuesForMachine(exec, MM, viewers.owner);
  const admin = await venuesForMachine(exec, MM, viewers.admin);
  const onCount = privateVenues.filter(v => v.showMachinesAndScores).length;
  assert.equal(stranger.privateCount, onCount);
  assert.equal(guest.privateCount, onCount);
  assert.equal(owner.venues.filter(v => v.home).length, privateVenues.filter(v => v.ownerId === OWNER).length);
  assert.equal(owner.privateCount, 1); // the friend's home
  assert.equal(admin.privateCount, privateVenues.length); // admins count everything but name nothing
  assert.equal(admin.venues.filter(v => v.home).length, 0);
});

test('hidden scores never count: a machine played only at a switch-off home', async () => {
  // Signed out, friend: the score is hidden → no venue, no pill.
  for (const viewer of [viewers.signedOut, viewers.friend]) {
    const counts = await machineVenueCounts(exec, viewer);
    assert.equal(counts.get(TOM), undefined);
    assert.deepEqual(await venuesForMachine(exec, TOM, viewer), { venues: [], privateCount: 0, venueCount: 0 });
  }
  // The score's author sees the score, but not the venue's activity → still not counted.
  assert.equal((await machineVenueCounts(exec, viewers.stranger)).get(TOM), undefined);
  assert.equal((await venuesForMachine(exec, TOM, viewers.stranger)).venueCount, 0);
  // Owner: their own home, listed with the visitor's score in it.
  const owner = await venuesForMachine(exec, TOM, viewers.owner);
  assert.deepEqual(owner.venues.map(v => [v.id, v.home, v.scoreCount, v.lastPlayedAt]),
    [[switchOffHome.id, true, 1, '2026-09-30T20:00:00.000Z']]);
  assert.equal((await machineVenueCounts(exec, viewers.owner)).get(TOM), 1);
  // Admin: counted, not named.
  const admin = await venuesForMachine(exec, TOM, viewers.admin);
  assert.deepEqual(admin, { venues: [], privateCount: 1, venueCount: 1 });
  assert.equal((await machineVenueCounts(exec, viewers.admin)).get(TOM), 1);
});

test('a machine with no logged score anywhere has no pill and an empty modal', async () => {
  const counts = await machineVenueCounts(exec, viewers.admin);
  assert.equal(counts.get(LONELY), undefined);
  assert.equal(counts.get(AFM), 1); // only Quiet Bar
  assert.deepEqual(await venuesForMachine(exec, LONELY, viewers.admin), { venues: [], privateCount: 0, venueCount: 0 });
});

test('shapeMachineVenues: pure listing rule', () => {
  const view = shapeMachineVenues([
    { id: 1, name: 'Pub', address: 'a', ownerId: 9, isResidence: false, privacyTier: 'full', scoreCount: 3, lastPlayedAt: '2026-09-02 03:04:05+00' },
    { id: 2, name: 'Mine', address: 'b', ownerId: 5, isResidence: true, privacyTier: 'full', scoreCount: 1, lastPlayedAt: new Date('2026-01-02T03:04:05Z') },
    { id: 3, name: 'Theirs', address: 'c', ownerId: 6, isResidence: false, privacyTier: 'city_state', scoreCount: 7, lastPlayedAt: '2026-08-01 00:00:00+00' },
  ], { id: 5, role: 'user' });
  assert.deepEqual(view.venues, [
    { id: 1, name: 'Pub', address: 'a', home: false, scoreCount: 3, lastPlayedAt: '2026-09-02T03:04:05.000Z' },
    { id: 2, name: 'Mine', address: 'b', home: true, scoreCount: 1, lastPlayedAt: '2026-01-02T03:04:05.000Z' },
  ]);
  assert.equal(view.privateCount, 1);
  assert.equal(view.venueCount, 3);
  assert.ok(!JSON.stringify(view).includes('Theirs'));
});

test('machineVenues.ts cannot reach Pinball Map (no pmClient / roster fetcher / catalog imports)', () => {
  const src = readFileSync(new URL('./machineVenues.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.ok(imports.length > 0);
  for (const mod of imports) {
    assert.ok(!/pmClient|pmRosterCache|pinballMap|pinballmapApi|pmGuards|venueHistory/.test(mod), `imports ${mod}`);
  }
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/getVenueRoster|pmClient\(|fetch\(/.test(code));
  // Our own data only: no roster cache, PM-derived history or inventory reads.
  assert.ok(!/pm_location_cache|venue_machine_history|venue_inventory/.test(code));
});
