// Adds venues.timezone — the IANA zone name for where the venue physically is.
//
// Scores are rendered in their venue's zone rather than the viewer's, so a play always reads as the
// clock on the wall said it was. The same column is what an incoming photo's zone-less EXIF wall
// clock gets interpreted in, which is what makes uploading after you've travelled home store the
// right instant.
//
//   cd artifacts/api-server && npx tsx migrate11.ts
//
// Populate it afterwards with backfill-venue-timezones.ts.

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS timezone text`;

const [{ total, filled }] = await sql<Array<{ total: number; filled: number }>>`
  SELECT count(*)::int AS total, count(timezone)::int AS filled FROM venues`;
console.log(`done — venues.timezone exists; ${filled}/${total} populated`);

await sql.end();
