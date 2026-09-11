import { db, pmLocationCache } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { getPmMachinesAtLocation, PmApiError, type PmLocationMachineXref } from './pinballmapApi.js';

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

/**
 * Machine roster for a Pinball Map location, served from our own table unless it has gone stale.
 *
 * Keyed by Pinball Map's location id rather than our venue id so that every caller — the venue page,
 * the pre-linked `/pm-machines/:pmId` lookup, score cross-posting — shares a single entry.
 *
 * `force` bypasses the cache for the handful of deliberate user actions where freshness is the whole
 * point (linking a venue, previewing a score re-sync). Everything else should take the cached path.
 */
export async function getVenueRoster(
  pmLocationId: number,
  { force = false }: { force?: boolean } = {},
): Promise<RosterResult> {
  const [cached] = await db
    .select()
    .from(pmLocationCache)
    .where(eq(pmLocationCache.pmLocationId, pmLocationId))
    .limit(1);

  if (!force && cached && isFresh(cached.fetchedAt)) {
    return {
      xrefs: cached.machines as PmLocationMachineXref[],
      fromCache: true,
      stale: false,
      fetchedAt: cached.fetchedAt,
    };
  }

  try {
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
  } catch (err) {
    // A stale roster beats no roster: during a Pinball Map outage the venue page should still show
    // the machines we last saw there, flagged as stale, rather than implying the venue is empty.
    if (cached && err instanceof PmApiError) {
      return {
        xrefs: cached.machines as PmLocationMachineXref[],
        fromCache: true,
        stale: true,
        fetchedAt: cached.fetchedAt,
      };
    }
    throw err;
  }
}
