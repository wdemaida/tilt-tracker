// Pinball Map's machine catalog (machines.json) — the typeahead's source, and what machine rows are
// enriched from (manufacturer / year / OPDB image).
//
// Stored in our own DB (`pm_catalog_cache`, one row keyed 'machines', migrate16) with a 24-hour TTL,
// so every process and every restart shares one copy and Pinball Map sees about one catalog request
// a day, whatever our traffic. On top of that a per-process memory copy avoids re-reading ~1MB of
// jsonb per keystroke. Refreshes are de-duplicated in flight; a failed refresh is remembered for 15
// minutes (in memory and in the row) and the stale catalog keeps being served meanwhile — never a
// refetch per request while Pinball Map is down.
//
// Loops must fetch the catalog ONCE and pass it down (see upsertMachineByName's `catalog` option and
// `catalogIndex`) — never call getAllMachines() per record.

import { db, pmCatalogCache } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { buildSearchIndex, searchIndex, type IndexedMachine } from './machineSearch.js';
import { pmClient, PmApiError } from './pmClient.js';

export interface PinballMachine {
  id: number;
  name: string;
  opdb_id: string | null;
  ipdb_id: number | null;
  machine_group_id: number | null;
  manufacturer: string | null;
  year: number | null;
  opdb_img: string | null;
  machine_type: string | null;
  machine_display: string | null;
}

export const CATALOG_TTL_MS = 24 * 60 * 60_000;
export const CATALOG_NEGATIVE_TTL_MS = 15 * 60_000;
const CATALOG_KEY = 'machines';

export interface CatalogRow {
  data: PinballMachine[] | null;
  fetchedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export interface CatalogStore {
  read(): Promise<CatalogRow | null>;
  saveData(data: PinballMachine[], fetchedAt: Date): Promise<void>;
  saveError(message: string, at: Date): Promise<void>;
}

/** Only the fields PinballMachine declares — keeps the stored row (and memory) small. */
export function trimCatalog(raw: any[]): PinballMachine[] {
  return raw
    .filter(m => m && typeof m.id === 'number' && typeof m.name === 'string')
    .map(m => ({
      id: m.id,
      name: m.name,
      opdb_id: m.opdb_id ?? null,
      ipdb_id: m.ipdb_id ?? null,
      machine_group_id: m.machine_group_id ?? null,
      manufacturer: m.manufacturer ?? null,
      year: m.year ?? null,
      opdb_img: m.opdb_img ?? null,
      machine_type: m.machine_type ?? null,
      machine_display: m.machine_display ?? null,
    }));
}

async function fetchCatalogFromPm(): Promise<PinballMachine[]> {
  // no_details drops fields this cache doesn't expose; Pinball Map recommends it for the machine list.
  const data = await pmClient().get<{ machines?: any[] }>('/machines.json', { no_details: 1 });
  const machines = trimCatalog(data?.machines ?? []);
  if (machines.length === 0) throw new PmApiError('http', 'Pinball Map returned an empty machine catalog');
  return machines;
}

const dbStore: CatalogStore = {
  async read() {
    const [row] = await db.select().from(pmCatalogCache).where(eq(pmCatalogCache.key, CATALOG_KEY)).limit(1);
    if (!row) return null;
    return {
      data: (row.data as PinballMachine[] | null) ?? null,
      fetchedAt: row.fetchedAt,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt,
    };
  },
  async saveData(data, fetchedAt) {
    await db.insert(pmCatalogCache)
      .values({ key: CATALOG_KEY, data, fetchedAt, lastError: null, lastErrorAt: null })
      .onConflictDoUpdate({ target: pmCatalogCache.key, set: { data, fetchedAt, lastError: null, lastErrorAt: null } });
  },
  async saveError(message, at) {
    await db.insert(pmCatalogCache)
      .values({ key: CATALOG_KEY, data: null, fetchedAt: null, lastError: message, lastErrorAt: at })
      .onConflictDoUpdate({ target: pmCatalogCache.key, set: { lastError: message, lastErrorAt: at } });
  },
};

export interface CatalogStatus {
  machineCount: number;
  fetchedAt: Date | null;
  stale: boolean;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export function createCatalog({
  store = dbStore,
  fetchCatalog = fetchCatalogFromPm,
  now = () => Date.now(),
}: { store?: CatalogStore; fetchCatalog?: () => Promise<PinballMachine[]>; now?: () => number } = {}) {
  let mem: { data: PinballMachine[]; fetchedAt: number } | null = null;
  // While now < negativeUntil a refresh has recently failed: serve `mem` if we have it, else fail fast.
  let negativeUntil = 0;
  let negativeError: Error | null = null;
  let inflight: Promise<PinballMachine[]> | null = null;

  const fresh = (fetchedAt: number) => now() - fetchedAt < CATALOG_TTL_MS;

  function unavailable(): Error {
    return negativeError ?? new PmApiError('unavailable', 'Machine catalog is unavailable right now — try again later');
  }

  async function load(): Promise<PinballMachine[]> {
    const row = await store.read();
    if (row?.data?.length && row.fetchedAt && fresh(row.fetchedAt.getTime())) {
      mem = { data: row.data, fetchedAt: row.fetchedAt.getTime() };
      return mem.data;
    }
    if (row?.data?.length && row.fetchedAt && (!mem || row.fetchedAt.getTime() > mem.fetchedAt)) {
      mem = { data: row.data, fetchedAt: row.fetchedAt.getTime() };
    }
    // Another process may have failed recently — respect its negative cache too.
    const lastErrorAt = row?.lastErrorAt?.getTime();
    if (lastErrorAt != null && now() - lastErrorAt < CATALOG_NEGATIVE_TTL_MS) {
      negativeUntil = lastErrorAt + CATALOG_NEGATIVE_TTL_MS;
      negativeError = new PmApiError('unavailable', `Machine catalog is unavailable right now (${row?.lastError ?? 'Pinball Map error'})`);
      if (mem) return mem.data;
      throw unavailable();
    }

    try {
      const data = await fetchCatalog();
      const at = new Date(now());
      await store.saveData(data, at);
      mem = { data, fetchedAt: at.getTime() };
      negativeUntil = 0;
      negativeError = null;
      return data;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      negativeUntil = now() + CATALOG_NEGATIVE_TTL_MS;
      negativeError = err instanceof PmApiError ? err : new PmApiError('unavailable', `Machine catalog is unavailable right now (${message})`);
      await store.saveError(message.slice(0, 500), new Date(now())).catch(e => console.error('Catalog error write failed:', e?.message ?? e));
      console.error('Pinball Map catalog refresh failed:', message, mem ? '— serving the stale catalog' : '— no copy to fall back on');
      if (mem) return mem.data;
      throw negativeError;
    }
  }

  return {
    async getAll(): Promise<PinballMachine[]> {
      if (mem && fresh(mem.fetchedAt)) return mem.data;
      if (now() < negativeUntil) {
        if (mem) return mem.data;
        throw unavailable();
      }
      if (!inflight) inflight = load().finally(() => { inflight = null; });
      return inflight;
    },
    /**
     * Whatever copy we already hold — memory, else the stored row — at any age, or null. Never
     * fetches from Pinball Map and never throws: for read paths that must make zero PM calls.
     */
    async peek(): Promise<PinballMachine[] | null> {
      if (mem) return mem.data;
      try {
        const row = await store.read();
        if (row?.data?.length && row.fetchedAt) {
          mem = { data: row.data, fetchedAt: row.fetchedAt.getTime() };
          return mem.data;
        }
      } catch (err) {
        console.error('Catalog read failed:', (err as Error)?.message ?? err);
      }
      return null;
    },
    /** Read-only view for the admin health page — never triggers a refresh. */
    async status(): Promise<CatalogStatus> {
      const row = await store.read();
      const fetchedAt = row?.fetchedAt ?? null;
      return {
        machineCount: row?.data?.length ?? 0,
        fetchedAt,
        stale: !fetchedAt || !fresh(fetchedAt.getTime()),
        lastError: row?.lastError ?? null,
        lastErrorAt: row?.lastErrorAt ?? null,
      };
    },
  };
}

const catalog = createCatalog();

export function getAllMachines(): Promise<PinballMachine[]> {
  return catalog.getAll();
}

/** The catalog, or null when it can't be read — for enrichment, where a miss just means "no extra data". */
export async function getCatalogOrNull(): Promise<PinballMachine[] | null> {
  try {
    return await catalog.getAll();
  } catch {
    return null;
  }
}

/** The stored catalog at any age, or null — never calls Pinball Map (see `peek`). */
export function getStoredCatalog(): Promise<PinballMachine[] | null> {
  return catalog.peek();
}

export function getCatalogStatus(): Promise<CatalogStatus> {
  return catalog.status();
}

const nameIndexes = new WeakMap<PinballMachine[], Map<string, PinballMachine>>();
/** Case-insensitive name → catalog entry, built once per catalog array. */
export function catalogIndex(all: PinballMachine[]): Map<string, PinballMachine> {
  let idx = nameIndexes.get(all);
  if (!idx) {
    idx = new Map();
    for (const m of all) if (!idx.has(m.name.toLowerCase())) idx.set(m.name.toLowerCase(), m);
    nameIndexes.set(all, idx);
  }
  return idx;
}

// Normalized names precomputed alongside the catalog, rebuilt whenever the catalog array is replaced.
let index: IndexedMachine<PinballMachine>[] = [];
let indexedFrom: PinballMachine[] | null = null;

export async function searchMachines(query: string, limit = 10): Promise<PinballMachine[]> {
  const all = await getAllMachines();
  if (indexedFrom !== all) {
    index = buildSearchIndex(all);
    indexedFrom = all;
  }
  // Returns catalog entries untouched, so the name a client picks is the catalog's own spelling —
  // venueInventory's resolveCatalogMachine relies on that for its exact-name match.
  return searchIndex(index, query, limit);
}
