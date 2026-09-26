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

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on feature/photos. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate17.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_key text`;
await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_bytes integer`;
await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_width integer`;
await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_height integer`;

console.log('migrate17: scores.photo_key / photo_bytes / photo_width / photo_height ready');
await sql.end();
