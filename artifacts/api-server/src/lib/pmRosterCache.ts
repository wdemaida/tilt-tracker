import { db, pmLocationCache } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { getPmMachinesAtLocation, PmApiError, type PmLocationMachineXref } from './pinballmapApi.js';
import { TtlCache } from './nearbyLookup.js';

// Pinball Map's guidance is explicit: request volume should track how often their data changes, not
// how often our pages get viewed. A venue's machine roster changes when an operator swaps a game —
// days or weeks — so a six-hour window is generous and still keeps our call rate bounded by the
// number of linked venues rather than by traffic.
const TTL_MS = 1000 * 60 * 60 * 6;

export interface RosterResult {
  xrefs: PmLocationMachineXref[];
  /** True when this came from the local cache without touching Pinball Map. */
  fromCache: boolean;
  /** True when Pinball Map was unreachable and we fell back to a cached copy past its TTL. */
  stale: boolean;
  fetchedAt: Date;
}

function isFresh(fetchedAt: Date): boolean {
  return Date.now() - fetchedAt.getTime() < TTL_MS;
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
const negative = new TtlCache<PmApiError>(NOT_FOUND_TTL_MS);
const negativeShort = new TtlCache<PmApiError>(FAILURE_TTL_MS);
setInterval(() => { negative.sweep(); negativeShort.sweep(); }, 10 * 60_000).unref();

// In-flight de-duplication: a burst of views of a venue whose cache just expired makes one call.
const inflight = new Map<number, Promise<RosterResult>>();

async function refresh(pmLocationId: number): Promise<RosterResult> {
  const xrefs = await getPmMachinesAtLocation(pmLocationId);
  const fetchedAt = new Date();
  await db
    .insert(pmLocationCache)
    .values({ pmLocationId, machines: xrefs, fetchedAt })
    .onConflictDoUpdate({
      target: pmLocationCache.pmLocationId,
      set: { machines: xrefs, fetchedAt },
    });
  return { xrefs, fromCache: false, stale: false, fetchedAt };
}

/** True when a recent lookup of this id failed — callers can refuse without touching anything. */
export function knownBadPmId(pmLocationId: number): PmApiError | undefined {
  return negative.get(String(pmLocationId)) ?? negativeShort.get(String(pmLocationId));
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
 */
export async function getVenueRoster(
  pmLocationId: number,
  { force = false, allowLive }: {
    force?: boolean;
    /** Consulted only when a live fetch is about to start — return false to refuse (e.g. a rate limit). */
    allowLive?: () => boolean;
  } = {},
): Promise<RosterResult> {
  const [cached] = await db
    .select()
    .from(pmLocationCache)
    .where(eq(pmLocationCache.pmLocationId, pmLocationId))
    .limit(1);

  const age = cached ? Date.now() - cached.fetchedAt.getTime() : Infinity;
  if (cached && (force ? age < FORCE_MIN_AGE_MS : isFresh(cached.fetchedAt))) {
    return {
      xrefs: cached.machines as PmLocationMachineXref[],
      fromCache: true,
      stale: false,
      fetchedAt: cached.fetchedAt,
    };
  }

  const staleCopy = (): RosterResult | null => cached ? {
    xrefs: cached.machines as PmLocationMachineXref[],
    fromCache: true,
    stale: true,
    fetchedAt: cached.fetchedAt,
  } : null;

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
      if (err.kind === 'not_found') negative.set(String(pmLocationId), err);
      else if (!cached && err.kind !== 'offline' && err.kind !== 'no_token') negativeShort.set(String(pmLocationId), err);
    }
    // A stale roster beats no roster: during a Pinball Map outage the venue page should still show
    // the machines we last saw there, flagged as stale, rather than implying the venue is empty.
    const stale = staleCopy();
    if (stale && err instanceof PmApiError && err.kind !== 'not_found') return stale;
    throw err;
  }
}
