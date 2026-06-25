import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pinball_map_id integer`;
console.log('Migration complete: pinball_map_id added to venues');
await sql.end();
