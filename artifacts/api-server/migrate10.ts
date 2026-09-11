// Local cache of Pinball Map machine rosters, keyed by their location id. Pinball Map asks that
// request volume track how often their data changes rather than how often our pages are viewed;
// before this, GET /api/venues/:id/machines hit their API on every single page view.
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  CREATE TABLE IF NOT EXISTS pm_location_cache (
    pm_location_id integer PRIMARY KEY,
    machines jsonb NOT NULL,
    fetched_at timestamp NOT NULL DEFAULT now()
  )
`;

const [{ n }] = await sql`SELECT count(*)::int AS n FROM pm_location_cache`;
console.log(`done — pm_location_cache ready (${n} rows)`);

await sql.end();
