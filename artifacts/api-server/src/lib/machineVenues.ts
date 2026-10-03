import { sql, type SQL } from 'drizzle-orm';
import type { Viewer } from './venueActivity.js';

// "Where can I play this?" — the Machines page's "X Venues" pill and its modal.
//
// ZERO Pinball Map calls, by construction: every roster here is read straight out of
// `pm_location_cache` (any age — a stale roster is still the best answer we have) and our own
// `venue_machine_history` / `venue_inventory` tables. This file must never import pmClient,
// pmRosterCache (getVenueRoster), pinballMap or pinballmapApi — machineVenues.test.ts
// reads this source and fails if it does. A machine page is browsed far more often than rosters change,
// and fanning out one roster read per venue per machine view is exactly what the PM standing rule
// forbids.
//
// Privacy (Will's decisions, 2026-10-02):
//  - Public venues (not a residence, tier `full`) are listed by name.
//  - Someone else's private venue is NEVER listed by name — listing homes by machine makes a home
//    collection easy to find ("who has a Theater of Magic?"). It only adds to a "+N private
//    collections" count, and only when the viewer may see that venue's activity
//    (canSeeVenueActivity): a venue whose owner turned "Show my machines/scores publicly" off isn't
//    counted at all. The viewer's own private venues are listed to them as usual.
//  - A private venue's roster is its owner-managed inventory (venue_inventory). Its
//    venue_machine_history is never read: that's the PM-derived roster, served only past
//    canSeeVenueLinkage, and a venue that went private would otherwise publish its old PM listing.
//  - "Formerly here" is venue_machine_history rows with removed_at set, public linked venues only.
//
// "On the floor" for a public venue linked to Pinball Map: the cached roster when there is one
// (that's what the venue's own machines modal shows), else the history rows still open. A roster
// entry maps to our machine by trimmed, case-insensitive name — the rule challengeReach.ts uses.
// Unlinked public venues have no roster: "played here" is deliberately not a source.

const isPrivateVenueSql = (v: SQL) => sql`(${v}.is_residence OR ${v}.privacy_tier <> 'full')`;
const isPublicVenueSql = (v: SQL) => sql`(NOT ${v}.is_residence AND ${v}.privacy_tier = 'full')`;

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
 * (venue_id, machine_id) pairs "on the floor" that this viewer may know about — public venues' current
 * rosters plus private venues' current inventory where the viewer may see activity. Optionally
 * narrowed to one machine. A SELECT, for use as a CTE body.
 */
export function onFloorSql(viewer: Viewer | undefined, machineId?: number): SQL {
  const v = sql.raw('v');
  const forMachine = (col: SQL) => (machineId === undefined ? sql`` : sql` AND ${col} = ${machineId}`);
  return sql`
    SELECT v.id AS venue_id, m.id AS machine_id
    FROM venues v
    JOIN pm_location_cache c ON c.pm_location_id = v.pinball_map_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.machines) = 'array' THEN c.machines ELSE '[]'::jsonb END
    ) AS x(entry)
    JOIN machines m ON lower(m.name) = lower(trim(x.entry->'machine'->>'name'))
    WHERE ${isPublicVenueSql(v)}${forMachine(sql.raw('m.id'))}
    UNION
    SELECT h.venue_id, h.machine_id
    FROM venue_machine_history h
    JOIN venues v ON v.id = h.venue_id
    WHERE h.removed_at IS NULL AND v.pinball_map_id IS NOT NULL AND ${isPublicVenueSql(v)}
      AND NOT EXISTS (SELECT 1 FROM pm_location_cache c WHERE c.pm_location_id = v.pinball_map_id)${forMachine(sql.raw('h.machine_id'))}
    UNION
    SELECT i.venue_id, i.machine_id
    FROM venue_inventory i
    JOIN venues v ON v.id = i.venue_id
    WHERE i.removed_at IS NULL AND ${isPrivateVenueSql(v)} AND ${visibleVenueActivitySql(viewer, 'v')}${forMachine(sql.raw('i.machine_id'))}`;
}

/** One GROUP BY: machine id → number of venues it's on the floor at (public + countable private). */
export function machineVenueCountsSql(viewer: Viewer | undefined): SQL {
  return sql`
    WITH floor AS (${onFloorSql(viewer)})
    SELECT machine_id, count(DISTINCT venue_id)::int AS venue_count
    FROM floor
    GROUP BY machine_id`;
}

/** Venues currently holding this machine, with what the modal needs to decide listing vs counting. */
export function floorVenuesSql(machineId: number, viewer: Viewer | undefined): SQL {
  return sql`
    WITH floor AS (${onFloorSql(viewer, machineId)})
    SELECT v.id, v.name, v.address, v.owner_id AS "ownerId", v.is_residence AS "isResidence",
      v.privacy_tier AS "privacyTier"
    FROM floor f
    JOIN venues v ON v.id = f.venue_id
    ORDER BY v.name, v.id`;
}

/** Public linked venues this machine has left (and isn't back on the floor at). */
export function formerVenuesSql(machineId: number, viewer: Viewer | undefined): SQL {
  return sql`
    WITH floor AS (${onFloorSql(viewer, machineId)})
    SELECT v.id, v.name, v.address, h.removed_at AS "removedAt"
    FROM venue_machine_history h
    JOIN venues v ON v.id = h.venue_id
    WHERE h.machine_id = ${machineId} AND h.removed_at IS NOT NULL
      AND v.pinball_map_id IS NOT NULL AND ${isPublicVenueSql(sql.raw('v'))}
      AND NOT EXISTS (SELECT 1 FROM floor f WHERE f.venue_id = v.id)
    ORDER BY h.removed_at DESC, v.id`;
}

export interface FloorVenueRow {
  id: number;
  name: string;
  address: string | null;
  ownerId: number | null;
  isResidence: boolean;
  privacyTier: 'full' | 'city_state' | 'hidden';
}

export interface FormerVenueRow {
  id: number;
  name: string;
  address: string | null;
  removedAt: Date | string;
}

export interface MachineVenuesView {
  onFloor: Array<{ id: number; name: string; address: string | null; home: boolean }>;
  /** Others' private venues holding it that this viewer may see activity for — counted, never named. */
  privateCount: number;
  formerly: Array<{ id: number; name: string; address: string | null; removedAt: string }>;
  /** onFloor.length + privateCount — the same number the Machines page pill shows. */
  venueCount: number;
}

/**
 * Splits the floor rows into listed venues and the private count. Pure, so the privacy rule is unit
 * tested apart from the SQL. Only rows this viewer may see activity for reach here (onFloorSql).
 */
export function shapeMachineVenues(
  floor: FloorVenueRow[],
  former: FormerVenueRow[],
  viewer: Viewer | undefined,
): MachineVenuesView {
  const onFloor: MachineVenuesView['onFloor'] = [];
  let privateCount = 0;
  for (const r of floor) {
    const isPrivate = r.isResidence || r.privacyTier !== 'full';
    if (!isPrivate) {
      onFloor.push({ id: r.id, name: r.name, address: r.address, home: false });
    } else if (viewer && r.ownerId === viewer.id) {
      // Your own collection — you already know where it is.
      onFloor.push({ id: r.id, name: r.name, address: r.address, home: true });
    } else {
      privateCount++;
    }
  }
  const formerly = former.map(r => ({
    id: r.id, name: r.name, address: r.address,
    removedAt: r.removedAt instanceof Date ? r.removedAt.toISOString() : new Date(r.removedAt).toISOString(),
  }));
  return { onFloor, privateCount, formerly, venueCount: onFloor.length + privateCount };
}

type Exec = (query: SQL) => Promise<unknown>;

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : ((result as { rows?: T[] })?.rows ?? [])) as T[];

/** machine id → venue count, for GET /api/machines. Ignores the Mine toggle; on the floor only. */
export async function machineVenueCounts(exec: Exec, viewer: Viewer | undefined): Promise<Map<number, number>> {
  const rows = rowsOf<{ machine_id: number; venue_count: number }>(await exec(machineVenueCountsSql(viewer)));
  return new Map(rows.map(r => [Number(r.machine_id), Number(r.venue_count)]));
}

/** GET /api/machines/:id/venues. */
export async function venuesForMachine(exec: Exec, machineId: number, viewer: Viewer | undefined): Promise<MachineVenuesView> {
  const floor = rowsOf<FloorVenueRow>(await exec(floorVenuesSql(machineId, viewer)));
  const former = rowsOf<FormerVenueRow>(await exec(formerVenuesSql(machineId, viewer)));
  return shapeMachineVenues(floor, former, viewer);
}
