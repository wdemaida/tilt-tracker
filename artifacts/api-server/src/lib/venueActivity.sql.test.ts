// Run: npx tsx --test src/lib/venueActivity.sql.test.ts   (from artifacts/api-server)
//
// Asserts visibleScoreSql (what the routes run) and canSeeScore (the rule the unit tests pin) agree,
// row for row, for every viewer. The SQL is rendered by drizzle's PgDialect and executed against an
// in-process PGlite (real Postgres, WASM) — no server, nothing dialled; the dummy DATABASE_URL only
// satisfies @workspace/db's import-time check.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { visibleScoreSql, canSeeScore } = await import('./venueActivity.js');
const { PgDialect } = await import('drizzle-orm/pg-core');
const { PGlite } = await import('@electric-sql/pglite');

type Tier = 'full' | 'city_state' | 'hidden';
interface VenueFixture { id: number; ownerId: number | null; isResidence: boolean; privacyTier: Tier; showMachinesAndScores: boolean }

const OWNER = 1, FRIEND = 2, STRANGER = 3, ADMIN = 4;

// Every kind of venue × switch position, all owned by OWNER, plus an ownerless public venue.
const venues: VenueFixture[] = [];
let vid = 1;
for (const [isResidence, privacyTier] of [[false, 'full'], [true, 'full'], [true, 'city_state'], [true, 'hidden'], [false, 'hidden']] as const) {
  for (const show of [true, false]) {
    venues.push({ id: vid++, ownerId: OWNER, isResidence, privacyTier, showMachinesAndScores: show });
  }
}
venues.push({ id: vid++, ownerId: null, isResidence: false, privacyTier: 'full', showMachinesAndScores: false });

// A score by each user at each venue, and one per user with no venue.
const scores: Array<{ id: number; userId: number; venueId: number | null }> = [];
let sid = 1;
for (const userId of [OWNER, FRIEND, STRANGER]) {
  for (const v of venues) scores.push({ id: sid++, userId, venueId: v.id });
  scores.push({ id: sid++, userId, venueId: null });
}

const db = new PGlite();
await db.exec(`
  CREATE TABLE venues (id integer PRIMARY KEY, owner_id integer, is_residence boolean NOT NULL,
    privacy_tier text NOT NULL, show_machines_and_scores boolean NOT NULL);
  CREATE TABLE scores (id integer PRIMARY KEY, user_id integer NOT NULL, venue_id integer);
`);
for (const v of venues) {
  await db.query('INSERT INTO venues VALUES ($1, $2, $3, $4, $5)', [v.id, v.ownerId, v.isResidence, v.privacyTier, v.showMachinesAndScores]);
}
for (const s of scores) await db.query('INSERT INTO scores VALUES ($1, $2, $3)', [s.id, s.userId, s.venueId]);

const dialect = new PgDialect();
const venueById = new Map(venues.map(v => [v.id, v]));

const viewers = {
  signedOut: undefined,
  owner: { id: OWNER, role: 'user' },
  friend: { id: FRIEND, role: 'user' },
  stranger: { id: STRANGER, role: 'user' },
  admin: { id: ADMIN, role: 'admin' },
};

for (const [name, viewer] of Object.entries(viewers)) {
  test(`visibleScoreSql and canSeeScore agree — ${name}`, async () => {
    const where = dialect.sqlToQuery(visibleScoreSql(viewer));
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM scores WHERE ${where.sql} ORDER BY id`, where.params);
    const fromSql = rows.map(r => r.id);
    const fromJs = scores
      .filter(s => canSeeScore(s, s.venueId == null ? null : venueById.get(s.venueId), viewer))
      .map(s => s.id);
    assert.deepEqual(fromSql, fromJs);
    // Sanity: the fixture actually exercises hiding for non-exempt viewers.
    if (name === 'stranger' || name === 'signedOut') assert.ok(fromJs.length < scores.length);
    if (name === 'admin' || name === 'owner') assert.equal(fromJs.length, scores.length);
  });
}
