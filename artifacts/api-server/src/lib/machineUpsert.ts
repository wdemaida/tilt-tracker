import { db, machines } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { getAllMachines } from './pinballMap.js';

interface UpsertMachineOptions {
  opdbId?: string;
  ipdbId?: string;
  variant?: string;
  manufacturer?: string;
  year?: number;
}

export async function upsertMachineByName(name: string, opts: UpsertMachineOptions = {}) {
  const { opdbId, ipdbId, variant, manufacturer, year } = opts;

  // Enrich from Pinball Map cache; caller-provided manufacturer/year are fallbacks when PM lookup misses
  const pmAll = await getAllMachines().catch(() => []);
  const pm = pmAll.find(m => m.name.toLowerCase() === name.toLowerCase());

  const [row] = await db
    .insert(machines)
    .values({
      name,
      opdbId: opdbId ?? pm?.opdb_id ?? null,
      ipdbId: ipdbId ?? null,
      variant: variant ?? null,
      manufacturer: pm?.manufacturer ?? manufacturer ?? null,
      year: pm?.year ?? year ?? null,
      imageUrl: pm?.opdb_img ?? null,
    })
    .onConflictDoUpdate({
      target: machines.name,
      set: {
        name: sql`excluded.name`,
        ...(opdbId !== undefined && { opdbId }),
        ...(ipdbId !== undefined && { ipdbId }),
        ...(variant !== undefined && { variant }),
        manufacturer: sql`COALESCE(machines.manufacturer, excluded.manufacturer)`,
        year: sql`COALESCE(machines.year, excluded.year)`,
        imageUrl: sql`COALESCE(machines.image_url, excluded.image_url)`,
      },
    })
    .returning();
  return row;
}
