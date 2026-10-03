// Run: npx tsx --test src/lib/venueOwner.test.ts   (from artifacts/api-server)
//
// `ownerUsername` — the owner's @handle shown beside a private venue's name ("HOME (@collasta)").
// Pins the rule (venueOwner.ts) across owner / friend / stranger / admin / guest × every kind of
// venue × the "Show my machines/scores publicly" switch, for the JS function, the venue payloads that
// use it (venueListRow, venueDetailView, venueMachinesView), and the SQL twin, which is executed in an
// in-process PGlite and must agree with the JS rule row for row. Nothing is dialled; the dummy
// DATABASE_URL only satisfies @workspace/db's import-time check.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { venueOwnerUsername, venueOwnerUsernameSql } = await import('./venueOwner.js');
const { venueListRow, venueDetailView, venueMachinesView } = await import('./venueView.js');
const { PgDialect } = await import('drizzle-orm/pg-core');
const { sql } = await import('drizzle-orm');
const { PGlite } = await import('@electric-sql/pglite');

type Tier = 'full' | 'city_state' | 'hidden';

const OWNER = 1, FRIEND = 2, STRANGER = 3, ADMIN = 4, DISABLED_OWNER = 5;
const VIEWERS = {
  owner: { id: OWNER, role: 'user' },
  friend: { id: FRIEND, role: 'user' },
  stranger: { id: STRANGER, role: 'user' },
  admin: { id: ADMIN, role: 'admin' },
  guest: undefined,
} as const;
type ViewerName = keyof typeof VIEWERS;

const KINDS: Record<string, { isResidence: boolean; privacyTier: Tier }> = {
  publicVenue: { isResidence: false, privacyTier: 'full' },
  residenceFull: { isResidence: true, privacyTier: 'full' },
  residenceCityState: { isResidence: true, privacyTier: 'city_state' },
  residenceHidden: { isResidence: true, privacyTier: 'hidden' },
  // A restricted tier without the residence flag is private too (isPrivateTier).
  restrictedNonResidence: { isResidence: false, privacyTier: 'city_state' },
};

function venue(kind: string, show: boolean, over: Record<string, unknown> = {}) {
  return {
    id: 44, name: 'HOME', ownerId: OWNER as number | null, createdById: OWNER, ownerUsername: 'collasta' as string | null,
    ...KINDS[kind],
    showMachinesAndScores: show,
    address: '1 Secret Ln, Brewster, MA 02631', latitude: 41.76, longitude: -70.07,
    city: 'Brewster', state: 'MA', cityLat: 41.75, cityLng: -70.08, timezone: 'America/New_York',
    pinballMapId: null as number | null, pmMachineCount: null as number | null,
    ...over,
  };
}
const counts = { playedMachineCount: 1, inventoryCount: 1, inventoryManaged: true };

/** What the rule says: private venue, and the viewer may see its activity (switch on, or owner/admin). */
function expected(kind: string, show: boolean, viewer: ViewerName): string | null {
  if (kind === 'publicVenue') return null;
  if (show) return 'collasta';
  return viewer === 'owner' || viewer === 'admin' ? 'collasta' : null;
}

test('venueOwnerUsername: owner/friend/stranger/admin/guest × every venue kind × the switch', () => {
  for (const kind of Object.keys(KINDS)) {
    for (const show of [true, false]) {
      for (const [name, viewer] of Object.entries(VIEWERS) as Array<[ViewerName, (typeof VIEWERS)[ViewerName]]>) {
        assert.equal(venueOwnerUsername(venue(kind, show), viewer), expected(kind, show, name), `${kind} / show=${show} / ${name}`);
      }
    }
  }
});

test('venueOwnerUsername: a public venue never names whoever created it, even with a switch value stored', () => {
  for (const viewer of Object.values(VIEWERS)) {
    assert.equal(venueOwnerUsername(venue('publicVenue', false), viewer), null);
  }
});

test('venueOwnerUsername: no owner on file → null', () => {
  assert.equal(venueOwnerUsername(venue('residenceHidden', true, { ownerId: null }), VIEWERS.admin), null);
  assert.equal(venueOwnerUsername(venue('residenceHidden', true, { ownerUsername: null }), VIEWERS.stranger), null);
});

test('venue payloads carry ownerUsername per the rule, and never the raw join value', () => {
  for (const kind of Object.keys(KINDS)) {
    for (const show of [true, false]) {
      for (const [name, viewer] of Object.entries(VIEWERS) as Array<[ViewerName, (typeof VIEWERS)[ViewerName]]>) {
        const want = expected(kind, show, name);
        const label = `${kind} / show=${show} / ${name}`;
        const list = venueListRow({ ...venue(kind, show), ...counts, scoreCount: 2, lastPlayedAt: null }, viewer) as Record<string, unknown>;
        assert.equal(list.ownerUsername, want, `list ${label}`);
        const detail = venueDetailView({ ...venue(kind, show), ...counts }, viewer) as Record<string, unknown>;
        assert.equal(detail.ownerUsername, want, `detail ${label}`);
        const machines = venueMachinesView(venue(kind, show), viewer) as Record<string, unknown>;
        assert.equal(machines.ownerUsername, want, `machines ${label}`);
      }
    }
  }
});

// ---- the SQL twin, executed --------------------------------------------------------------------

const pg = new PGlite();
await pg.exec(`
  CREATE TABLE users (id integer PRIMARY KEY, username text NOT NULL, disabled_at timestamptz);
  CREATE TABLE venues (id integer PRIMARY KEY, name text NOT NULL, owner_id integer,
    is_residence boolean NOT NULL, privacy_tier text NOT NULL, show_machines_and_scores boolean NOT NULL);
  CREATE TABLE scores (id integer PRIMARY KEY, venue_id integer);
`);
await pg.exec(`INSERT INTO users VALUES (${OWNER}, 'collasta', NULL), (${FRIEND}, 'pal', NULL), (${STRANGER}, 'someone', NULL),
  (${ADMIN}, 'boss', NULL), (${DISABLED_OWNER}, 'gone', now())`);

interface Fx { id: number; kind: string; show: boolean; ownerId: number | null }
const fixtures: Fx[] = [];
let nextId = 100;
for (const kind of Object.keys(KINDS)) {
  for (const show of [true, false]) fixtures.push({ id: nextId++, kind, show, ownerId: OWNER });
}
const DISABLED_HOME = nextId++;
fixtures.push({ id: DISABLED_HOME, kind: 'residenceHidden', show: true, ownerId: DISABLED_OWNER });
const OWNERLESS = nextId++;
fixtures.push({ id: OWNERLESS, kind: 'residenceHidden', show: true, ownerId: null });
for (const f of fixtures) {
  await pg.query('INSERT INTO venues VALUES ($1, $2, $3, $4, $5, $6)',
    [f.id, 'HOME', f.ownerId, KINDS[f.kind].isResidence, KINDS[f.kind].privacyTier, f.show]);
  await pg.query('INSERT INTO scores VALUES ($1, $1)', [f.id]);
}
await pg.query('INSERT INTO scores VALUES (1, NULL)'); // a venue-less score

async function sqlOwners(viewer: (typeof VIEWERS)[ViewerName]): Promise<Map<number, string | null>> {
  const q = new PgDialect().sqlToQuery(sql`SELECT scores.id, ${venueOwnerUsernameSql(viewer, sql.raw('scores.venue_id'))} AS u FROM scores`);
  const { rows } = await pg.query<{ id: number; u: string | null }>(q.sql, q.params as unknown[]);
  return new Map(rows.map(r => [r.id, r.u]));
}

test('venueOwnerUsernameSql matches venueOwnerUsername for every venue and viewer', async () => {
  for (const [name, viewer] of Object.entries(VIEWERS) as Array<[ViewerName, (typeof VIEWERS)[ViewerName]]>) {
    const got = await sqlOwners(viewer);
    for (const f of fixtures.filter(x => x.ownerId === OWNER)) {
      const js = venueOwnerUsername(venue(f.kind, f.show), viewer);
      assert.equal(got.get(f.id), js, `${f.kind} / show=${f.show} / ${name}`);
    }
    assert.equal(got.get(1), null, `venue-less score / ${name}`);
    assert.equal(got.get(OWNERLESS), null, `ownerless venue / ${name}`);
  }
});

test('a disabled owner keeps their handle (users are never deleted; it still tells two HOMEs apart)', async () => {
  for (const viewer of Object.values(VIEWERS)) {
    assert.equal((await sqlOwners(viewer)).get(DISABLED_HOME), 'gone');
  }
});
