// Fills venues.timezone for rows that predate the column.
//
// Every venue-creation path now records the zone HERE already hands back, but the 36 venues that
// existed before that need one lookup each. Keys off latitude/longitude rather than the address:
// 34 of them came from the seed script with no city/state, and two venues can share an address
// string anyway, whereas coordinates always resolve.
//
//   npx tsx backfill-venue-timezones.ts            # dry run
//   npx tsx backfill-venue-timezones.ts --apply
//
// Re-runnable: only touches rows where timezone is null, unless --force is passed.

import 'dotenv/config';
import { db, venues } from '@workspace/db';
import { eq, isNull } from 'drizzle-orm';
import { resolveTimezone } from './src/lib/hereApi.js';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

const rows = await db
  .select({
    id: venues.id,
    name: venues.name,
    latitude: venues.latitude,
    longitude: venues.longitude,
    timezone: venues.timezone,
  })
  .from(venues)
  .where(FORCE ? undefined : isNull(venues.timezone));

console.log(`${rows.length} venue(s) to look up${FORCE ? ' (--force: including ones already set)' : ''}\n`);

let resolved = 0;
let skipped = 0;
const results: Array<{ id: number; name: string; tz: string | null }> = [];

for (const v of rows) {
  if (v.latitude == null || v.longitude == null) {
    console.log(`  #${String(v.id).padEnd(3)} ${v.name.slice(0, 30).padEnd(30)} — no coordinates, skipped`);
    skipped++;
    continue;
  }

  const tz = await resolveTimezone(v.latitude, v.longitude);
  results.push({ id: v.id, name: v.name, tz });

  if (tz) {
    resolved++;
    const change = v.timezone && v.timezone !== tz ? `  (was ${v.timezone})` : '';
    console.log(`  #${String(v.id).padEnd(3)} ${v.name.slice(0, 30).padEnd(30)} -> ${tz}${change}`);
    if (APPLY) await db.update(venues).set({ timezone: tz }).where(eq(venues.id, v.id));
  } else {
    skipped++;
    console.log(`  #${String(v.id).padEnd(3)} ${v.name.slice(0, 30).padEnd(30)} — HERE returned no zone, skipped`);
  }
}

const byZone = results.reduce<Record<string, number>>((acc, r) => {
  if (r.tz) acc[r.tz] = (acc[r.tz] ?? 0) + 1;
  return acc;
}, {});
console.log('\nzones:', Object.entries(byZone).map(([z, n]) => `${z} x${n}`).join(', ') || 'none');
console.log(`resolved ${resolved}, skipped ${skipped}`);
console.log(APPLY ? '\nWritten.' : '\nDry run — nothing written. Re-run with --apply.');

process.exit(0);
