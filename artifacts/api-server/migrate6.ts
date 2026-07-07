import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  CREATE TABLE IF NOT EXISTS stats (
    id serial PRIMARY KEY,
    key text UNIQUE NOT NULL,
    label text NOT NULL,
    description text,
    created_at timestamp NOT NULL DEFAULT now()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS stat_history (
    id serial PRIMARY KEY,
    stat_id integer NOT NULL REFERENCES stats(id),
    value integer NOT NULL,
    period_date date NOT NULL,
    created_at timestamp NOT NULL DEFAULT now()
  )
`;

await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS stat_history_stat_id_period_date_idx
  ON stat_history (stat_id, period_date)
`;

await sql`
  INSERT INTO stats (key, label, description) VALUES
    ('plays', 'Plays', 'Scores logged site-wide so far this calendar month (America/New_York), by play date'),
    ('visits', 'Visits', 'Clustered visits site-wide so far this calendar month (America/New_York) — 6-hour gap between plays starts a new visit'),
    ('scores_submitted', 'Scores Submitted', 'Scores submitted site-wide so far this calendar month (America/New_York), by upload time')
  ON CONFLICT (key) DO NOTHING
`;

console.log('Migration complete: stats + stat_history tables created and seeded');
await sql.end();
