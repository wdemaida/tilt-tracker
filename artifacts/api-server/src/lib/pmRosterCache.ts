import { db, pmLocationCache } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  getPmLocationWithMachines, PmApiError, type PmLocation, type PmLocationMachineXref,
} from './pinballmapApi.js';
import { TtlCache } from './nearbyLookup.js';

// Pinball Map's guidance is explicit: request volume should track how often their data changes, not
// how often our pages get viewed. A venue's machine roster changes when an operator swaps a game —
// days or weeks — so a six-hour window is generous and still keeps our call rate bounded by the
// number of linked venues rather than by traffic.
const TTL_MS = 1000 * 60 * 60 * 6;

// A listing's name and address change far less often than its roster — a week-old copy is fine for
// placing an address-less venue or labelling a search hit. `/locations/:id.json` is the one PM URL for
// a location; the location fields come off the same response as the roster (there is no separate
// `?metadata_only=1` request any more).
export const METADATA_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface RosterResult {
  xrefs: PmLocationMachineXref[];
  /**
   * The location's own fields (id, name, lat/lon, street, city, state, zip, country) from the same
   * response. Null only for a row cached before migrate20 that hasn't been refreshed since.
   */
  location: PmLocation | null;
  /** True when this came from the local cache without touching Pinball Map. */
  fromCache: boolean;
  /** True when Pinball Map was unreachable and we fell back to a cached copy past its TTL. */
  stale: boolean;
  fetchedAt: Date;
}

// `force: true` is for deliberate user actions only, and even then a copy fetched in the last five
// minutes is fresh enough — the roster doesn't change that fast, and it stops a user clicking
// "preview" repeatedly from turning into repeated Pinball Map calls.
export const FORCE_MIN_AGE_MS = 5 * 60_000;

// Negative cache for ids that didn't resolve. A 404 (no such location) is remembered for an hour; any
// other failure with no cached roster to fall back on for ten minutes (the pmClient breaker already
// covers Pinball Map being down globally). Never a DB row — an id that didn't resolve must not look
// like a location with no machines.
const NOT_FOUND_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;

export interface RosterRow {
  machines: unknown;
  location: unknown;
  fetchedAt: Date;
}

/** Where cached rosters live — `pm_location_cache` in the app, an in-memory map in tests. */
export interface RosterStore {
  read(pmLocationId: number): Promise<RosterRow | null>;
  write(pmLocationId: number, xrefs: PmLocationMachineXref[], location: PmLocation, fetchedAt: Date): Promise<void>;
}

export interface RosterCacheOptions {
  store: RosterStore;
  /** The live read — one `/locations/:id.json` request. */
  fetchLocation?: typeof getPmLocationWithMachines;
  now?: () => number;
}

type LiveGate = {
  force?: boolean;
  /** Consulted only when a live fetch is about to start — return false to refuse (e.g. a rate limit). */
  allowLive?: () => boolean;
};

export function createRosterCache({ store, fetchLocation = getPmLocationWithMachines, now = Date.now }: RosterCacheOptions) {
  const negative = new TtlCache<PmApiError>(NOT_FOUND_TTL_MS);
  const negativeShort = new TtlCache<PmApiError>(FAILURE_TTL_MS);
  const sweeper = setInterval(() => { negative.sweep(); negativeShort.sweep(); }, 10 * 60_000);
  sweeper.unref?.();

  // In-flight de-duplication: a burst of views of a venue whose cache just expired makes one call.
  const inflight = new Map<number, Promise<RosterResult>>();

  async function refresh(pmLocationId: number): Promise<RosterResult> {
    const { location, xrefs } = await fetchLocation(pmLocationId);
    const fetchedAt = new Date(now());
    await store.write(pmLocationId, xrefs, location, fetchedAt);
    return { xrefs, location, fromCache: false, stale: false, fetchedAt };
  }

  /** True when a recent lookup of this id failed — callers can refuse without touching anything. */
  function knownBadPmId(pmLocationId: number): PmApiError | undefined {
    const t = now();
    return negative.get(String(pmLocationId), t) ?? negativeShort.get(String(pmLocationId), t);
  }

  function fromRow(row: RosterRow, stale: boolean): RosterResult {
    return {
      xrefs: row.machines as PmLocationMachineXref[],
      location: (row.location as PmLocation | null) ?? null,
      fromCache: true,
      stale,
      fetchedAt: row.fetchedAt,
    };
  }

  async function roster(
    pmLocationId: number,
    { force = false, allowLive }: LiveGate,
    /** Treat a cached row with no stored location (pre-migrate20) as a miss. */
    needLocation: boolean,
  ): Promise<RosterResult> {
    let cached = await store.read(pmLocationId);
    if (cached && needLocation && !cached.location) cached = null;

    const age = cached ? now() - cached.fetchedAt.getTime() : Infinity;
    if (cached && (force ? age < FORCE_MIN_AGE_MS : age < TTL_MS)) return fromRow(cached, false);

    const staleCopy = (): RosterResult | null => cached ? fromRow(cached, true) : null;

    const bad = knownBadPmId(pmLocationId);
    if (bad) {
      const stale = staleCopy();
      if (stale && bad.kind !== 'not_found') return stale;
      throw bad;
    }

    let pending = inflight.get(pmLocationId);
    if (!pending && allowLive && !allowLive()) {
      const stale = staleCopy();
      if (stale) return stale;
      throw new PmApiError('rate_limited', 'Too many Pinball Map lookups — wait a few minutes and try again');
    }
    if (!pending) {
      pending = refresh(pmLocationId).finally(() => inflight.delete(pmLocationId));
      inflight.set(pmLocationId, pending);
    }

    try {
      return await pending;
    } catch (err) {
      if (err instanceof PmApiError) {
        const t = now();
        if (err.kind === 'not_found') negative.set(String(pmLocationId), err, t);
        else if (!cached && err.kind !== 'offline' && err.kind !== 'no_token') negativeShort.set(String(pmLocationId), err, t);
      }
      // A stale roster beats no roster: during a Pinball Map outage the venue page should still show
      // the machines we last saw there, flagged as stale, rather than implying the venue is empty.
      const stale = staleCopy();
      if (stale && err instanceof PmApiError && err.kind !== 'not_found') return stale;
      throw err;
    }
  }

  /**
   * Machine roster for a Pinball Map location, served from our own table unless it has gone stale.
   *
   * Keyed by Pinball Map's location id rather than our venue id so that every caller — the venue page,
   * the pre-linked `/pm-machines/:pmId` lookup, score cross-posting — shares a single entry.
   *
   * `force` bypasses the cache for the handful of deliberate user actions where freshness is the whole
   * point (linking a venue, previewing a score re-sync) — but only when the cached copy is more than
   * FORCE_MIN_AGE_MS old. Everything else should take the cached path.
   *
   * Throws PmApiError('not_found') for an id Pinball Map doesn't have (negatively cached for an hour),
   * so a successful call also verifies the id.
   */
  function getVenueRoster(pmLocationId: number, gate: LiveGate = {}): Promise<RosterResult> {
    return roster(pmLocationId, gate, false);
  }

  /**
   * A location's name/address/coordinates — the replacement for the old uncached `metadata_only`
   * request. Reads the location stored with the cached roster (up to METADATA_MAX_AGE_MS old);
   * otherwise refreshes the roster, which fetches the same `/locations/:id.json` URL and caches it
   * for everyone else (Add Score, the venue page). Null when Pinball Map has no such location.
   */
  async function getPmLocationCached(pmLocationId: number, { allowLive }: Pick<LiveGate, 'allowLive'> = {}): Promise<PmLocation | null> {
    const row = await store.read(pmLocationId);
    if (row?.location && now() - row.fetchedAt.getTime() <= METADATA_MAX_AGE_MS) return row.location as PmLocation;
    try {
      const r = await roster(pmLocationId, { allowLive }, true);
      return r.location ?? (row?.location as PmLocation | undefined) ?? null;
    } catch (err) {
      if (err instanceof PmApiError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  return { getVenueRoster, getPmLocationCached, knownBadPmId };
}

const dbStore: RosterStore = {
  async read(pmLocationId) {
    const [row] = await db
      .select()
      .from(pmLocationCache)
      .where(eq(pmLocationCache.pmLocationId, pmLocationId))
      .limit(1);
    return row ?? null;
  },
  async write(pmLocationId, xrefs, location, fetchedAt) {
    await db
      .insert(pmLocationCache)
      .values({ pmLocationId, machines: xrefs, location, fetchedAt })
      .onConflictDoUpdate({
        target: pmLocationCache.pmLocationId,
        set: { machines: xrefs, location, fetchedAt },
      });
  },
};

const shared = createRosterCache({ store: dbStore });

export const getVenueRoster = shared.getVenueRoster;
export const getPmLocationCached = shared.getPmLocationCached;
export const knownBadPmId = shared.knownBadPmId;
