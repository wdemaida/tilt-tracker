import { db, machines } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { getCatalogOrNull, catalogIndex, type PinballMachine } from './pinballMap.js';

interface UpsertMachineOptions {
  opdbId?: string;
  ipdbId?: string;
  variant?: string;
  manufacturer?: string;
  year?: number;
  /**
   * The Pinball Map catalog, already fetched by the caller. Loops MUST pass it (fetch once, pass
   * down) — `null` means "the caller tried and it's unavailable", so no lookup is attempted.
   */
  catalog?: PinballMachine[] | null;
}

export async function upsertMachineByName(name: string, opts: UpsertMachineOptions = {}) {
  const { opdbId, ipdbId, variant, manufacturer, year } = opts;

  // Enrich from the Pinball Map catalog (DB-cached, see pinballMap.ts); caller-provided
  // manufacturer/year are fallbacks when the lookup misses.
  const catalog = opts.catalog !== undefined ? opts.catalog : await getCatalogOrNull();
  const pm = catalog ? catalogIndex(catalog).get(name.toLowerCase()) : undefined;

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
