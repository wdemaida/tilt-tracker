// migrate30: self-service profile — users.image_url (the user's Clerk-hosted profile photo, null =
// none of their own) and users.image_synced_at (the Clerk state instant image_url reflects; the
// user.updated webhook's out-of-order guard and GET /me's 24 h lazy resync both key on it).
// See src/lib/profileAvatar.ts. Run backfill-avatars.ts afterwards to fill image_url from Clerk.
//
// Also prints the longest existing display name: PATCH /api/users/me, setup and the admin edit now
// cap names at 40 characters (src/lib/profileFields.ts). Existing longer names are left alone — they
// only have to fit the cap when next edited.
//
// Idempotent (IF NOT EXISTS).
//
//   cd artifacts/api-server && npx tsx migrate30.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

await sql.begin(async tx => {
  await tx`ALTER TABLE users ADD COLUMN IF NOT EXISTS image_url text`;
  await tx`ALTER TABLE users ADD COLUMN IF NOT EXISTS image_synced_at timestamptz`;
});

const cols = await sql`
  SELECT column_name, data_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name IN ('image_url', 'image_synced_at')
   ORDER BY column_name`;
const [names] = await sql`
  SELECT max(char_length(display_name))::int AS longest,
         count(*) FILTER (WHERE char_length(display_name) > 40)::int AS over_cap,
         count(*) FILTER (WHERE btrim(display_name) = '')::int AS blank
    FROM users`;
console.log(`migrate30 done: ${cols.map(c => `${c.column_name} ${c.data_type}`).join(', ')}`);
console.log(`display names: longest ${names.longest ?? 0} chars, ${names.over_cap} over the 40 cap, ${names.blank} blank`);
await sql.end();
