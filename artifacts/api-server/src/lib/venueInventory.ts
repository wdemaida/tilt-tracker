import { db, venueInventory, machines, venues } from '@workspace/db';
import { and, eq, isNull, asc, sql } from 'drizzle-orm';
import { getAllMachines } from './pinballMap.js';
import { upsertMachineByName } from './machineUpsert.js';

// Owner-managed inventory for private venues (see venueActivity.ts for who sees and edits it).

export interface InventoryView {
  /** True once the owner has ever added a machine — from then on the inventory *is* the count. */
  managed: boolean;
  machines: Array<{ id: number; name: string; manufacturer: string | null; year: number | null; addedAt: Date }>;
  former: Array<{ id: number; name: string; manufacturer: string | null; year: number | null; addedAt: Date; removedAt: Date }>;
}

export async function getInventory(venueId: number): Promise<InventoryView> {
  const rows = await db
    .select({
      id: machines.id,
      name: machines.name,
      manufacturer: machines.manufacturer,
      year: machines.year,
      addedAt: venueInventory.addedAt,
      removedAt: venueInventory.removedAt,
    })
    .from(venueInventory)
    .innerJoin(machines, eq(venueInventory.machineId, machines.id))
    .where(eq(venueInventory.venueId, venueId))
    .orderBy(asc(machines.name));

  return {
    managed: rows.length > 0,
    machines: rows.filter(r => r.removedAt == null).map(({ removedAt: _r, ...m }) => m),
    former: rows
      .filter((r): r is typeof r & { removedAt: Date } => r.removedAt != null)
      .sort((a, b) => b.removedAt.getTime() - a.removedAt.getTime()),
  };
}

/** Pinball Map's machine catalog couldn't be read, so a picked name can't be checked against it. */
export class CatalogUnavailableError extends Error {
  constructor() { super('Machine catalog is unavailable right now — try again'); }
}

/**
 * Resolves a picked machine to a machines row. Only machines that already exist — in our table or
 * in Pinball Map's catalog (the same list the score wizard's typeahead searches) — are accepted, so
 * the inventory can't be used to mint junk machine rows that then show up site-wide.
 */
export async function resolveCatalogMachine(input: { machineId?: unknown; name?: unknown }) {
  if (input.machineId != null) {
    const id = Number(input.machineId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const [row] = await db.select().from(machines).where(eq(machines.id, id)).limit(1);
    return row ?? null;
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 200) return null;

  // No silent catch → [] (see CLAUDE.md): a Pinball Map outage must not read as "that machine
  // isn't in the catalog". The route turns this into a 503.
  let catalog: Awaited<ReturnType<typeof getAllMachines>>;
  try {
    catalog = await getAllMachines();
  } catch (err) {
    console.error('Machine catalog unavailable:', err);
    throw new CatalogUnavailableError();
  }
  const pm = catalog.find(m => m.name.toLowerCase() === name.toLowerCase());
  if (pm) {
    return upsertMachineByName(pm.name, { manufacturer: pm.manufacturer ?? undefined, year: pm.year ?? undefined });
  }
  const [existing] = await db.select().from(machines).where(sql`lower(${machines.name}) = ${name.toLowerCase()}`).limit(1);
  return existing ?? null;
}

/** Adds (or re-adds) a machine. Returns false when it was already there. */
export async function addToInventory(venueId: number, machineId: number, userId: number): Promise<boolean> {
  const [current] = await db.select({ id: venueInventory.id }).from(venueInventory)
    .where(and(eq(venueInventory.venueId, venueId), eq(venueInventory.machineId, machineId), isNull(venueInventory.removedAt)))
    .limit(1);
  if (current) return false;

  // A machine that left and came back starts a new stint: the earlier one isn't kept (one row per
  // venue+machine, like venue_machine_history).
  await db.insert(venueInventory)
    .values({ venueId, machineId, addedById: userId })
    .onConflictDoUpdate({
      target: [venueInventory.venueId, venueInventory.machineId],
      set: { addedAt: sql`now()`, addedById: userId, removedAt: null, removedById: null },
    });
  return true;
}

/** Marks a machine as gone. Returns false when it wasn't in the current inventory. */
export async function removeFromInventory(venueId: number, machineId: number, userId: number): Promise<boolean> {
  const updated = await db.update(venueInventory)
    .set({ removedAt: sql`now()`, removedById: userId })
    .where(and(eq(venueInventory.venueId, venueId), eq(venueInventory.machineId, machineId), isNull(venueInventory.removedAt)))
    .returning({ id: venueInventory.id });
  return updated.length > 0;
}

/** Whether any inventory row (current or former) points at this machine — blocks deleting it. */
export async function machineInInventory(machineId: number): Promise<boolean> {
  const [row] = await db.select({ id: venueInventory.id }).from(venueInventory)
    .where(eq(venueInventory.machineId, machineId)).limit(1);
  return !!row;
}

/** Removes a venue's inventory rows outright — only for deleting the venue itself. */
export async function deleteVenueInventory(venueId: number): Promise<void> {
  await db.delete(venueInventory).where(eq(venueInventory.venueId, venueId));
}

// Correlated subqueries for the venues list (any query whose FROM includes `venues`).
export const inventoryCountSql = sql<number>`(SELECT count(*)::int FROM venue_inventory vi WHERE vi.venue_id = ${venues.id} AND vi.removed_at IS NULL)`;
export const inventoryManagedSql = sql<boolean>`EXISTS (SELECT 1 FROM venue_inventory vi WHERE vi.venue_id = ${venues.id})`;
