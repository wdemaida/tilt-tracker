import { db, venueMachineHistory, machines } from '@workspace/db';
import { and, eq, isNull, isNotNull, notInArray, desc } from 'drizzle-orm';
import { upsertMachineByName } from './machineUpsert.js';
import type { PmLocationMachineXref } from './pinballmapApi.js';

// Diffs the live Pinball Map machine list against our last-known snapshot for a venue,
// recording arrivals/departures. Called opportunistically whenever a venue's machine list
// is fetched — there's no polling; a venue's history only advances when someone looks at it.
export async function syncVenueMachineHistory(venueId: number, pmXrefs: PmLocationMachineXref[]) {
  const currentIds: number[] = [];
  for (const xref of pmXrefs) {
    const row = await upsertMachineByName(xref.machine.name, {
      manufacturer: xref.machine.manufacturer,
      year: xref.machine.year,
    });
    currentIds.push(row.id);
  }

  const existing = await db
    .select()
    .from(venueMachineHistory)
    .where(eq(venueMachineHistory.venueId, venueId));
  const existingByMachineId = new Map(existing.map(r => [r.machineId, r]));

  for (const machineId of currentIds) {
    const row = existingByMachineId.get(machineId);
    if (!row) {
      await db.insert(venueMachineHistory).values({ venueId, machineId });
    } else if (row.removedAt !== null) {
      await db.update(venueMachineHistory)
        .set({ lastSeenAt: new Date(), removedAt: null })
        .where(eq(venueMachineHistory.id, row.id));
    } else {
      await db.update(venueMachineHistory)
        .set({ lastSeenAt: new Date() })
        .where(eq(venueMachineHistory.id, row.id));
    }
  }

  // Guard on a non-empty list: getPmMachinesAtLocation returns [] on a fetch failure,
  // and we don't want a transient PM API blip to mass-mark every machine as removed.
  if (currentIds.length > 0) {
    await db.update(venueMachineHistory)
      .set({ removedAt: new Date() })
      .where(and(
        eq(venueMachineHistory.venueId, venueId),
        isNull(venueMachineHistory.removedAt),
        notInArray(venueMachineHistory.machineId, currentIds),
      ));
  }
}

export async function getFormerMachines(venueId: number) {
  return db
    .select({
      id: machines.id,
      name: machines.name,
      manufacturer: machines.manufacturer,
      year: machines.year,
      firstSeenAt: venueMachineHistory.firstSeenAt,
      removedAt: venueMachineHistory.removedAt,
    })
    .from(venueMachineHistory)
    .innerJoin(machines, eq(venueMachineHistory.machineId, machines.id))
    .where(and(
      eq(venueMachineHistory.venueId, venueId),
      isNotNull(venueMachineHistory.removedAt),
    ))
    .orderBy(desc(venueMachineHistory.removedAt));
}
