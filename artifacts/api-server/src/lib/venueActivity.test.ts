// Run: npx tsx --test src/lib/venueActivity.test.ts   (from artifacts/api-server)
// venueActivity.ts imports @workspace/db (for column references in visibleScoreSql), which throws
// without DATABASE_URL; postgres.js connects lazily, so this dummy URL is never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  activityRestricted, canSeeVenueActivity, canSeeScore, canManageInventory, usesOwnerInventory, canEditVenue, visibleScoreSql,
} = await import('./venueActivity.js');
const { venueListRow, venueDetailView, venueMachinesView, displayedMachineCount } = await import('./venueView.js');
const { PgDialect } = await import('drizzle-orm/pg-core');

type Tier = 'full' | 'city_state' | 'hidden';

const OWNER_ID = 1;
const OTHER_ID = 26;
const owner = { id: OWNER_ID, role: 'user' };
const admin = { id: 99, role: 'admin' };
const other = { id: OTHER_ID, role: 'user' };
const signedOut = undefined;

const VIEWERS = { owner, admin, other, signedOut } as const;
type ViewerName = keyof typeof VIEWERS;

// isResidence/privacyTier combinations that exist in the app.
const KINDS: Record<string, { isResidence: boolean; privacyTier: Tier }> = {
  publicVenue: { isResidence: false, privacyTier: 'full' },
  residenceFull: { isResidence: true, privacyTier: 'full' },
  residenceCityState: { isResidence: true, privacyTier: 'city_state' },
  residenceHidden: { isResidence: true, privacyTier: 'hidden' },
};

function venue(kind: keyof typeof KINDS, show: boolean, over: Record<string, unknown> = {}) {
  return {
    id: 44, name: "Will's Basement", ownerId: OWNER_ID, createdById: OWNER_ID,
    ...KINDS[kind],
    showMachinesAndScores: show,
    address: '1 Secret Ln, Brewster, MA 02631', latitude: 41.76, longitude: -70.07,
    city: 'Brewster', state: 'MA', cityLat: 41.75, cityLng: -70.08, timezone: 'America/New_York',
    pinballMapId: null as number | null, pmMachineCount: null as number | null,
    ...over,
  };
}

// ---- the visibility matrix -------------------------------------------------------------------

test('canSeeVenueActivity: switch ON — everyone sees machines and scores, whatever the tier', () => {
  for (const kind of Object.keys(KINDS)) {
    for (const [name, viewer] of Object.entries(VIEWERS)) {
      assert.equal(canSeeVenueActivity(venue(kind, true), viewer), true, `${kind} / ${name}`);
    }
  }
});

test('canSeeVenueActivity: switch OFF on a private venue — only owner and admin', () => {
  const expected: Record<ViewerName, boolean> = { owner: true, admin: true, other: false, signedOut: false };
  for (const kind of ['residenceFull', 'residenceCityState', 'residenceHidden']) {
    for (const [name, viewer] of Object.entries(VIEWERS) as Array<[ViewerName, typeof owner | undefined]>) {
      assert.equal(canSeeVenueActivity(venue(kind, false), viewer), expected[name], `${kind} / ${name}`);
    }
  }
});

test('canSeeVenueActivity: switch OFF on a public venue is ignored — its creator cannot hide a bar', () => {
  for (const viewer of Object.values(VIEWERS)) {
    assert.equal(canSeeVenueActivity(venue('publicVenue', false), viewer), true);
  }
  assert.equal(activityRestricted(venue('publicVenue', false)), false);
  assert.equal(activityRestricted(venue('residenceHidden', false)), true);
  assert.equal(activityRestricted(venue('residenceHidden', true)), false);
});

test('canSeeScore: a score\'s author always sees it, even at a hidden venue they don\'t own', () => {
  const hiddenHome = venue('residenceHidden', false);
  assert.equal(canSeeScore({ userId: OTHER_ID }, hiddenHome, other), true);
  // ...but not somebody else's score there
  assert.equal(canSeeScore({ userId: 27 }, hiddenHome, other), false);
  assert.equal(canSeeScore({ userId: OTHER_ID }, hiddenHome, signedOut), false);
  // owner and admin see every score there
  assert.equal(canSeeScore({ userId: 27 }, hiddenHome, owner), true);
  assert.equal(canSeeScore({ userId: 27 }, hiddenHome, admin), true);
  // no venue — always visible
  assert.equal(canSeeScore({ userId: 27 }, null, signedOut), true);
  // switch on — visible to anyone
  assert.equal(canSeeScore({ userId: 27 }, venue('residenceCityState', true), signedOut), true);
});

// ---- inventory permissions ---------------------------------------------------------------------

test('usesOwnerInventory: private venues only', () => {
  assert.equal(usesOwnerInventory(KINDS.publicVenue), false);
  assert.equal(usesOwnerInventory(KINDS.residenceFull), true);
  assert.equal(usesOwnerInventory(KINDS.residenceCityState), true);
  assert.equal(usesOwnerInventory(KINDS.residenceHidden), true);
});

test('canManageInventory: owner and admin on a private venue; nobody on a public one', () => {
  const expected: Record<ViewerName, boolean> = { owner: true, admin: true, other: false, signedOut: false };
  for (const kind of ['residenceFull', 'residenceCityState', 'residenceHidden']) {
    for (const show of [true, false]) {
      for (const [name, viewer] of Object.entries(VIEWERS) as Array<[ViewerName, typeof owner | undefined]>) {
        assert.equal(canManageInventory(venue(kind, show), viewer), expected[name], `${kind} / show=${show} / ${name}`);
      }
    }
  }
  for (const viewer of Object.values(VIEWERS)) {
    assert.equal(canManageInventory(venue('publicVenue', true), viewer), false);
  }
  // A venue's creator who isn't its owner gets no say over the inventory.
  assert.equal(canManageInventory(venue('residenceHidden', true, { ownerId: null, createdById: OTHER_ID }), other), false);
});

test('canEditVenue mirrors PATCH /api/venues/:id — owner or admin', () => {
  assert.equal(canEditVenue(venue('residenceHidden', true), owner), true);
  assert.equal(canEditVenue(venue('residenceHidden', true), admin), true);
  assert.equal(canEditVenue(venue('residenceHidden', true), other), false);
  assert.equal(canEditVenue(venue('residenceHidden', true), signedOut), false);
  assert.equal(canEditVenue(venue('publicVenue', true, { ownerId: null }), other), false);
});

// ---- machine counts ------------------------------------------------------------------------------

test('displayedMachineCount: a private venue with a managed inventory counts the inventory', () => {
  const counts = { playedMachineCount: 3, inventoryCount: 1, inventoryManaged: true };
  assert.equal(displayedMachineCount({ ...KINDS.residenceHidden, ...counts }), 1);
  // never managed: falls back to machines scored there, as before
  assert.equal(displayedMachineCount({ ...KINDS.residenceHidden, ...counts, inventoryManaged: false, inventoryCount: 0 }), 3);
  // managed but everything sold: 0, not the played count
  assert.equal(displayedMachineCount({ ...KINDS.residenceHidden, ...counts, inventoryCount: 0 }), 0);
  // public venues always count played machines
  assert.equal(displayedMachineCount({ ...KINDS.publicVenue, ...counts }), 3);
});

// ---- the wire shapes -------------------------------------------------------------------------------

function listRow(kind: keyof typeof KINDS, show: boolean) {
  return {
    ...venue(kind, show),
    scoreCount: 5, playedMachineCount: 2, inventoryCount: 1, inventoryManaged: true,
    lastPlayedAt: new Date('2026-09-20T20:00:00Z'),
  };
}

test('venueListRow: someone else\'s home venue carries only what the card needs', () => {
  for (const viewer of [other, signedOut]) {
    const row = venueListRow(listRow('residenceHidden', true), viewer) as Record<string, unknown>;
    assert.equal(row.name, "Will's Basement");
    assert.equal(row.address, null);
    assert.equal(row.machineCount, 1);
    assert.equal(row.isPrivate, true);
    assert.equal(row.canEdit, false);
    for (const k of ['ownerId', 'createdById', 'privacyTier', 'latitude', 'longitude', 'timezone', 'lastPlayedAt',
      'city', 'state', 'cityLat', 'cityLng', 'showMachinesAndScores', 'hereId']) {
      assert.ok(!(k in row), `${k} should not be sent`);
    }
  }
});

test('venueListRow: city_state tier still shows "City, ST"', () => {
  const row = venueListRow(listRow('residenceCityState', true), other);
  assert.equal(row.address, 'Brewster, MA');
});

test('venueListRow: switch OFF hides the machine count from others, not from owner/admin', () => {
  assert.equal(venueListRow(listRow('residenceHidden', false), other).machineCount, null);
  assert.equal(venueListRow(listRow('residenceHidden', false), other).activityHidden, true);
  assert.equal(venueListRow(listRow('residenceHidden', false), signedOut).machineCount, null);
  assert.equal(venueListRow(listRow('residenceHidden', false), owner).machineCount, 1);
  assert.equal(venueListRow(listRow('residenceHidden', false), admin).machineCount, 1);
});

test('venueListRow: the owner gets the full row, the switch value, and no ownerId', () => {
  const row = venueListRow(listRow('residenceHidden', false), owner) as Record<string, unknown>;
  assert.equal(row.address, '1 Secret Ln, Brewster, MA 02631');
  assert.equal(row.canEdit, true);
  assert.equal(row.showMachinesAndScores, false);
  assert.equal(row.privacyTier, 'hidden');
  assert.ok(!('ownerId' in row));
  assert.ok(!('createdById' in row));
});

test('venueListRow: public venues keep their shape (minus ownerId) and X/Y counts', () => {
  const row = venueListRow({ ...listRow('publicVenue', true), pinballMapId: 5, pmMachineCount: 12 }, other) as Record<string, unknown>;
  assert.equal(row.machineCount, 2);
  assert.equal(row.pmMachineCount, 12);
  assert.equal(row.latitude, 41.76);
  assert.ok(!('ownerId' in row));
  assert.ok(!('showMachinesAndScores' in row));
});

test('venueDetailView: others see the tier-redacted location and the inventory count', () => {
  const counts = { playedMachineCount: 0, inventoryCount: 1, inventoryManaged: true };
  const hidden = venueDetailView({ ...venue('residenceHidden', true), ...counts }, other) as Record<string, unknown>;
  assert.equal(hidden.address, null);
  assert.equal(hidden.latitude, null);
  assert.equal(hidden.timezone, null);
  assert.equal(hidden.machineCount, 1);
  assert.ok(!('ownerId' in hidden));
  const city = venueDetailView({ ...venue('residenceCityState', true), ...counts }, signedOut);
  assert.equal(city.address, 'Brewster, MA');
  assert.equal(city.latitude, 41.75);
  const off = venueDetailView({ ...venue('residenceCityState', false), ...counts }, signedOut);
  assert.equal(off.machineCount, null);
  assert.equal(off.activityHidden, true);
});

test('venueMachinesView: others get name + tier-redacted location only; owner/admin get the row', () => {
  for (const viewer of [other, signedOut]) {
    const v = venueMachinesView({ ...venue('residenceHidden', false), createdAt: new Date() }, viewer) as Record<string, unknown>;
    assert.deepEqual(Object.keys(v).sort(), ['address', 'id', 'isResidence', 'latitude', 'longitude', 'name', 'timezone']);
    assert.equal(v.address, null);
    assert.equal(v.timezone, null);
  }
  assert.equal(venueMachinesView(venue('residenceCityState', true), other).address, 'Brewster, MA');
  const own = venueMachinesView(venue('residenceHidden', false), owner) as Record<string, unknown>;
  assert.equal(own.privacyTier, 'hidden');
  assert.ok(!('ownerId' in own) && !('createdById' in own));
  const pub = venueMachinesView(venue('publicVenue', true), other) as Record<string, unknown>;
  assert.equal(pub.address, '1 Secret Ln, Brewster, MA 02631');
  assert.ok(!('ownerId' in pub));
});

// ---- the SQL twin --------------------------------------------------------------------------------

const dialect = new PgDialect();
const render = (viewer?: { id: number; role: string }) => dialect.sqlToQuery(visibleScoreSql(viewer));

test('visibleScoreSql: admin sees everything', () => {
  assert.equal(render(admin).sql, 'true');
});

test('visibleScoreSql: signed out — only venue-less scores or venues not hidden', () => {
  const q = render(undefined);
  assert.match(q.sql, /"scores"\."venue_id" IS NULL OR NOT EXISTS/);
  assert.match(q.sql, /show_machines_and_scores = false/);
  assert.match(q.sql, /hv\.is_residence OR hv\.privacy_tier <> 'full'/);
  assert.doesNotMatch(q.sql, /user_id/);
  assert.deepEqual(q.params, []);
});

test('visibleScoreSql: signed in — own scores and own venues are exempt', () => {
  const q = render(other);
  assert.match(q.sql, /"scores"\."user_id" = \$1/);
  assert.match(q.sql, /hv\.owner_id IS DISTINCT FROM \$2/);
  assert.deepEqual(q.params, [OTHER_ID, OTHER_ID]);
});
