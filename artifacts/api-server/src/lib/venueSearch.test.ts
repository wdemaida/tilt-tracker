// Run: npx tsx --test src/lib/venueSearch.test.ts   (from artifacts/api-server)
//
// Pure rules only. venueDedup.ts imports @workspace/db, which throws at import time without
// DATABASE_URL; postgres.js connects lazily, so a dummy URL is never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  searchTokens, matchScore, matchTiltTrackVenues, mergeSearchResults, venueForPlace, namesOverlap,
  searchableBy, queryLength, placeCacheKey,
} = await import('./venueSearch.js');

type Row = Parameters<typeof matchTiltTrackVenues>[1][number];

const base = { hereId: null, pinballMapId: null, timezone: 'America/New_York', ownerId: null, isResidence: false, privacyTier: 'full' as const };
// Shaped like the dev DB rows (2026-09-25).
const deepCuts: Row = { ...base, id: 19, name: "Pop's Pinball - Deep Cuts", address: '21 Main St, Medford, MA', latitude: 42.41798, longitude: -71.11011, hereId: 'here:pds:place:840drt3m-242c1003e7575b2f', pinballMapId: 25761 };
const bowMarket: Row = { ...base, id: 17, name: "Pop's Pinball - Bow Market", address: '1 Bow Market Way, Somerville, MA', latitude: 42.38091, longitude: -71.09645, hereId: 'here:pds:place:840drt3n-5a51afe0e4a525ef', pinballMapId: 19751 };
const alley: Row = { ...base, id: 9, name: 'The Alley Bar', address: '14 PI Alley, Boston, MA', latitude: 42.35791, longitude: -71.05854 };
const versus: Row = { ...base, id: 10, name: 'Versus', address: '42 Province St, Boston, MA', latitude: 42.356937, longitude: -71.059906 };
// Someone's hidden home venue, and one named to collide with a search for "pop".
const basement: Row = { ...base, id: 44, name: "Will's Basement", address: null, latitude: 41.76002, longitude: -70.0762, ownerId: 1, isResidence: true, privacyTier: 'hidden' };
const popsHouse: Row = { ...base, id: 50, name: "Pop's House", address: '9 Elm St, Medford, MA', latitude: 42.419, longitude: -71.11, ownerId: 1, isResidence: true, privacyTier: 'hidden' };
const rows = [deepCuts, bowMarket, alley, versus, basement, popsHouse];

const owner = { id: 1, role: 'user' };
const stranger = { id: 26, role: 'user' };
const admin = { id: 2, role: 'admin' };
const medford = { lat: 42.418, lng: -71.107 };

test('tokens fold apostrophes into the word and punctuation into breaks', () => {
  assert.deepEqual(searchTokens("Pop's Pinball - Deep Cuts"), ['pops', 'pinball', 'deep', 'cuts']);
  assert.deepEqual(searchTokens('Pop’s'), ['pops']);
  assert.deepEqual(searchTokens('Café  Olé!'), ['cafe', 'ole']);
  assert.equal(queryLength(" p' "), 1);
});

test('"pop", "pops", "Pop\'s", "deep cuts" and friends all find Deep Cuts', () => {
  for (const q of ['pop', 'pops', "Pop's", 'POP’S PINBALL', 'deep cuts', 'deep', 'cuts', 'pinball pop', 'popspin', 'pops medford', "Pop's Pinball Deep Cuts"]) {
    const ids = matchTiltTrackVenues(q, rows, stranger, null).map(h => h.id);
    assert.ok(ids.includes(19), `${q} → ${JSON.stringify(ids)}`);
  }
});

test('non-matches stay out', () => {
  assert.equal(matchScore('popcorn', "Pop's Pinball - Deep Cuts"), null);
  assert.equal(matchScore('medford', "Pop's Pinball - Deep Cuts", '21 Main St, Medford, MA'), null, 'address alone is not enough');
  assert.equal(matchScore('ops', "Pop's Pinball"), null, 'words match from their start, not the middle');
  assert.deepEqual(matchTiltTrackVenues('p', rows, stranger, null), [], 'one character searches nothing');
});

test('ranking: exact > name-start > any word; ties by distance when a location is known', () => {
  assert.equal(matchScore("pop's pinball deep cuts", deepCuts.name), 100);
  assert.equal(matchScore('pop', deepCuts.name), 90);
  assert.equal(matchScore('deep cuts', deepCuts.name), 80);
  assert.equal(matchScore('pops medford', deepCuts.name, deepCuts.address), 40);

  const near = matchTiltTrackVenues('pop', rows, stranger, medford).map(h => h.id);
  assert.deepEqual(near, [19, 17], 'Medford location puts Deep Cuts first');
  const hits = matchTiltTrackVenues('pop', rows, stranger, { lat: 42.381, lng: -71.0965 });
  assert.deepEqual(hits.map(h => h.id), [17, 19], 'Somerville location puts Bow Market first');
  assert.ok(hits[0].distance! < 50);
  assert.equal(matchTiltTrackVenues('pop', rows, stranger, null)[0].distance, null, 'no location, no distances');
});

test('others\' private venues never appear; owner and admin see their own', () => {
  assert.deepEqual(matchTiltTrackVenues('pop', rows, stranger, medford).map(h => h.id), [19, 17]);
  assert.deepEqual(matchTiltTrackVenues("will's basement", rows, stranger, null), [], 'not even by exact name — that is /venues/exact');
  assert.deepEqual(matchTiltTrackVenues('pop', rows, undefined, medford).map(h => h.id), [19, 17]);
  const mine = matchTiltTrackVenues('pop', rows, owner, medford);
  assert.ok(mine.some(h => h.id === 50 && h.isPrivate));
  assert.ok(matchTiltTrackVenues('basement', rows, admin, null).some(h => h.id === 44));
  assert.equal(searchableBy({ ...alley, privacyTier: 'city_state' }, stranger), false, 'restricted tier counts as private');
});

// HERE's own answers near Medford, verified 2026-09-25 (ids shortened).
const herePopsMedford = { hereId: 'here:pds:place:840drt3m-5d44072a', name: "Pop's Pinball", address: '21 Main St, Medford, MA 02145-1439, United States', lat: 42.41798, lng: -71.11011, timezone: 'America/New_York' };
const herePopsBow = { hereId: 'here:pds:place:840drt3n-aaaa', name: "Pop's Pinball", address: '1 Bow St, Somerville, MA 02143-2936, United States', lat: 42.3812, lng: -71.0968, timezone: 'America/New_York' };
const hereLocksmith = { hereId: 'here:pds:place:840dr-lock', name: 'Pop Locksmith Near Me', address: '41 Ash Ave, Somerville, MA', lat: 42.40, lng: -71.10, timezone: 'America/New_York' };
const hereDeepCutsById = { hereId: deepCuts.hereId!, name: 'Deep Cuts', address: '21 Main St, Medford, MA', lat: 42.41798, lng: -71.11011, timezone: 'America/New_York' };

test('a HERE place that already is a TiltTrack venue resolves to it — by id, or by name within 150m', () => {
  const visible = rows.filter(v => searchableBy(v, stranger));
  assert.equal(venueForPlace(hereDeepCutsById, visible)?.id, 19, 'same HERE id');
  assert.equal(venueForPlace(herePopsMedford, visible)?.id, 19, 'different HERE id, same spot, overlapping name');
  assert.equal(venueForPlace(herePopsBow, visible)?.id, 17);
  assert.equal(venueForPlace(hereLocksmith, visible), undefined);
  assert.equal(venueForPlace({ ...herePopsMedford, lat: 42.43, lng: -71.11 }, visible), undefined, '1.3km away is another place');
  assert.equal(venueForPlace({ ...herePopsMedford, name: 'Medford Dental' }, visible), undefined, 'same building, unrelated tenant');
  assert.ok(namesOverlap("Pop's Pinball", "Pops Pinball - Deep Cuts"));
});

test('merge: each real place appears once, as the TiltTrack venue when there is one', () => {
  const { tiltTrack, places } = mergeSearchResults({
    query: 'pop', rows, requester: stranger, from: medford,
    places: [herePopsMedford, hereLocksmith, herePopsBow, herePopsMedford],
  });
  assert.deepEqual(tiltTrack.map(h => h.id), [19, 17]);
  assert.deepEqual(places.map(p => p.hereId), [hereLocksmith.hereId], 'Pop\'s listings folded into the venues; repeats dropped');
  assert.ok(places[0].distance! > 1000);
});

test('merge: a place that resolves to a venue the text missed is added to the TiltTrack section', () => {
  const { tiltTrack, places } = mergeSearchResults({
    query: 'versus boston', rows, requester: stranger, from: null,
    places: [{ hereId: 'here:versus', name: 'Versus Arcade Bar', address: '42 Province St, Boston, MA', lat: 42.35695, lng: -71.0599, timezone: null }],
  });
  assert.deepEqual(places, []);
  assert.equal(tiltTrack.length, 1);
  assert.equal(tiltTrack[0].id, 10);
  assert.equal(tiltTrack[0].distance, null);
});

test('merge: a place near someone\'s private venue stays a plain place and reveals nothing', () => {
  const { tiltTrack, places } = mergeSearchResults({
    query: "pop's house", rows, requester: stranger, from: medford,
    places: [{ hereId: 'here:popshouse', name: "Pop's House of Pizza", address: '9 Elm St, Medford, MA', lat: 42.419, lng: -71.11, timezone: null }],
  });
  assert.deepEqual(tiltTrack, []);
  assert.equal(places.length, 1);
  // The owner, by contrast, gets their own venue instead of a lookalike place.
  const own = mergeSearchResults({ query: "pop's house", rows, requester: owner, from: medford, places: [{ hereId: 'here:popshouse', name: "Pop's House of Pizza", address: '9 Elm St', lat: 42.419, lng: -71.11, timezone: null }] });
  assert.deepEqual(own.tiltTrack.map(h => h.id), [50]);
  assert.deepEqual(own.places, []);
});

test('place cache key folds spelling noise but keeps the bias cell', () => {
  assert.equal(placeCacheKey("Pop's  Pinball", medford), placeCacheKey('pops pinball', medford));
  assert.notEqual(placeCacheKey('pops', medford), placeCacheKey('pops', { lat: 41.88, lng: -87.63 }));
});

test('far-away places are dropped unless the query names their town', async () => {
  const { placeIsRelevant } = await import('./venueSearch.js');
  const chicago = { lat: 41.88, lng: -87.63 };
  const popsMedford = { ...herePopsMedford, address: '21 Main St, Medford, MA 02145-1439, United States' };
  assert.equal(placeIsRelevant('pops', popsMedford, medford), true, 'near the bias');
  assert.equal(placeIsRelevant('pops', popsMedford, chicago), false, '1,360km from the bias');
  assert.equal(placeIsRelevant('pops medford', popsMedford, chicago), true, 'the town is in the query');
  assert.equal(placeIsRelevant('pops main', popsMedford, chicago), true, 'so is the street');
  assert.equal(placeIsRelevant('pinball', { ...popsMedford, name: 'Pinball Wizard', address: 'Pinball Rd, Medford' }, chicago), false,
    'a word already in the name does not count as naming the place');
  const { places } = mergeSearchResults({ query: 'pop', rows: [], requester: stranger, from: null, bias: chicago, places: [herePopsMedford] });
  assert.deepEqual(places, []);
});
