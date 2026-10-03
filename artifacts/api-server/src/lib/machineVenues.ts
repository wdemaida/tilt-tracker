import { sql, type SQL } from 'drizzle-orm';
import { visibleScoreSql, type Viewer } from './venueActivity.js';
import { dbTimestampToIso } from './instant.js';

// "Where has this been played?" — the Machines page's "X Venues" pill and its modal.
//
// TiltTrack shows its OWN information here, not a Pinball Map-style "where is it on the floor"
// listing (Will, 2026-10-03): the venues are the ones where at least one score on this machine has
// been logged that the viewer may see. No rosters, no inventories, no "formerly here".
//
// ZERO Pinball Map calls, by construction: the only tables read are scores and venues. This file must
// never import pmClient, pmRosterCache (getVenueRoster), pinballMap or pinballmapApi —
// machineVenues.test.ts reads this source and fails if it does.
//
// Visibility: a score counts only if visibleScoreSql(viewer) passes — the predicate every score
// listing uses (a private venue's scores with "Show my machines/scores publicly" off are hidden from
// everyone but the score's author, the venue's owner and admins).
//
// Privacy (Will's decisions, 2026-10-02, unchanged):
//  - Public venues (not a residence, tier `full`) are listed by name.
//  - Someone else's private venue is NEVER listed by name — listing homes by machine makes a home
//    collection easy to find ("who has a Theater of Magic?"). It only adds to a "+N private
//    collections" count, and only when the viewer may see that venue's activity
//    (visibleVenueActivitySql). That holds for a score's own author too: your score at a friend's
//    home whose switch is off is still visible to you elsewhere, but doesn't put their home in the count.
//  - The viewer's own private venues are listed to them (`home: true`).
//  - Score count and last played go out for listed venues only, never for a counted private one.

const isPrivateVenueSql = (v: SQL) => sql`(${v}.is_residence OR ${v}.privacy_tier <> 'full')`;

/**
 * SQL twin of canSeeVenueActivity (venueActivity.ts) for a venue row aliased `alias`. Visible unless
 * the venue is private with the switch off and the viewer is neither its owner nor an admin.
 */
export function visibleVenueActivitySql(viewer: Viewer | undefined, alias = 'v'): SQL {
  if (viewer?.role === 'admin') return sql`true`;
  const v = sql.raw(alias);
  const ownerClause = viewer ? sql` OR ${v}.owner_id = ${viewer.id}` : sql``;
  return sql`(NOT (${isPrivateVenueSql(v)} AND ${v}.show_machines_and_scores = false)${ownerClause})`;
}

/**
 * FROM/WHERE shared by both queries: scores this viewer may see, at a venue whose activity the viewer
 * may see. `scores` stays unaliased (visibleScoreSql names it); venues are `v`. Optionally one machine.
 */
function scoredAtSql(viewer: Viewer | undefined, machineId?: number): SQL {
  const forMachine = machineId === undefined ? sql`` : sql` AND scores.machine_id = ${machineId}`;
  return sql`
    FROM scores
    JOIN venues v ON v.id = scores.venue_id
    WHERE ${visibleScoreSql(viewer)} AND ${visibleVenueActivitySql(viewer, 'v')}${forMachine}`;
}

/** One GROUP BY: machine id → venues with a visible logged score (listed + countable private). */
export function machineVenueCountsSql(viewer: Viewer | undefined): SQL {
  return sql`
    SELECT scores.machine_id, count(DISTINCT scores.venue_id)::int AS venue_count
    ${scoredAtSql(viewer)}
    GROUP BY scores.machine_id`;
}

/** Venues with a visible score on this machine, most recently played first. One GROUP BY. */
export function scoredVenuesSql(machineId: number, viewer: Viewer | undefined): SQL {
  return sql`
    SELECT v.id, v.name, v.address, v.owner_id AS "ownerId", v.is_residence AS "isResidence",
      v.privacy_tier AS "privacyTier", count(*)::int AS "scoreCount",
      max(scores.played_at) AS "lastPlayedAt"
    ${scoredAtSql(viewer, machineId)}
    GROUP BY v.id, v.name, v.address, v.owner_id, v.is_residence, v.privacy_tier
    ORDER BY max(scores.played_at) DESC, v.id`;
}

export interface ScoredVenueRow {
  id: number;
  name: string;
  address: string | null;
  ownerId: number | null;
  isResidence: boolean;
  privacyTier: 'full' | 'city_state' | 'hidden';
  scoreCount: number;
  lastPlayedAt: Date | string;
}

export interface MachineVenue {
  id: number;
  name: string;
  address: string | null;
  /** Your own private venue. */
  home: boolean;
  /** Scores on this machine there that you may see. */
  scoreCount: number;
  /** ISO instant of the most recent of those scores. */
  lastPlayedAt: string;
}

export interface MachineVenuesView {
  /** Most recently played first. */
  venues: MachineVenue[];
  /** Others' private venues with a score here that this viewer may see activity for — counted, never named. */
  privateCount: number;
  /** venues.length + privateCount — the same number the Machines page pill shows. */
  venueCount: number;
}

/**
 * Splits the venue rows into listed venues and the private count. Pure, so the privacy rule is unit
 * tested apart from the SQL. Only rows this viewer may see activity for reach here (scoredAtSql).
 */
export function shapeMachineVenues(rows: ScoredVenueRow[], viewer: Viewer | undefined): MachineVenuesView {
  const venues: MachineVenue[] = [];
  let privateCount = 0;
  for (const r of rows) {
    const isPrivate = r.isResidence || r.privacyTier !== 'full';
    const own = !!viewer && r.ownerId === viewer.id;
    if (isPrivate && !own) {
      privateCount++;
      continue;
    }
    venues.push({
      id: r.id,
      name: r.name,
      address: r.address,
      home: isPrivate, // your own collection — you already know where it is
      scoreCount: Number(r.scoreCount),
      // Raw-SQL max() comes back as Postgres text ("2026-09-30 11:32:45+00"), never send that as-is.
      lastPlayedAt: dbTimestampToIso(r.lastPlayedAt) ?? '',
    });
  }
  return { venues, privateCount, venueCount: venues.length + privateCount };
}

type Exec = (query: SQL) => Promise<unknown>;

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : ((result as { rows?: T[] })?.rows ?? [])) as T[];

/** machine id → venue count, for GET /api/machines. Ignores the Mine toggle. */
export async function machineVenueCounts(exec: Exec, viewer: Viewer | undefined): Promise<Map<number, number>> {
  const rows = rowsOf<{ machine_id: number; venue_count: number }>(await exec(machineVenueCountsSql(viewer)));
  return new Map(rows.map(r => [Number(r.machine_id), Number(r.venue_count)]));
}

/** GET /api/machines/:id/venues. */
export async function venuesForMachine(exec: Exec, machineId: number, viewer: Viewer | undefined): Promise<MachineVenuesView> {
  return shapeMachineVenues(rowsOf<ScoredVenueRow>(await exec(scoredVenuesSql(machineId, viewer))), viewer);
}
