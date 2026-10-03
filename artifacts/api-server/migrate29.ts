// migrate29 (fix/both-reach + feature/last-resort):
//  - users.challenge_venues_edited_at — set when a user saves their challenge-locations list by hand.
//    Null = never edited, so an empty list can be re-seeded from their history (ensureSeeded).
//  - user_challenge_areas — a user's "Last Resort" area: US ZIP + radius (5/10/15/20/30/50 mi), the
//    ZIP centroid rounded to 2 decimals, its city label and its 0.1° cache cell. One row per user.
//  - pm_area_cache — Pinball Map locations around a cell (src/lib/pmAreaCache.ts), 7-day TTL.
//
// Idempotent (IF NOT EXISTS throughout). Never calls Pinball Map.
//
//   cd artifacts/api-server && npx tsx migrate29.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

await sql.begin(async tx => {
  await tx`ALTER TABLE users ADD COLUMN IF NOT EXISTS challenge_venues_edited_at timestamptz`;

  await tx`
    CREATE TABLE IF NOT EXISTS user_challenge_areas (
      user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      postal_code text NOT NULL CHECK (postal_code ~ '^[0-9]{5}$'),
      country text NOT NULL DEFAULT 'US' CHECK (country = 'US'),
      lat real NOT NULL,
      lng real NOT NULL,
      place_label text,
      radius_miles integer NOT NULL CONSTRAINT user_challenge_areas_radius_check CHECK (radius_miles IN (5, 10, 15, 20, 30, 50)),
      cell_key text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await tx`CREATE INDEX IF NOT EXISTS user_challenge_areas_cell_idx ON user_challenge_areas (cell_key)`;

  await tx`
    CREATE TABLE IF NOT EXISTS pm_area_cache (
      cell_key text PRIMARY KEY,
      fetch_radius_miles integer NOT NULL,
      locations jsonb,
      location_count integer,
      fetched_at timestamptz,
      last_error text,
      last_error_at timestamptz
    )`;
});

const cols = await sql`
  SELECT table_name AS tb, column_name AS c, data_type AS t FROM information_schema.columns
   WHERE table_schema = 'public' AND (
     (table_name = 'users' AND column_name = 'challenge_venues_edited_at')
     OR table_name IN ('user_challenge_areas', 'pm_area_cache'))
   ORDER BY table_name, ordinal_position`;
console.log(`migrate29 done:\n${cols.map(r => `  ${r.tb}.${r.c} ${r.t}`).join('\n')}`);
await sql.end();
