import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  CREATE TABLE IF NOT EXISTS venue_machine_history (
    id serial PRIMARY KEY,
    venue_id integer NOT NULL REFERENCES venues(id),
    machine_id integer NOT NULL REFERENCES machines(id),
    first_seen_at timestamp NOT NULL DEFAULT now(),
    last_seen_at timestamp NOT NULL DEFAULT now(),
    removed_at timestamp
  )
`;

await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS venue_machine_history_venue_machine_idx
  ON venue_machine_history (venue_id, machine_id)
`;

console.log('Migration complete: venue_machine_history table created');
await sql.end();
