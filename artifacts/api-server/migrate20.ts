// Pinball Map location metadata alongside the cached roster (fix/pm-link-dedup).
//
//  pm_location_cache.location  jsonb  — the location fields (id, name, lat, lon, street, city,
//                                       state, zip, country) from the same /locations/:id.json
//                                       response the roster is read from. Lets the venue repair flow
//                                       and pm-link get a listing's name/address without a separate
//                                       `?metadata_only=1` request. Null = a row cached before this
//                                       column existed; the next roster refresh fills it.
//
// Purely additive (ADD COLUMN IF NOT EXISTS) and idempotent — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate20.ts

import 'dotenv/config';
import postgres from 'postgres';

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on fix/pm-link-dedup. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate20.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE pm_location_cache ADD COLUMN IF NOT EXISTS location jsonb`;

console.log('migrate20: pm_location_cache.location ready');
await sql.end();
