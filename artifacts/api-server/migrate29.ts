// migrate29 (fix/both-reach + feature/last-resort):
//  - users.challenge_venues_edited_at — set when a user saves their challenge-locations list by hand.
//    Null = never edited, so an empty list can be re-seeded from their history (ensureSeeded).
//
// Idempotent (IF NOT EXISTS throughout).
//
//   cd artifacts/api-server && npx tsx migrate29.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

await sql.begin(async tx => {
  await tx`ALTER TABLE users ADD COLUMN IF NOT EXISTS challenge_venues_edited_at timestamptz`;
});

const cols = await sql`
  SELECT column_name AS c, data_type AS t FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'challenge_venues_edited_at'`;
console.log(`migrate29 done: ${cols.map(r => `users.${r.c} ${r.t}`).join(', ')}`);
await sql.end();
