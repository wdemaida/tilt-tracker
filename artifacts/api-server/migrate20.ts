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

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE pm_location_cache ADD COLUMN IF NOT EXISTS location jsonb`;

console.log('migrate20: pm_location_cache.location ready');
await sql.end();
