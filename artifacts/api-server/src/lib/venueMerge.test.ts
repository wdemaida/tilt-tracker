// Run: npx tsx --test src/lib/venueMerge.test.ts   (from artifacts/api-server)
//
// Pure rules only. The database half is exercised by test-venue-merge.ts against the dev branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { mergeBlocker, adoptedFromSource, adoptionLabels } = await import('./venueMerge.js');

const admin = { id: 1, role: 'admin' };
const alice = { id: 10, role: 'user' };
const bob = { id: 11, role: 'user' };

const pub = (id: number) => ({ id, ownerId: null, isResidence: false, privacyTier: 'full' as const });
const home = (id: number, ownerId: number, privacyTier: 'full' | 'city_state' | 'hidden' = 'hidden') =>
  ({ id, ownerId, isResidence: true, privacyTier });

test('public into public: allowed when every score is the caller’s, or for an admin', () => {
  assert.equal(mergeBlocker(pub(1), pub(2), alice, 0), null);
  assert.equal(mergeBlocker(pub(1), pub(2), alice, 3), 'others_scores');
  assert.equal(mergeBlocker(pub(1), pub(2), admin, 3), null);
});

test('a venue never merges into itself', () => {
  assert.equal(mergeBlocker(pub(1), pub(1), admin, 0), 'same_venue');
});

test('public into private is refused, even for the owner or an admin', () => {
  assert.equal(mergeBlocker(pub(1), home(2, alice.id), alice, 0), 'public_into_private');
  assert.equal(mergeBlocker(pub(1), home(2, alice.id), admin, 0), 'public_into_private');
});

test('someone else’s private venue is not a visible target', () => {
  assert.equal(mergeBlocker(pub(1), home(2, bob.id), alice, 0), 'target_not_visible');
  // A restricted tier without the residence flag is private too.
  assert.equal(mergeBlocker(pub(1), { ...pub(2), ownerId: bob.id, privacyTier: 'city_state' }, alice, 0), 'target_not_visible');
});

test('private into public is refused for everyone', () => {
  assert.equal(mergeBlocker(home(1, alice.id), pub(2), alice, 0), 'private_into_public');
  assert.equal(mergeBlocker(home(1, alice.id), pub(2), admin, 0), 'private_into_public');
  // A full-tier residence is still a residence.
  assert.equal(mergeBlocker(home(1, alice.id, 'full'), pub(2), alice, 0), 'private_into_public');
});

test('private into private: same owner only, and only that owner or an admin', () => {
  assert.equal(mergeBlocker(home(1, alice.id), home(2, alice.id), alice, 0), null);
  assert.equal(mergeBlocker(home(1, alice.id), home(2, alice.id), admin, 0), null);
  assert.equal(mergeBlocker(home(1, bob.id), home(2, alice.id), admin, 0), 'private_owner_mismatch');
  assert.equal(mergeBlocker(home(1, bob.id), home(2, alice.id), alice, 0), 'private_owner_mismatch');
  // Friends' scores at the owner's own two homes still need an admin.
  assert.equal(mergeBlocker(home(1, alice.id), home(2, alice.id), alice, 2), 'others_scores');
});

const venueRow = (over: Record<string, unknown> = {}) => ({
  hereId: null, pinballMapId: null, pmMachineCount: null, address: null, latitude: null, longitude: null,
  city: null, state: null, cityLat: null, cityLng: null, timezone: null,
  isResidence: false, privacyTier: 'full' as const, ...over,
});

test('the target fills only its gaps from the source', () => {
  const source = venueRow({ hereId: 'here:1', pinballMapId: 5, pmMachineCount: 9, address: '1 Main St', latitude: 1, longitude: 2, timezone: 'America/New_York' });
  const adopt = adoptedFromSource(source, venueRow());
  assert.equal(adopt.hereId, 'here:1');
  assert.equal(adopt.pinballMapId, 5);
  assert.equal(adopt.pmMachineCount, 9);
  assert.equal(adopt.address, '1 Main St');
  assert.deepEqual(adoptionLabels(adopt), ['HERE link', 'Pinball Map link', 'address']);

  const full = venueRow({ hereId: 'here:2', pinballMapId: 6, address: '2 Main St', latitude: 3, longitude: 4, timezone: 'America/Chicago' });
  assert.deepEqual(adoptedFromSource(source, full), {});
});

test('an address-less source adopts nothing locational', () => {
  assert.deepEqual(adoptedFromSource(venueRow(), venueRow({ address: '2 Main St', latitude: 3, longitude: 4 })), {});
});

test('nothing is adopted onto (or from) a private venue', () => {
  const source = venueRow({ hereId: 'here:1', pinballMapId: 5 });
  assert.deepEqual(adoptedFromSource(source, venueRow({ isResidence: true })), {});
  assert.deepEqual(adoptedFromSource(venueRow({ hereId: 'x', privacyTier: 'hidden' }), venueRow()), {});
});
