// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/pmCaches.test.ts   (from artifacts/api-server)
// The caches in front of pmClient: the DB-backed catalog (in-memory store here) and the shared
// per-cell "PM locations near" cache. DATABASE_URL is a dummy — never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PM_MODE = 'offline';
const { createCatalog, trimCatalog, catalogIndex, CATALOG_TTL_MS, CATALOG_NEGATIVE_TTL_MS } = await import('./pinballMap.js');
const { pmLocationsNear, allowPmIds, pmIdAllowedFor } = await import('./pmGuards.js');
const { PmApiError } = await import('./pmClient.js');
type PinballMachine = import('./pinballMap.js').PinballMachine;
type CatalogRow = import('./pinballMap.js').CatalogRow;

const M = (id: number, name: string): PinballMachine => trimCatalog([{ id, name, manufacturer: 'Stern', year: 2020 }])[0];

function memoryStore(initial: CatalogRow | null = null) {
  let row = initial;
  const writes: string[] = [];
  return {
    writes,
    get row() { return row; },
    store: {
      read: async () => row,
      saveData: async (data: PinballMachine[], fetchedAt: Date) => { writes.push('data'); row = { data, fetchedAt, lastError: null, lastErrorAt: null }; },
      saveError: async (message: string, at: Date) => { writes.push('error'); row = { data: row?.data ?? null, fetchedAt: row?.fetchedAt ?? null, lastError: message, lastErrorAt: at }; },
    },
  };
}

test('catalog: one fetch, then served from memory/DB for 24h; concurrent callers share the fetch', async () => {
  let t = 1_000_000_000;
  let fetches = 0;
  const mem = memoryStore();
  const cat = createCatalog({ store: mem.store, now: () => t, fetchCatalog: async () => { fetches++; await new Promise(r => setTimeout(r, 5)); return [M(1, 'Godzilla')]; } });
  const [a, b] = await Promise.all([cat.getAll(), cat.getAll()]);
  assert.equal(fetches, 1);
  assert.equal(a, b);
  t += CATALOG_TTL_MS - 1;
  await cat.getAll();
  assert.equal(fetches, 1);
  t += 2;
  await cat.getAll();
  assert.equal(fetches, 2, 'refreshed after 24h');
});

test('catalog: a fresh DB row written by another process is used without fetching', async () => {
  const t = 5_000_000_000;
  const mem = memoryStore({ data: [M(2, 'Elvira')], fetchedAt: new Date(t - 1000), lastError: null, lastErrorAt: null });
  const cat = createCatalog({ store: mem.store, now: () => t, fetchCatalog: async () => { throw new Error('should not fetch'); } });
  assert.equal((await cat.getAll())[0].name, 'Elvira');
});

test('catalog: a failed refresh serves the stale copy and is negatively cached (no refetch per request)', async () => {
  let t = 9_000_000_000;
  let fetches = 0;
  const mem = memoryStore({ data: [M(3, 'Attack from Mars')], fetchedAt: new Date(t - CATALOG_TTL_MS - 1), lastError: null, lastErrorAt: null });
  const cat = createCatalog({ store: mem.store, now: () => t, fetchCatalog: async () => { fetches++; throw new PmApiError('http', 'Pinball Map returned 503', 503); } });
  assert.equal((await cat.getAll())[0].name, 'Attack from Mars');
  for (let i = 0; i < 20; i++) await cat.getAll();
  assert.equal(fetches, 1, 'one attempt, not one per keystroke');
  assert.equal(mem.row?.lastError, 'Pinball Map returned 503');
  t += CATALOG_NEGATIVE_TTL_MS + 1;
  await cat.getAll();
  assert.equal(fetches, 2, 'retried once the negative cache expired');
});

test('catalog: with no copy at all a failure throws, fast, until the negative TTL passes', async () => {
  let t = 1;
  let fetches = 0;
  const cat = createCatalog({ store: memoryStore().store, now: () => t, fetchCatalog: async () => { fetches++; throw new PmApiError('network', 'down'); } });
  await assert.rejects(cat.getAll());
  await assert.rejects(cat.getAll());
  assert.equal(fetches, 1);
});

test('catalog: another process\'s recent failure (row.lastErrorAt) is respected', async () => {
  const t = 50_000_000;
  const mem = memoryStore({ data: null, fetchedAt: null, lastError: 'Pinball Map returned 429', lastErrorAt: new Date(t - 1000) });
  let fetches = 0;
  const cat = createCatalog({ store: mem.store, now: () => t, fetchCatalog: async () => { fetches++; return [M(1, 'x')]; } });
  await assert.rejects(cat.getAll(), /unavailable/);
  assert.equal(fetches, 0);
});

test('catalogIndex: case-insensitive, first entry wins, built once per array', () => {
  const all = [M(1, 'The Addams Family'), M(2, 'the addams family')];
  const idx = catalogIndex(all);
  assert.equal(idx.get('the addams family')?.id, 1);
  assert.equal(catalogIndex(all), idx);
});

test('pmLocationsNear: one call per cell, and a failure is negatively cached', async () => {
  let calls = 0;
  const ok = async () => { calls++; return [{ id: 1, name: 'x', lat: 0, lon: 0 }]; };
  await pmLocationsNear(10.0001, 20.0001, ok);
  await pmLocationsNear(10.0002, 20.0002, ok); // same ~110m cell
  assert.equal(calls, 1);

  let failures = 0;
  const bad = async () => { failures++; throw new PmApiError('http', 'boom', 500); };
  await assert.rejects(pmLocationsNear(30, 40, bad));
  await new Promise(r => setImmediate(r));
  await assert.rejects(pmLocationsNear(30, 40, bad));
  assert.equal(failures, 1, 'failure remembered, not retried per tap');
});

test('allowlist: per user and per id', () => {
  allowPmIds('user_a', [5, null, -1, 7]);
  assert.equal(pmIdAllowedFor('user_a', 5), true);
  assert.equal(pmIdAllowedFor('user_a', 7), true);
  assert.equal(pmIdAllowedFor('user_b', 5), false);
  assert.equal(pmIdAllowedFor('user_a', 6), false);
  allowPmIds(null, [9]);
  assert.equal(pmIdAllowedFor('null', 9), false);
});
