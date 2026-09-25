// Run: npx tsx --test src/lib/venuePrivacy.test.ts   (from artifacts/api-server)
// venueDedup.ts imports @workspace/db, which throws without DATABASE_URL; postgres.js connects
// lazily, so this dummy URL is never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { redactVenue, canSeeVenueLinkage, mayRevealByLocation } = await import('./venuePrivacy.js');
const { matchDuplicates } = await import('./venueDedup.js');

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

test('mayRevealByLocation: someone else\'s private venue never surfaces from a location', () => {
  const stranger = { id: STRANGER, role: 'user' };
  assert.equal(mayRevealByLocation(venue(), stranger), false);
  assert.equal(mayRevealByLocation(venue({ privacyTier: 'city_state' }), stranger), false);
  // A residence shown in full is still someone's home.
  assert.equal(mayRevealByLocation(venue({ privacyTier: 'full' }), stranger), false);
  assert.equal(mayRevealByLocation(venue(), undefined), false);
  assert.equal(mayRevealByLocation(venue(), { id: OWNER, role: 'user' }), true);
  assert.equal(mayRevealByLocation(venue(), { id: STRANGER, role: 'admin' }), true);
  // Public venues: anyone, signed in or not.
  assert.equal(mayRevealByLocation(venue({ isResidence: false, privacyTier: 'full', ownerId: null }), stranger), true);
  assert.equal(mayRevealByLocation(venue({ isResidence: false, privacyTier: 'full', ownerId: null }), undefined), true);
});

// Will's Basement sits at 41.76,-70.07. A stranger types an address that geocodes 40m away.
function row(over: Record<string, unknown> = {}) {
  return {
    id: 44, name: "Will's Basement", address: '1 Secret Ln', latitude: 41.76, longitude: -70.07,
    ownerId: OWNER, isResidence: true, privacyTier: 'hidden' as 'full' | 'city_state' | 'hidden',
    ...over,
  };
}
const pubRow = row({ id: 12, name: 'Logan Arcade', address: '2410 W Fullerton', latitude: 41.9249, longitude: -87.6877, ownerId: null, isResidence: false, privacyTier: 'full' });
const near = { latitude: 41.7603, longitude: -70.07 };        // ~33m from #44
const farAway = { latitude: 34.05, longitude: -118.24 };      // Los Angeles
const nowhere = { latitude: null, longitude: null };          // geocode failed
const strangerU = { id: STRANGER, role: 'user' };

test('matchDuplicates: a stranger never matches a private venue by proximity', () => {
  // Same *normalized* name but not exact ("Wills Basement"), 33m away: no match at all.
  assert.deepEqual(matchDuplicates({ name: 'Wills Basement', ...near }, [row()], strangerU), []);
  // Nor via the geocode-failure name-only fallback.
  assert.deepEqual(matchDuplicates({ name: 'Wills Basement', ...nowhere }, [row()], strangerU), []);
});

test('matchDuplicates: an exact name match on a private venue is name-only, wherever the typed address is', () => {
  const expected = [{ id: 44, name: "Will's Basement", address: null, distance: null, isPrivate: true }];
  for (const where of [near, farAway, nowhere]) {
    assert.deepEqual(matchDuplicates({ name: "  will's BASEMENT ", ...where }, [row()], strangerU), expected);
  }
  // The answer is identical near and far — so it can't be used to learn anything about location.
  assert.deepEqual(
    matchDuplicates({ name: "Will's Basement", ...near }, [row()], strangerU),
    matchDuplicates({ name: "Will's Basement", ...farAway }, [row()], strangerU),
  );
});

test('matchDuplicates: signed-out requester is a stranger', () => {
  assert.equal(matchDuplicates({ name: "Will's Basement", ...near }, [row()], undefined)[0].isPrivate, true);
});

test('matchDuplicates: restricted tier without the residence flag, and a full-tier residence, are private', () => {
  assert.equal(matchDuplicates({ name: 'Wills Basement', ...near }, [row({ isResidence: false, privacyTier: 'city_state' })], strangerU).length, 0);
  assert.equal(matchDuplicates({ name: 'Wills Basement', ...near }, [row({ privacyTier: 'full' })], strangerU).length, 0);
});

test('matchDuplicates: owner and admin keep today\'s full candidates for their private venue', () => {
  for (const who of [{ id: OWNER, role: 'user' }, { id: STRANGER, role: 'admin' }]) {
    const [m] = matchDuplicates({ name: 'Wills Basement', ...near }, [row()], who);
    assert.equal(m.id, 44);
    assert.equal(m.address, '1 Secret Ln');
    assert.equal(typeof m.distance, 'number');
    assert.equal(m.isPrivate, undefined);
    assert.deepEqual(matchDuplicates({ name: "Will's Basement", ...farAway }, [row()], who), []);
  }
});

test('matchDuplicates: public venues unchanged — normalized name within 250m, or name-only without a geocode', () => {
  const pubNear = { latitude: 41.9250, longitude: -87.6877 };
  const [m] = matchDuplicates({ name: 'logan arcade', ...pubNear }, [pubRow], strangerU);
  assert.equal(m.address, '2410 W Fullerton');
  assert.ok(m.distance != null && m.distance < 250);
  assert.deepEqual(matchDuplicates({ name: 'Logan Arcade', ...farAway }, [pubRow], strangerU), []);
  assert.equal(matchDuplicates({ name: 'Logan Arcade', ...nowhere }, [pubRow], strangerU)[0].distance, null);
});

// --- Exact-name discovery (owner decision 2026-09-25) --------------------------------------------

const { exactVenueNameKey, isPrivateTier } = await import('./venuePrivacy.js');

test('exactVenueNameKey: trimmed and case-insensitive, nothing fuzzier', () => {
  assert.equal(exactVenueNameKey("  Will's Basement "), "will's basement");
  assert.equal(exactVenueNameKey("WILL'S BASEMENT"), exactVenueNameKey("will's basement"));
  // Punctuation, articles and inner spacing are NOT folded — that would make it a fuzzy search.
  assert.notEqual(exactVenueNameKey('Wills Basement'), exactVenueNameKey("Will's Basement"));
  assert.notEqual(exactVenueNameKey('The Basement'), exactVenueNameKey('Basement'));
  assert.notEqual(exactVenueNameKey("Will's  Basement"), exactVenueNameKey("Will's Basement"));
});

test('isPrivateTier', () => {
  assert.equal(isPrivateTier({ isResidence: true, privacyTier: 'full' }), true);
  assert.equal(isPrivateTier({ isResidence: false, privacyTier: 'hidden' }), true);
  assert.equal(isPrivateTier({ isResidence: false, privacyTier: 'full' }), false);
});
