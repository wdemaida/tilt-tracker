// Full-size score photos on Cloudflare R2 (feature/photos).
//
//  scores.photo_key    text     — R2 object key, `scores/{scoreId}/{uuid}.jpg`. Null = no full-size
//                                 photo (the data-URL thumbnail in photo_thumbnail is unaffected).
//  scores.photo_bytes  integer  — object size, from HeadObject at confirm time.
//  scores.photo_width  integer  — pixel size reported by the uploading browser (layout hint only).
//  scores.photo_height integer
//
// A separate column rather than reusing photo_url: photo_url is never written by the real client,
// but seed scripts put a marker (`seed:challengesForWill`) in it on dev, and challenge rules treat
// `photo_url OR photo_thumbnail` as "has a photo". Keys must never be confused with either.
//
// Purely additive (ADD COLUMN IF NOT EXISTS) and idempotent — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate17.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_key text`;
await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_bytes integer`;
await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_width integer`;
await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_height integer`;

console.log('migrate17: scores.photo_key / photo_bytes / photo_width / photo_height ready');
await sql.end();
