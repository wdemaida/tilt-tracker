import { db, scores, machines, venueMachineHistory, venueInventory } from '@workspace/db';
import { and, eq, count, inArray } from 'drizzle-orm';
import { upsertMachineByName } from './machineUpsert.js';
import { getCatalogOrNull } from './pinballMap.js';
import type { PmLocationMachineXref } from './pinballmapApi.js';

export interface RepairableVenue {
  id: number;
  ownerId: number | null;
  createdById: number | null;
}

export interface RepairActor {
  id: number;
  role: string;
}

// A venue is repairable by an admin, by the user whose residence it is, or by whoever first added it
// to TiltTrack. That last case is the important one: a venue created by the photo-upload flow has no
// owner, and if only admins could relink it, every user whose venue failed to resolve would be stuck
// exactly where this feature exists to rescue them from.
export function canRepairVenue(venue: RepairableVenue, actor: RepairActor): boolean {
  if (actor.role === 'admin') return true;
  if (venue.ownerId != null && venue.ownerId === actor.id) return true;
  if (venue.createdById != null && venue.createdById === actor.id) return true;
  return false;
}

// Strips the things that differ between what the AI read off a backglass and what Pinball Map calls
// the same machine: case, punctuation, a leading article, and the edition suffix operators use
// ("(Pro)", "(Premium)", "(LE)"). Deliberately does NOT strip subtitles — "King Kong: Myth of Terror
// Island" and "King Kong" are different enough that collapsing them would be a guess, not a match.
export function normalizeMachineName(name: string): string {
  return name
    .toLowerCase()
    // Fold diacritics before the a-z0-9 filter below, or "Pokémon" becomes "pok mon" and stops
    // matching Pinball Map's "Pokemon" — accented titles are common enough to matter.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\((pro|premium|le|limited edition|classic|special edition|se)\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export type MatchConfidence = 'exact' | 'normalized' | 'fuzzy' | 'unmatched';

export interface ResyncProposal {
  machineId: number;
  machineName: string;
  scoreCount: number;
  confidence: MatchConfidence;
  /** The Pinball Map machine we believe this is. Null when unmatched. */
  pmName: string | null;
  pmManufacturer: string | null;
  pmYear: number | null;
  /** True when the score is already on a machine row whose name matches PM exactly — nothing to do. */
  alreadyCorrect: boolean;
}

function matchAgainstPm(
  machineName: string,
  pmXrefs: PmLocationMachineXref[],
): { confidence: MatchConfidence; pm: PmLocationMachineXref | null } {
  const exact = pmXrefs.find(x => x.machine.name.toLowerCase() === machineName.toLowerCase());
  if (exact) return { confidence: 'exact', pm: exact };

  const norm = normalizeMachineName(machineName);
  if (!norm) return { confidence: 'unmatched', pm: null };

  const normalized = pmXrefs.find(x => normalizeMachineName(x.machine.name) === norm);
  if (normalized) return { confidence: 'normalized', pm: normalized };

  // An operator's fuller title usually *starts* with what the backglass says ("Transformers" →
  // "Transformers: More Than Meets the Eye"). Require the shorter side to be a whole-word prefix of
  // the longer so "Rush" can't latch onto an unrelated title that merely contains those letters.
  const fuzzy = pmXrefs.filter(x => {
    const pmNorm = normalizeMachineName(x.machine.name);
    if (!pmNorm) return false;
    const [shorter, longer] = norm.length <= pmNorm.length ? [norm, pmNorm] : [pmNorm, norm];
    return longer === shorter || longer.startsWith(`${shorter} `);
  });
  // Ambiguity is not a match — "Transformers" against both "(Pro)" and "(LE)" needs a human.
  if (fuzzy.length === 1) return { confidence: 'fuzzy', pm: fuzzy[0] };

  return { confidence: 'unmatched', pm: null };
}

export interface RankedRosterEntry {
  pmName: string;
  pmManufacturer: string | null;
  pmYear: number | null;
  confidence: MatchConfidence;
}

// Every machine on a venue's Pinball Map roster, ranked by how well it matches one machine name,
// best first. The venue page's bulk preview only needs the single winner per machine; the edit-score
// modal needs the whole list so the user can override the recommendation with a different machine.
export function rankRosterForName(machineName: string, pmXrefs: PmLocationMachineXref[]): RankedRosterEntry[] {
  const best = matchAgainstPm(machineName, pmXrefs);
  const rank = (c: MatchConfidence) => (c === 'exact' ? 0 : c === 'normalized' ? 1 : c === 'fuzzy' ? 2 : 3);

  return pmXrefs
    .map(x => {
      const isBest = best.pm != null && best.pm.id === x.id && best.pm.machine.name === x.machine.name;
      return {
        pmName: x.machine.name,
        pmManufacturer: x.machine.manufacturer ?? null,
        pmYear: x.machine.year ?? null,
        confidence: isBest ? best.confidence : ('unmatched' as MatchConfidence),
      };
    })
    .sort((a, b) => rank(a.confidence) - rank(b.confidence) || a.pmName.localeCompare(b.pmName));
}

// Deletes a machine row once nothing references it. Shared by the bulk re-sync and the single-score
// repair so a merge never strands an orphan row, and never deletes one another user still points at.
export async function retireMachineIfUnused(machineId: number): Promise<boolean> {
  const [{ remaining }] = await db
    .select({ remaining: count() })
    .from(scores)
    .where(eq(scores.machineId, machineId));
  const [{ histRefs }] = await db
    .select({ histRefs: count() })
    .from(venueMachineHistory)
    .where(eq(venueMachineHistory.machineId, machineId));

  // A home venue's inventory references machines too, current or former.
  const [{ invRefs }] = await db
    .select({ invRefs: count() })
    .from(venueInventory)
    .where(eq(venueInventory.machineId, machineId));

  if (Number(remaining) === 0 && Number(histRefs) === 0 && Number(invRefs) === 0) {
    await db.delete(machines).where(eq(machines.id, machineId));
    return true;
  }
  return false;
}

// Builds the proposed remapping without writing anything. `scopeUserId` limits both the scores
// counted and the scores later repointed — a non-admin only ever sees and moves their own.
export async function buildResyncPreview(
  venueId: number,
  pmXrefs: PmLocationMachineXref[],
  scopeUserId: number | null,
): Promise<ResyncProposal[]> {
  const rows = await db
    .select({
      machineId: machines.id,
      machineName: machines.name,
      scoreCount: count(scores.id),
    })
    .from(scores)
    .innerJoin(machines, eq(scores.machineId, machines.id))
    .where(scopeUserId != null
      ? and(eq(scores.venueId, venueId), eq(scores.userId, scopeUserId))
      : eq(scores.venueId, venueId))
    .groupBy(machines.id, machines.name);

  return rows
    .map(row => {
      const { confidence, pm } = matchAgainstPm(row.machineName, pmXrefs);
      return {
        machineId: row.machineId,
        machineName: row.machineName,
        scoreCount: Number(row.scoreCount),
        confidence,
        pmName: pm?.machine.name ?? null,
        pmManufacturer: pm?.machine.manufacturer ?? null,
        pmYear: pm?.machine.year ?? null,
        alreadyCorrect: confidence === 'exact',
      };
    })
    .sort((a, b) => {
      // Things needing a decision float to the top; settled rows sink.
      const rank = (p: ResyncProposal) => (p.alreadyCorrect ? 2 : p.confidence === 'unmatched' ? 1 : 0);
      return rank(a) - rank(b) || b.scoreCount - a.scoreCount;
    });
}

export interface AppliedMerge {
  fromMachineId: number;
  fromName: string;
  toMachineId: number;
  toName: string;
  scoresMoved: number;
  sourceDeleted: boolean;
}

// Repoints scores from a duplicate machine row onto the canonical Pinball Map one. Only the merges
// explicitly listed are performed — the caller approves each one in the UI first, because a machine
// row is global and merging it changes every venue's data, not just this venue's.
export async function applyResync(
  venueId: number,
  merges: Array<{ fromMachineId: number; pmName: string; pmManufacturer?: string; pmYear?: number }>,
  scopeUserId: number | null,
): Promise<AppliedMerge[]> {
  const applied: AppliedMerge[] = [];
  // Fetched once for the whole loop — never per merge (no per-record fan-out).
  const catalog = merges.length ? await getCatalogOrNull() : null;

  for (const merge of merges) {
    const [from] = await db.select().from(machines).where(eq(machines.id, merge.fromMachineId)).limit(1);
    if (!from) continue;

    const target = await upsertMachineByName(merge.pmName, {
      manufacturer: merge.pmManufacturer,
      year: merge.pmYear,
      catalog,
    });
    if (target.id === from.id) continue; // already canonical

    const moved = await db
      .update(scores)
      .set({ machineId: target.id })
      .where(scopeUserId != null
        ? and(eq(scores.venueId, venueId), eq(scores.machineId, from.id), eq(scores.userId, scopeUserId))
        : and(eq(scores.venueId, venueId), eq(scores.machineId, from.id)))
      .returning({ id: scores.id });

    // Retire the duplicate only once nothing references it anywhere — a partial (single-user) merge
    // deliberately leaves the row in place for the other users still pointing at it.
    const sourceDeleted = await retireMachineIfUnused(from.id);

    applied.push({
      fromMachineId: from.id,
      fromName: from.name,
      toMachineId: target.id,
      toName: target.name,
      scoresMoved: moved.length,
      sourceDeleted,
    });
  }

  return applied;
}

// Re-enriches machine rows that were created while the Pinball Map API was unreachable — those went
// in with the AI-extracted name and null manufacturer/year/opdb_id. Safe to run over any machine
// list; upsertMachineByName only fills fields that are still null.
export async function reenrichMachines(machineIds: number[]): Promise<number> {
  if (machineIds.length === 0) return 0;
  const rows = await db
    .select({ id: machines.id, name: machines.name })
    .from(machines)
    .where(inArray(machines.id, machineIds));

  // Once for the whole loop, not per machine.
  const catalog = await getCatalogOrNull();
  let enriched = 0;
  for (const row of rows) {
    const before = await db.select().from(machines).where(eq(machines.id, row.id)).limit(1);
    await upsertMachineByName(row.name, { catalog });
    const after = await db.select().from(machines).where(eq(machines.id, row.id)).limit(1);
    if (before[0]?.manufacturer !== after[0]?.manufacturer || before[0]?.year !== after[0]?.year) enriched++;
  }
  return enriched;
}
