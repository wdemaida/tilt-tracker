// Run: npx tsx --test src/lib/pmMatch.test.ts   (from artifacts/api-server)
//
// Pure rules only. pmMatch.ts imports venueAddress.ts, which pulls in @workspace/db — that throws at
// import time without DATABASE_URL; postgres.js connects lazily, so a dummy URL is never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { matchPmLocation, pmNamesOverlap, pmIdToPersist, parsePmId, PM_SAME_SPOT_M } = await import('./pmMatch.js');

// Pinball Map's closest_by_lat_lon answer around HERE's Wedgehead (3728 NE Sandy Blvd, Portland),
// 2026-09-25 — lat/lon arrive as decimal strings, exactly as here.
const wedgeheadPlace = { name: 'Wedgehead', lat: 45.53404, lng: -122.62435 };
const nearWedgehead = [
  { id: 10804, name: 'Wedgehead', lat: '45.5340457', lon: '-122.6243871' },
  { id: 30506, name: 'The Callback', lat: '45.5346334', lon: '-122.6217363' },
  { id: 30068, name: "Gambit's Games & Anime", lat: '45.5303852', lon: '-122.6346991' },
  { id: 871, name: 'Beulahland', lat: '45.5239233', lon: '-122.6370112' },
] as any[];

test('Wedgehead (HERE place) resolves to its Pinball Map listing', () => {
  assert.equal(matchPmLocation(wedgeheadPlace, nearWedgehead)?.id, 10804);
});

test('a different business nearby gets neither Wedgehead nor The Callback', () => {
  // ~165m from Wedgehead, ~115m from The Callback: no name overlap, and not on the same spot.
  assert.equal(matchPmLocation({ name: 'Starbucks', lat: 45.5352, lng: -122.6230 }, nearWedgehead), null);
});

test('the coffee shop next door (80m, different name) no longer inherits the bar\'s listing', () => {
  // The old rule took the nearest PM location within 150m whatever its name.
  const nextDoor = { name: 'Case Study Coffee', lat: 45.53404, lng: -122.62537 };
  assert.equal(matchPmLocation(nextDoor, nearWedgehead), null);
});

test('same building, different name: matched (HERE "Deep Cuts" vs PM "Pop\'s Pinball")', () => {
  const pm = [{ id: 25761, name: "Pop's Pinball", lat: '42.41800', lon: '-71.11012' }] as any[];
  assert.equal(matchPmLocation({ name: 'Deep Cuts', lat: 42.41798, lng: -71.11011 }, pm)?.id, 25761);
});

test('a name match beats a closer unrelated location inside the radius', () => {
  const pm = [
    { id: 1, name: 'Law Office of Smith', lat: '41.88400', lon: '-87.63500' }, // ~10m
    { id: 2, name: 'Headquarters Beercade', lat: '41.88460', lon: '-87.63500' }, // ~75m
  ] as any[];
  assert.equal(matchPmLocation({ name: 'Headquarters', lat: 41.88391, lng: -87.63500 }, pm)?.id, 2);
});

test('an unnamed match needs to be within the same-spot radius', () => {
  const at = { name: 'Some Bar', lat: 40, lng: -75 };
  const metresNorth = (m: number) => String(40 + m / 111_195);
  assert.equal(matchPmLocation(at, [{ id: 7, name: 'Other', lat: metresNorth(PM_SAME_SPOT_M - 5), lon: '-75' }] as any[])?.id, 7);
  assert.equal(matchPmLocation(at, [{ id: 7, name: 'Other', lat: metresNorth(PM_SAME_SPOT_M + 10), lon: '-75' }] as any[]), null);
});

test('no coordinates: name overlap only (history venues arrive without them)', () => {
  assert.equal(matchPmLocation({ name: 'Wedgehead' }, nearWedgehead)?.id, 10804);
  assert.equal(matchPmLocation({ name: 'Unrelated Tavern', lat: null, lng: null }, nearWedgehead), null);
});

test('no Pinball Map locations → null, and junk entries are ignored', () => {
  assert.equal(matchPmLocation(wedgeheadPlace, []), null);
  assert.equal(matchPmLocation(wedgeheadPlace, [{ id: 0, name: 'Wedgehead', lat: '45.53404', lon: '-122.62435' }] as any[]), null);
});

test('pmNamesOverlap: containment, distinctive shared words, not generic ones', () => {
  assert.equal(pmNamesOverlap("Pop's Pinball", "Pop's Pinball - Deep Cuts"), true);
  assert.equal(pmNamesOverlap('The Wedgehead', 'wedge-head'), true);
  assert.equal(pmNamesOverlap('Ground Kontrol Classic Arcade', 'Ground Kontrol'), true);
  assert.equal(pmNamesOverlap('Pokémon Bar', 'Pokemon Lounge'), true);
  assert.equal(pmNamesOverlap('Logan Arcade', 'Headquarters Arcade'), false);
  assert.equal(pmNamesOverlap('The Pinball Bar', 'Pinball Pub'), false);
  assert.equal(pmNamesOverlap('', 'Wedgehead'), false);
});

const publicVenue = { pinballMapId: null, isResidence: false, privacyTier: 'full' as const };

test('pmIdToPersist: a new venue takes the resolved id', () => {
  assert.equal(pmIdToPersist(10804, null), 10804);
  assert.equal(pmIdToPersist('10804', null), 10804);
});

test('pmIdToPersist: fills an unlinked public venue, never replaces an existing link', () => {
  assert.equal(pmIdToPersist(10804, publicVenue), 10804);
  assert.equal(pmIdToPersist(10804, { ...publicVenue, pinballMapId: 999 }), null);
});

test('pmIdToPersist: private venues are never linked', () => {
  assert.equal(pmIdToPersist(10804, { ...publicVenue, isResidence: true }), null);
  assert.equal(pmIdToPersist(10804, { ...publicVenue, privacyTier: 'city_state' }), null);
  assert.equal(pmIdToPersist(10804, { ...publicVenue, privacyTier: 'hidden' }), null);
});

test('parsePmId rejects anything but a positive integer', () => {
  for (const bad of [undefined, null, '', 0, -3, 1.5, 'abc', '12abc', NaN, {}, [], true]) {
    assert.equal(parsePmId(bad), null, String(bad));
  }
  assert.equal(parsePmId(' 42 '), 42);
});
