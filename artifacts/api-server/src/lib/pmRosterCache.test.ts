// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/pmRosterCache.test.ts   (from artifacts/api-server)
// The roster cache with its location metadata (migrate20), and the venue repair link flow's call
// count: place-search → pick (POST /repair/place) → link (POST /repair/pm-link) → Add Score. An
// in-memory store stands in for pm_location_cache and a counting fake for the live
// /locations/:id.json read. DATABASE_URL is a dummy — never dialled. PM_MODE=offline: the one test
// that goes through pmClient reads a recorded fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.PM_MODE = 'offline';
const { createRosterCache, FORCE_MIN_AGE_MS, METADATA_MAX_AGE_MS } = await import('./pmRosterCache.js');
const { PmApiError, pickPmLocation, getPmLocationWithMachines } = await import('./pinballmapApi.js');
const { rememberOfferedPmLocations, offeredPmLocation, pmIdAllowedFor } = await import('./pmGuards.js');
type PmLocation = import('./pinballmapApi.js').PmLocation;
type RosterRow = import('./pmRosterCache.js').RosterRow;

const HOUR = 60 * 60_000;

const LOC: PmLocation = {
  id: 10804, name: 'Pop\'s Pinball', lat: '42.4179' as any, lon: '-71.1101' as any,
  street: '21 Main St', city: 'Medford', state: 'MA', zip: '02155', country: 'US',
};
const XREFS = [{ id: 1, machine: { id: 7, name: 'Godzilla (Pro)' } }];

function harness(initial: Record<number, RosterRow> = {}) {
  let t = 1_800_000_000_000;
  const rows = new Map<number, RosterRow>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  const fetches: number[] = [];
  let fail: InstanceType<typeof PmApiError> | null = null;
  const cache = createRosterCache({
    now: () => t,
    store: {
      read: async id => rows.get(id) ?? null,
      write: async (id, machines, location, fetchedAt) => { rows.set(id, { machines, location, fetchedAt }); },
    },
    fetchLocation: async id => {
      fetches.push(id);
      await new Promise(r => setTimeout(r, 2));
      if (fail) throw fail;
      return { location: { ...LOC, id }, xrefs: XREFS };
    },
  });
  return {
    cache, rows, fetches,
    get t() { return t; },
    advance: (ms: number) => { t += ms; },
    failWith: (e: InstanceType<typeof PmApiError> | null) => { fail = e; },
  };
}

/** What POST /repair/place {source:'pm'} does to resolve the picked listing. */
async function pick(h: ReturnType<typeof harness>, user: string, id: number) {
  return offeredPmLocation(user, id) ?? await h.cache.getPmLocationCached(id);
}
/** What POST /repair/pm-link does. */
async function link(h: ReturnType<typeof harness>, id: number) {
  return h.cache.getVenueRoster(id, { force: true });
}

test('link flow, cold caches: place-search offered the record → pick 0 calls, link 1 roster call, Add Score 0', async () => {
  const h = harness();
  rememberOfferedPmLocations('user_a', [LOC]); // place-search returned it (locations.json, full record)
  assert.ok(pmIdAllowedFor('user_a', LOC.id), 'still allowlisted for /pm-machines');
  const picked = await pick(h, 'user_a', LOC.id);
  assert.equal(picked?.name, 'Pop\'s Pinball');
  assert.equal(h.fetches.length, 0, 'the pick reuses the offered record');

  const r = await link(h, LOC.id);
  assert.equal(h.fetches.length, 1, 'link = exactly one roster fetch');
  assert.equal(r.location?.name, 'Pop\'s Pinball', 'the roster carries the listing name — no metadata call');
  assert.equal(r.fromCache, false);

  h.advance(5 * HOUR);
  const addScore = await h.cache.getVenueRoster(LOC.id);
  assert.equal(addScore.fromCache, true);
  assert.equal(h.fetches.length, 1, 'Add Score within 6h makes no call');
});

test('link flow, no offered record (e.g. after a restart): pick fetches the roster once, link within 5 min reuses it', async () => {
  const h = harness();
  const picked = await pick(h, 'user_b', 555);
  assert.equal(picked?.id, 555);
  assert.equal(h.fetches.length, 1);
  h.advance(FORCE_MIN_AGE_MS - 1);
  await link(h, 555);
  assert.equal(h.fetches.length, 1, 'force only refetches a copy older than 5 minutes');
  h.advance(2);
  await link(h, 555);
  assert.equal(h.fetches.length, 2, 'past 5 minutes force refetches');
});

test('link flow, warm cache (roster fetched < 5 min ago): pick + link make 0 calls', async () => {
  const h = harness();
  await h.cache.getVenueRoster(LOC.id);
  assert.equal(h.fetches.length, 1);
  await pick(h, 'user_c', LOC.id);
  await link(h, LOC.id);
  assert.equal(h.fetches.length, 1);
});

test('getPmLocationCached: stored location served up to 7 days old; older refreshes the roster once', async () => {
  const h = harness({ 42: { machines: XREFS, location: { ...LOC, id: 42, name: 'Old Name' }, fetchedAt: new Date(1_800_000_000_000 - 3 * 24 * HOUR) } });
  assert.equal((await h.cache.getPmLocationCached(42))?.name, 'Old Name');
  assert.equal(h.fetches.length, 0);
  h.advance(METADATA_MAX_AGE_MS);
  const fresh = await h.cache.getPmLocationCached(42);
  assert.equal(h.fetches.length, 1);
  assert.equal(fresh?.name, 'Pop\'s Pinball');
  assert.equal((h.rows.get(42)!.location as PmLocation).name, 'Pop\'s Pinball', 'written back with the roster');
});

test('getPmLocationCached: a fresh pre-migrate20 row (no location) is refreshed once, then served', async () => {
  const h = harness({ 7: { machines: XREFS, location: null, fetchedAt: new Date(1_800_000_000_000 - 60_000) } });
  assert.equal((await h.cache.getVenueRoster(7)).location, null, 'roster readers are unaffected by the missing location');
  assert.equal(h.fetches.length, 0);
  assert.equal((await h.cache.getPmLocationCached(7))?.id, 7);
  assert.equal(h.fetches.length, 1);
  await h.cache.getPmLocationCached(7);
  assert.equal(h.fetches.length, 1);
});

test('unknown id: getPmLocationCached → null, pm-link → not_found; negatively cached (no second call)', async () => {
  const h = harness();
  h.failWith(new PmApiError('not_found', 'Pinball Map has no location with id 999', 404));
  assert.equal(await h.cache.getPmLocationCached(999), null);
  await assert.rejects(link(h, 999), (e: any) => e instanceof PmApiError && e.kind === 'not_found');
  assert.equal(h.fetches.length, 1, 'the 404 is remembered');
  assert.ok(h.cache.knownBadPmId(999));
});

test('allowLive refusal: no call, rate_limited when there is nothing cached', async () => {
  const h = harness();
  await assert.rejects(h.cache.getPmLocationCached(3, { allowLive: () => false }),
    (e: any) => e instanceof PmApiError && e.kind === 'rate_limited');
  assert.equal(h.fetches.length, 0);
});

test('concurrent pick + link + roster read share one in-flight fetch', async () => {
  const h = harness();
  const [a, b, c] = await Promise.all([h.cache.getPmLocationCached(11), link(h, 11), h.cache.getVenueRoster(11)]);
  assert.equal(h.fetches.length, 1);
  assert.equal(a?.id, 11);
  assert.equal(b.location?.id, 11);
  assert.equal(c.xrefs.length, 1);
});

test('PM outage: stale roster (with its stored location) beats an error', async () => {
  const h = harness({ 5: { machines: XREFS, location: { ...LOC, id: 5 }, fetchedAt: new Date(1_800_000_000_000 - 10 * 24 * HOUR) } });
  h.failWith(new PmApiError('network', 'down'));
  const loc = await h.cache.getPmLocationCached(5);
  assert.equal(loc?.id, 5);
  const r = await h.cache.getVenueRoster(5);
  assert.equal(r.stale, true);
  assert.equal(r.location?.id, 5);
});

test('offered records: only full records are kept; per user', () => {
  rememberOfferedPmLocations('user_d', [
    { id: 70, name: 'Autocomplete Hit', lat: 0, lon: 0 },
    { ...LOC, id: 71 },
  ]);
  assert.equal(offeredPmLocation('user_d', 70), undefined, 'no coordinates → not kept');
  assert.ok(pmIdAllowedFor('user_d', 70), 'but still allowlisted');
  assert.equal(offeredPmLocation('user_d', 71)?.id, 71);
  assert.equal(offeredPmLocation('someone_else', 71), undefined);
});

test('pickPmLocation / getPmLocationWithMachines read the real /locations/:id.json shape (offline fixture)', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../fixtures/pm/locations_20676.json__20a9c95d.json', import.meta.url), 'utf8'));
  const loc = pickPmLocation(fixture.body)!;
  assert.deepEqual(
    { id: loc.id, name: loc.name, street: loc.street, city: loc.city, state: loc.state, zip: loc.zip, country: loc.country },
    { id: 20676, name: 'Red Nun Bar & Grill', street: '673 Main St', city: 'Dennis', state: 'MA', zip: '02639', country: 'US' },
  );
  assert.equal(Number(loc.lat), 41.6677752);
  assert.equal((loc as any).location_machine_xrefs, undefined, 'the roster is not duplicated into the location');
  assert.equal(pickPmLocation({ errors: 'Failed to find location' }), null);

  const { location, xrefs } = await getPmLocationWithMachines(20676); // PM_MODE=offline → the fixture
  assert.equal(location.name, 'Red Nun Bar & Grill');
  assert.ok(xrefs.length >= 1);
  assert.equal(xrefs[0].machine.name, 'The Munsters (Pro)');
});
