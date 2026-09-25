// Run: npx tsx --test src/lib/venuePrivacy.test.ts   (from artifacts/api-server)
// venueDedup.ts imports @workspace/db, which throws without DATABASE_URL; postgres.js connects
// lazily, so this dummy URL is never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { redactVenue, canSeeVenueLinkage, mayAttachScoreTo } = await import('./venuePrivacy.js');
const { partitionDuplicates } = await import('./venueDedup.js');

const OWNER = 1;
const STRANGER = 26;

function venue(over: Record<string, unknown> = {}) {
  return {
    id: 44, name: "Will's Basement", ownerId: OWNER, isResidence: true, privacyTier: 'hidden' as 'full' | 'city_state' | 'hidden',
    address: '1 Secret Ln, Brewster, MA 02631', latitude: 41.76, longitude: -70.07,
    city: 'Brewster', state: 'MA', cityLat: 41.75, cityLng: -70.08, timezone: 'America/New_York',
    hereId: 'here:pds:place:abc', pinballMapId: 999, pmMachineCount: 12,
    ...over,
  };
}

test('redactVenue: hidden tier strips HERE / Pinball Map linkage for strangers', () => {
  const r = redactVenue(venue(), STRANGER, false);
  assert.equal(r.hereId, null);
  assert.equal(r.pinballMapId, null);
  assert.equal(r.pmMachineCount, null);
  assert.equal(r.address, null);
  assert.equal(r.latitude, null);
  assert.equal(r.timezone, null);
});

test('redactVenue: city_state tier strips linkage too, keeps the city centroid', () => {
  const r = redactVenue(venue({ privacyTier: 'city_state' }), STRANGER, false);
  assert.equal(r.hereId, null);
  assert.equal(r.pinballMapId, null);
  assert.equal(r.address, 'Brewster, MA');
  assert.equal(r.latitude, 41.75);
});

test('redactVenue: signed-out viewers are strangers', () => {
  assert.equal(redactVenue(venue(), undefined, false).pinballMapId, null);
});

test('redactVenue: owner and admin see everything', () => {
  for (const [id, admin] of [[OWNER, false], [STRANGER, true]] as const) {
    const r = redactVenue(venue(), id, admin);
    assert.equal(r.hereId, 'here:pds:place:abc');
    assert.equal(r.pinballMapId, 999);
    assert.equal(r.address, '1 Secret Ln, Brewster, MA 02631');
  }
});

test('redactVenue: full tier is untouched, and so is a full-tier residence', () => {
  const pub = venue({ isResidence: false, privacyTier: 'full', ownerId: null });
  assert.deepEqual(redactVenue(pub, STRANGER, false), pub);
  const openHome = venue({ privacyTier: 'full' });
  assert.equal(redactVenue(openHome, STRANGER, false).pinballMapId, 999);
});

test('redactVenue: only nulls linkage keys the row already has — no shape change', () => {
  const { hereId: _h, pinballMapId: _p, pmMachineCount: _c, ...bare } = venue();
  const r = redactVenue(bare, STRANGER, false) as Record<string, unknown>;
  assert.equal('hereId' in r, false);
  assert.equal('pinballMapId' in r, false);
  assert.equal('pmMachineCount' in r, false);
  // a pmLocationUrl carried on the row is stripped as well
  const withUrl = redactVenue({ ...venue(), pmLocationUrl: 'https://pinballmap.com/map?by_location_id=999' }, STRANGER, false);
  assert.equal(withUrl.pmLocationUrl, null);
});

test('redactVenue does not mutate its input', () => {
  const v = venue();
  redactVenue(v, STRANGER, false);
  assert.equal(v.pinballMapId, 999);
  assert.equal(v.hereId, 'here:pds:place:abc');
});

test('canSeeVenueLinkage mirrors redactVenue', () => {
  assert.equal(canSeeVenueLinkage(venue(), STRANGER, false), false);
  assert.equal(canSeeVenueLinkage(venue(), undefined, false), false);
  assert.equal(canSeeVenueLinkage(venue(), OWNER, false), true);
  assert.equal(canSeeVenueLinkage(venue(), STRANGER, true), true);
  assert.equal(canSeeVenueLinkage(venue({ privacyTier: 'full' }), STRANGER, false), true);
});

test('mayAttachScoreTo: nobody files a score under someone else\'s private venue', () => {
  const stranger = { id: STRANGER, role: 'user' };
  assert.equal(mayAttachScoreTo(venue(), stranger), false);
  assert.equal(mayAttachScoreTo(venue({ privacyTier: 'city_state' }), stranger), false);
  // A residence shown in full is still someone's home.
  assert.equal(mayAttachScoreTo(venue({ privacyTier: 'full' }), stranger), false);
  assert.equal(mayAttachScoreTo(venue(), { id: OWNER, role: 'user' }), true);
  assert.equal(mayAttachScoreTo(venue(), { id: STRANGER, role: 'admin' }), true);
  // Public venues: anyone.
  assert.equal(mayAttachScoreTo(venue({ isResidence: false, privacyTier: 'full', ownerId: null }), stranger), true);
});

function match(over: Record<string, unknown> = {}) {
  return {
    id: 44, name: "Will's Basement", address: '1 Secret Ln', distance: 40,
    ownerId: OWNER, isResidence: true, privacyTier: 'hidden' as 'full' | 'city_state' | 'hidden',
    ...over,
  };
}
const pubMatch = match({ id: 12, name: 'Logan Arcade', address: '2410 W Fullerton', distance: 90, ownerId: null, isResidence: false, privacyTier: 'full' });

test('partitionDuplicates: a stranger gets only an anonymous flag for a private match', () => {
  const r = partitionDuplicates([match()], STRANGER, false);
  assert.deepEqual(r, { candidates: [], privateNearby: true });
  // Nothing identifying survives: no id, name, address or distance.
  const out = JSON.stringify(r);
  for (const leak of ['Basement', 'Secret', '44', '40']) assert.equal(out.includes(leak), false, leak);
});

test('partitionDuplicates: signed-out requester is a stranger', () => {
  assert.deepEqual(partitionDuplicates([match()], undefined, false), { candidates: [], privateNearby: true });
});

test('partitionDuplicates: public matches pass through without privacy fields', () => {
  const r = partitionDuplicates([pubMatch, match()], STRANGER, false);
  assert.equal(r.privateNearby, true);
  assert.deepEqual(r.candidates, [{ id: 12, name: 'Logan Arcade', address: '2410 W Fullerton', distance: 90 }]);
});

test('partitionDuplicates: the owner and admins see their private match as a normal candidate', () => {
  const own = partitionDuplicates([match()], OWNER, false);
  assert.equal(own.privateNearby, false);
  assert.deepEqual(own.candidates, [{ id: 44, name: "Will's Basement", address: '1 Secret Ln', distance: 40 }]);
  assert.equal(partitionDuplicates([match()], STRANGER, true).candidates.length, 1);
});

test('partitionDuplicates: restricted tier without the residence flag, and full-tier residences, are private', () => {
  assert.equal(partitionDuplicates([match({ isResidence: false, privacyTier: 'city_state' })], STRANGER, false).privateNearby, true);
  assert.equal(partitionDuplicates([match({ privacyTier: 'full' })], STRANGER, false).privateNearby, true);
});

test('partitionDuplicates: no matches', () => {
  assert.deepEqual(partitionDuplicates([], STRANGER, false), { candidates: [], privateNearby: false });
});
