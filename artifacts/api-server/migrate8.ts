import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  DO $$ BEGIN
    CREATE TYPE venue_privacy AS ENUM ('full', 'city_state', 'hidden');
  EXCEPTION
    WHEN duplicate_object THEN null;
  END $$
`;

await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS owner_id integer REFERENCES users(id)`;
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS is_residence boolean NOT NULL DEFAULT false`;
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS privacy_tier venue_privacy NOT NULL DEFAULT 'full'`;
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS city text`;
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS state text`;
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS city_lat real`;
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS city_lng real`;

console.log('Migration complete: venues gained owner_id, is_residence, privacy_tier, city, state, city_lat, city_lng');
await sql.end();
