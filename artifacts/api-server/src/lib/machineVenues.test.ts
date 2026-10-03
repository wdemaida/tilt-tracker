// Run: npx tsx --test src/lib/machineVenues.test.ts   (from artifacts/api-server)
//
// The Machines page "X Venues" pill and modal (machineVenues.ts). The SQL is rendered by drizzle's
// PgDialect and executed against an in-process PGlite (real Postgres, WASM) — no server, nothing
// dialled; the dummy DATABASE_URL only satisfies @workspace/db's import-time check. Covers the privacy
// matrix (owner / friend / stranger / admin / guest × every private tier × the show-publicly switch),
// the roster sources (cached roster wins over history; history only for linked public venues without a
// cached roster; inventory only for private venues), "Formerly here", and that the module can't reach
// Pinball Map.
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
  privacyTier: Tier; showMachinesAndScores: boolean; pinballMapId: number | null;
}

const OWNER = 1, FRIEND = 2, STRANGER = 3, ADMIN = 4;
const MM = 1, AFM = 2, TOM = 3, LONELY = 4;

const pg = new PGlite();
await pg.exec(`
  CREATE TABLE machines (id integer PRIMARY KEY, name text NOT NULL UNIQUE);
  CREATE TABLE venues (id integer PRIMARY KEY, name text NOT NULL, address text, owner_id integer,
    is_residence boolean NOT NULL, privacy_tier text NOT NULL, show_machines_and_scores boolean NOT NULL,
    pinball_map_id integer);
  CREATE TABLE venue_inventory (venue_id integer NOT NULL, machine_id integer NOT NULL, removed_at timestamptz);
  CREATE TABLE venue_machine_history (venue_id integer NOT NULL, machine_id integer NOT NULL,
    removed_at timestamptz);
  CREATE TABLE pm_location_cache (pm_location_id integer PRIMARY KEY, machines jsonb NOT NULL);
`);
for (const [id, name] of [[MM, 'Medieval Madness'], [AFM, 'Attack from Mars'], [TOM, 'Theater of Magic'], [LONELY, 'Lonely Machine']] as const) {
  await pg.query('INSERT INTO machines VALUES ($1, $2)', [id, name]);
}

const venues: VenueFx[] = [];
const addVenue = async (v: VenueFx) => {
  venues.push(v);
  await pg.query('INSERT INTO venues VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [v.id, v.name, v.address, v.ownerId, v.isResidence, v.privacyTier, v.showMachinesAndScores, v.pinballMapId]);
};
const roster = (...names: string[]) => JSON.stringify(names.map((n, i) => ({ id: 900 + i, machine: { id: 500 + i, name: n } })));

// Public, linked, cached roster: MM (spelled differently — trimmed, case-insensitive) and AFM. Its
// history still says TOM is here, but the cached roster is the truth.
await addVenue({ id: 10, name: 'Bar With Cache', address: '1 Main St, Boston, MA 02110', ownerId: STRANGER, isResidence: false, privacyTier: 'full', showMachinesAndScores: false, pinballMapId: 100 });
await pg.query('INSERT INTO pm_location_cache VALUES ($1, $2)', [100, roster('  medieval MADNESS ', 'Attack from Mars', 'Not In Our Table')]);
await pg.query('INSERT INTO venue_machine_history VALUES (10, $1, NULL)', [TOM]);
// Public, linked, no cached roster → open history rows: MM.  Plus MM-removed elsewhere below.
await addVenue({ id: 11, name: 'Arcade No Cache', address: '2 Elm St, Portland, OR 97201', ownerId: null, isResidence: false, privacyTier: 'full', showMachinesAndScores: true, pinballMapId: 200 });
await pg.query('INSERT INTO venue_machine_history VALUES (11, $1, NULL)', [MM]);
// Public, linked, MM left (formerly here). AFM left too, but AFM is back → not "formerly".
await addVenue({ id: 12, name: 'Old Haunt', address: '3 Oak St, Chicago, IL 60601', ownerId: null, isResidence: false, privacyTier: 'full', showMachinesAndScores: true, pinballMapId: 300 });
await pg.query(`INSERT INTO venue_machine_history VALUES (12, $1, '2026-08-01T00:00:00Z')`, [MM]);
await pg.query(`INSERT INTO venue_machine_history VALUES (12, $1, '2026-07-01T00:00:00Z')`, [AFM]);
await pg.query('INSERT INTO venue_machine_history VALUES (12, $1, NULL)', [TOM]); // keeps "no cache" path real
// Public, UNlinked, stale history → nothing (no roster source; "played here" isn't one).
await addVenue({ id: 13, name: 'Unlinked Bar', address: '4 Pine St, Austin, TX 78701', ownerId: null, isResidence: false, privacyTier: 'full', showMachinesAndScores: true, pinballMapId: null });
await pg.query('INSERT INTO venue_machine_history VALUES (13, $1, NULL)', [MM]);
await pg.query(`INSERT INTO venue_machine_history VALUES (13, $1, '2026-06-01T00:00:00Z')`, [AFM]);
// Public venue with stray inventory rows (inventory is private-only) → ignored.
await pg.query('INSERT INTO venue_inventory VALUES (10, $1, NULL)', [LONELY]);

// Every private kind × switch, all OWNER's, each holding MM in inventory (one removed AFM too) and a
// leftover PM history row (from before it went private) that must never surface.
let vid = 20;
const privateVenues: VenueFx[] = [];
for (const [isResidence, privacyTier] of [[true, 'full'], [true, 'city_state'], [true, 'hidden'], [false, 'hidden'], [false, 'city_state']] as const) {
  for (const show of [true, false]) {
    const v: VenueFx = { id: vid++, name: `Home ${vid}`, address: '99 Secret Ln, Somerville, MA 02144', ownerId: OWNER, isResidence, privacyTier, showMachinesAndScores: show, pinballMapId: null };
    await addVenue(v);
    privateVenues.push(v);
    await pg.query('INSERT INTO venue_inventory VALUES ($1, $2, NULL)', [v.id, MM]);
    await pg.query(`INSERT INTO venue_inventory VALUES ($1, $2, '2026-05-01T00:00:00Z')`, [v.id, AFM]);
    await pg.query(`INSERT INTO venue_machine_history VALUES ($1, $2, '2026-04-01T00:00:00Z')`, [v.id, TOM]);
    await pg.query('INSERT INTO venue_machine_history VALUES ($1, $2, NULL)', [v.id, AFM]);
  }
}
// A private venue owned by FRIEND, switch on, holding MM.
const friendHome: VenueFx = { id: 40, name: 'Friend Home', address: null, ownerId: FRIEND, isResidence: true, privacyTier: 'hidden', showMachinesAndScores: true, pinballMapId: null };
await addVenue(friendHome);
privateVenues.push(friendHome);
await pg.query('INSERT INTO venue_inventory VALUES (40, $1, NULL)', [MM]);

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

    // Public venues by name (cache roster with a differently-cased name; history with no cache).
    const listed = view.onFloor.map(v => v.id);
    assert.deepEqual(listed.filter(id => id < 20).sort(), [10, 11]);
    // Own private venues listed (as home); others' never named.
    assert.deepEqual(listed.filter(id => id >= 20).sort(), own.map(v => v.id).sort());
    for (const r of view.onFloor) assert.equal(r.home, r.id >= 20);
    assert.equal(view.privateCount, others.length);
    assert.equal(view.venueCount, 2 + countable.length);
    // No listed row is someone else's private venue.
    for (const r of view.onFloor) {
      const v = venues.find(x => x.id === r.id)!;
      const isPrivate = v.isResidence || v.privacyTier !== 'full';
      assert.ok(!isPrivate || v.ownerId === viewer?.id, `${r.name} leaked to ${name}`);
    }

    // Formerly here: public linked venues only, newest first, never private history.
    assert.deepEqual(view.formerly.map(f => f.id), [12]);
    assert.equal(view.formerly[0].removedAt, '2026-08-01T00:00:00.000Z');

    // The pill: same number from the one GROUP BY query.
    const counts = await machineVenueCounts(exec, viewer);
    assert.equal(counts.get(MM), view.venueCount);
  });
}

test('the switch: off hides a private venue from friend/stranger/guest entirely, owner/admin still count it', async () => {
  const off = privateVenues.filter(v => !v.showMachinesAndScores);
  assert.ok(off.length >= 5);
  const stranger = await venuesForMachine(exec, MM, viewers.stranger);
  const owner = await venuesForMachine(exec, MM, viewers.owner);
  const admin = await venuesForMachine(exec, MM, viewers.admin);
  const onCount = privateVenues.filter(v => v.showMachinesAndScores).length;
  assert.equal(stranger.privateCount, onCount);
  assert.equal(owner.onFloor.filter(v => v.home).length, privateVenues.filter(v => v.ownerId === OWNER).length);
  assert.equal(owner.privateCount, 1); // the friend's home
  assert.equal(admin.privateCount, privateVenues.length); // admins count everything but name nothing
  assert.equal(admin.onFloor.filter(v => v.home).length, 0);
});

test('roster sources: cached roster beats stale history; unlinked and inventory-on-public ignored', async () => {
  const counts = await machineVenueCounts(exec, viewers.stranger);
  // AFM: on the cached roster at 10; back nowhere else (removed at 12, 13 unlinked, private history ignored).
  assert.equal(counts.get(AFM), 1);
  // TOM: history at 10 is overridden by its cached roster; history at 12 (no cache) counts.
  assert.equal(counts.get(TOM), 1);
  const tom = await venuesForMachine(exec, TOM, viewers.stranger);
  assert.deepEqual(tom.onFloor.map(v => v.id), [12]);
  assert.deepEqual(tom.formerly, [], 'private-venue history never becomes "formerly here"');
  // Inventory on a public venue isn't a roster.
  assert.equal(counts.get(LONELY), undefined);
  const afm = await venuesForMachine(exec, AFM, viewers.stranger);
  assert.deepEqual(afm.formerly.map(f => f.id), [12]);
  // A machine nowhere → empty.
  const lonely = await venuesForMachine(exec, LONELY, viewers.admin);
  assert.deepEqual(lonely, { onFloor: [], privateCount: 0, formerly: [], venueCount: 0 });
});

test('shapeMachineVenues: pure listing rule', () => {
  const view = shapeMachineVenues([
    { id: 1, name: 'Pub', address: 'a', ownerId: 9, isResidence: false, privacyTier: 'full' },
    { id: 2, name: 'Mine', address: 'b', ownerId: 5, isResidence: true, privacyTier: 'full' },
    { id: 3, name: 'Theirs', address: 'c', ownerId: 6, isResidence: false, privacyTier: 'city_state' },
  ], [{ id: 4, name: 'Gone', address: null, removedAt: new Date('2026-01-02T03:04:05Z') }], { id: 5, role: 'user' });
  assert.deepEqual(view.onFloor, [
    { id: 1, name: 'Pub', address: 'a', home: false },
    { id: 2, name: 'Mine', address: 'b', home: true },
  ]);
  assert.equal(view.privateCount, 1);
  assert.equal(view.venueCount, 3);
  assert.equal(view.formerly[0].removedAt, '2026-01-02T03:04:05.000Z');
  assert.ok(!JSON.stringify(view).includes('Theirs'));
});

test('machineVenues.ts cannot reach Pinball Map (no pmClient / roster fetcher / catalog imports)', () => {
  const src = readFileSync(new URL('./machineVenues.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.ok(imports.length > 0);
  for (const mod of imports) {
    assert.ok(!/pmClient|pmRosterCache|pinballMap|pinballmapApi|pmGuards|venueHistory/.test(mod), `imports ${mod}`);
  }
  assert.ok(!/getVenueRoster|pmClient\(|fetch\(/.test(src.replace(/^\s*\/\/.*$/gm, '')));
});
