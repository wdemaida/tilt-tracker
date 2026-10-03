// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/pmAreaCache.test.ts
// (from artifacts/api-server — the in-memory store below never touches the database)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAreaCache, AREA_TTL_MS, AREA_NEGATIVE_TTL_MS, type AreaRow, type AreaStore } from './pmAreaCache.js';
import { PmApiError } from './pinballmapApi.js';
import { AREA_FETCH_RADIUS_MILES, areaCell } from './areaMatch.js';

const CELL = areaCell(45.5, -122.7);
const RAW = [{ id: 10804, name: 'Wedgehead', city: 'Portland', state: 'OR', lat: '45.523', lon: '-122.65', machine_ids: [4625, 3099] }];

function memoryStore() {
  const rows = new Map<string, AreaRow>();
  const store: AreaStore = {
    async read(k) { return rows.get(k) ?? null; },
    async saveData(k, fetchRadiusMiles, locations, fetchedAt) { rows.set(k, { fetchRadiusMiles, locations, fetchedAt, lastError: null, lastErrorAt: null }); },
    async saveError(k, fetchRadiusMiles, message, at) {
      const prev = rows.get(k);
      rows.set(k, { fetchRadiusMiles: prev?.fetchRadiusMiles ?? fetchRadiusMiles, locations: prev?.locations ?? null, fetchedAt: prev?.fetchedAt ?? null, lastError: message, lastErrorAt: at });
    },
  };
  return { rows, store };
}

function setup(fail: () => Error | null = () => null) {
  let t = Date.UTC(2026, 9, 2);
  const calls: Array<[number, number, number]> = [];
  const { rows, store } = memoryStore();
  const cache = createAreaCache({
    store,
    now: () => t,
    fetchNear: async (lat, lng, miles) => {
      calls.push([lat, lng, miles]);
      await new Promise(r => setTimeout(r, 5));
      const err = fail();
      if (err) throw err;
      return RAW;
    },
  });
  return { cache, calls, rows, advance: (ms: number) => { t += ms; } };
}

test('a miss makes ONE request from the cell’s grid point at the fetch radius; then 0 within the TTL', async () => {
  const { cache, calls, rows } = setup();
  const a = await cache.getArea(CELL);
  assert.deepEqual(calls, [[45.5, -122.7, AREA_FETCH_RADIUS_MILES]]);
  assert.equal(a.fromCache, false);
  assert.deepEqual(a.locations[0].machineIds, [4625, 3099]);
  assert.equal(rows.get(CELL.key)?.fetchRadiusMiles, 55);
  const b = await cache.getArea(CELL);
  assert.equal(calls.length, 1, 'TTL hit: zero requests');
  assert.equal(b.fromCache, true);
  assert.equal(b.stale, false);
});

test('in-flight de-duplication: a burst for one cell makes one request', async () => {
  const { cache, calls } = setup();
  await Promise.all([cache.getArea(CELL), cache.getArea(CELL), cache.getArea(CELL)]);
  assert.equal(calls.length, 1);
});

test('TTL is 7 days', async () => {
  const { cache, calls, advance } = setup();
  await cache.getArea(CELL);
  advance(AREA_TTL_MS - 1000);
  await cache.getArea(CELL);
  assert.equal(calls.length, 1);
  advance(2000);
  await cache.getArea(CELL);
  assert.equal(calls.length, 2);
  assert.equal(AREA_TTL_MS, 7 * 24 * 60 * 60_000);
});

test('allowLive is consulted only when a request would go out; refusal → stale copy, or rate_limited', async () => {
  const { cache, calls, advance } = setup();
  let asked = 0;
  const no = () => { asked++; return false; };
  await assert.rejects(cache.getArea(CELL, { allowLive: no }), (e: any) => e instanceof PmApiError && e.kind === 'rate_limited');
  assert.equal(calls.length, 0);
  await cache.getArea(CELL, { allowLive: () => true });
  asked = 0;
  await cache.getArea(CELL, { allowLive: no });
  assert.equal(asked, 0, 'a cache hit never charges the limit');
  advance(AREA_TTL_MS + 1);
  const stale = await cache.getArea(CELL, { allowLive: no });
  assert.equal(asked, 1);
  assert.equal(stale.stale, true);
  assert.equal(calls.length, 1);
});

test('a failure with a stale copy serves it, and is negatively cached for an hour (no retry per request)', async () => {
  let failing = false;
  const { cache, calls, rows, advance } = setup(() => (failing ? new PmApiError('network', 'boom') : null));
  await cache.getArea(CELL);
  advance(AREA_TTL_MS + 1);
  failing = true;
  const a = await cache.getArea(CELL);
  assert.equal(a.stale, true);
  assert.equal(calls.length, 2);
  assert.ok(rows.get(CELL.key)?.lastErrorAt, 'failure remembered in the row');
  const b = await cache.getArea(CELL);
  assert.equal(b.stale, true);
  assert.equal(calls.length, 2, 'within the hour: no new request');
  advance(AREA_NEGATIVE_TTL_MS + 1);
  failing = false;
  const c = await cache.getArea(CELL);
  assert.equal(calls.length, 3);
  assert.equal(c.stale, false);
  assert.equal(rows.get(CELL.key)?.lastError, null, 'a success clears the error');
});

test('a failure with no copy throws, and the next request within the hour fails fast', async () => {
  const { cache, calls } = setup(() => new PmApiError('http', 'PM 500', 500));
  await assert.rejects(cache.getArea(CELL));
  await assert.rejects(cache.getArea(CELL), (e: any) => e instanceof PmApiError && e.kind === 'unavailable');
  assert.equal(calls.length, 1);
});

test('offline (no fixture) / no_token are not negatively cached', async () => {
  let kind: 'offline' | null = 'offline';
  const { cache, calls, rows } = setup(() => (kind ? new PmApiError(kind, 'no fixture') : null));
  await assert.rejects(cache.getArea(CELL));
  assert.equal(rows.get(CELL.key), undefined);
  kind = null;
  await cache.getArea(CELL);
  assert.equal(calls.length, 2);
});

test('a row fetched with a smaller radius is a miss', async () => {
  const { cache, calls, rows } = setup();
  rows.set(CELL.key, { fetchRadiusMiles: 35, locations: [], fetchedAt: new Date(Date.UTC(2026, 9, 2)), lastError: null, lastErrorAt: null });
  await cache.getArea(CELL);
  assert.equal(calls.length, 1);
});
