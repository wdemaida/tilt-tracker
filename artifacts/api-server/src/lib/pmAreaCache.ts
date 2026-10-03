import { db, pmAreaCache } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { findNearestPmLocations, PmApiError } from './pinballmapApi.js';
import { AREA_FETCH_RADIUS_MILES, trimAreaLocations, type AreaCell, type AreaLocation } from './areaMatch.js';

// Pinball Map locations around a Last Resort cell (feature/last-resort) — the DB-backed cache the
// standing rule asks for, in the same shape as pmRosterCache.ts / the catalog:
//  - one row per 0.1° cell (`pm_area_cache`, migrate29), keyed by areaCell().key, holding every
//    location within AREA_FETCH_RADIUS_MILES of the cell's grid point (trimmed: id, name, city,
//    state, lat, lon, machine ids) — ONE `closest_by_lat_lon` request per cell;
//  - TTL 7 days: pinball locations open, close and swap games over weeks, and nothing here needs it
//    fresher (a stale roster at worst suggests a machine that just left);
//  - a failed refresh is negatively cached for an hour IN THE ROW (last_error / last_error_at), so
//    every process sees it; during that hour the stale copy is served, or the failure re-thrown;
//  - in-flight de-duplication per cell; a stale copy is served when Pinball Map fails;
//  - `allowLive` is consulted only when a request is actually about to go out (it's how the
//    per-user / global Expand limits in pmGuards.ts are charged — a cache hit costs nothing).
// A row written with a smaller fetch radius (if AREA_FETCH_RADIUS_MILES ever grows) is a miss.
//
// Never touches pm_location_cache: those rows are keyed by location and carry xref ids that score
// posting depends on; this answer has no xrefs.

export const AREA_TTL_MS = 7 * 24 * 60 * 60_000;
export const AREA_NEGATIVE_TTL_MS = 60 * 60_000;

export interface AreaRow {
  fetchRadiusMiles: number;
  locations: AreaLocation[] | null;
  fetchedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/** Where cells live — pm_area_cache in the app, an in-memory map in tests. */
export interface AreaStore {
  read(cellKey: string): Promise<AreaRow | null>;
  saveData(cellKey: string, fetchRadiusMiles: number, locations: AreaLocation[], fetchedAt: Date): Promise<void>;
  saveError(cellKey: string, fetchRadiusMiles: number, message: string, at: Date): Promise<void>;
}

export interface AreaResult {
  locations: AreaLocation[];
  fetchedAt: Date;
  /** Served from the table without touching Pinball Map. */
  fromCache: boolean;
  /** Past its TTL — Pinball Map failed, was refused (allowLive), or failed within the last hour. */
  stale: boolean;
}

export interface AreaCacheOptions {
  store: AreaStore;
  /** The live read — one closest_by_lat_lon request. */
  fetchNear?: (lat: number, lng: number, miles: number) => Promise<unknown[]>;
  now?: () => number;
}

export function createAreaCache({ store, fetchNear = findNearestPmLocations, now = Date.now }: AreaCacheOptions) {
  const inflight = new Map<string, Promise<AreaResult>>();

  async function refresh(cell: AreaCell): Promise<AreaResult> {
    const raw = await fetchNear(cell.lat, cell.lng, AREA_FETCH_RADIUS_MILES);
    const locations = trimAreaLocations(raw);
    const fetchedAt = new Date(now());
    await store.saveData(cell.key, AREA_FETCH_RADIUS_MILES, locations, fetchedAt);
    return { locations, fetchedAt, fromCache: false, stale: false };
  }

  /**
   * Every Pinball Map location within AREA_FETCH_RADIUS_MILES of the cell's grid point. Throws
   * PmApiError when there's no usable copy and Pinball Map can't (or may not) be asked.
   */
  async function getArea(cell: AreaCell, { allowLive }: { allowLive?: () => boolean } = {}): Promise<AreaResult> {
    const row = await store.read(cell.key);
    const usable = row?.locations && row.fetchedAt && row.fetchRadiusMiles >= AREA_FETCH_RADIUS_MILES ? row : null;
    const t = now();
    if (usable && t - usable.fetchedAt!.getTime() < AREA_TTL_MS) {
      return { locations: usable.locations!, fetchedAt: usable.fetchedAt!, fromCache: true, stale: false };
    }
    const staleCopy = (): AreaResult | null => usable
      ? { locations: usable.locations!, fetchedAt: usable.fetchedAt!, fromCache: true, stale: true }
      : null;

    // Negative cache: a refresh failed within the hour (and nothing newer succeeded since).
    if (row?.lastErrorAt && t - row.lastErrorAt.getTime() < AREA_NEGATIVE_TTL_MS
      && (!row.fetchedAt || row.lastErrorAt > row.fetchedAt)) {
      const stale = staleCopy();
      if (stale) return stale;
      throw new PmApiError('unavailable', `Pinball Map lookup failed recently (${row.lastError ?? 'error'}) — try again later`);
    }

    let pending = inflight.get(cell.key);
    if (!pending && allowLive && !allowLive()) {
      const stale = staleCopy();
      if (stale) return stale;
      throw new PmApiError('rate_limited', 'Too many Pinball Map area lookups — try again later');
    }
    if (!pending) {
      pending = refresh(cell).finally(() => inflight.delete(cell.key));
      inflight.set(cell.key, pending);
    }
    try {
      return await pending;
    } catch (err) {
      // Remember the failure in the row (other processes see it), except "we're not set up to ask"
      // (dev without a fixture, no token) — that says nothing about Pinball Map.
      if (!(err instanceof PmApiError && (err.kind === 'offline' || err.kind === 'no_token'))) {
        await store.saveError(cell.key, AREA_FETCH_RADIUS_MILES, (err as Error).message?.slice(0, 300) ?? 'error', new Date(now()))
          .catch(() => { /* the negative cache is best effort */ });
      }
      const stale = staleCopy();
      if (stale) return stale;
      throw err;
    }
  }

  return { getArea };
}

const dbStore: AreaStore = {
  async read(cellKey) {
    const [row] = await db.select().from(pmAreaCache).where(eq(pmAreaCache.cellKey, cellKey)).limit(1);
    if (!row) return null;
    return {
      fetchRadiusMiles: row.fetchRadiusMiles,
      locations: (row.locations as AreaLocation[] | null) ?? null,
      fetchedAt: row.fetchedAt,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt,
    };
  },
  async saveData(cellKey, fetchRadiusMiles, locations, fetchedAt) {
    await db.insert(pmAreaCache)
      .values({ cellKey, fetchRadiusMiles, locations, locationCount: locations.length, fetchedAt, lastError: null, lastErrorAt: null })
      .onConflictDoUpdate({
        target: pmAreaCache.cellKey,
        set: { fetchRadiusMiles, locations, locationCount: locations.length, fetchedAt, lastError: null, lastErrorAt: null },
      });
  },
  async saveError(cellKey, fetchRadiusMiles, message, at) {
    // Keeps any earlier data (and its fetch radius) — the stale copy is still worth serving.
    await db.insert(pmAreaCache)
      .values({ cellKey, fetchRadiusMiles, lastError: message, lastErrorAt: at })
      .onConflictDoUpdate({ target: pmAreaCache.cellKey, set: { lastError: message, lastErrorAt: at } });
  },
};

const shared = createAreaCache({ store: dbStore });
export const getArea = shared.getArea;
