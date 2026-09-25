// Home-venue inventory and the "Show my machines/scores publicly" switch.
//
//  1. venues.show_machines_and_scores — boolean, NOT NULL, DEFAULT true. Existing rows get true, so
//     nothing that is visible today becomes hidden. Only has an effect on private venues (residence
//     or a restricted privacy tier); see src/lib/venueActivity.ts.
//  2. venue_inventory — owner-managed machines at a private venue, which can't use a Pinball Map
//     roster. One row per (venue, machine); removed_at null = there now.
//
// Idempotent (IF NOT EXISTS throughout) — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate12.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS show_machines_and_scores boolean NOT NULL DEFAULT true`;

await sql`
  CREATE TABLE IF NOT EXISTS venue_inventory (
    id serial PRIMARY KEY,
    venue_id integer NOT NULL REFERENCES venues(id),
    machine_id integer NOT NULL REFERENCES machines(id),
    added_at timestamp NOT NULL DEFAULT now(),
    added_by_id integer REFERENCES users(id),
    removed_at timestamp,
    removed_by_id integer REFERENCES users(id)
  )`;
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_inventory_venue_machine_idx ON venue_inventory (venue_id, machine_id)`;

const [{ venues, hidden }] = await sql<Array<{ venues: number; hidden: number }>>`
  SELECT count(*)::int AS venues, count(*) FILTER (WHERE NOT show_machines_and_scores)::int AS hidden FROM venues`;
const [{ rows }] = await sql<Array<{ rows: number }>>`SELECT count(*)::int AS rows FROM venue_inventory`;
console.log(`done — show_machines_and_scores on ${venues} venues (${hidden} hidden); venue_inventory has ${rows} rows`);

await sql.end();
