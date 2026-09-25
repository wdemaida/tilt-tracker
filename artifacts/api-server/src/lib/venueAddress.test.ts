// Run: npx tsx --test src/lib/venueAddress.test.ts   (from artifacts/api-server)
//
// Pure rules only — no database or network. venueRepair.ts imports @workspace/db, which throws at
// import time without DATABASE_URL; postgres.js connects lazily, so a dummy URL is never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  addressResolutionBlocker, venueNeedsAddress, pmLocationToPlace, formatPmAddress,
  buildManualAddressQuery, isPreciseGeocode, pickConfidentHereMatch, stripPlaceNamePrefix,
} = await import('./venueAddress.js');
const { canRepairVenue } = await import('./venueRepair.js');
const { pmAutocompleteId } = await import('./pinballmapApi.js');

const admin = { id: 1, role: 'admin' };
const creator = { id: 27, role: 'user' };
const stranger = { id: 26, role: 'user' };

// Shaped like prod venue 47 ("Special when lit") as of 2026-09-24.
const specialWhenLit = {
  id: 47, ownerId: null, createdById: 27,
  address: null, isResidence: false, privacyTier: 'full' as const,
};
// Shaped like prod venue 44 — a hidden-tier residence with coordinates but no address.
const basement = {
  id: 44, ownerId: 1, createdById: 1,
  address: null, isResidence: true, privacyTier: 'hidden' as const,
};

test('canRepairVenue: admin, owner and creator may; anyone else may not', () => {
  assert.equal(canRepairVenue(specialWhenLit, admin), true);
  assert.equal(canRepairVenue(specialWhenLit, creator), true);
  assert.equal(canRepairVenue(specialWhenLit, stranger), false);
  assert.equal(canRepairVenue({ id: 1, ownerId: 26, createdById: null }, stranger), true);
  // null ids never match a user — an unowned, creator-less venue is admin-only.
  assert.equal(canRepairVenue({ id: 1, ownerId: null, createdById: null }, stranger), false);
});

test('addressResolutionBlocker: admin and creator can resolve an address-less venue', () => {
  assert.equal(addressResolutionBlocker(specialWhenLit, admin), null);
  assert.equal(addressResolutionBlocker(specialWhenLit, creator), null);
});

test('addressResolutionBlocker: other users are forbidden', () => {
  assert.equal(addressResolutionBlocker(specialWhenLit, stranger), 'forbidden');
});

test('addressResolutionBlocker: residences never qualify, even for their owner or an admin', () => {
  assert.equal(addressResolutionBlocker(basement, admin), 'residence');
  assert.equal(addressResolutionBlocker(basement, { id: 1, role: 'user' }), 'residence');
  // A row whose flags disagree (tier set, residence flag not) is still treated as private.
  assert.equal(addressResolutionBlocker({ ...specialWhenLit, privacyTier: 'city_state' }, admin), 'residence');
});

test('addressResolutionBlocker: a venue with an address uses the HERE step instead', () => {
  assert.equal(addressResolutionBlocker({ ...specialWhenLit, address: '1 Main St' }, admin), 'has_address');
  // whitespace is not an address
  assert.equal(addressResolutionBlocker({ ...specialWhenLit, address: '   ' }, admin), null);
});

test('forbidden is reported before residence, so a stranger learns nothing about the venue', () => {
  assert.equal(addressResolutionBlocker(basement, stranger), 'forbidden');
});

test('venueNeedsAddress', () => {
  assert.equal(venueNeedsAddress(specialWhenLit), true);
  assert.equal(venueNeedsAddress(basement), false);
  assert.equal(venueNeedsAddress({ ...specialWhenLit, address: '1 Main St' }), false);
});

test('pmLocationToPlace: US listing, string coordinates as Pinball Map sends them', () => {
  const place = pmLocationToPlace({
    id: 23289, name: 'Special When Lit', street: '15685 SW 116th Ave', city: 'King City',
    state: 'OR', zip: '97224', country: 'US', lat: '45.4063431' as any, lon: '-122.7973717' as any,
  });
  assert.deepEqual(place, {
    address: '15685 SW 116th Ave, King City, OR 97224',
    city: 'King City', state: 'OR', latitude: 45.4063431, longitude: -122.7973717,
  });
});

test('pmLocationToPlace: international listing with no state appends the country', () => {
  const place = pmLocationToPlace({
    id: 16646, name: 'Special When Lit', street: 'Unit 5, Loyal Trade Business Park', city: 'Salisbury',
    state: null, zip: 'SP2 7NS', country: 'GB', lat: '51.0688648' as any, lon: '-1.8117338' as any,
  });
  assert.equal(place?.address, 'Unit 5, Loyal Trade Business Park, Salisbury, SP2 7NS, GB');
  assert.equal(place?.state, null);
  assert.equal(place?.latitude, 51.0688648);
});

test('pmLocationToPlace: rejects missing, zero and out-of-range coordinates', () => {
  const base = { id: 1, name: 'X', street: '1 Main', city: 'Town' };
  assert.equal(pmLocationToPlace({ ...base, lat: 0, lon: 0 }), null); // autocomplete placeholder
  assert.equal(pmLocationToPlace({ ...base, lat: 'abc' as any, lon: '1' as any }), null);
  assert.equal(pmLocationToPlace({ ...base, lat: 91, lon: 0 }), null);
  assert.equal(pmLocationToPlace({ ...base, lat: undefined as any, lon: undefined as any }), null);
});

test('formatPmAddress trims blanks and skips empty parts', () => {
  assert.equal(formatPmAddress({ street: ' 1 Main St ', city: '', state: 'MA', zip: null, country: 'us' }), '1 Main St, MA');
  assert.equal(formatPmAddress({ street: null, city: 'Boston', state: null, zip: null, country: null }), 'Boston');
});

test('buildManualAddressQuery: requires street and city, joins region + postal', () => {
  assert.deepEqual(
    buildManualAddressQuery({ street: '15685 SW 116th Ave', city: 'King City', state: 'OR', postalCode: '97224', country: 'USA' }),
    { ok: true, query: '15685 SW 116th Ave, King City, OR 97224, USA' },
  );
  assert.deepEqual(buildManualAddressQuery({ street: '1 Main St', city: 'Boston' }), { ok: true, query: '1 Main St, Boston' });
  assert.equal(buildManualAddressQuery({ city: 'Boston' }).ok, false);
  assert.equal(buildManualAddressQuery({ street: '1 Main St', city: '  ' }).ok, false);
  // non-strings (a JSON body can carry anything) are ignored, not stringified
  assert.equal(buildManualAddressQuery({ street: 42, city: 'Boston' }).ok, false);
  assert.equal(buildManualAddressQuery({ street: 'x'.repeat(201), city: 'Boston' }).ok, false);
});

test('isPreciseGeocode: a city centroid is not a venue position', () => {
  assert.equal(isPreciseGeocode('houseNumber'), true);
  assert.equal(isPreciseGeocode('place'), true);
  assert.equal(isPreciseGeocode('locality'), false);
  assert.equal(isPreciseGeocode(null), false);
});

test('pickConfidentHereMatch mirrors the /repair/here auto-attach rule', () => {
  const c = (name: string, distance: number, hereId: string | null = 'h1') => ({ name, distance, hereId });
  // lone, name-overlapping, under 500m
  assert.ok(pickConfidentHereMatch('Special when lit', [c('Special When Lit Pinball', 46)]));
  // lone but 500m+ — the next-town guard
  assert.equal(pickConfidentHereMatch('Special when lit', [c('Special When Lit', 500)]), null);
  // contested: closest must be under 100m
  assert.ok(pickConfidentHereMatch('Versus', [c('Versus', 80), c('Versus Too', 90)]));
  assert.equal(pickConfidentHereMatch('Versus', [c('Versus', 150), c('Versus Too', 160)]), null);
  // names must overlap
  assert.equal(pickConfidentHereMatch('Versus', [c('The Alley Bar', 10)]), null);
  // no hereId, nothing to attach
  assert.equal(pickConfidentHereMatch('Versus', [c('Versus', 10, null)]), null);
  assert.equal(pickConfidentHereMatch('Versus', []), null);
});

test('stripPlaceNamePrefix', () => {
  assert.equal(
    stripPlaceNamePrefix('Special When Lit Pinball, 15685 SW 116th Ave, Portland, OR 97224-2651, United States', 'Special When Lit Pinball'),
    '15685 SW 116th Ave, Portland, OR 97224-2651, United States',
  );
  assert.equal(stripPlaceNamePrefix('1 Main St, Boston', 'Other'), '1 Main St, Boston');
  assert.equal(stripPlaceNamePrefix('1 Main St', ''), '1 Main St');
});

test('pmAutocompleteId: numeric id wins; a name in `value` is not an id', () => {
  // The live shape as of 2026-09-24.
  assert.equal(pmAutocompleteId({ value: 'Special When Lit', id: 23289 }), 23289);
  // The older documented shape.
  assert.equal(pmAutocompleteId({ value: 23289 }), 23289);
  assert.equal(pmAutocompleteId({ value: '23289' }), 23289);
  assert.equal(pmAutocompleteId({ value: 'Special When Lit' }), 0);
  assert.equal(pmAutocompleteId({}), 0);
});
