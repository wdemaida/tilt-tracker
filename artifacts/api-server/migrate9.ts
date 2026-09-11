// Adds venues.created_by_id — who first added the venue to TiltTrack, as distinct from owner_id
// (which marks a residence and drives address privacy). Creators get to repair a venue's HERE /
// Pinball Map linkage, so a venue that failed to resolve on upload isn't stuck waiting on an admin.
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS created_by_id integer REFERENCES users(id)`;

// Backfill: a residence's owner created it; everything else is attributed to whoever logged the
// earliest score there, which is how upload-flow venues come into existence in the first place.
await sql`UPDATE venues SET created_by_id = owner_id WHERE created_by_id IS NULL AND owner_id IS NOT NULL`;
await sql`
  UPDATE venues v
  SET created_by_id = s.user_id
  FROM (
    SELECT DISTINCT ON (venue_id) venue_id, user_id
    FROM scores
    WHERE venue_id IS NOT NULL
    ORDER BY venue_id, played_at ASC, id ASC
  ) s
  WHERE v.id = s.venue_id AND v.created_by_id IS NULL
`;

const [{ total }] = await sql`SELECT count(*)::int AS total FROM venues WHERE created_by_id IS NOT NULL`;
const [{ orphans }] = await sql`SELECT count(*)::int AS orphans FROM venues WHERE created_by_id IS NULL`;
console.log(`done — ${total} venues attributed, ${orphans} still without a creator`);

await sql.end();
