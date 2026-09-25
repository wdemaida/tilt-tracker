import { db, machines, scores } from '@workspace/db';
import { eq, sql } from 'drizzle-orm';
import { normalizeMachineName } from './venueRepair.js';

export interface MachineScoreStats {
  machineId: number | null;
  machineName: string | null;
  /** Number of recorded scores on the machine. 0 when the machine is unknown or unplayed. */
  count: number;
  median: number | null;
}

const EMPTY: MachineScoreStats = { machineId: null, machineName: null, count: 0, median: null };

/**
 * Resolves a machine the same way scores are attached to one — machine rows are unique by name and
 * every score points at a row by id (see machineUpsert.ts). Tries the id, then a case-insensitive
 * exact name, then `normalizeMachineName` (only when exactly one row matches — ambiguity is not a
 * match, same rule as venue repair).
 */
async function resolveMachine(opts: { machineId?: number; name?: string }): Promise<{ id: number; name: string } | null> {
  if (opts.machineId != null && Number.isInteger(opts.machineId)) {
    const [m] = await db.select({ id: machines.id, name: machines.name }).from(machines).where(eq(machines.id, opts.machineId)).limit(1);
    if (m) return m;
  }
  const name = opts.name?.trim();
  if (!name) return null;

  const [exact] = await db
    .select({ id: machines.id, name: machines.name })
    .from(machines)
    .where(sql`lower(${machines.name}) = lower(${name})`)
    .limit(1);
  if (exact) return exact;

  const target = normalizeMachineName(name);
  if (!target) return null;
  const all = await db.select({ id: machines.id, name: machines.name }).from(machines);
  const hits = all.filter(m => normalizeMachineName(m.name) === target);
  return hits.length === 1 ? hits[0] : null;
}

/** Read-only: count and median of the scores recorded on a machine. */
export async function getMachineScoreStats(opts: { machineId?: number; name?: string }): Promise<MachineScoreStats> {
  const machine = await resolveMachine(opts);
  if (!machine) return EMPTY;

  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      median: sql<number | null>`percentile_cont(0.5) within group (order by ${scores.score})`,
    })
    .from(scores)
    .where(eq(scores.machineId, machine.id));

  return {
    machineId: machine.id,
    machineName: machine.name,
    count: Number(row?.count ?? 0),
    median: row?.median != null ? Math.round(Number(row.median)) : null,
  };
}
