// Run: npx tsx --test src/lib/venueMapPoint.test.ts   (from artifacts/api-server)
// The map's privacy contract: every viewer — owner and admin included — gets the PUBLIC map point.
// Hidden-tier venues are never pinned and never carry a coordinate; city_state venues only ever
// expose the city centroid, flagged approximate. Plus the venue-less score GPS rule on GET /api/scores.
// venueView.ts pulls in @workspace/db (via venueActivity), which throws without DATABASE_URL;
// postgres.js connects lazily, so this dummy URL is never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { venueListRow, venueDetailView, venueMapPoint } = await import('./venueView.js');
const { redactScoreLocation } = await import('./venuePrivacy.js');

type Tier = 'full' | 'city_state' | 'hidden';

const OWNER_ID = 1;
const owner = { id: OWNER_ID, role: 'user' };
const admin = { id: 99, role: 'admin' };
const stranger = { id: 26, role: 'user' };
const VIEWERS = { owner, admin, stranger, signedOut: undefined } as const;

// The exact position — must never reach anyone through a map point of a restricted venue.
const EXACT = { lat: 45.523456, lng: -122.676543 };
const CENTROID = { lat: 45.5118, lng: -122.6756 };

const KINDS: Record<string, { isResidence: boolean; privacyTier: Tier }> = {
  publicVenue: { isResidence: false, privacyTier: 'full' },
  residenceFull: { isResidence: true, privacyTier: 'full' },
  residenceCityState: { isResidence: true, privacyTier: 'city_state' },
  residenceHidden: { isResidence: true, privacyTier: 'hidden' },
};

function venue(kind: keyof typeof KINDS, over: Record<string, unknown> = {}) {
  return {
    id: 56, name: "Collasta's Basement", ownerId: OWNER_ID, createdById: OWNER_ID,
    ...KINDS[kind],
    showMachinesAndScores: true,
    address: '12 Hidden Way, Portland, OR 97201', latitude: EXACT.lat, longitude: EXACT.lng,
    city: 'Portland', state: 'Oregon', cityLat: CENTROID.lat, cityLng: CENTROID.lng, timezone: 'America/Los_Angeles',
    pinballMapId: null as number | null, pmMachineCount: null as number | null,
    playedMachineCount: 1, inventoryCount: 0, inventoryManaged: false,
    ...over,
  };
}
const listRow = (kind: keyof typeof KINDS, over: Record<string, unknown> = {}) =>
  ({ ...venue(kind, over), scoreCount: 2, lastPlayedAt: new Date('2026-10-01T20:00:00Z') });

/** What each tier's map point must be — the same for every viewer. */
const EXPECTED: Record<string, unknown> = {
  publicVenue: { lat: EXACT.lat, lng: EXACT.lng, approximate: false, label: null },
  // A full-tier residence: the owner chose to publish the address, so the pin is exact.
  residenceFull: { lat: EXACT.lat, lng: EXACT.lng, approximate: false, label: null },
  residenceCityState: { lat: CENTROID.lat, lng: CENTROID.lng, approximate: true, label: 'Portland, Oregon' },
  residenceHidden: null,
};

// Does `value` contain the exact coordinate anywhere (any key, any depth)?
function containsExact(value: unknown): boolean {
  if (value === EXACT.lat || value === EXACT.lng) return true;
  if (value && typeof value === 'object') return Object.values(value).some(containsExact);
  return false;
}

for (const [shape, build] of [
  ['venueListRow', (kind: string, viewer: any) => venueListRow(listRow(kind), viewer)],
  ['venueDetailView', (kind: string, viewer: any) => venueDetailView(venue(kind), viewer)],
] as const) {
  for (const kind of Object.keys(KINDS)) {
    for (const [name, viewer] of Object.entries(VIEWERS)) {
      test(`${shape}: ${kind} × ${name} — mapPoint is the public one`, () => {
        const row = build(kind, viewer) as Record<string, unknown>;
        assert.deepEqual(row.mapPoint, EXPECTED[kind]);
      });
    }
  }
}

test('hidden tier: no viewer ever gets a map point', () => {
  for (const viewer of Object.values(VIEWERS)) {
    assert.equal(venueListRow(listRow('residenceHidden'), viewer).mapPoint, null);
    assert.equal(venueDetailView(venue('residenceHidden'), viewer).mapPoint, null);
  }
  // Even an oddly-stored row (hidden, but with a centroid and coordinates on file).
  assert.equal(venueMapPoint({ ...venue('residenceHidden'), privacyTier: 'hidden' }), null);
  // And a non-residence stored as hidden (pre-storedPrivacyTier data) is still never pinned.
  assert.equal(venueMapPoint({ ...venue('publicVenue'), privacyTier: 'hidden' }), null);
});

test('restricted tiers: strangers and signed-out viewers never receive the exact coordinate anywhere', () => {
  for (const kind of ['residenceCityState', 'residenceHidden']) {
    for (const viewer of [stranger, undefined]) {
      assert.equal(containsExact(venueListRow(listRow(kind), viewer)), false, `${kind} list`);
      assert.equal(containsExact(venueDetailView(venue(kind), viewer)), false, `${kind} detail`);
    }
  }
});

test('owner and admin: the map point is the centroid even though their own row is exact', () => {
  for (const viewer of [owner, admin]) {
    const row = venueDetailView(venue('residenceCityState'), viewer) as Record<string, any>;
    assert.equal(row.latitude, EXACT.lat, 'they still see the real row');
    assert.deepEqual(row.mapPoint, EXPECTED.residenceCityState);
    assert.equal(containsExact(row.mapPoint), false);
  }
});

test('city_state with no centroid on file → no map point (never the exact coordinate as a fallback)', () => {
  for (const viewer of Object.values(VIEWERS)) {
    const v = venue('residenceCityState', { cityLat: null, cityLng: null });
    assert.equal(venueDetailView(v, viewer).mapPoint, null);
    assert.equal(venueListRow({ ...v, scoreCount: 1, lastPlayedAt: null }, viewer).mapPoint, null);
  }
});

test('public venue with no coordinates → no map point', () => {
  assert.equal(venueMapPoint(venue('publicVenue', { latitude: null, longitude: null })), null);
});

test('venueMapPoint does not mutate its input', () => {
  const v = venue('residenceCityState');
  const before = JSON.stringify(v);
  venueMapPoint(v);
  assert.equal(JSON.stringify(v), before);
});

// ---- GET /api/scores: a score's own photo GPS -------------------------------------------------

const AUTHOR_ID = 7;
const gpsScore = () => ({ id: 1, latitude: EXACT.lat, longitude: EXACT.lng, venueTimezone: null as string | null });

test('venue-less score: only its author and admins get the GPS', () => {
  const cases: Array<[string, number | undefined, boolean, boolean]> = [
    ['author', AUTHOR_ID, false, true],
    ['admin', admin.id, true, true],
    ['stranger', stranger.id, false, false],
    ['signed out', undefined, false, false],
  ];
  for (const [name, requesterId, isAdmin, sees] of cases) {
    const out = redactScoreLocation(gpsScore(), undefined, requesterId, isAdmin, AUTHOR_ID);
    if (sees) {
      assert.equal(out.latitude, EXACT.lat, name);
      assert.equal(out.longitude, EXACT.lng, name);
    } else {
      assert.equal(out.latitude, null, name);
      assert.equal(out.longitude, null, name);
    }
  }
});

test('score at a venue: tier rules unchanged; the author of a score at someone else\'s private venue gets no exact GPS', () => {
  const v = (tier: Tier) => ({ ownerId: OWNER_ID, privacyTier: tier, city: 'Portland', state: 'Oregon', cityLat: CENTROID.lat, cityLng: CENTROID.lng });
  // Public venue: the venue's location is public anyway.
  assert.equal(redactScoreLocation(gpsScore(), v('full'), stranger.id, false, AUTHOR_ID).latitude, EXACT.lat);
  // city_state: the centroid for anyone but the owner/admin — including the score's own author.
  for (const requesterId of [stranger.id, AUTHOR_ID, undefined]) {
    const out = redactScoreLocation(gpsScore(), v('city_state'), requesterId, false, AUTHOR_ID);
    assert.deepEqual([out.latitude, out.longitude], [CENTROID.lat, CENTROID.lng]);
  }
  // hidden: nothing.
  for (const requesterId of [stranger.id, AUTHOR_ID, undefined]) {
    const out = redactScoreLocation(gpsScore(), v('hidden'), requesterId, false, AUTHOR_ID);
    assert.deepEqual([out.latitude, out.longitude], [null, null]);
  }
  // Owner and admin keep the raw fix.
  assert.equal(redactScoreLocation(gpsScore(), v('hidden'), OWNER_ID, false, AUTHOR_ID).latitude, EXACT.lat);
  assert.equal(redactScoreLocation(gpsScore(), v('hidden'), admin.id, true, AUTHOR_ID).latitude, EXACT.lat);
});

test('redactScoreLocation does not mutate its input', () => {
  const s = gpsScore();
  redactScoreLocation(s, undefined, stranger.id, false, AUTHOR_ID);
  assert.equal(s.latitude, EXACT.lat);
});
