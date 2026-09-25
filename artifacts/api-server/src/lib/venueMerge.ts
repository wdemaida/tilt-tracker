import { db, venues, scores, users, venueMachineHistory, venueInventory, type Venue } from '@workspace/db';
import { eq, count, inArray, sql } from 'drizzle-orm';
import type { RepairActor } from './venueRepair.js';
import { isPrivateTier } from './venuePrivacy.js';

// Merging a duplicate venue into the one that already existed. The typical case: a score was logged
// against a venue name typed by hand ("Deep Cuts -- Pop's II"), and when its creator later resolves
// it in the repair panel, HERE / Pinball Map say the place already belongs to another TiltTrack venue
// ("Pop's Pinball - Deep Cuts"). The only right fix is to fold the duplicate into that venue.
//
// Everything that references venues.id (verified against the live FK catalogue, 2026-09-25):
//   scores.venue_id (+ the denormalized scores.venue_name snapshot) — repointed, snapshot renamed.
//   venue_machine_history.venue_id — unique per (venue, machine): merged per machine, see below.
//   venue_inventory.venue_id       — unique per (venue, machine): merged per machine, see below.
// venues.owner_id / created_by_id live on the venue row itself and go with the deleted source; the
// target keeps its own. pm_location_cache is keyed by Pinball Map id, not venue id.

type Tier = 'full' | 'city_state' | 'hidden';

export interface MergeVenueFields {
  id: number;
  ownerId: number | null;
  isResidence: boolean;
  privacyTier: Tier;
}

export type MergeBlocker =
  | 'same_venue'
  | 'target_not_visible'
  | 'public_into_private'
  | 'private_into_public'
  | 'private_owner_mismatch'
  | 'others_scores';

export const MERGE_BLOCKER_MESSAGES: Record<MergeBlocker, string> = {
  same_venue: 'A venue can’t be merged into itself',
  target_not_visible: 'You can’t merge into that venue',
  public_into_private:
    'A public venue can’t be merged into a private (home) venue — it would hide everyone’s scores there behind a residence',
  private_into_public:
    'A private (home) venue can’t be merged into a public one — that would publish where its scores were played. Its owner can make it public from Edit Venue first',
  private_owner_mismatch:
    'Two private venues can only be merged by their owner (or an admin), and only when both belong to the same person',
  others_scores:
    'Other players have scores at this venue — ask an admin to merge it, so nobody’s scores get moved without a second pair of eyes',
};

const isAdmin = (a: RepairActor) => a.role === 'admin';
const owns = (v: { ownerId: number | null }, a: RepairActor) => v.ownerId != null && v.ownerId === a.id;

/**
 * Why this merge may not happen, or null when it may. The caller has already checked that the actor
 * may repair the SOURCE (canRepairVenue) — this covers the target and the privacy rules:
 *
 *  - The target must be one the actor can see in full: any public venue, or a private one they own
 *    (admins: any).
 *  - public → public: allowed.
 *  - public → private: refused. Everyone's scores at a bar would vanish behind someone's home (and
 *    its "show publicly" switch), and a public listing would be tied to a residence.
 *  - private → public: refused. Scores logged "at a home" would reappear at a public place, and ones
 *    hidden by the owner's switch would become visible. Making a venue public is the owner's
 *    disclosure decision, taken in Edit Venue — after that, it's an ordinary public merge.
 *  - private → private: only when both have the same owner, and the actor is that owner or an admin.
 *    Never one person's home into another's.
 *  - A non-admin may only move their own scores: if anyone else has a score at the source, an admin
 *    has to do it. (Venue creators are ordinary users — without this, anyone who typed a venue in
 *    could relocate other players' scores to any public venue.)
 */
export function mergeBlocker(
  source: MergeVenueFields,
  target: MergeVenueFields,
  actor: RepairActor,
  othersScoreCount: number,
): MergeBlocker | null {
  if (source.id === target.id) return 'same_venue';
  const srcPrivate = isPrivateTier(source);
  const tgtPrivate = isPrivateTier(target);
  if (tgtPrivate && !isAdmin(actor) && !owns(target, actor)) return 'target_not_visible';
  if (!srcPrivate && tgtPrivate) return 'public_into_private';
  if (srcPrivate && !tgtPrivate) return 'private_into_public';
  if (srcPrivate && tgtPrivate) {
    if (source.ownerId !== target.ownerId) return 'private_owner_mismatch';
    if (!isAdmin(actor) && !owns(source, actor)) return 'private_owner_mismatch';
  }
  if (!isAdmin(actor) && othersScoreCount > 0) return 'others_scores';
  return null;
}

type AdoptableVenue = Pick<Venue,
  'hereId' | 'pinballMapId' | 'pmMachineCount' | 'address' | 'latitude' | 'longitude' | 'city' | 'state'
  | 'cityLat' | 'cityLng' | 'timezone' | 'isResidence' | 'privacyTier'>;

/**
 * What the target fills in from the source because it had nothing there. Only gaps are filled —
 * nothing the target already has is overwritten — and never onto a private target (a private venue
 * carries no HERE / Pinball Map linkage). The source's HERE id would otherwise be lost with it, and
 * it's the thing that stops the *next* upload from creating the duplicate all over again.
 */
export function adoptedFromSource(source: AdoptableVenue, target: AdoptableVenue): Partial<AdoptableVenue> {
  if (isPrivateTier(target) || isPrivateTier(source)) return {};
  const out: Partial<AdoptableVenue> = {};
  if (!target.hereId && source.hereId) out.hereId = source.hereId;
  if (target.pinballMapId == null && source.pinballMapId != null) {
    out.pinballMapId = source.pinballMapId;
    out.pmMachineCount = source.pmMachineCount;
  }
  // Location travels as a unit — an address from one venue with coordinates from the other is worse
  // than either.
  if (!target.address?.trim() && source.address?.trim() && source.latitude != null && source.longitude != null) {
    Object.assign(out, {
      address: source.address, latitude: source.latitude, longitude: source.longitude,
      city: source.city, state: source.state, cityLat: source.cityLat, cityLng: source.cityLng,
    });
    if (source.timezone) out.timezone = source.timezone;
  } else if (!target.timezone && source.timezone) {
    out.timezone = source.timezone;
  }
  return out;
}

/** Labels for the preview ("will also take its HERE link"). */
export function adoptionLabels(adopt: Partial<AdoptableVenue>): string[] {
  const labels: string[] = [];
  if (adopt.hereId) labels.push('HERE link');
  if (adopt.pinballMapId != null) labels.push('Pinball Map link');
  if (adopt.address) labels.push('address');
  else if (adopt.timezone) labels.push('time zone');
  return labels;
}

export interface MergeCounts {
  scoreCount: number;
  myScoreCount: number;
  players: Array<{ userId: number; username: string; scoreCount: number }>;
  historyRows: number;
  historyOverlap: number;
  inventoryRows: number;
  inventoryOverlap: number;
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function countsFor(ex: Executor, sourceId: number, targetId: number, actorId: number): Promise<MergeCounts> {
  const players = (await ex
    .select({ userId: scores.userId, username: users.username, scoreCount: count() })
    .from(scores)
    .innerJoin(users, eq(scores.userId, users.id))
    .where(eq(scores.venueId, sourceId))
    .groupBy(scores.userId, users.username))
    .map(p => ({ ...p, scoreCount: Number(p.scoreCount) }))
    .sort((a, b) => b.scoreCount - a.scoreCount || a.username.localeCompare(b.username));

  const overlap = async (table: typeof venueMachineHistory | typeof venueInventory) => {
    const rows = await ex.select({ machineId: table.machineId, venueId: table.venueId })
      .from(table).where(inArray(table.venueId, [sourceId, targetId]));
    const src = rows.filter(r => r.venueId === sourceId).map(r => r.machineId);
    const tgt = new Set(rows.filter(r => r.venueId === targetId).map(r => r.machineId));
    return { rows: src.length, overlap: src.filter(m => tgt.has(m)).length };
  };
  const hist = await overlap(venueMachineHistory);
  const inv = await overlap(venueInventory);

  return {
    scoreCount: players.reduce((n, p) => n + p.scoreCount, 0),
    myScoreCount: players.find(p => p.userId === actorId)?.scoreCount ?? 0,
    players,
    historyRows: hist.rows,
    historyOverlap: hist.overlap,
    inventoryRows: inv.rows,
    inventoryOverlap: inv.overlap,
  };
}

export async function buildMergePreview(source: Venue, target: Venue, actor: RepairActor) {
  const counts = await countsFor(db, source.id, target.id, actor.id);
  const blocker = mergeBlocker(source, target, actor, counts.scoreCount - counts.myScoreCount);
  return { counts, blocker, adopts: adoptionLabels(adoptedFromSource(source, target)) };
}

export class MergeRefusedError extends Error {
  constructor(readonly blocker: MergeBlocker) { super(MERGE_BLOCKER_MESSAGES[blocker]); }
}
/** The source changed between preview and confirm (a score was logged or moved meanwhile). */
export class MergeStaleError extends Error {
  constructor(readonly scoreCount: number) { super('Scores at this venue changed since the preview — check it again'); }
}
export class MergeVenueGoneError extends Error {
  constructor() { super('One of these venues no longer exists — reload the page'); }
}

export interface MergeResult {
  sourceId: number;
  targetId: number;
  targetName: string;
  scoresMoved: number;
  historyMoved: number;
  historyMerged: number;
  inventoryMoved: number;
  inventoryMerged: number;
  adopted: string[];
}

/**
 * Folds `sourceId` into `targetId` in one transaction and deletes the source. Both rows are locked
 * (in id order, so two opposite merges can't deadlock) and every rule is re-checked against the
 * locked rows, so a preview can't be replayed after the situation changed. `expectedScoreCount`,
 * when given, must still match — the user confirmed moving *that many* scores.
 *
 * Per-machine history (venue_machine_history, Pinball Map-derived):
 *  - machine known at both: one row, first seen = earliest, last seen = latest; the target's
 *    `removedAt` stands, because the target's listing is the one that stays authoritative.
 *  - known only at the source: moved across. If the target has a *different* Pinball Map listing,
 *    a row the source still called current is closed at its last sighting — the target's roster
 *    never listed it, so it isn't "there now" (the next roster sync would say the same).
 * Inventory (venue_inventory, owner-kept, private venues): machine at both → one row carrying the
 * stint that's current (or, if both ended, the later one; if both current, the earlier start);
 * otherwise moved across.
 */
export async function applyVenueMerge(
  sourceId: number,
  targetId: number,
  actor: RepairActor,
  expectedScoreCount?: number,
): Promise<MergeResult> {
  return db.transaction(async tx => {
    const locked = await tx.select().from(venues)
      .where(inArray(venues.id, [sourceId, targetId]))
      .orderBy(venues.id)
      .for('update');
    const source = locked.find(v => v.id === sourceId);
    const target = locked.find(v => v.id === targetId);
    if (!source || !target) throw new MergeVenueGoneError();

    const counts = await countsFor(tx, source.id, target.id, actor.id);
    const blocker = mergeBlocker(source, target, actor, counts.scoreCount - counts.myScoreCount);
    if (blocker) throw new MergeRefusedError(blocker);
    if (expectedScoreCount != null && expectedScoreCount !== counts.scoreCount) {
      throw new MergeStaleError(counts.scoreCount);
    }

    const adopt = adoptedFromSource(source, target);

    // 1. Scores. venue_name is the snapshot score lists render directly — keep it in step, as
    //    PATCH /api/scores/:id does when a score changes venue.
    const moved = await tx.update(scores)
      .set({ venueId: target.id, venueName: target.name })
      .where(eq(scores.venueId, source.id))
      .returning({ id: scores.id });

    // 2. Machine history.
    const targetPmId = target.pinballMapId ?? adopt.pinballMapId ?? null;
    const closeCurrent = targetPmId != null && targetPmId !== source.pinballMapId;
    const histMerged = await tx.execute(sql`
      UPDATE venue_machine_history t
         SET first_seen_at = LEAST(t.first_seen_at, s.first_seen_at),
             last_seen_at = GREATEST(t.last_seen_at, s.last_seen_at)
        FROM venue_machine_history s
       WHERE t.venue_id = ${target.id} AND s.venue_id = ${source.id} AND s.machine_id = t.machine_id
      RETURNING t.id`);
    await tx.execute(sql`
      DELETE FROM venue_machine_history s
       WHERE s.venue_id = ${source.id}
         AND EXISTS (SELECT 1 FROM venue_machine_history t WHERE t.venue_id = ${target.id} AND t.machine_id = s.machine_id)`);
    const histMoved = await tx.update(venueMachineHistory)
      .set({
        venueId: target.id,
        ...(closeCurrent
          ? { removedAt: sql`COALESCE(${venueMachineHistory.removedAt}, ${venueMachineHistory.lastSeenAt})` }
          : {}),
      })
      .where(eq(venueMachineHistory.venueId, source.id))
      .returning({ id: venueMachineHistory.id });

    // 3. Inventory. `pick` = take the source row's stint instead of the target's.
    const invMerged = await tx.execute(sql`
      WITH pairs AS (
        SELECT t.id AS tid, s.added_at, s.added_by_id, s.removed_at, s.removed_by_id,
               CASE
                 WHEN t.removed_at IS NULL AND s.removed_at IS NULL THEN s.added_at < t.added_at
                 WHEN t.removed_at IS NULL THEN false
                 WHEN s.removed_at IS NULL THEN true
                 ELSE s.removed_at > t.removed_at
               END AS pick
          FROM venue_inventory t
          JOIN venue_inventory s ON s.machine_id = t.machine_id AND s.venue_id = ${source.id}
         WHERE t.venue_id = ${target.id}
      )
      UPDATE venue_inventory t
         SET added_at = CASE WHEN p.pick THEN p.added_at ELSE t.added_at END,
             added_by_id = CASE WHEN p.pick THEN p.added_by_id ELSE t.added_by_id END,
             removed_at = CASE WHEN p.pick THEN p.removed_at ELSE t.removed_at END,
             removed_by_id = CASE WHEN p.pick THEN p.removed_by_id ELSE t.removed_by_id END
        FROM pairs p
       WHERE t.id = p.tid
      RETURNING t.id`);
    await tx.execute(sql`
      DELETE FROM venue_inventory s
       WHERE s.venue_id = ${source.id}
         AND EXISTS (SELECT 1 FROM venue_inventory t WHERE t.venue_id = ${target.id} AND t.machine_id = s.machine_id)`);
    const invMoved = await tx.update(venueInventory)
      .set({ venueId: target.id })
      .where(eq(venueInventory.venueId, source.id))
      .returning({ id: venueInventory.id });

    // 4. The source goes; then the target takes what it lacked. Deleting first frees the source's
    //    HERE id, which is unique across venues.
    await tx.delete(venues).where(eq(venues.id, source.id));
    if (Object.keys(adopt).length) {
      await tx.update(venues).set(adopt).where(eq(venues.id, target.id));
    }

    return {
      sourceId: source.id,
      targetId: target.id,
      targetName: target.name,
      scoresMoved: moved.length,
      historyMoved: histMoved.length,
      historyMerged: (histMerged as unknown as unknown[]).length,
      inventoryMoved: invMoved.length,
      inventoryMerged: (invMerged as unknown as unknown[]).length,
      adopted: adoptionLabels(adopt),
    };
  });
}
