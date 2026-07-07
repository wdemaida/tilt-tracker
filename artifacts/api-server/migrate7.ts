import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  INSERT INTO stats (key, label, description) VALUES
    ('total_plays', 'Plays', 'Total scores logged site-wide, all-time, as of the snapshot'),
    ('total_visits', 'Visits', 'Total clustered visits site-wide, all-time, as of the snapshot (6-hour gap = new visit)'),
    ('total_venues', 'Venues', 'Total venues in the system, as of the snapshot'),
    ('machines_with_score', 'Machines w/ Score', 'Machines with at least one logged score, as of the snapshot'),
    ('total_machines', 'Machines in System', 'Total machines known to the system (including ones only ever seen at a synced venue, never played), as of the snapshot')
  ON CONFLICT (key) DO NOTHING
`;

console.log('Migration complete: 5 all-time total stats seeded');
await sql.end();
